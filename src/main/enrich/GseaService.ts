/**
 * GSEA 服务（主进程侧）。
 *
 * ## 与 EnrichService 的一处关键差异
 *
 * 富集是「先 run 出表、再单独 plot 出图」两条 IPC —— 因为气泡图的 topN / 分面
 * 是**交互参数**，用户拉动滑杆就要重画一次。
 *
 * GSEA 没有这种交互：top-N 与「指定通路」都在开跑时就定了，图是 R 在分析末尾
 * 顺手画出来的。所以这里做成**一次调用把表和图一起返回**，少一次往返、也少一个
 * 「图和表不匹配」的窗口（比如用户改了 topN 但没重画）。
 *
 * 代价是返回体里有两张 base64 图（各 100~200 KB），对 IPC 来说完全可以接受。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import type {
  GseaExportPlotRequest,
  GseaExportPlotResult,
  GseaExportTableRequest,
  GseaExportTableResult
} from '@shared/types/ipc-contract'
import type { GseaRunRequest, GseaResultRow, GseaRunResult } from '@shared/types/gsea'
import { logger } from '../logger'
import type { RRunner } from '../process/RProcessRunner'
import { countCsvDataRows, writeXlsx } from '../util/csv'

const RUN_TIMEOUT_MS = 10 * 60 * 1000

export interface GseaServiceDeps {
  runner: RRunner
  projectStore: { getRoot(): string | null }
}

/** R 写出的列名 → 前端驼峰 */
interface RawGseaRow {
  pathway?: string
  description?: string
  size?: number | string
  es?: number | string
  nes?: number | string
  pvalue?: number | string
  p_adjust?: number | string
  leading_edge?: string
}

/** 极简 CSV 解析（带引号、双引号转义），够读我们自己产出的表 */
function parseCsv(text: string): RawGseaRow[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return []
  const header = rows[0]
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])) as RawGseaRow)
}

function num(v: number | string | undefined, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

export class GseaService {
  constructor(private readonly deps: GseaServiceDeps) {}

  /**
   * 跑一次 GSEA。
   *
   * 差异表路径由渲染进程给出（用户导入的文件，或项目里已有的差异结果）——
   * 但**不在这里校验它的内容**：列名识别、ID 体系是否匹配都由 R 侧判断，
   * 那边能看到真实的列名，能给出「你的 logFC 列叫什么」这种可读提示。
   * 这里只挡「文件都不存在」这一种情况。
   */
  async run(input: GseaRunRequest): Promise<GseaRunResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行 GSEA。',
        suggestion: '请先打开一个项目。'
      })
    }
    if (!input.degPath || !fs.existsSync(input.degPath)) {
      throw toAppError('E_DATA_EMPTY', {
        message: `找不到差异结果文件：${path.basename(input.degPath || '')}`,
        suggestion: '请重新选择文件。'
      })
    }
    if (input.source === 'custom' && (!input.gmtPath || !fs.existsSync(input.gmtPath))) {
      throw toAppError('E_DATA_EMPTY', {
        message: '找不到 GMT 文件。',
        suggestion: '请重新选择 .gmt 文件，或改用内置基因集。'
      })
    }

    const gseaId = `gsea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    const runDir = path.join(root, 'results', 'gsea', gseaId)
    fs.mkdirSync(runDir, { recursive: true })

    const config = {
      runId: gseaId,
      runDir,
      projectRoot: root,
      params: {
        degPath: input.degPath,
        geneColumn: input.geneColumn ?? '',
        logfcColumn: input.logfcColumn ?? '',
        pColumn: input.pColumn ?? '',
        pvalueCutoff: input.pvalueCutoff,
        gmtSource: input.source === 'custom' ? 'custom' : input.source,
        gmtCollection: input.collection,
        gmtPath: input.gmtPath ?? '',
        topN: input.topN,
        pathways: input.pathways ?? [],
        minSize: input.minSize,
        maxSize: input.maxSize,
        nperm: input.nperm,
        widthIn: input.widthIn,
        heightIn: input.heightIn,
        palette: input.palette ?? [],
        skipFonts: true
      }
    }

    logger.info(
      'gsea',
      `启动 GSEA ${gseaId}: ${path.basename(input.degPath)} / ${input.source}:${input.collection} / topN=${input.topN}`
    )

    const result = await this.deps.runner.run({
      runId: gseaId,
      scriptRelPath: 'enrich/run_gsea.R',
      config,
      runDir,
      timeoutMs: RUN_TIMEOUT_MS,
      requiredPackages: ['fgsea', 'clusterProfiler', 'enrichplot']
    })

    if (!result.ok) {
      if (result.stderr) {
        logger.error('gsea', `GSEA 失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
      }
      throw (
        result.error ??
        toAppError('E_R_GENERIC', {
          message: 'GSEA 运行失败。',
          suggestion: '请检查差异表是否包含基因列与 logFC 列。'
        })
      )
    }

    const csvPath = path.join(runDir, 'gsea_result.csv')
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', { message: 'R 报告成功，但没有写出结果表。' })
    }

    const rows: GseaResultRow[] = parseCsv(fs.readFileSync(csvPath, 'utf-8')).map((r) => ({
      pathway: String(r.pathway ?? ''),
      description: String(r.description ?? ''),
      size: num(r.size),
      es: num(r.es),
      nes: num(r.nes),
      pvalue: num(r.pvalue),
      pAdjust: num(r.p_adjust),
      leadingEdge: String(r.leading_edge ?? '')
    }))

    return {
      gseaId,
      rows,
      summary: (result.summary ?? {}) as Record<string, unknown>,
      topPlot: this.readPlot(runDir, 'gsea_top.png'),
      detailPlot: this.readPlot(runDir, 'gsea_detail.png')
    }
  }

  /**
   * 把已经画好的图复制到用户选的位置。
   *
   * 刻意**不重画**：R 在分析末尾已经把 png 和 pdf 都落在 runDir 里，重跑一遍除了
   * 多等几秒，还可能因为图形设备差异让导出图和屏幕上看到的不是同一张。
   *
   * 两种格式是**两个独立文件**（R 用两个设备分别画的）。所以 PDF 缺失时不能退回
   * png —— 用户点的是「导出 PDF」，给他一个后缀是 .pdf 的位图，等投稿放大才发现
   * 就太晚了。老运行（加 PDF 之前跑的）重跑一次 GSEA 即可，几秒钟。
   */
  exportPlot(input: GseaExportPlotRequest): GseaExportPlotResult {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    }
    const format = input.format ?? 'png'
    const base = input.which === 'detail' ? 'gsea_detail' : 'gsea_top'
    const src = path.join(root, 'results', 'gsea', input.gseaId, `${base}.${format}`)
    const what = input.which === 'detail' ? '详情图' : 'top-N 图'

    if (!fs.existsSync(src)) {
      if (format === 'pdf') {
        throw toAppError('E_RESULT_INVALID', {
          message: `这次运行的${what}没有矢量 PDF（是在支持 PDF 导出之前跑的）。`,
          suggestion: '重新点一次「运行 GSEA」即可 —— 只需几秒，重跑后表和图都会带上 PDF。'
        })
      }
      throw toAppError('E_RESULT_INVALID', {
        message: `还没有生成${what}。`,
        suggestion: '请先跑一次 GSEA，或在「指定通路」里填上通路名后重新运行。'
      })
    }
    fs.copyFileSync(src, input.outPath)
    return { outPath: input.outPath, bytes: fs.statSync(input.outPath).size }
  }

  /**
   * 导出**完整**结果表。
   *
   * 为什么不在渲染进程里把 `rows` 打包传下来（通用 `deg:export:table` 是那样做的）：
   * `rows` 是解析后的对象，浮点数已经被 JS 处理过一遍；而且 Reactome 这类集合
   * 一次能出 1700+ 行，来回传一遍纯属浪费。这里直接转 R 写出的 `gsea_result.csv`，
   * 行数、精度、列名与磁盘上那份完全一致 —— 用户拿去当投稿附件时，附件和软件里
   * 看到的必须是同一个东西。
   */
  async exportTable(input: GseaExportTableRequest): Promise<GseaExportTableResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', { message: '还没有打开项目，无法导出结果表。' })
    }
    const csvPath = path.join(root, 'results', 'gsea', input.gseaId, 'gsea_result.csv')
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到 GSEA 结果文件，无法导出。',
        suggestion: '请重新运行一次 GSEA。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })

    if (input.format === 'csv') {
      fs.copyFileSync(csvPath, input.outPath)
    } else {
      await writeXlsx(csvPath, input.outPath, 'gsea')
    }
    const stat = fs.statSync(input.outPath)
    const rows = countCsvDataRows(csvPath)
    logger.info('gsea', `导出结果表 ${input.format}：${input.outPath}（${rows} 行，${stat.size} 字节）`)
    return { outPath: input.outPath, bytes: stat.size, rows }
  }

  /** 读 png 成 data URL；文件不存在返回 null（图可能因渲染失败没生成，不该让整次分析失败） */
  private readPlot(runDir: string, file: string): string | null {
    const p = path.join(runDir, file)
    if (!fs.existsSync(p)) return null
    return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
  }
}
