/**
 * 单细胞服务（主进程侧）—— 第 1 步：数据导入与对象构建。
 *
 * ## 为什么扫描不放在 R 里
 *
 * 扫描只需要 `existsSync`，用 R 起进程要 5~8 秒（本项目的 R 启动 + 包检查开销），
 * 而用户点「扫描」时期待的是**立刻**看到样本列表。所以扫描留在主进程，
 * R 只在真正「构建对象」时才启动。
 *
 * ## 为什么构建给 10 分钟
 *
 * 本批数据两份 `matrix.mtx.gz` 各 40 MB（解压后 1660 万非零元），
 * `Read10X` + `CreateSeuratObject` 实测每份十几秒；但客户的其它数据可能是
 * 十几万个细胞，读取 + merge + 写 rds 会到几分钟。10 分钟是「不至于卡死界面、
 * 又不会被正常数据撞上」的折中。
 *
 * ## 对象文件
 *
 * `obj_step1.rds` 落在 `results/scrna/<scrnaId>/`，与图、统计表同目录。
 * 「下载对象」只是 `fs.copyFile` —— 不重新序列化，也不经渲染进程内存。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import { IPC, type IpcEventChannel } from '@shared/ipc'
import type { ProgressMessage } from '@shared/protocol'
import type {
  ScrnaAnnotateMerged,
  ScrnaAnnotatePreviewRequest,
  ScrnaAnnotatePreviewResult,
  ScrnaAnnotateRequest,
  ScrnaAnnotateResult,
  ScrnaCelltypeRow,
  ScrnaCelltypePaletteEntry,
  ScrnaClusterPerSample,
  ScrnaClusterStat,
  ScrnaCustomPlotsRequest,
  ScrnaCustomPlotsResult,
  ScrnaGeneQueryRequest,
  ScrnaGeneQueryResult,
  ScrnaGeneStat,
  ScrnaEmbedRequest,
  ScrnaEmbedResult,
  ScrnaExportTemplateRequest,
  ScrnaSingleRRequest,
  ScrnaSingleRResult,
  ScrnaSingleRSuggestion,
  ScrnaExportMarkersRequest,
  ScrnaExportMarkersResult,
  ScrnaMarkerCluster,
  ScrnaMarkerTop,
  ScrnaMarkersTableRequest,
  ScrnaMarkersTableResult,
  ScrnaMarkersRequest,
  ScrnaMarkersResult,
  ScrnaExportObjectResult,
  ScrnaFilterPerSample,
  ScrnaFilterResult,
  ScrnaImportObjectRequest,
  ScrnaImportObjectResult,
  ScrnaImportRequest,
  ScrnaImportResult,
  ScrnaInspectRequest,
  ScrnaInspectResult,
  ScrnaObjectFile,
  ScrnaPerSampleStat,
  ScrnaPlotImage,
  ScrnaPrepPerSample,
  ScrnaPrepRequest,
  ScrnaPrepResult,
  ScrnaQcRequest,
  ScrnaQcResult,
  ScrnaQcSampleStat,
  ScrnaQcThresholds,
  ScrnaSampleOverlap,
  ScrnaScanResult,
  ScrnaScanSample
} from '@shared/types/scrna'
import { logger } from '../logger'
import type { LogMsg, RRunner, RunRResult } from '../process/RProcessRunner'
import { countCsvDataRows, parseCsv, writeXlsx } from '../util/csv'
import { copyAllFigures, copyFigure } from '../util/figureExport'
import { scanSamples } from './scanSamples'

const IMPORT_TIMEOUT_MS = 10 * 60 * 1000
/**
 * QC / 过滤给 20 分钟：percent.mt 要遍历整个稀疏矩阵，几十万细胞时是分钟级；
 * 而这一步本来就不该像建对象那样卡在 10 分钟边上。
 */
const QC_TIMEOUT_MS = 20 * 60 * 1000
/**
 * 第 3 步给 30 分钟：harmony 在 2.6 万细胞上实测 39 s，但客户的数据可能是十万级；
 * 这一步还包含 ScaleData + RunPCA，整体比 QC 重得多。
 */
const PREP_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 第 4 步给 40 分钟：tSNE 在 2.6 万细胞上实测 81 s，但十万级细胞会到十几分钟；
 * UMAP 与 tSNE 都是「数据量一涨就非线性变慢」的那类。
 */
const EMBED_TIMEOUT_MS = 40 * 60 * 1000
/** 第 5 步给 60 分钟：FindAllMarkers 是分钟级，细胞/cluster 一多就十几分钟 */
const MARKERS_TIMEOUT_MS = 60 * 60 * 1000
/**
 * 第 6 步给 30 分钟：人工注释只是「读 rds + 改一列 + 出三张图」，正常几十秒；
 * SingleR 那条路要读参考集（几百 MB 到 1 GB 的 rds），在大对象上会到分钟级。
 * 两者共用一个上限，取宽的那个。
 */
const ANNOTATE_TIMEOUT_MS = 30 * 60 * 1000
const SCRNA_PACKAGES = ['Seurat', 'Matrix']
/**
 * 第 3 步要 harmony 做批次校正。
 *
 * ★ `RhpcBLASctl` 必须一起列：它只在 harmony 的 **Suggests** 里，
 *   装 harmony 时不会被带上；`requireNamespace("harmony")` 是 TRUE（命名空间能加载），
 *   所以只查 harmony 会放行，然后跑到 harmony 真调用 `RhpcBLASctl::blas_get_num_procs()`
 *   时才炸 —— 客户机器上就是这么失败的（跑满 44 秒后报「不存在叫 RhpcBLASctl 这个名字的程辑包」）。
 */
const PREP_PACKAGES = ['Seurat', 'Matrix', 'harmony', 'RhpcBLASctl']

export interface ScrnaServiceDeps {
  runner: RRunner
  projectStore: { getRoot(): string | null }
  /** 主进程 → 渲染进程的单向事件（进度/日志），由 handler 传 `app.emit` 进来 */
  emit: (channel: IpcEventChannel, payload: unknown) => void
}

function newScrnaId(): string {
  return `scrna-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** `auto_unbox` 塌缩的兜底：拿到的永远是数组 */
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value == null) return []
  return [value as T]
}

/**
 * 从 summary 里读回阈值。null 与「字段缺失」都表示「这条没启用」；
 * R 侧用 NULL 发出去时 JSON 里没有这个键，所以两种都要当 null 处理。
 */
function readThresholds(summary: Record<string, unknown>): ScrnaQcThresholds {
  const pick = (key: string): number | null => {
    const v = summary[key]
    if (v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return { minFeature: pick('minFeature'), minCount: pick('minCount'), maxMt: pick('maxMt') }
}

/** 读 png 成 data URL；缺图不报错（图失败不该让整次导入失败） */
function readPlotDataUrl(runDir: string, file: string): string | null {
  if (!file) return null
  const p = path.join(runDir, file)
  if (!fs.existsSync(p)) {
    logger.warn('scrna', `图未生成：${file}（不影响对象构建）`)
    return null
  }
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
}

/**
 * cluster 名排序：纯数字按数值（`0, 1, 2, 10`），否则按字典序。
 *
 * 和第 4/5 步 R 侧的 `.scrna_order_clusters()` 保持一致 —— 界面上表格的行序
 * 与 UMAP 图例的顺序不一致，是最容易被当成 bug 的那种不一致。
 */
function compareCluster(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const aNum = Number.isFinite(na) && a.trim() !== ''
  const bNum = Number.isFinite(nb) && b.trim() !== ''
  if (aNum && bNum) return na - nb
  if (aNum) return -1
  if (bNum) return 1
  return a.localeCompare(b)
}

/** 读 cluster_summary.csv（cluster,cells）。文件缺失返回空 Map，不抛错。 */
function readClusterSizes(file: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!fs.existsSync(file)) return out
  for (const row of parseCsv(fs.readFileSync(file, 'utf-8'))) {
    const cluster = String(row.cluster ?? '').trim()
    if (!cluster) continue
    out.set(cluster, num(row.cells))
  }
  return out
}

/** 读 markers_top10.csv → cluster → [{gene, avgLog2FC}]（保持文件里的降序） */
function readTop10(file: string): Map<string, { gene: string; avgLog2FC: number }[]> {
  const out = new Map<string, { gene: string; avgLog2FC: number }[]>()
  if (!fs.existsSync(file)) return out
  for (const row of parseCsv(fs.readFileSync(file, 'utf-8'))) {
    const cluster = String(row.cluster ?? '').trim()
    const gene = String(row.gene ?? '').trim()
    if (!cluster || !gene) continue
    const list = out.get(cluster) ?? []
    list.push({ gene, avgLog2FC: num(row.avg_log2FC) })
    out.set(cluster, list)
  }
  return out
}

/**
 * 解析注释表 —— 规则与 `r/scrna/run_scrna_annotate.R` 的 `.scrna_read_annotation()`
 * **必须一致**（分隔符、表头识别、空行），否则「预览里对得上、应用时对不上」。
 *
 * 客户给的 `07.clusterAnn.txt` 是两列、制表符、无表头；这里也接受带表头与逗号分隔。
 */
function readAnnotationTable(file: string): { cluster: string; celltype: string }[] {
  if (!file || !fs.existsSync(file)) {
    throw toAppError('E_DATA_EMPTY', {
      message: '注释表文件不存在。',
      suggestion: '请重新选择一张注释表（两列：cluster、细胞类型）。'
    })
  }
  const lines = fs
    .readFileSync(file, 'utf-8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
  if (lines.length === 0) {
    throw toAppError('E_DATA_EMPTY', {
      message: '注释表是空的。',
      suggestion: '表里至少要有「簇 + 细胞类型」两列。'
    })
  }
  const sep = lines[0].includes('\t') ? '\t' : ','
  const cells = lines.map((l) => l.split(sep).map((c) => c.trim()))
  const first = cells[0]
  const hasHeader =
    first.length >= 2 &&
    /cluster/i.test(first[0]) &&
    /cell|label|type|细胞/i.test(first[1])
  const body = hasHeader ? cells.slice(1) : cells
  if (body.length === 0) {
    throw toAppError('E_DATA_EMPTY', {
      message: '注释表只有表头，没有数据行。',
      suggestion: '请在表头下面补上「簇 + 细胞类型」。'
    })
  }
  return body.map((c) => ({ cluster: c[0] ?? '', celltype: c[1] ?? '' }))
}


/** 把 R 的 inspect summary 掰成前端要的形状 */
function summarizeInspect(
  summary: Record<string, unknown> | undefined,
  input: ScrnaInspectRequest
): ScrnaInspectResult {
  const s = summary ?? {}
  const readyFor = (s.readyFor ?? {}) as Record<string, unknown>
  return {
    path: input.path,
    nCells: num(s.nCells),
    nGenes: num(s.nGenes),
    reductions: toArray<string>(s.reductions).map(String),
    hasClusters: s.hasClusters === true,
    clusterColumn: String(s.clusterColumn ?? ''),
    clusterSizes: toArray<Record<string, unknown>>(s.clusterSizes).map((row) => ({
      cluster: String(row.cluster ?? ''),
      cells: num(row.cells)
    })),
    hasVariableFeatures: s.hasVariableFeatures === true,
    nVariableFeatures: num(s.nVariableFeatures),
    hasScaleData: s.hasScaleData === true,
    scaleRows: num(s.scaleRows),
    suggestedReduction: String(s.suggestedReduction ?? ''),
    suggestedNpcs: num(s.suggestedNpcs),
    strain:
      s.strain === 'human' ? 'human' : s.strain === 'mouse' ? 'mouse' : 'other',
    targetStep: input.targetStep,
    ok: s.ok === true,
    readyFor: {
      '4': readyFor['4'] === true,
      '5': readyFor['5'] === true,
      '6': readyFor['6'] === true
    },
    missing: toArray<string>(s.missing).map(String),
    message: String(s.message ?? ''),
    durationMs: num(s.durationMs)
  }
}
export class ScrnaService {
  constructor(private readonly deps: ScrnaServiceDeps) {}

  /**
   * 扫描根目录下的样本（纯文件系统操作，不起 R）。
   *
   * 不打开任何矩阵文件 —— 用户点一下就要看到列表。
   */
  scanDir(rootDir: string): ScrnaScanResult {
    const started = Date.now()
    if (!rootDir || !fs.existsSync(rootDir)) {
      throw toAppError('E_DATA_EMPTY', {
        message: `目录不存在：${path.basename(rootDir || '')}`,
        suggestion: '请重新选择一个包含 10x 矩阵的目录。'
      })
    }
    if (!fs.statSync(rootDir).isDirectory()) {
      throw toAppError('E_VALIDATION', {
        message: '请选择一个目录，而不是文件。',
        suggestion: '10x 数据是一个目录（内含 matrix.mtx / barcodes / genes 或 features）。'
      })
    }

    const { samples, scannedDirs } = scanSamples(rootDir)
    logger.info(
      'scrna',
      `扫描 ${rootDir}：遍历 ${scannedDirs} 个目录，找到 ${samples.length} 个样本`
    )
    return {
      rootDir,
      samples: samples as ScrnaScanSample[],
      scannedDirs,
      elapsedMs: Date.now() - started
    }
  }

  /** 构建 Seurat 对象（起 R，10 分钟超时） */
  async import(input: ScrnaImportRequest): Promise<ScrnaImportResult> {
    const root = this.requireRoot()
    if (!input.rootDir || !fs.existsSync(input.rootDir)) {
      throw toAppError('E_DATA_EMPTY', { message: '根目录不存在，请重新选择。' })
    }
    if (!input.samples || input.samples.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有选择样本。',
        suggestion: '先扫描目录并勾选要导入的样本。'
      })
    }
    const names = input.samples.map((s) => s.name.trim())
    if (names.some((n) => !n)) {
      throw toAppError('E_VALIDATION', {
        message: '样本名不能为空。',
        suggestion: '请给每个样本填一个名字（会作为分组名 orig.ident）。'
      })
    }
    if (new Set(names).size !== names.length) {
      throw toAppError('E_VALIDATION', {
        message: '样本名重复了。',
        suggestion: '每个样本需要有唯一的名字，否则合并后无法区分。'
      })
    }

    const scrnaId = newScrnaId()
    const runDir = path.join(root, 'results', 'scrna', scrnaId)
    fs.mkdirSync(runDir, { recursive: true })

    const config = {
      runId: scrnaId,
      runDir,
      projectRoot: root,
      params: {
        dataDir: input.rootDir,
        samples: input.samples.map((s) => ({ name: s.name.trim(), dir: s.dir })),
        skipFonts: true
      }
    }

    logger.info(
      'scrna',
      `启动单细胞导入 ${scrnaId}: ${input.samples.length} 个样本（${names.join(', ')}）`
    )

    const result = await this.deps.runner.run({
      runId: scrnaId,
      scriptRelPath: 'scrna/run_scrna_import.R',
      config,
      runDir,
      timeoutMs: IMPORT_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(scrnaId, p),
      onLog: (l) => this.emitLog(scrnaId, l)
    })
    this.ensureOk(result, '单细胞数据导入')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    const objectPath = path.join(runDir, 'obj_step1.rds')
    if (!fs.existsSync(objectPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: 'R 报告成功，但没有写出 obj_step1.rds。',
        suggestion: '请展开原始日志查看详情。'
      })
    }

    const perSample = toArray<Record<string, unknown>>(summary.perSample).map(
      (row): ScrnaPerSampleStat => ({
        sample: String(row.sample ?? ''),
        cells: num(row.cells),
        genesMedian: num(row.genesMedian)
      })
    )

    const payload: ScrnaImportResult = {
      scrnaId,
      runDir,
      nSamples: num(summary.nSamples, input.samples.length),
      nCells: num(summary.nCells),
      nGenes: num(summary.nGenes),
      perSample,
      filteredByMinFeatures:
        summary.filteredByMinFeatures == null ? null : num(summary.filteredByMinFeatures),
      sampleOverlap: toArray<Record<string, unknown>>(summary.sampleOverlap).map(
        (row): ScrnaSampleOverlap => ({
          a: String(row.a ?? ''),
          b: String(row.b ?? ''),
          overlap: num(row.overlap),
          shared: num(row.shared),
          smaller: num(row.smaller)
        })
      ),
      minCells: num(summary.minCells, 3),
      minFeatures: num(summary.minFeatures, 100),
      plotDataUrl: readPlotDataUrl(runDir, String(summary.plotFile ?? '')),
      objectPath,
      durationMs: num(summary.durationMs, result.durationMs),
      summary
    }

    fs.writeFileSync(
      path.join(runDir, 'import.json'),
      JSON.stringify({ ...payload, plotDataUrl: null }, null, 2),
      'utf8'
    )
    return payload
  }

  /**
   * 第 2 步 · 段 A：QC 分布预览（**只画图，不删细胞**）。
   *
   * 阈值在这里只用来「画阈值线 + 算能过多少」，对象原样存回 obj_qc.rds。
   * 用户改阈值后重跑这一步即可（几秒到几十秒），不需要重建对象。
   */
  async qc(input: ScrnaQcRequest): Promise<ScrnaQcResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const step1 = path.join(runDir, 'obj_step1.rds')
    if (!fs.existsSync(step1)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 1 步的对象（obj_step1.rds）。',
        suggestion: '请先完成「数据导入与对象构建」。'
      })
    }

    const result = await this.runQcScript(input.scrnaId, runDir, root, 'scrna/run_scrna_qc.R', {
      objectFile: 'obj_step1.rds',
      minFeature: input.thresholds.minFeature,
      minCount: input.thresholds.minCount,
      maxMt: input.thresholds.maxMt
    })
    this.ensureOk(result, '单细胞质控（预览）')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      nCells: num(summary.nCells),
      nGenes: num(summary.nGenes),
      mtGeneCount: num(summary.mtGeneCount),
      mtExamples: toArray<string>(summary.mtExamples).map(String),
      qcSummary: toArray<Record<string, unknown>>(summary.qcSummary).map(
        (row): ScrnaQcSampleStat => ({
          sample: String(row.sample ?? ''),
          cells: num(row.cells),
          medianFeature: num(row.medianFeature),
          medianCount: num(row.medianCount),
          // R 侧在没有 mt 基因时给 NA_real_ → JSON 里是 null
          medianMt: row.medianMt == null ? null : num(row.medianMt),
          passFeature: num(row.passFeature),
          passCount: num(row.passCount),
          passMt: num(row.passMt),
          passAll: num(row.passAll)
        })
      ),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      thresholds: readThresholds(summary),
      objectPath: path.join(runDir, 'obj_qc.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /** 第 2 步 · 段 B：按阈值真正过滤，产出 obj_step2.rds 与前后对比 */
  async filter(input: ScrnaQcRequest): Promise<ScrnaFilterResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const qcObj = path.join(runDir, 'obj_qc.rds')
    if (!fs.existsSync(qcObj)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到 QC 对象（obj_qc.rds）。',
        suggestion: '请先点「① 预览分布」，看过分布再应用过滤。'
      })
    }

    const result = await this.runQcScript(input.scrnaId, runDir, root, 'scrna/run_scrna_filter.R', {
      objectFile: 'obj_qc.rds',
      minFeature: input.thresholds.minFeature,
      minCount: input.thresholds.minCount,
      maxMt: input.thresholds.maxMt
    })
    this.ensureOk(result, '单细胞过滤')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    const plots = toArray<Record<string, unknown>>(summary.plots)
    return {
      scrnaId: input.scrnaId,
      cellsBefore: num(summary.cellsBefore),
      cellsAfter: num(summary.cellsAfter),
      removed: num(summary.removed),
      removedPct: num(summary.removedPct),
      perSample: toArray<Record<string, unknown>>(summary.perSample).map(
        (row): ScrnaFilterPerSample => ({
          sample: String(row.sample ?? ''),
          before: num(row.before),
          after: num(row.after)
        })
      ),
      emptySamples: toArray<string>(summary.emptySamples).map(String),
      thresholds: readThresholds(summary),
      mtFilterApplied: summary.mtFilterApplied !== false,
      plotDataUrl: readPlotDataUrl(runDir, String(plots[0]?.file ?? 'p05_filter_before_after.png')),
      summaryCsvPath: path.join(runDir, 'qc_summary.csv'),
      objectPath: path.join(runDir, 'obj_step2.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /** QC 与过滤共用同一套「起 R + 超时 + 进度日志」的调用 */
  private async runQcScript(
    runId: string,
    runDir: string,
    projectRoot: string,
    scriptRelPath: string,
    params: Record<string, unknown>
  ): Promise<RunRResult> {
    logger.info('scrna', `启动 ${scriptRelPath}（${runId}）`)
    return this.deps.runner.run({
      runId,
      scriptRelPath,
      config: { runId, runDir, projectRoot, params: { ...params, skipFonts: true } },
      runDir,
      timeoutMs: QC_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(runId, p),
      onLog: (l) => this.emitLog(runId, l)
    })
  }

  /**
   * 只读检查：这个 .rds 能不能作为第 4/5/6 步的输入。
   *
   * 走 R 而不是在主进程读 rds（Node 读不了 R 的序列化格式），但**只读不落盘**，
   * 3 秒左右出结果 —— 用户选完文件要立刻看到「能不能用、缺什么」。
   */
  async inspectObject(input: ScrnaInspectRequest): Promise<ScrnaInspectResult> {
    const root = this.requireRoot()
    if (!input.path || !fs.existsSync(input.path)) {
      throw toAppError('E_DATA_EMPTY', {
        message: `文件不存在：${path.basename(input.path || '')}`,
        suggestion: '请重新选择 .rds 文件。'
      })
    }
    // 只读检查也需要一个 runDir 放日志/事件；放在 _inspect 下，不污染真实 run
    const inspectDir = path.join(root, 'results', 'scrna', '_inspect')
    fs.mkdirSync(inspectDir, { recursive: true })

    const result = await this.deps.runner.run({
      runId: 'scrna-inspect',
      scriptRelPath: 'scrna/run_scrna_inspect.R',
      config: {
        runId: 'scrna-inspect',
        runDir: inspectDir,
        projectRoot: root,
        params: { path: input.path, targetStep: input.targetStep, skipFonts: true }
      },
      runDir: inspectDir,
      timeoutMs: 5 * 60 * 1000,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: () => undefined,
      onLog: () => undefined
    })
    this.ensureOk(result, '读取对象')
    return summarizeInspect(result.summary, input)
  }

  /**
   * 把外部对象落到当前 run 目录，作为目标步骤的输入文件。
   *
   * 落盘规则（文件名必须对上各脚本的 `objectFile` 默认值）：
   *   目标 4 → obj_step3.rds   目标 5 → obj_step4.rds   目标 6 → obj_step5.rds
   *
   * ★ `scrnaId` 省略时**新建一个 run**：客户可能根本没在本工具里跑过第 1 步，
   *   直接从第 4 步开始 —— 不能强制他先造一个 run。
   */
  async importObject(input: ScrnaImportObjectRequest): Promise<ScrnaImportObjectResult> {
    const root = this.requireRoot()
    const summary = await this.inspectObject({ path: input.path, targetStep: input.targetStep })
    if (!summary.ok) {
      throw toAppError('E_RESULT_INVALID', {
        message: summary.message,
        suggestion:
          input.targetStep === 4
            ? '这个对象缺少降维结果，请改从第 3 步开始（或用带 pca/harmony 的对象）。'
            : '这个对象缺少聚类结果，请改从第 4 步开始（或先完成聚类）。'
      })
    }

    const fileForStep: Record<number, string> = {
      4: 'obj_step3.rds',
      5: 'obj_step4.rds',
      6: 'obj_step5.rds'
    }
    const importedAs = fileForStep[input.targetStep]
    const scrnaId = input.scrnaId ?? newScrnaId()
    const runDir = path.join(root, 'results', 'scrna', scrnaId)
    fs.mkdirSync(runDir, { recursive: true })
    fs.copyFileSync(input.path, path.join(runDir, importedAs))

    const importedAt = new Date().toISOString()
    fs.writeFileSync(
      path.join(runDir, 'imported.json'),
      JSON.stringify(
        {
          sourcePath: input.path,
          importedAt,
          targetStep: input.targetStep,
          nCells: summary.nCells,
          nGenes: summary.nGenes,
          importedAs
        },
        null,
        2
      ),
      'utf8'
    )
    // 顺手补一份 cluster_summary.csv：第 6 步的填表界面靠它显示「每簇多少细胞」。
    // 从 obj_step5.rds 直接开始的情况下 runDir 里没有第 4 步的这份文件，不补就得
    // 为了一个数字再起一次 R。已有同名文件时不覆盖（那是第 4 步的真实产物）。
    const clusterCsv = path.join(runDir, 'cluster_summary.csv')
    if (!fs.existsSync(clusterCsv) && summary.clusterSizes.length > 0) {
      const lines = ['cluster,cells']
      for (const row of summary.clusterSizes) lines.push(`${row.cluster},${row.cells}`)
      fs.writeFileSync(clusterCsv, `${lines.join('\n')}\n`, 'utf8')
    }

    logger.info('scrna', `导入外部对象：${input.path} → ${scrnaId}/${importedAs}`)
    return { scrnaId, runDir, importedAs, importedAt, summary }
  }

  /**
   * 第 5 步：各簇 marker 基因（FindAllMarkers + 二次筛选 + top10 + 三组图）。
   *
   * `min.pct` 写死 0.25（客户脚本的值），不进请求参数、界面只读。
   */
  async markers(input: ScrnaMarkersRequest): Promise<ScrnaMarkersResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    if (!fs.existsSync(path.join(runDir, 'obj_step4.rds'))) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 4 步的对象（obj_step4.rds）。',
        suggestion: '请先完成「聚类 · UMAP · tSNE」。'
      })
    }

    logger.info(
      'scrna',
      `启动 scrna/run_scrna_markers.R（${input.scrnaId}，` +
        `logFC=${input.logfcThreshold}，padj=${input.adjPvalFilter}）`
    )
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_markers.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step4.rds',
          logfcThreshold: input.logfcThreshold,
          adjPvalFilter: input.adjPvalFilter,
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: MARKERS_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '单细胞 marker 基因')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      nCells: num(summary.nCells),
      nClusters: num(summary.nClusters),
      clusters: toArray<string>(summary.clusters).map(String),
      minPct: num(summary.minPct, 0.25),
      logfcThreshold: num(summary.logfcThreshold, input.logfcThreshold),
      adjPvalFilter: num(summary.adjPvalFilter, input.adjPvalFilter),
      totalMarkers: num(summary.totalMarkers),
      sigMarkers: num(summary.sigMarkers),
      findSeconds: num(summary.findSeconds),
      perCluster: toArray<Record<string, unknown>>(summary.perCluster).map(
        (row): ScrnaMarkerCluster => ({
          cluster: String(row.cluster ?? ''),
          cells: num(row.cells),
          sigCount: num(row.sigCount),
          top10: toArray<Record<string, unknown>>(row.top10).map(
            (t): ScrnaMarkerTop => ({
              gene: String(t.gene ?? ''),
              avgLog2FC: num(t.avgLog2FC),
              pvalAdj: num(t.pvalAdj),
              pct1: num(t.pct1),
              pct2: num(t.pct2)
            })
          )
        })
      ),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      sigCsvPath: path.join(runDir, 'markers_sig.csv'),
      top10CsvPath: path.join(runDir, 'markers_top10.csv'),
      objectPath: path.join(runDir, 'obj_step5.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /**
   * 按条件查 marker 表（服务端过滤 + 分页）。
   *
   * 为什么不在 summary 里把所有行都发给界面：一次 FindAllMarkers 可能几万行，
   * 全量塞进 IPC 返回值会让界面卡死；而且「搜索某个基因」必须在**全表**上搜，
   * 只对 top10 搜等于没搜。所以查询放主进程，一次读 csv + 过滤 + 切页。
   */
  markersTable(input: ScrnaMarkersTableRequest): ScrnaMarkersTableResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const csv = path.join(runDir, 'markers_sig.csv')
    if (!fs.existsSync(csv)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到 markers_sig.csv。',
        suggestion: '请先完成「计算 Marker」。'
      })
    }
    const all = parseCsv(fs.readFileSync(csv, 'utf-8'))
    const cluster = input.cluster?.trim() ?? ''
    const search = input.search?.trim().toLowerCase() ?? ''
    const filtered = all.filter((r) => {
      if (cluster && String(r.cluster ?? '') !== cluster) return false
      if (search && !String(r.gene ?? '').toLowerCase().includes(search)) return false
      return true
    })
    const offset = Math.max(0, input.offset)
    const limit = Math.max(1, Math.min(2000, input.limit))
    return {
      rows: filtered.slice(offset, offset + limit).map((r) => ({
        cluster: String(r.cluster ?? ''),
        gene: String(r.gene ?? ''),
        avgLog2FC: num(r.avg_log2FC),
        pval: num(r.p_val),
        pvalAdj: num(r.p_val_adj),
        pct1: num(r['pct.1']),
        pct2: num(r['pct.2'])
      })),
      matched: filtered.length,
      total: all.length
    }
  }

  /**
   * 导出 marker 表。
   *
   * csv 直接复制（几十万行，`fs.copyFileSync` 不读内存）；xlsx 用项目已有的 exceljs 从 csv 生成。
   * 导出的一定是**全量表**，不是界面上「只显示 top10」的那几十行。
   */
  async exportMarkers(input: ScrnaExportMarkersRequest): Promise<ScrnaExportMarkersResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const name = input.table === 'sig' ? 'markers_sig.csv' : 'markers_top10.csv'
    const src = path.join(runDir, name)
    if (!fs.existsSync(src)) {
      throw toAppError('E_RESULT_INVALID', {
        message: `找不到 ${name}。`,
        suggestion: '请先完成「计算 Marker」。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })
    if (input.format === 'csv') {
      fs.copyFileSync(src, input.outPath)
    } else {
      await writeXlsx(src, input.outPath, 'markers')
    }
    return {
      outPath: input.outPath,
      bytes: fs.statSync(input.outPath).size,
      rows: countCsvDataRows(src)
    }
  }

  /**
   * 第 4 步：聚类 + UMAP + tSNE。
   *
   * reduction 名与 dims 都由对象自己带（第 3 步写进 `misc`）——
   * 这里不判断样本数，避免两处判断分叉。
   */
  async embed(input: ScrnaEmbedRequest): Promise<ScrnaEmbedResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const step3 = path.join(runDir, 'obj_step3.rds')
    if (!fs.existsSync(step3)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 3 步的对象（obj_step3.rds）。',
        suggestion: '请先完成「标准化 · PCA · 批次校正」。'
      })
    }

    logger.info('scrna', `启动 scrna/run_scrna_embed.R（${input.scrnaId}）`)
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_embed.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step3.rds',
          resolution: input.resolution,
          ...(input.dims == null ? {} : { nPcs: input.dims }),
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: EMBED_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '单细胞聚类与降维')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      nCells: num(summary.nCells),
      nClusters: num(summary.nClusters),
      resolution: num(summary.resolution, input.resolution),
      dims: num(summary.dims),
      activeReduction: summary.activeReduction === 'harmony' ? 'harmony' : 'pca',
      reductions: toArray<string>(summary.reductions).map(String),
      clusterColumn: String(summary.clusterColumn ?? 'clusters'),
      perCluster: toArray<Record<string, unknown>>(summary.perCluster).map(
        (row): ScrnaClusterStat => ({
          cluster: String(row.cluster ?? ''),
          cells: num(row.cells),
          perSample: toArray<Record<string, unknown>>(row.perSample).map(
            (ps): ScrnaClusterPerSample => ({
              sample: String(ps.sample ?? ''),
              cells: num(ps.cells)
            })
          )
        })
      ),
      umapSeconds: num(summary.umapSeconds),
      tsneSeconds: num(summary.tsneSeconds),
      clusterSeconds: num(summary.clusterSeconds),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      summaryCsvPath: path.join(runDir, 'cluster_summary.csv'),
      objectPath: path.join(runDir, 'obj_step4.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /**
   * 「下载当前对象」：把 obj_step1.rds 复制到用户选的位置。
   *
   * 复制而不是另存：rds 可能上百 MB，重新序列化既要内存又慢，
   * 而内容与文件里的完全一致。
   */
  exportObject(scrnaId: string, outPath: string, file?: ScrnaObjectFile): ScrnaExportObjectResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', scrnaId)
    // 白名单：文件名由这里拼，绝不接受调用方传路径
    const name = `${file ?? 'obj_step1'}.rds`
    const src = path.join(runDir, name)
    if (!fs.existsSync(src)) {
      throw toAppError('E_RESULT_INVALID', {
        message: `找不到对象文件（${name}）。`,
        suggestion: '请先完成对应的步骤。'
      })
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.copyFileSync(src, outPath)
    const bytes = fs.statSync(outPath).size
    logger.info('scrna', `导出对象：${outPath}（${bytes} 字节）`)
    return { outPath, bytes, runDir }
  }

  /**
   * 第 3 步：标准化 → 高变基因 → ScaleData → PCA → 批次校正（harmony）。
   *
   * 单样本时 R 侧会跳过 harmony，`activeReduction` 返回 `"pca"` ——
   * 这不是失败路径，界面要按正常结果展示（只提示「已跳过批次校正」）。
   */
  async prep(input: ScrnaPrepRequest): Promise<ScrnaPrepResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const step2 = path.join(runDir, 'obj_step2.rds')
    if (!fs.existsSync(step2)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 2 步的对象（obj_step2.rds）。',
        suggestion: '请先完成「质控与过滤」并应用过滤。'
      })
    }

    logger.info('scrna', `启动 scrna/run_scrna_prep.R（${input.scrnaId}）`)
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_prep.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step2.rds',
          nFeatures: input.nFeatures,
          nPcs: input.nPcs,
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: PREP_TIMEOUT_MS,
      requiredPackages: PREP_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '单细胞标准化与降维')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      nCells: num(summary.nCells),
      nGenes: num(summary.nGenes),
      nSamples: num(summary.nSamples),
      perSample: toArray<Record<string, unknown>>(summary.perSample).map(
        (row): ScrnaPrepPerSample => ({ sample: String(row.sample ?? ''), cells: num(row.cells) })
      ),
      nFeatures: num(summary.nFeatures, input.nFeatures),
      nHVG: num(summary.nHVG),
      nPcs: num(summary.nPcs, input.nPcs),
      harmonyApplied: summary.harmonyApplied === true,
      harmonySeconds: num(summary.harmonySeconds),
      // R 侧是唯一判定点；这里只做兜底（万一字段缺失，按 pca 处理，下游至少不会崩）
      activeReduction: summary.activeReduction === 'harmony' ? 'harmony' : 'pca',
      // ★ 单样本时 R 只给一个 reduction 名，auto_unbox 会把它塌成字符串
      reductions: toArray<string>(summary.reductions).map(String),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      objectPath: path.join(runDir, 'obj_step3.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /** 导出第 2 步的统计表（qc_summary.csv）。同样是复制，不重新生成。 */
  exportSummary(
    scrnaId: string,
    outPath: string,
    file: 'qc_summary' | 'cluster_summary' | 'celltype_annotation' = 'qc_summary'
  ): ScrnaExportObjectResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', scrnaId)
    const name = `${file}.csv`
    const src = path.join(runDir, name)
    if (!fs.existsSync(src)) {
      throw toAppError('E_RESULT_INVALID', {
        message: `找不到 ${name}。`,
        suggestion:
          file === 'qc_summary'
            ? '请先完成「② 应用过滤」。'
            : file === 'cluster_summary'
              ? '请先完成「运行聚类与降维」。'
              : '请先完成「应用注释」。'
      })
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.copyFileSync(src, outPath)
    return { outPath, bytes: fs.statSync(outPath).size, runDir }
  }

  /* ---------------------------------------------------------------- *
   * 第 6 步：细胞注释
   * ---------------------------------------------------------------- */

  /**
   * 第 6 步**预览**（不起 R）。
   *
   * 界面要的是一张「簇 / 细胞数 / top10 / 细胞类型输入框」的表。这些数据第 5 步
   * 已经落在盘上了（`cluster_summary.csv` 的细胞数 + `markers_top10.csv` 的 top10），
   * 为了拼这张表再起一次 R 去读 200 MB 的 rds 是让用户白等 40 秒 —— 而这一步
   * 本来只是「填表」，用户填十次才点一次应用。
   *
   * 注释表（客户 `07.clusterAnn.txt` 那种两列无表头）在这里就解析并**立刻对账**，
   * 而不是等用户点应用再报错：填表时就能看到「文件里的 12 在对象里不存在」。
   */
  annotatePreview(input: ScrnaAnnotatePreviewRequest): ScrnaAnnotatePreviewResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)

    const cellsOf = readClusterSizes(path.join(runDir, 'cluster_summary.csv'))
    const topOf = readTop10(path.join(runDir, 'markers_top10.csv'))

    // 簇列表以 cluster_summary.csv 为准（它由第 4 步写成，是「对象里有哪些簇」的真源）；
    // 该文件缺失时退回 top10 的簇（用户可能只导入了 obj_step4.rds 还没跑第 5 步）
    const clusters = cellsOf.size > 0 ? [...cellsOf.keys()] : [...topOf.keys()]
    if (clusters.length === 0) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到聚类结果（cluster_summary.csv / markers_top10.csv 都不存在）。',
        suggestion: '请先完成「聚类 · UMAP · tSNE」，或从已有的 obj_step4.rds 导入后继续。'
      })
    }
    clusters.sort(compareCluster)

    const rows: ScrnaCelltypeRow[] = clusters.map((cluster) => ({
      cluster,
      cells: cellsOf.get(cluster) ?? 0,
      celltype: '',
      top10: (topOf.get(cluster) ?? []).slice(0, 10)
    }))

    const imported: { cluster: string; celltype: string }[] = []
    let diff: { missing: string[]; extra: string[] } = { missing: [], extra: [] }
    if (input.annotationFile) {
      const mapping = readAnnotationTable(input.annotationFile)
      for (const m of mapping) imported.push(m)
      const byCluster = new Map(mapping.map((m) => [m.cluster, m.celltype]))
      for (const r of rows) r.celltype = byCluster.get(r.cluster) ?? ''
      // 只做「文件对不上对象」的提示，不在这里报错 —— 用户还能手工改
      diff = {
        missing: clusters.filter((c) => !byCluster.has(c)),
        extra: mapping.map((m) => m.cluster).filter((c) => !clusters.includes(c))
      }
    }

    // 样本名只用于界面提示（第 1 步写下的 sample_stats.csv；外部导入的对象没有）
    const sampleCsv = path.join(runDir, 'sample_stats.csv')
    const samples = fs.existsSync(sampleCsv)
      ? parseCsv(fs.readFileSync(sampleCsv, 'utf-8'))
          .map((row) => String(row.sample ?? '').trim())
          .filter((x) => x.length > 0)
      : []

    return { clusters, samples, rows, imported, diff }
  }

  /**
   * 导出注释模板：两列（cluster / celltype）、制表符、**无表头**。
   *
   * 格式故意和客户的 `07.clusterAnn.txt` 一模一样 —— 他填完直接能回填到自己的
   * 脚本里，不必再转格式；而「导入注释表」也认这个格式，一来一回闭环。
   */
  exportTemplate(input: ScrnaExportTemplateRequest): ScrnaExportObjectResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    const cellsOf = readClusterSizes(path.join(runDir, 'cluster_summary.csv'))
    const topOf = readTop10(path.join(runDir, 'markers_top10.csv'))
    const clusters = (cellsOf.size > 0 ? [...cellsOf.keys()] : [...topOf.keys()]).sort(compareCluster)
    if (clusters.length === 0) {
      throw toAppError('E_RESULT_INVALID', {
        message: '还没有聚类结果，无法导出注释模板。',
        suggestion: '请先完成「聚类 · UMAP · tSNE」。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })
    // 写 UTF-8 无 BOM：带 BOM 时客户的 R 脚本 read.table 会把第一列名前面多一个 \ufeff
    fs.writeFileSync(input.outPath, `${clusters.map((c) => `${c}\t`).join('\n')}\n`, 'utf8')
    return { outPath: input.outPath, bytes: fs.statSync(input.outPath).size, runDir }
  }

  /**
   * 第 6 步·A：**人工注释**（客户的路径 —— 水稻走不了 SingleR）。
   *
   * `assignments`（界面表格）与 `annotationFile`（导入的表）二选一，同时给时
   * 以文件为准（R 侧就是这个优先级），因为文件是用户「已经确认过」的那份。
   */
  async annotate(input: ScrnaAnnotateRequest): Promise<ScrnaAnnotateResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    if (!fs.existsSync(path.join(runDir, 'obj_step5.rds'))) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 5 步的对象（obj_step5.rds）。',
        suggestion: '请先完成「Marker 基因」，或从已有的 obj_step5.rds 导入后继续。'
      })
    }
    const assignments = (input.assignments ?? []).filter((a) => a && a.cluster !== '')
    if (!input.annotationFile && assignments.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有填任何细胞类型。',
        suggestion: '在表格里给每个簇填一个细胞类型，或导入一张注释表。'
      })
    }

    logger.info(
      'scrna',
      `启动 scrna/run_scrna_annotate.R（${input.scrnaId}，` +
        `${input.annotationFile ? '导入注释表' : `${assignments.length} 条手工映射`}）`
    )
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_annotate.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step5.rds',
          mode: 'manual',
          // 空字符串 → R 侧走 assignments 分支（nzchar("") 为 FALSE）
          annotationFile: input.annotationFile ?? '',
          assignments: assignments.map((a) => ({
            cluster: String(a.cluster),
            celltype: String(a.celltype ?? '')
          })),
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: ANNOTATE_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '单细胞细胞注释')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      nCells: num(summary.nCells),
      nClusters: num(summary.nClusters),
      mode: summary.mode === 'singleR' ? 'singleR' : 'manual',
      nCelltypes: num(summary.nCelltypes),
      renamed: num(summary.renamed),
      merged: toArray<Record<string, unknown>>(summary.merged).map(
        (row): ScrnaAnnotateMerged => ({
          celltype: String(row.celltype ?? ''),
          clusters: toArray<string>(row.clusters).map(String)
        })
      ),
      unnamed: num(summary.unnamed),
      celltypePalette: toArray<Record<string, unknown>>(summary.celltypePalette).map(
        (row): ScrnaCelltypePaletteEntry => ({
          celltype: String(row.celltype ?? ''),
          color: String(row.color ?? ''),
          fromClusters: toArray<string>(row.fromClusters).map(String)
        })
      ),
      celltypes: toArray<Record<string, unknown>>(summary.celltypes).map(
        (row): ScrnaCelltypeRow => ({
          cluster: String(row.cluster ?? ''),
          cells: num(row.cells),
          celltype: String(row.celltype ?? ''),
          top10: toArray<Record<string, unknown>>(row.top10).map((t) => ({
            gene: String(t.gene ?? ''),
            avgLog2FC: num(t.avgLog2FC)
          }))
        })
      ),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      annotationCsvPath: path.join(runDir, 'celltype_annotation.csv'),
      objectPath: path.join(runDir, 'obj_step6.rds'),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /**
   * 第 6 步·B：**SingleR 预览**（人/鼠）—— 只出建议，不写对象。
   *
   * 为什么预览与「应用」分开：SingleR 给的是「簇 → 类型」的建议，一般要人工过一眼
   * （低置信度的簇会在 `pruned` 里变成 NA）。直接写进对象等于替用户做了决定，
   * 而他很可能要把 3 个簇合并成「T cell」这种。所以这份结果只回填到表格，
   * 用户改完再走 `annotate`（mode=manual）落地。
   */
  async singleRPreview(input: ScrnaSingleRRequest): Promise<ScrnaSingleRResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    if (!fs.existsSync(path.join(runDir, 'obj_step5.rds'))) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第 5 步的对象（obj_step5.rds）。',
        suggestion: '请先完成「Marker 基因」，或从已有的 obj_step5.rds 导入后继续。'
      })
    }
    if (!input.refRds || !fs.existsSync(input.refRds)) {
      throw toAppError('E_DATA_EMPTY', {
        message: '参考集文件不存在。',
        suggestion: '请选择一个本地的参考集 .rds（celldex 的数据集另存为 rds 后可直接用）。'
      })
    }

    logger.info('scrna', `启动 scrna/run_scrna_singleR.R（${input.scrnaId}）`)
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_singleR.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step5.rds',
          refRds: input.refRds,
          labelColumn: input.labelColumn ?? '',
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: ANNOTATE_TIMEOUT_MS,
      requiredPackages: [...SCRNA_PACKAGES, 'SingleR'],
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, 'SingleR 自动注释')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      refLabel: String(summary.refLabel ?? ''),
      nClusters: num(summary.nClusters),
      suggestions: toArray<Record<string, unknown>>(summary.suggestions).map(
        (row): ScrnaSingleRSuggestion => ({
          cluster: String(row.cluster ?? ''),
          celltype: String(row.celltype ?? ''),
          pruned: String(row.pruned ?? ''),
          score: num(row.score)
        })
      ),
      singleRSeconds: num(summary.singleRSeconds),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /**
   * 第 5 步：自选基因出图（DotPlot + 小提琴，**一次调用两张**）。
   *
   * 为什么独立于 `markers`：客户要的是「填基因 → 按一下 → 出图」。
   * 挂在 FindAllMarkers 里意味着换一组基因要重跑四分钟，而这两张图只依赖 `data` 层。
   */
  async customPlots(input: ScrnaCustomPlotsRequest): Promise<ScrnaCustomPlotsResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    // 优先用第 5 步的对象（obj_step5）；只有第 4 步也允许（客户可能还没算 marker）
    const objectFile = ['obj_step5.rds', 'obj_step4.rds'].find((f) =>
      fs.existsSync(path.join(runDir, f))
    )
    if (!objectFile) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到可用的对象（obj_step4.rds / obj_step5.rds 都不存在）。',
        suggestion: '请先完成「聚类 · UMAP · tSNE」，或从已有的 rds 导入后继续。'
      })
    }
    const genes = (input.genes ?? []).map((g) => g.trim()).filter((g) => g.length > 0)
    if (genes.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有填基因。',
        suggestion: '在输入框里粘贴基因名（一行一个，空格 / 逗号分隔也行），再点「出图」。'
      })
    }

    logger.info('scrna', `启动 scrna/run_scrna_custom_plots.R（${input.scrnaId}，${genes.length} 个基因）`)
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_custom_plots.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: { objectFile, genes, skipFonts: true }
      },
      runDir,
      timeoutMs: ANNOTATE_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '自选基因出图')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      genes: toArray<string>(summary.genes).map(String),
      missingGenes: toArray<string>(summary.missingGenes).map(String),
      geneStats: toArray<Record<string, unknown>>(summary.geneStats).map(
        (row): ScrnaGeneStat => ({
          gene: String(row.gene ?? ''),
          pctExpressing: num(row.pctExpressing),
          mean: num(row.mean),
          max: num(row.max)
        })
      ),
      nCells: num(summary.nCells),
      nGroups: num(summary.nGroups),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  /**
   * 第 6 步：基因查询（FeaturePlot / 小提琴 / DotPlot）。
   *
   * 分组配色由 R 侧决定（celltype 色 = 从簇色派生），这里只把 palette 透传给界面，
   * 好让用户能核对「注释前后的颜色是同一套」。颜色绝不在 JS 侧生成第二份。
   */
  async geneQuery(input: ScrnaGeneQueryRequest): Promise<ScrnaGeneQueryResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'scrna', input.scrnaId)
    if (!fs.existsSync(path.join(runDir, 'obj_step6.rds'))) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到注释后的对象（obj_step6.rds）。',
        suggestion: '请先在第 6 步填好细胞类型并点「应用注释」。'
      })
    }
    const genes = (input.genes ?? []).map((g) => g.trim()).filter((g) => g.length > 0)
    if (genes.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有填基因。',
        suggestion: '在输入框里粘贴基因名（一行一个），再点「出图」。'
      })
    }
    const groupBy = input.groupBy === 'clusters' ? 'clusters' : 'celltype'

    logger.info(
      'scrna',
      `启动 scrna/run_scrna_gene_query.R（${input.scrnaId}，${genes.length} 个基因，` +
        `groupBy=${groupBy}，splitBy=${input.splitBy || 'none'}）`
    )
    const result = await this.deps.runner.run({
      runId: input.scrnaId,
      scriptRelPath: 'scrna/run_scrna_gene_query.R',
      config: {
        runId: input.scrnaId,
        runDir,
        projectRoot: root,
        params: {
          objectFile: 'obj_step6.rds',
          genes,
          groupBy,
          splitBy: input.splitBy ?? '',
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: ANNOTATE_TIMEOUT_MS,
      requiredPackages: SCRNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.scrnaId, p),
      onLog: (l) => this.emitLog(input.scrnaId, l)
    })
    this.ensureOk(result, '基因查询')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    return {
      scrnaId: input.scrnaId,
      genes: toArray<string>(summary.genes).map(String),
      missingGenes: toArray<string>(summary.missingGenes).map(String),
      geneStats: toArray<Record<string, unknown>>(summary.geneStats).map(
        (row): ScrnaGeneStat => ({
          gene: String(row.gene ?? ''),
          pctExpressing: num(row.pctExpressing),
          mean: num(row.mean),
          max: num(row.max)
        })
      ),
      groupBy: summary.groupBy === 'clusters' ? 'clusters' : 'celltype',
      splitBy: String(summary.splitBy ?? ''),
      nGroups: num(summary.nGroups),
      samples: toArray<string>(summary.samples).map(String),
      nCells: num(summary.nCells),
      palette: toArray<Record<string, unknown>>(summary.palette).map((row) => ({
        group: String(row.group ?? ''),
        color: String(row.color ?? '')
      })),
      plots: toArray<Record<string, unknown>>(summary.plots).map(
        (row): ScrnaPlotImage => ({
          id: String(row.id ?? ''),
          caption: String(row.caption ?? ''),
          file: String(row.file ?? ''),
          dataUrl: readPlotDataUrl(runDir, String(row.file ?? ''))
        })
      ),
      durationMs: num(summary.durationMs, result.durationMs)
    }
  }

  private requireRoot(): string {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行单细胞分析。',
        suggestion: '请先打开一个项目。'
      })
    }
    return root
  }

  /**
   * 导出单张图（png / pdf）。
   *
   * 单细胞的图是按步骤分批生成的：用户很可能只跑了第 2 步就去点第 4 步的导出。
   * 所以这里对「图不存在」和「没有 PDF 版本（旧版本跑的）」分别给明确提示，
   * 而不是复制出一个 0 字节文件。
   */
  exportPlot(input: { scrnaId: string; file: string; format: 'png' | 'pdf'; outPath: string }) {
    const root = this.requireRoot()
    return copyFigure({
      runDir: path.join(root, 'results', 'scrna', input.scrnaId),
      file: input.file,
      format: input.format,
      outPath: input.outPath
    })
  }

  /** 批量导出该次单细胞分析的全部图（pdf） */
  exportAllPlots(input: { scrnaId: string; outDir: string; files?: string[] }) {
    const root = this.requireRoot()
    return copyAllFigures({
      runDir: path.join(root, 'results', 'scrna', input.scrnaId),
      outDir: input.outDir,
      files: input.files
    })
  }

  private ensureOk(result: RunRResult, label: string): void {
    if (result.ok) return
    if (result.stderr) {
      logger.error('scrna', `${label}失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
    }
    throw (
      result.error ??
      toAppError('E_R_GENERIC', {
        message: `${label}失败。`,
        suggestion: '请展开原始日志查看详情。'
      })
    )
  }

  private emitProgress(runId: string, p: ProgressMessage): void {
    this.deps.emit(IPC.event.analysisProgress, { runId, stage: p.stage, pct: p.pct, msg: p.msg })
  }

  private emitLog(runId: string, l: LogMsg): void {
    this.deps.emit(IPC.event.analysisLog, { runId, ts: l.ts, level: l.level, line: l.line })
  }
}
