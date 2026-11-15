/**
 * 绘图模块的出图服务：把一次请求翻译成「临时素材 + R 调用 + 产物搬运」。
 *
 * ## 为什么与 `VolcanoExporter` 分开
 *
 * 那个类只服务火山图，参数与 `PlotExportRequest` 一一对应（logFC / fdr / basis）。
 * 绘图模块的三张图参数完全不同（Venn 是圈和基因，小提琴是矩阵 + 检验方法，
 * 生存曲线是随访表 + ggsurvplot 的一堆开关），硬塞进去会让那个类里出现
 * 三段互相无关的分支。共用的是**同一套做法**：写临时文件 → 调 R → 读产物 →
 * finally 删目录。
 *
 * ## 三种数据怎么进 R
 *
 *  - **Venn**：用户粘贴的基因列表在内存里，落成 `sets.csv`（两列 set/gene）给 R 读。
 *    不在 params 里塞嵌套对象 —— `jsonlite` 会把「对象数组」简化成 data.frame，
 *    形状随元素个数变化（1 个圈时退化成单行），是最难查的那类坑。
 *  - **小提琴 / 生存曲线**：矩阵和随访表在用户磁盘上，**只把路径传下去**，
 *    让 R 自己 `read.delim`。整张矩阵走 IPC 序列化毫无必要。
 *
 * ## 预览与导出走同一个 R 脚本
 *
 * 只改 format / dpi / skipFonts。分成两套代码迟早出现「屏幕上和导出不一样」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import type { VizRenderRequest, VizRenderResult } from '@shared/types/viz'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'

export interface VizRendererDeps {
  runner: RRunner
  paths: Pick<PathService, 'getTempDir'>
}

/** 正常 1~5 秒；给慢机器和 survminer 的 risk table 留足余量 */
const RENDER_TIMEOUT_MS = 180_000

/** 预览分辨率：与火山图/热图保持一致，140dpi 在 9 英寸宽上约 1260px */
const PREVIEW_DPI = 140

/** 每张图对应的 R 脚本与必需包 */
const SCRIPTS: Record<
  VizRenderRequest['kind'],
  { scriptRelPath: string; requiredPackages: string[] }
> = {
  venn: {
    scriptRelPath: 'viz/plot_venn.R',
    requiredPackages: ['ggplot2', 'data.table']
  },
  violin: {
    scriptRelPath: 'viz/plot_violin.R',
    requiredPackages: ['ggplot2', 'data.table']
  },
  survival: {
    scriptRelPath: 'viz/plot_survival.R',
    requiredPackages: ['ggplot2', 'data.table']
  }
}

/** 把 Venn 的圈与基因写成长表：两列 set / gene */
function writeVennSets(filePath: string, sets: { name: string; genes: string[] }[]): number {
  const lines: string[] = ['set,gene']
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  let written = 0
  for (const set of sets) {
    const name = set.name.trim() || 'set'
    for (const gene of set.genes) {
      const trimmed = gene.trim()
      if (!trimmed) continue
      lines.push(`${escape(name)},${escape(trimmed)}`)
      written += 1
    }
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
  return written
}

export class VizRenderer {
  constructor(private readonly deps: VizRendererDeps) {}

  async render(req: VizRenderRequest): Promise<VizRenderResult> {
    const exporting = Boolean(req.outPath)
    const format = req.format ?? 'png'
    const dpi = exporting ? req.dpi ?? 300 : PREVIEW_DPI

    if (!(req.widthIn > 0) || !(req.heightIn > 0)) {
      throw toAppError('E_VALIDATION', { message: '图幅尺寸必须大于 0。' })
    }

    const runId = `viz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const runDir = path.join(this.deps.paths.getTempDir(), runId)
    const outPath = exporting ? (req.outPath as string) : path.join(runDir, `preview.${format}`)

    try {
      fs.mkdirSync(runDir, { recursive: true })

      const params: Record<string, unknown> = {
        outPath,
        format,
        widthIn: req.widthIn,
        heightIn: req.heightIn,
        dpi,
        title: req.title ?? '',
        // 只有预览跳过字体注册：预览图里的标签是基因名/组名（可能含中文），
        // 但导出的图同样可能含中文，所以导出那条路必须字体就位。
        // 预览这边省略字体能把首图时间压掉几百毫秒，值得。
        skipFonts: !exporting
      }

      if (req.kind === 'venn') {
        if (req.sets.length < 2) {
          throw toAppError('E_VALIDATION', {
            message: 'Venn 图至少需要 2 组基因。',
            suggestion: '再加一组，或改用单组的柱状图。'
          })
        }
        const nonEmpty = req.sets.filter((set) => set.genes.filter((g) => g.trim()).length > 0)
        if (nonEmpty.length < 2) {
          throw toAppError('E_VALIDATION', {
            message: '至少要有 2 组非空的基因列表。',
            suggestion: '检查粘贴的列表是否为空，或分隔符是否被识别。'
          })
        }
        const setsPath = path.join(runDir, 'sets.csv')
        const pairs = writeVennSets(setsPath, nonEmpty)
        params.dataPath = setsPath
        params.pairs = pairs
        params.setOrder = nonEmpty.map((set) => set.name.trim() || 'set')
        params.fill = req.options.fill
        params.showCount = req.options.showCount
        params.showPercent = req.options.showPercent
        params.palette = req.options.palette
        if (req.options.labelSize !== undefined) params.labelSize = req.options.labelSize
      }

      if (req.kind === 'violin') {
        if (req.source.genes.length === 0) {
          throw toAppError('E_VALIDATION', {
            message: '请至少选择一个基因。',
            suggestion: '从矩阵的基因列表里选，或手动输入基因名。'
          })
        }
        params.matrixPath = req.source.matrixPath
        params.groupsPath = req.source.groupsPath ?? ''
        params.geneColumn = req.source.geneColumn ?? ''
        params.genes = req.source.genes
        params.plotType = req.options.plotType
        params.inputIsLog2 = req.options.inputIsLog2
        params.testMethod = req.options.testMethod
        params.pLabel = req.options.pLabel
        params.refGroup = req.options.refGroup ?? ''
        params.showPoints = req.options.showPoints
        params.showMean = req.options.showMean
        params.palette = req.options.palette
        params.facetFreeY = req.options.facetFreeY
        params.yLabel = req.options.yLabel ?? ''
        params.xLabel = req.options.xLabel ?? ''
      }

      if (req.kind === 'survival') {
        params.clinicalPath = req.source.clinicalPath
        params.matrixPath = req.source.matrixPath ?? ''
        params.groupBy = req.options.groupBy
        params.groupColumn = req.options.groupColumn ?? ''
        params.timeColumn = req.options.timeColumn ?? ''
        params.statusColumn = req.options.statusColumn ?? ''
        params.gene = req.options.gene ?? ''
        params.cutMethod = req.options.cutMethod ?? 'median'
        params.inputIsLog2 = req.options.inputIsLog2 ?? true
        params.palette = req.options.palette
        params.confInt = req.options.confInt
        params.pval = req.options.pval
        params.pvalMethod = req.options.pvalMethod
        params.logRankWeights = req.options.logRankWeights
        params.riskTable = req.options.riskTable
        params.riskTableHeight = req.options.riskTableHeight
        params.legendLabs = req.options.legendLabs ?? characterVector()
        params.xLabel = req.options.xLabel ?? ''
        params.yLabel = req.options.yLabel ?? ''
      }

      const spec = SCRIPTS[req.kind]
      const config = { runId, runDir, projectRoot: runDir, params }

      logger.info(
        'viz',
        `出图 ${req.kind} ${exporting ? format : 'preview'} ${req.widthIn}x${req.heightIn}in @${dpi}dpi`
      )

      const result = await this.deps.runner.run({
        runId,
        scriptRelPath: spec.scriptRelPath,
        config,
        runDir,
        timeoutMs: RENDER_TIMEOUT_MS,
        requiredPackages: spec.requiredPackages
      })

      if (!result.ok) {
        if (result.stderr) {
          logger.error(
            'viz',
            `R 绘图失败（exit=${result.exitCode}），stderr 末尾：\n${result.stderr.slice(-3000)}`
          )
        }
        throw (
          result.error ??
          toAppError('E_R_GENERIC', {
            message: 'R 绘图失败，但没有返回可识别的错误信息。',
            suggestion: '请查看日志确认；若反复出现，请导出诊断报告。'
          })
        )
      }

      if (!fs.existsSync(outPath)) {
        throw toAppError('E_IO_PERMISSION', {
          message: `R 报告成功，但目标文件不存在：${outPath}`,
          suggestion: '请确认保存位置可写（例如没有被杀毒软件锁定）。'
        })
      }

      const summary = (result.summary ?? {}) as Record<string, unknown>
      const stat = fs.statSync(outPath)
      const bytes = Number.isFinite(Number(summary.bytes)) ? Number(summary.bytes) : stat.size
      const durationMs = Number.isFinite(Number(summary.durationMs))
        ? Number(summary.durationMs)
        : result.durationMs

      if (exporting) {
        return { outPath, bytes, durationMs, summary }
      }

      const buffer = fs.readFileSync(outPath)
      return {
        dataUrl: `data:image/${format};base64,${buffer.toString('base64')}`,
        bytes,
        widthPx: Math.round(req.widthIn * dpi),
        heightPx: Math.round(req.heightIn * dpi),
        durationMs,
        summary
      }
    } finally {
      // 预览产物与临时素材一律删掉；导出文件在 outPath（用户指定位置），不在这里
      try {
        fs.rmSync(runDir, { recursive: true, force: true })
      } catch {
        logger.warn('viz', `临时目录清理失败：${runDir}`)
      }
    }
  }
}

/** JSON 里「空数组」要能被 R 认出来是字符向量，这里给个空字符向量占位 */
function characterVector(): string[] {
  return []
}
