/**
 * 热图渲染（R / pheatmap）—— 预览与导出共用一个实现。
 *
 * ## 数据从哪来
 *
 * 热图必须有**表达矩阵**，而矩阵只在项目里（`data/expression.clean.csv`）。
 * 所以这里按当前项目根去读矩阵与分组表；但**选哪些基因**由调用方传：
 *   - `geneList` 非空 → 完全按列表（不受 top N 限制，客户明确要求的独立路径）
 *   - `geneList` 为空 → 用传进来的 `rows` 按当前阈值筛显著基因、FDR 升序取前 N
 *
 * 为什么基因筛选不在 R 里「自己再算一遍」：前端已经有一份判定逻辑
 * （`isSignificant`），R 再算一次就会有第二套口径。这里把筛出来的 rows
 * 和阈值一起交给 R，R 只做「按阈值过滤 + 排序」这一步，判定谓词与前端逐字相同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_FILES } from '@shared/constants'
import { toAppError } from '@shared/errors'
import type {
  HeatmapExportRequest,
  HeatmapPlotResult,
  HeatmapPreviewRequest
} from '@shared/types/ipc-contract'
import { writeTableCsv } from '../io/OutputWriter'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'

/** 预览分辨率：与火山图一致（140dpi 在 6 英寸宽上约 840px） */
const PREVIEW_DPI = 140

const TIMEOUT_MS = 120_000

export interface HeatmapExporterDeps {
  runner: RRunner
  paths: Pick<PathService, 'getTempDir'>
  /** 只需能拿到当前项目根 */
  projectStore: { getRoot(): string | null }
}

interface RenderOptions {
  outPath: string
  format: 'png' | 'pdf'
  dpi: number
}

export class HeatmapExporter {
  constructor(private readonly deps: HeatmapExporterDeps) {}

  /** 预览：渲染到临时 PNG 并回传 dataURL */
  async preview(req: HeatmapPreviewRequest): Promise<HeatmapPlotResult> {
    const runId = `hm-prev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const runDir = path.join(this.deps.paths.getTempDir(), runId)
    try {
      fs.mkdirSync(runDir, { recursive: true })
      const outPath = path.join(runDir, 'heatmap.png')
      const result = await this.render(req, { outPath, format: 'png', dpi: PREVIEW_DPI }, runDir)
      const buffer = fs.readFileSync(outPath)
      return {
        ...result,
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        bytes: buffer.length
      }
    } finally {
      this.cleanup(runDir)
    }
  }

  /** 导出：写到用户指定路径 */
  async export(req: HeatmapExportRequest): Promise<HeatmapPlotResult> {
    const runId = `hm-exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const runDir = path.join(this.deps.paths.getTempDir(), runId)
    try {
      fs.mkdirSync(runDir, { recursive: true })
      const result = await this.render(
        req,
        { outPath: req.outPath, format: req.format, dpi: req.dpi },
        runDir
      )
      return { ...result, outPath: req.outPath }
    } finally {
      this.cleanup(runDir)
    }
  }

  private async render(
    req: HeatmapPreviewRequest,
    out: RenderOptions,
    runDir: string
  ): Promise<HeatmapPlotResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法绘制热图。',
        suggestion: '热图需要项目里的表达矩阵，请先导入数据或打开一个项目。'
      })
    }

    const matrixPath = path.join(root, PROJECT_FILES.cleanMatrix)
    const groupsPath = path.join(root, PROJECT_FILES.groups)
    if (!fs.existsSync(matrixPath)) {
      throw toAppError('E_DATA_EMPTY', {
        message: '项目里没有表达矩阵。',
        suggestion: '请先在「数据导入与质控」页导入表达矩阵。'
      })
    }
    if (req.rows.length === 0) {
      throw toAppError('E_VALIDATION', { message: '没有差异结果，无法挑选基因。' })
    }

    const runId = path.basename(runDir)
    // 差异结果写成与 de.csv 同构的 9 列，R 侧按列名读，不再另立一套格式
    const dePath = path.join(runDir, 'de.csv')
    writeTableCsv(dePath, req.rows as unknown as Record<string, unknown>[])

    const config = {
      runId,
      runDir,
      projectRoot: root,
      params: {
        matrixPath,
        groupsPath: fs.existsSync(groupsPath) ? groupsPath : '',
        dePath,
        outPath: out.outPath,
        format: out.format,
        widthIn: req.widthIn,
        heightIn: req.heightIn,
        dpi: out.dpi,
        topN: req.topN,
        clusterRows: req.clusterRows,
        clusterCols: req.clusterCols,
        scale: req.scale,
        showGeneNames: req.showGeneNames,
        showSampleNames: req.showSampleNames,
        showGroupAnnotation: req.showGroupAnnotation,
        logFC: req.thresholds.logFC,
        fdr: req.thresholds.fdr,
        basis: req.thresholds.basis ?? 'adjPValue',
        colors: req.colors,
        geneList: req.geneList,
        title: req.title ?? '',
        // 预览图的标签全是英文/基因 ID，跳过字体注册能省几百毫秒
        skipFonts: out.format === 'png'
      }
    }

    logger.info(
      'plot',
      `热图 ${out.format} ${req.widthIn}x${req.heightIn}in ` +
        `genes=${req.geneList.length > 0 ? `列表(${req.geneList.length})` : `top${req.topN}`}`
    )

    const result = await this.deps.runner.run({
      runId,
      scriptRelPath: 'plot/export_heatmap.R',
      config,
      runDir,
      timeoutMs: TIMEOUT_MS,
      requiredPackages: ['pheatmap', 'ragg', 'data.table']
    })

    if (!result.ok || !fs.existsSync(out.outPath)) {
      if (result.stderr) {
        logger.error('plot', `热图失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
      }
      throw (
        result.error ??
        toAppError('E_R_GENERIC', {
          message: '热图生成失败。',
          suggestion: '请检查是否已导入表达矩阵与分组表。'
        })
      )
    }

    const summary = (result.summary ?? {}) as Record<string, unknown>
    const stat = fs.statSync(out.outPath)
    return {
      bytes: Number.isFinite(Number(summary.bytes)) ? Number(summary.bytes) : stat.size,
      genes: Number(summary.genes ?? 0),
      samples: Number(summary.samples ?? 0),
      durationMs: Number.isFinite(Number(summary.durationMs))
        ? Number(summary.durationMs)
        : result.durationMs
    }
  }

  private cleanup(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      logger.warn('plot', `热图临时目录清理失败：${dir}`)
    }
  }
}
