/**
 * WGCNA 服务（主进程侧）。
 *
 * ## 为什么是两段（prepare → network）
 *
 * 第一段只做到 `pickSoftThreshold`：把拟合表和质控图交给用户，用户自己点头选 β
 * 再进第二段。软阈值选错会让网络失去无标度特性，这不是能替用户决定的事。
 *
 * 更实际的收益是**缓存**：第二段的 TOM 只依赖「表达矩阵 + β」，跟 minModuleSize /
 * mergeHeight 无关。只要两段共用同一个 runDir，R 侧就能靠 `stage1.rds` 续跑、
 * 靠 `cache_disstom.rds` 复用 TOM —— 用户调模块粒度从「等几分钟」变成「几秒出」。
 * 所以 `network()` 的 runDir **必须由 wgcnaId 拼出来**，绝不能新建时间戳目录。
 *
 * ## 结果里的图
 *
 * R 把 12 张 png 落在 runDir 里，摘要只给文件名。主进程负责把文件读成
 * `data:image/png;base64,...` 填进 `dataUrl`。**某张图渲染失败不能让整次分析失败**
 * —— R 侧本来就是逐图 tryCatch 的，这里同样把缺图降级成 null + warn。
 *
 * ## auto_unbox 的坑
 *
 * `jsonlite::toJSON(auto_unbox = TRUE)` 会把长度为 1 的数组塌成标量。前端对
 * `traits` 调 `.join`、对 `plots` 调 `.map` 时会因为拿到的不是数组直接崩页
 * （本项目踩过一次）。所以从 summary 里取出的每个数组字段都先过 `toArray()`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import { IPC, type IpcEventChannel } from '@shared/ipc'
import type { ProgressMessage } from '@shared/protocol'
import type {
  WgcnaExportAllRequest,
  WgcnaExportAllResult,
  WgcnaExportModuleGenesRequest,
  WgcnaExportModuleGenesResult,
  WgcnaExportPlotRequest,
  WgcnaExportPlotResult,
  WgcnaExportTableRequest,
  WgcnaExportTableResult,
  WgcnaLoadRequest,
  WgcnaLoadResult,
  WgcnaModuleGenesRequest,
  WgcnaModuleGenesResult,
  WgcnaModuleRow,
  WgcnaNetworkRequest,
  WgcnaNetworkResult,
  WgcnaPlot,
  WgcnaPowerRow,
  WgcnaPrepareRequest,
  WgcnaPrepareResult,
  WgcnaTableId,
  WgcnaTableInfo,
  WgcnaTraitRow
} from '@shared/types/wgcna'
import { logger } from '../logger'
import type { LogMsg, RRunner, RunRResult } from '../process/RProcessRunner'
import { countCsvDataRows, parseCsv, writeXlsx } from '../util/csv'

const PREPARE_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 第二段给足 90 分钟：上万基因的 `TOMsimilarity` 是 O(n²) 的稠密矩阵运算，
 * 一台普通办公机跑几十分钟很常见。这是本模块唯一必须放宽超时的调用。
 */
const NETWORK_TIMEOUT_MS = 90 * 60 * 1000
const WGCNA_PACKAGES = ['WGCNA', 'dynamicTreeCut', 'fastcluster', 'preprocessCore', 'impute', 'gplots']

/** 结果表 id → R 侧写出的文件名（导出时直接按这张表找文件） */
const TABLE_FILES: Record<WgcnaTableId, string> = {
  powers: 'wgcna_powers.csv',
  genes: 'wgcna_genes.csv',
  modules: 'wgcna_module_sizes.csv',
  traits: 'wgcna_module_trait.csv',
  eigengenes: 'wgcna_eigengenes.csv'
}

export interface WgcnaServiceDeps {
  runner: RRunner
  projectStore: { getRoot(): string | null }
  /**
   * 主进程 → 渲染进程的单向事件。`AppContext` 目前不持有 WgcnaService 实例，
   * 由 handler 在构造时把 `app.emit` 传进来，避免服务层反向依赖容器。
   */
  emit: (channel: IpcEventChannel, payload: unknown) => void
}

/**
 * 快照里保存的图元信息。
 *
 * `file` 留着是为了恢复时重新内联 base64（快照本身不能存 dataUrl，会撑到几 MB）；
 * `pdf` 留着是为了「导出 PDF」时能直接找到矢量文件 —— 那份文件是 R 在分析时
 * 顺手用 pdf() 设备画的，**不是**把 png 转出来的。
 */
interface RawPlot {
  id: string
  title: string
  caption: string
  file: string
  /** 老运行（加 PDF 之前跑的）没有这个字段 */
  pdf?: string | null
}

/**
 * `auto_unbox` 塌缩的兜底：数组原样返回；标量包成单元素数组；null/undefined 给空数组。
 * 前端只要拿到的一定是数组，就不会再出现 `.join is not a function`。
 */
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value == null) return []
  return [value as T]
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

function newWgcnaId(): string {
  return `wgcna-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
}

/** 读 png 成 data URL；文件不存在返回 null（图可能因渲染失败没生成，不该让整次分析失败） */
function readPlotDataUrl(runDir: string, file: string): string | null {
  if (!file) return null
  const p = path.join(runDir, file)
  if (!fs.existsSync(p)) {
    logger.warn('wgcna', `诊断图未生成：${file}（dataUrl 置空，不影响本次分析）`)
    return null
  }
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
}

/** 把 R 给的 plots 同时展开成「带 base64 的返回体」和「带 file 的快照元信息」 */
function buildPlots(raw: unknown, runDir: string): { plots: WgcnaPlot[]; meta: RawPlot[] } {
  const meta = toArray<Record<string, unknown>>(raw).map((p) => ({
    id: str(p.id),
    title: str(p.title),
    caption: str(p.caption),
    file: str(p.file),
    pdf: str(p.pdf) || null
  }))
  return { plots: hydratePlots(meta, runDir), meta }
}

/** 用快照里的 file 重新内联图片（loadResult 恢复会话时用） */
function hydratePlots(raw: unknown, runDir: string): WgcnaPlot[] {
  return toArray<Record<string, unknown>>(raw).map((p) => {
    const file = str(p.file)
    const pdf = str(p.pdf)
    return {
      id: str(p.id),
      title: str(p.title),
      caption: str(p.caption),
      dataUrl: readPlotDataUrl(runDir, file),
      // 以「文件真的在」为准，不信快照里的字段：用户可能手动删过 runDir
      hasPdf: Boolean(pdf) && fs.existsSync(path.join(runDir, pdf))
    }
  })
}

/**
 * 写结果快照。
 *
 * ★ 快照里**不能带 dataUrl**：12 张图 × 几百 KB 的 base64 会把一个 json 撑到几 MB，
 *   而恢复时完全可以从 `plots[].file` 重新内联。调用方传入的 payload 已把 plots
 *   换成了 `RawPlot[]`。
 */
function writeSnapshot(file: string, payload: unknown): void {
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
}

function readSnapshot(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    logger.warn('wgcna', `结果快照读取失败：${file}（${String(err)}）`)
    return null
  }
}

/** 目标目录已有同名文件时加 (1)(2)…，不覆盖用户之前导出的图 */
function uniqueDest(dir: string, file: string): string {
  const ext = path.extname(file)
  const base = path.basename(file, ext)
  let dest = path.join(dir, file)
  let i = 1
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base} (${i})${ext}`)
    i += 1
  }
  return dest
}

export class WgcnaService {
  constructor(private readonly deps: WgcnaServiceDeps) {}

  /** 第一段：读矩阵 + 质控 + 软阈值（30 分钟超时） */
  async prepare(input: WgcnaPrepareRequest): Promise<WgcnaPrepareResult> {
    const root = this.requireRoot()
    this.requireFile(input.matrixPath, '表达矩阵')
    if (input.traitPath) this.requireFile(input.traitPath, '性状表')

    const wgcnaId = newWgcnaId()
    const runDir = path.join(root, 'results', 'wgcna', wgcnaId)
    fs.mkdirSync(runDir, { recursive: true })

    const config = {
      runId: wgcnaId,
      runDir,
      projectRoot: root,
      params: {
        wgcnaId,
        matrixPath: input.matrixPath,
        traitPath: input.traitPath ?? '',
        varianceFilter: input.varianceFilter,
        transform: input.transform,
        sampleCutHeight: input.sampleCutHeight ?? null,
        minSamples: input.minSamples ?? 8,
        skipFonts: true
      }
    }

    logger.info('wgcna', `启动 WGCNA 第一段 ${wgcnaId}: ${path.basename(input.matrixPath)}`)

    const result = await this.deps.runner.run({
      runId: wgcnaId,
      scriptRelPath: 'wgcna/run_wgcna_prepare.R',
      config,
      runDir,
      timeoutMs: PREPARE_TIMEOUT_MS,
      requiredPackages: WGCNA_PACKAGES,
      onProgress: (p) => this.emitProgress(wgcnaId, p),
      onLog: (l) => this.emitLog(wgcnaId, l)
    })
    this.ensureOk(result, 'WGCNA 第一段（读矩阵 + 软阈值）')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    const { plots, meta } = buildPlots(summary.plots, runDir)

    const payload: WgcnaPrepareResult = {
      wgcnaId,
      runDir,
      nGenesInput: num(summary.nGenesInput),
      nGenesUsed: num(summary.nGenesUsed),
      nSamples: num(summary.nSamples),
      nSamplesRemoved: num(summary.nSamplesRemoved),
      // auto 由 R 侧解析成实际动作，这里只认 log2 / 其它一律 none
      transformUsed: summary.transformUsed === 'log2' ? 'log2' : 'none',
      varianceCutoff: num(summary.varianceCutoff),
      traits: toArray<string>(summary.traits).map((t) => str(t)),
      unmatchedSamples: num(summary.unmatchedSamples),
      powers: toArray<Record<string, unknown>>(summary.powers).map(
        (p): WgcnaPowerRow => ({
          power: num(p.power),
          signedR2: num(p.signedR2),
          slope: num(p.slope),
          meanK: num(p.meanK),
          medianK: num(p.medianK),
          maxK: num(p.maxK)
        })
      ),
      recommendedPower: summary.recommendedPower == null ? null : num(summary.recommendedPower),
      plots,
      summary
    }

    writeSnapshot(path.join(runDir, 'prepare.json'), { ...payload, plots: meta })
    return payload
  }

  /** 第二段：建网络 + 切模块 + 合并 + 关联性状（复用第一段 runDir / TOM 缓存，90 分钟超时） */
  async network(input: WgcnaNetworkRequest): Promise<WgcnaNetworkResult> {
    const root = this.requireRoot()
    // ★ 复用同一个 runDir：R 靠 stage1.rds 续跑、靠 cache_disstom.rds 复用 TOM。
    //   这里若新建时间戳目录，两份缓存都会失效，用户每调一次 minModuleSize 都要等几分钟。
    const runDir = path.join(root, 'results', 'wgcna', input.wgcnaId)
    if (!fs.existsSync(path.join(runDir, 'stage1.rds'))) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到第一段的中间结果（stage1.rds）。',
        suggestion: '请先完成第一步（方差过滤 + 软阈值），再选择 β 运行网络构建。'
      })
    }

    const config = {
      runId: input.wgcnaId,
      runDir,
      projectRoot: root,
      params: {
        wgcnaId: input.wgcnaId,
        softPower: input.softPower,
        minModuleSize: input.minModuleSize,
        mergeHeight: input.mergeHeight,
        heatmapPalette: input.heatmapPalette,
        profileModule: input.profileModule ?? '',
        tomSampleSize: input.tomSampleSize ?? 1000,
        skipFonts: true
      }
    }

    logger.info(
      'wgcna',
      `启动 WGCNA 第二段 ${input.wgcnaId}: softPower=${input.softPower}, minModuleSize=${input.minModuleSize}`
    )

    const result = await this.deps.runner.run({
      runId: input.wgcnaId,
      scriptRelPath: 'wgcna/run_wgcna_network.R',
      config,
      runDir,
      timeoutMs: NETWORK_TIMEOUT_MS,
      requiredPackages: WGCNA_PACKAGES,
      onProgress: (p) => this.emitProgress(input.wgcnaId, p),
      onLog: (l) => this.emitLog(input.wgcnaId, l)
    })
    this.ensureOk(result, 'WGCNA 第二段（建网络 + 切模块）')

    const summary = (result.summary ?? {}) as Record<string, unknown>
    const { plots, meta } = buildPlots(summary.plots, runDir)

    const modules = toArray<Record<string, unknown>>(summary.modules).map(
      (m): WgcnaModuleRow => ({ module: str(m.module), genes: num(m.genes) })
    )
    const traitRows = toArray<Record<string, unknown>>(summary.traitRows).map(
      (t): WgcnaTraitRow => ({
        module: str(t.module),
        trait: str(t.trait),
        cor: num(t.cor),
        pvalue: num(t.pvalue),
        fdr: num(t.fdr)
      })
    )
    const tables = toArray<Record<string, unknown>>(summary.tables).map(
      (t): WgcnaTableInfo => ({
        id: str(t.id) as WgcnaTableId,
        label: str(t.label),
        file: str(t.file),
        rows: num(t.rows),
        columns: str(t.columns)
      })
    )

    const payload: WgcnaNetworkResult = {
      wgcnaId: input.wgcnaId,
      runDir,
      geneCount: num(summary.geneCount),
      modules,
      traitRows,
      plots,
      tables,
      tomCached: summary.tomCached === true,
      summary
    }

    writeSnapshot(path.join(runDir, 'network.json'), { ...payload, plots: meta })
    return payload
  }

  /**
   * 导出单张诊断图（复制 runDir 里已生成的 png，不重画）。
   *
   * plot id（如 `sampleTree`）和文件名（如 `p01_sample_tree.png`）之间没有可推导的
   * 对应关系 —— 唯一可靠的映射在快照里。两段都要查：用户在第二步也可能想导第一段的图。
   */
  /**
   * 导出单张诊断图。
   *
   * `format='pdf'` 拷的是 R 用 `pdf()` 矢量设备画的那份，不是把 png 转成 pdf ——
   * 后者只是位图换了个容器，投稿放大照样糊。所以 PDF 文件在**分析阶段**就生成了，
   * 这里只做拷贝（几毫秒），不需要重跑任何分析。
   */
  exportPlot(input: WgcnaExportPlotRequest): WgcnaExportPlotResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'wgcna', input.wgcnaId)
    const format = input.format ?? 'png'
    const found = this.findPlotFiles(runDir, input.plotId)

    if (!found.known) {
      throw toAppError('E_RESULT_INVALID', {
        message: '还没有生成这张图，请先运行。',
        suggestion: '请先完成对应的 WGCNA 步骤，再导出这张诊断图。'
      })
    }
    const fileName = format === 'pdf' ? found.pdf : found.png
    if (format === 'pdf' && !fileName) {
      // 老运行（加 PDF 之前跑的）只有 png。这里**必须报错而不是退回 png**：
      // 用户点的是「导出 PDF」，给他一个 .pdf 后缀的位图等于骗他，
      // 而他拿去投稿后才发现放大是马赛克，代价比现在重跑一次大得多。
      throw toAppError('E_RESULT_INVALID', {
        message: '这次运行没有生成矢量 PDF（是在支持 PDF 导出之前跑的）。',
        suggestion: '点一下「② 构建网络」重跑一次即可 —— TOM 有缓存，通常十几秒；重跑后每张图都会带 PDF。'
      })
    }
    const src = path.join(runDir, fileName as string)
    if (!fs.existsSync(src)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '这张图在磁盘上已经不存在了。',
        suggestion: '请重新运行一次 WGCNA。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })
    fs.copyFileSync(src, input.outPath)
    return { outPath: input.outPath, bytes: fs.statSync(input.outPath).size }
  }

  /**
   * 一次把全部诊断图拷到用户选的目录。
   *
   * 默认 PNG + PDF 都给：PNG 用来贴 PPT / 微信发给导师，PDF 用来投稿排版。
   * 让用户为这个再点一次、选一次目录没有意义 —— 文件本来就在 runDir 里。
   */
  exportAll(input: WgcnaExportAllRequest): WgcnaExportAllResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'wgcna', input.wgcnaId)
    if (!fs.existsSync(runDir)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到这次 WGCNA 的运行目录。',
        suggestion: '请重新运行一次 WGCNA。'
      })
    }
    fs.mkdirSync(input.dir, { recursive: true })

    const formats = input.formats && input.formats.length > 0 ? input.formats : (['png', 'pdf'] as const)
    const all = fs.readdirSync(runDir)
    const counts = { png: 0, pdf: 0 }
    let missingPdf = 0

    for (const format of formats) {
      const pattern = format === 'pdf' ? /^p.*\.pdf$/i : /^p.*\.png$/i
      const files = all.filter((f) => pattern.test(f))
      if (format === 'pdf') {
        // 期望的 PDF 数 = 这次运行的图数量（以快照为准），少一张就是老运行 / 画失败
        missingPdf = Math.max(0, this.expectedPlotCount(runDir) - files.length)
      }
      for (const file of files) {
        try {
          fs.copyFileSync(path.join(runDir, file), uniqueDest(input.dir, file))
          counts[format] += 1
        } catch (err) {
          logger.warn('wgcna', `导出诊断图失败：${file}（${String(err)}）`)
        }
      }
    }
    return { dir: input.dir, files: counts.png + counts.pdf, png: counts.png, pdf: counts.pdf, missingPdf }
  }

  /** 这次运行一共有几张图（以快照里的 plots 为准，两段相加） */
  private expectedPlotCount(runDir: string): number {
    let total = 0
    for (const name of ['prepare.json', 'network.json']) {
      const snap = readSnapshot(path.join(runDir, name))
      if (!snap) continue
      total += toArray<Record<string, unknown>>(snap.plots).filter((p) => str(p.file)).length
    }
    return total
  }

  /**
   * 读某个模块的基因。
   *
   * 数据源是 R 写的 `wgcna_genes.csv`（每个基因一行，含最终模块颜色），
   * 这里现切一份返回 —— **不缓存在内存里，也不塞进 network() 的返回值**：
   * 上万基因的列表塞进每次构建结果，会让「只改合并高度重跑」多传几十 KB
   * JSON，而用户 90% 的时间根本不看某个具体模块的基因。
   */
  moduleGenes(input: WgcnaModuleGenesRequest): WgcnaModuleGenesResult {
    const rows = this.readGeneModules(input.wgcnaId)
    const genes = rows.filter((r) => r.module === input.module).map((r) => r.gene)
    if (genes.length === 0 && !rows.some((r) => r.module === input.module)) {
      // 区分「模块名写错」和「模块存在但没有基因」：前者是调用方 bug，
      // 后者在实际数据里几乎不会出现，合并报错反而让人找不到原因
      const known = [...new Set(rows.map((r) => r.module))].slice(0, 8)
      throw toAppError('E_VALIDATION', {
        message: `没有名为 ${input.module} 的模块。`,
        suggestion: `当前运行的模块有：${known.join('、') || '（无）'}`
      })
    }
    return { module: input.module, genes, total: genes.length }
  }

  /**
   * 导出模块基因。
   *
   * 三种格式各有真实用途，不是凑数：
   *   csv  —— 带 module,gene 两列，回 Excel 里筛选/透视
   *   xlsx —— 同上，但不写代码的同事能直接打开
   *   txt  —— **一行一个基因名**，直接贴进 DAVID / metascape / clusterProfiler，
   *           这类工具只吃纯列表，给它 csv 反而要手工删表头
   * 不传 module 时导全部模块（长表），一次把整套模块基因打包带走。
   */
  async exportModuleGenes(
    input: WgcnaExportModuleGenesRequest
  ): Promise<WgcnaExportModuleGenesResult> {
    const rows = this.readGeneModules(input.wgcnaId)
    const picked = input.module ? rows.filter((r) => r.module === input.module) : rows
    if (picked.length === 0) {
      throw toAppError('E_RESULT_INVALID', {
        message: input.module ? `模块 ${input.module} 没有基因可导出。` : '这次运行没有模块基因可导出。',
        suggestion: '可能还没跑完第二段，或 minModuleSize 太大导致所有基因都归到 grey。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })

    if (input.format === 'txt') {
      // 纯文本只写基因名，一行一个 —— 不要表头、不要模块名，
      // 否则贴进富集工具会被当成一个叫 "gene" 的基因
      fs.writeFileSync(input.outPath, picked.map((r) => r.gene).join('\n') + '\n', 'utf8')
    } else {
      const header = input.module ? 'gene' : 'module,gene'
      const lines = picked.map((r) => (input.module ? r.gene : `${r.module},${r.gene}`))
      const csvPath = path.join(path.dirname(input.outPath), `.tmp-module-genes-${Date.now()}.csv`)
      fs.writeFileSync(csvPath, [header, ...lines].join('\n') + '\n', 'utf8')
      try {
        if (input.format === 'xlsx') {
          await writeXlsx(csvPath, input.outPath, 'moduleGenes')
        } else {
          fs.copyFileSync(csvPath, input.outPath)
        }
      } finally {
        try {
          fs.unlinkSync(csvPath)
        } catch {
          /* 临时文件删不掉不影响结果 */
        }
      }
    }

    const stat = fs.statSync(input.outPath)
    logger.info(
      'wgcna',
      `导出模块基因：${input.module ?? '全部模块'} → ${input.outPath}（${picked.length} 个基因）`
    )
    return { outPath: input.outPath, bytes: stat.size, genes: picked.length }
  }

  /** 读 `wgcna_genes.csv`，返回 gene → 最终模块颜色 */
  private readGeneModules(wgcnaId: string): { gene: string; module: string }[] {
    const root = this.requireRoot()
    const csvPath = path.join(root, 'results', 'wgcna', wgcnaId, 'wgcna_genes.csv')
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到基因-模块归属表。',
        suggestion: '请先完成「② 构建网络」。'
      })
    }
    return parseCsv(fs.readFileSync(csvPath, 'utf8'))
      .map((r) => ({ gene: String(r.gene ?? '').trim(), module: String(r.mergedColor ?? '').trim() }))
      .filter((r) => r.gene && r.module)
  }

  /**
   * 导出结果表。
   *
   * csv 走 `fs.copyFile`（R 已经写好，直拷最省事也最保真）；
   * xlsx 用 exceljs 从同一份 CSV 生成，列名与数值类型与 R 产物一致。
   */
  async exportTable(input: WgcnaExportTableRequest): Promise<WgcnaExportTableResult> {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'wgcna', input.wgcnaId)
    const csvName = TABLE_FILES[input.table]
    const csvPath = path.join(runDir, csvName)
    if (!fs.existsSync(csvPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: `找不到结果表：${csvName}`,
        suggestion: '请先完成对应的 WGCNA 步骤，再导出这张表。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })

    if (input.format === 'csv') {
      fs.copyFileSync(csvPath, input.outPath)
    } else {
      await writeXlsx(csvPath, input.outPath, 'wgcna')
    }

    const stat = fs.statSync(input.outPath)
    logger.info('wgcna', `导出结果表 ${input.table} → ${input.outPath}（${stat.size} 字节）`)
    return { outPath: input.outPath, bytes: stat.size, rows: countCsvDataRows(csvPath) }
  }

  /** 会话恢复：读回项目里已经跑过的两段结果（免重算分钟级的网络） */
  loadResult(input: WgcnaLoadRequest): WgcnaLoadResult {
    const root = this.requireRoot()
    const runDir = path.join(root, 'results', 'wgcna', input.wgcnaId)
    return {
      wgcnaId: input.wgcnaId,
      prepare: this.hydratePrepare(runDir),
      network: this.hydrateNetwork(runDir)
    }
  }

  private hydratePrepare(runDir: string): WgcnaPrepareResult | null {
    const snap = readSnapshot(path.join(runDir, 'prepare.json'))
    if (!snap) return null
    return { ...(snap as unknown as WgcnaPrepareResult), plots: hydratePlots(snap.plots, runDir) }
  }

  private hydrateNetwork(runDir: string): WgcnaNetworkResult | null {
    const snap = readSnapshot(path.join(runDir, 'network.json'))
    if (!snap) return null
    return { ...(snap as unknown as WgcnaNetworkResult), plots: hydratePlots(snap.plots, runDir) }
  }

  /** 从两段快照里按 plot id 找回文件名 */
  /**
   * 按 plotId 找出这张图的 png / pdf 文件名。
   *
   * 刻意不拿 id 去拼文件名（`sampleTree` → `p01_sample_tree.png` 没有可推导的规则），
   * 只认快照里记着的那份对应关系。
   *
   * 三种「没有」必须分开，否则用户会收到错误的指引：
   *   · `known=false`            —— 压根没这张图（用户还没跑到那一步）
   *   · `known=true, pdf=null`   —— 图在，但这是「加 PDF 之前」的老运行
   *   · 文件名有、文件不在        —— runDir 被清过
   */
  private findPlotFiles(
    runDir: string,
    plotId: string
  ): { known: boolean; png: string | null; pdf: string | null } {
    for (const name of ['prepare.json', 'network.json']) {
      const snap = readSnapshot(path.join(runDir, name))
      if (!snap) continue
      const hit = toArray<Record<string, unknown>>(snap.plots).find((p) => str(p.id) === plotId)
      if (!hit) continue
      return { known: true, png: str(hit.file) || null, pdf: str(hit.pdf) || null }
    }
    return { known: false, png: null, pdf: null }
  }

  private requireRoot(): string {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行 WGCNA。',
        suggestion: '请先打开一个项目。'
      })
    }
    return root
  }

  private requireFile(filePath: string, label: string): void {
    if (!filePath || !fs.existsSync(filePath)) {
      throw toAppError('E_DATA_EMPTY', {
        message: `找不到${label}文件：${path.basename(filePath || '')}`,
        suggestion: '请重新选择文件。'
      })
    }
  }

  /** 失败统一收口：stderr 只留最后 2500 字符，避免几万行 TOM 日志灌满主日志 */
  private ensureOk(result: RunRResult, label: string): void {
    if (result.ok) return
    if (result.stderr) {
      logger.error('wgcna', `${label}失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
    }
    throw (
      result.error ??
      toAppError('E_R_GENERIC', {
        message: `${label}运行失败。`,
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
