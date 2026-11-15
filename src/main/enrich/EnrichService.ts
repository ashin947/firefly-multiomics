/**
 * 富集分析（ORA）—— 跑 R、读结果、出气泡图。
 *
 * ## 为什么结果要落到项目里
 *
 * `results/enrich/<id>/enrich_result.csv` 是整个分析的唯一真源：
 * 表格页、气泡图、以后可能的导出/对比都读它。只在内存里留一份的话，
 * 用户关掉软件再打开，富集结果就没了（和 de.csv 同一个道理）。
 *
 * ## 基因从哪来
 *
 * 由渲染进程传（`genes`）：默认是「当前阈值下全部显著基因」，用户也可以手填。
 * 不在主进程重算 —— 那会变成第二套判定口径，和结果页的 123/75 对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import type { EnrichResultRow, EnrichSource } from '@shared/types/enrich'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'
// CSV 解析 / 行数统计 / xlsx 生成抽到 util：WGCNA 导出结果表也要用同一份实现
import { countCsvDataRows, parseCsv, writeXlsx } from '../util/csv'

const RUN_TIMEOUT_MS = 5 * 60 * 1000

export interface EnrichRunInput {
  genes: string[]
  geneIdType: string
  species: 'human' | 'mouse' | 'rice' | 'other'
  sources: ('go' | 'kegg')[]
  ontology: 'BP' | 'MF' | 'CC' | 'ALL'
  pvalueCutoff: number
  qvalueCutoff: number
  customGoPath?: string
  customPathwayPath?: string
  customTermPrefix?: string
}

export interface EnrichServiceDeps {
  runner: RRunner
  paths: Pick<PathService, 'getTempDir'>
  projectStore: { getRoot(): string | null }
}

/** R 的 CSV 行 → 前端统一的 EnrichResultRow */
interface RawEnrichRow {
  database?: string
  ontology?: string
  term_id?: string
  description?: string
  gene_ratio?: number | string
  gene_ratio_text?: string
  bg_ratio?: string
  pvalue?: number | string
  p_adjust?: number | string
  qvalue?: number | string
  count?: number | string
  gene_ids?: string
  category?: string
}

function toSource(database: string, ontology: string | null): EnrichSource {
  if (database === 'GO') {
    // GO 的 ontology 可能是 ALL（enrichGO 一次返回三类），此时每行都带自己的 ONTOLOGY
    const ont = (ontology ?? '').toUpperCase()
    if (ont === 'BP' || ont === 'CC' || ont === 'MF') return `GO:${ont}` as EnrichSource
    return 'GO:BP'
  }
  if (database === 'KEGG') return 'KEGG'
  // 自定义背景（Pathway-custom / GO-custom）
  return 'Pathway' as EnrichSource
}

/**
 * 把 Excel 注释文件转成 TSV，落进本次运行的 runDir。
 *
 * 非 Excel（txt / tsv / csv）**原样返回**，一个字节都不动 —— 那些文件 R 直接读。
 *
 * ## 为什么不用 R 的 readxl / openxlsx
 *
 * 内置 R 里没装，装一次要给安装包再加几十 MB，而这里只做「把一张表摊成文本」。
 * 项目里已经有 `xlsx@0.18.5`（主进程其它地方在用），够用。
 *
 * ## 交付给 R 的形态
 *
 * 原样保留第一行（Excel 里的表头），不重命名列：R 侧的 `.read_term2gene()`
 * 靠**表头词**判断宽表/长表，改列名反而会让它认不出来。
 * 空行、全空单元格都丢掉，避免 R 侧出现「gene 为空」的脏行。
 */
async function materializeBackground(
  filePath: string | undefined,
  runDir: string,
  kind: 'go' | 'pathway'
): Promise<string | undefined> {
  if (!filePath) return filePath
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.xlsx' && ext !== '.xls') return filePath
  if (!fs.existsSync(filePath)) {
    throw toAppError('E_DATA_EMPTY', {
      message: `找不到注释文件：${path.basename(filePath)}`,
      suggestion: '请重新选择文件。'
    })
  }

  const mod = await import('xlsx')
  const XLSX = ((mod as unknown as { default?: typeof import('xlsx') }).default ?? mod) as typeof import('xlsx')
  const wb = XLSX.readFile(filePath)
  const sheetName = wb.SheetNames[0]
  if (!sheetName) {
    throw toAppError('E_DATA_EMPTY', { message: 'Excel 文件里没有任何工作表。' })
  }
  const sheet = wb.Sheets[sheetName]
  if (!sheet) {
    throw toAppError('E_DATA_EMPTY', { message: `工作表 ${sheetName} 是空的。` })
  }
  // header:1 → 每行一个数组；defval 保证列数对齐（Excel 里空单元格会被跳过）
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
  const cells = rows
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []))
    .filter((r) => r.some((c) => c !== ''))
  if (cells.length === 0) {
    throw toAppError('E_DATA_EMPTY', { message: `工作表 ${sheetName} 里没有数据行。` })
  }

  // ★ 右补空列，让每行列数一致。
  //   `sheet_to_json` 会把**行尾的空单元格**裁掉，于是同一列里某些行有 3 列、
  //   某些行只有 2 列。R 侧是**按位置**取列（第 3 列=名称），行长度不一致时
  //   那一行就悄悄没有名字了 —— 不报错，只是名字缺一个。
  const width = Math.max(...cells.map((r) => r.length))
  const padded = cells.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r))

  const outPath = path.join(runDir, `background_${kind}.tsv`)
  fs.writeFileSync(outPath, `${padded.map((r) => r.join('\t')).join('\n')}\n`, 'utf8')
  logger.info(
    'enrich',
    `Excel 注释已转为 TSV：${path.basename(filePath)} → ${path.basename(outPath)}` +
      `（${padded.length} 行 × ${width} 列，首行：${padded[0].join(' | ').slice(0, 80)}）`
  )
  return outPath
}

export class EnrichService {
  constructor(private readonly deps: EnrichServiceDeps) {}

  async run(input: EnrichRunInput): Promise<{
    enrichId: string
    rows: EnrichResultRow[]
    summary: Record<string, unknown>
  }> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行富集分析。',
        suggestion: '请先打开一个项目。'
      })
    }
    if (input.genes.length < 3) {
      throw toAppError('E_VALIDATION', {
        message: `至少需要 3 个基因才能做富集，当前只有 ${input.genes.length} 个。`,
        suggestion: '放宽差异阈值，或手动输入更多基因。'
      })
    }

    const enrichId = `enr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    const runDir = path.join(root, 'results', 'enrich', enrichId)
    fs.mkdirSync(runDir, { recursive: true })

    const databases: string[] = []
    if (input.sources.includes('go')) databases.push('GO')
    if (input.sources.includes('kegg')) databases.push('KEGG')

    // ★ Excel 注释文件在主进程转成 TSV 再交给 R —— 内置 R 没装 readxl/openxlsx，
    //   而为了读一个 490 KB 的表去装包会把安装包再撑大几十 MB，不划算。
    //   转换放在 `run()` 里（而不是单独一条「先转换再运行」的 IPC），
    //   是为了让「用户选了 xlsx」这件事**不可能被绕过**：
    //   调用方只传路径，谁来调都走同一条路。
    const customGoPath = await materializeBackground(input.customGoPath, runDir, 'go')
    const customPathwayPath = await materializeBackground(input.customPathwayPath, runDir, 'pathway')

    const config = {
      runId: enrichId,
      runDir,
      projectRoot: root,
      params: {
        geneList: input.genes,
        species: input.species,
        geneIdType: input.geneIdType,
        databases,
        ontology: input.ontology,
        pvalueCutoff: input.pvalueCutoff,
        qvalueCutoff: input.qvalueCutoff,
        customGoPath: customGoPath ?? '',
        customPathwayPath: customPathwayPath ?? '',
        customTermPrefix: input.customTermPrefix ?? '',
        skipFonts: true
      }
    }

    logger.info(
      'enrich',
      `启动富集 ${enrichId}: ${input.genes.length} 基因, ${databases.join('+')}, ${input.species}`
    )

    const result = await this.deps.runner.run({
      runId: enrichId,
      scriptRelPath: 'enrich/run_ora.R',
      config,
      runDir,
      timeoutMs: RUN_TIMEOUT_MS,
      requiredPackages: ['clusterProfiler', 'data.table']
    })

    if (!result.ok) {
      if (result.stderr) {
        logger.error('enrich', `富集失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
      }
      throw (
        result.error ??
        toAppError('E_R_GENERIC', {
          message: '富集分析失败。',
          suggestion: '请检查物种与基因 ID 类型是否匹配。'
        })
      )
    }

    const csvPath = path.join(runDir, 'enrich_result.csv')
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', { message: 'R 报告成功，但没有写出结果表。' })
    }
    const rows = this.readRows(fs.readFileSync(csvPath, 'utf-8'))
    return { enrichId, rows, summary: (result.summary ?? {}) as Record<string, unknown> }
  }

  /** 读已有的富集结果（重开项目 / 切页面时用） */
  load(enrichId: string): EnrichResultRow[] {
    const root = this.deps.projectStore.getRoot()
    if (!root) return []
    const csvPath = path.join(root, 'results', 'enrich', enrichId, 'enrich_result.csv')
    if (!fs.existsSync(csvPath)) return []
    return this.readRows(fs.readFileSync(csvPath, 'utf-8'))
  }

  /**
   * 生成气泡图。
   *
   * `outPath` 给了就是导出，没给就是预览（返回 dataURL）。
   * 两者走同一个 R 脚本，只差分辨率和输出方式 —— 和火山图/热图一致。
   */
  async plot(
    enrichId: string,
    opts: {
      outPath?: string
      format?: 'png' | 'pdf'
      widthIn: number
      heightIn: number
      dpi?: number
      topN: number
      splitByOntology: boolean
      title?: string
      palette?: string[]
    }
  ): Promise<{ dataUrl?: string; outPath?: string; bytes: number; terms: number; durationMs: number }> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    }
    const dataPath = path.join(root, 'results', 'enrich', enrichId, 'enrich_result.csv')
    if (!fs.existsSync(dataPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到富集结果文件。',
        suggestion: '请重新运行一次富集分析。'
      })
    }

    const preview = !opts.outPath
    const runId = `enrplot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    const workDir = path.join(this.deps.paths.getTempDir(), runId)
    fs.mkdirSync(workDir, { recursive: true })
    const outPath = opts.outPath ?? path.join(workDir, 'enrich_plot.png')

    try {
      const result = await this.deps.runner.run({
        runId,
        scriptRelPath: 'enrich/export_enrich_plot.R',
        config: {
          runId,
          runDir: workDir,
          projectRoot: root,
          params: {
            dataPath,
            outPath,
            format: opts.format ?? 'png',
            widthIn: opts.widthIn,
            heightIn: opts.heightIn,
            dpi: opts.dpi ?? (preview ? 140 : 300),
            topN: opts.topN,
            splitByOntology: opts.splitByOntology,
            title: opts.title ?? '',
            palette: opts.palette ?? ['#f7ca64', '#46bac2', '#7e62a3'],
            skipFonts: preview
          }
        },
        runDir: workDir,
        timeoutMs: RUN_TIMEOUT_MS,
        requiredPackages: ['ggplot2', 'ragg', 'data.table', 'stringr']
      })

      if (!result.ok || !fs.existsSync(outPath)) {
        if (result.stderr) {
          logger.error('enrich', `气泡图失败：\n${result.stderr.slice(-2000)}`)
        }
        throw (
          result.error ??
          toAppError('E_R_GENERIC', { message: '富集气泡图生成失败。' })
        )
      }

      const buffer = fs.readFileSync(outPath)
      const summary = (result.summary ?? {}) as Record<string, unknown>
      return {
        ...(preview ? { dataUrl: `data:image/png;base64,${buffer.toString('base64')}` } : { outPath }),
        bytes: buffer.length,
        terms: Number(summary.terms ?? 0),
        durationMs: Number(summary.durationMs ?? result.durationMs)
      }
    } finally {
      if (preview) {
        try {
          fs.rmSync(workDir, { recursive: true, force: true })
        } catch {
          logger.warn('enrich', `临时目录清理失败：${workDir}`)
        }
      }
    }
  }

  /**
   * 导出富集结果表。
   *
   * ★ 导出的**永远**是 R 侧写出的完整结果表（`enrich_result.csv`），
   *   不是界面上筛选/折叠后的视图。界面上按 P 值筛剩 3 行、导出拿到 41 行
   *   很容易被当成 bug，所以按钮 tooltip 里写明了这一点。
   *
   * csv 走 `fs.copyFile`：结果可能上万行、几十 MB，读进内存再写一遍纯属浪费，
   * 而且 `fs.copyFile` 是内核级复制。行数用**分块**计（不整读文件）。
   */
  async exportTable(opts: {
    enrichId: string
    outPath: string
    format: 'csv' | 'xlsx'
  }): Promise<{ outPath: string; bytes: number; rows: number }> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', { message: '还没有打开项目，无法导出结果表。' })
    }
    const csvPath = path.join(root, 'results', 'enrich', opts.enrichId, 'enrich_result.csv')
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到富集结果文件，无法导出。',
        suggestion: '请重新运行一次富集分析。'
      })
    }
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })

    if (opts.format === 'csv') {
      fs.copyFileSync(csvPath, opts.outPath)
      const stat = fs.statSync(opts.outPath)
      logger.info('enrich', `导出结果表 CSV：${opts.outPath}（${stat.size} 字节）`)
      return { outPath: opts.outPath, bytes: stat.size, rows: countCsvDataRows(csvPath) }
    }

    await writeXlsx(csvPath, opts.outPath)
    const stat = fs.statSync(opts.outPath)
    logger.info('enrich', `导出结果表 XLSX：${opts.outPath}（${stat.size} 字节）`)
    return { outPath: opts.outPath, bytes: stat.size, rows: countCsvDataRows(csvPath) }
  }

  private readRows(text: string): EnrichResultRow[] {
    const records = parseCsv(text) as unknown as RawEnrichRow[]
    return records.map((r) => ({
      id: String(r.term_id ?? ''),
      description: String(r.description ?? r.term_id ?? ''),
      geneRatio: String(r.gene_ratio_text ?? ''),
      bgRatio: String(r.bg_ratio ?? ''),
      pvalue: Number(r.pvalue ?? NaN),
      pAdjust: Number(r.p_adjust ?? NaN),
      qvalue: Number(r.qvalue ?? NaN),
      geneId: String(r.gene_ids ?? ''),
      count: Number(r.count ?? 0),
      source: toSource(String(r.database ?? ''), r.ontology ? String(r.ontology) : null)
    }))
  }
}
