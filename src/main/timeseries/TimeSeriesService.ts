/**
 * 时序转录组服务（主进程侧）—— 单序列 + SAM 时序。
 *
 * ## 三个通道的职责划分
 *
 * | 通道 | 起 R？ | 说明 |
 * | --- | --- | --- |
 * | `inspectMatrix` | 否 | 只读表头 + 按命名规则解析，**选完文件立刻出预览表** |
 * | `run` | 是 | SAM（200 次置换，实测 1.2 万基因 / 21 样本约 2 秒） |
 * | `curves` | 是 | 自选基因的时序曲线（读同一份矩阵，约 1 秒） |
 *
 * ## 为什么阈值不在 R 里再跑一次
 *
 * 客户会反复拨 FDR 与 |Score(d)| 看基因数怎么变。R 侧返回的是**全基因表**
 * （每个基因自己的 q 与 d），阈值过滤放在界面 —— 拨一下立刻见结果，
 * 而不是每次都等 200 次置换。
 */
import fs from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { toAppError } from '@shared/errors'
import type {
  TsCurvesRequest,
  TsCurvesResult,
  TsExportTableRequest,
  TsExportTableResult,
  TsGeneRow,
  TsInspectRequest,
  TsInspectResult,
  TsParseRule,
  TsMoaninCurvesRequest,
  TsMoaninCurvesResult,
  TsMoaninRequest,
  TsMoaninResult,
  TsMoaninRow,
  TsMoaninSummary,
  TsRunRequest,
  TsRunResult,
  TsRunSummary,
  TsSampleMeta
} from '@shared/types/timeseries'
import { IPC, type IpcEventChannel } from '@shared/ipc'
import type { ProgressMessage } from '@shared/protocol'
import { logger } from '../logger'
import type { LogMsg, RRunner, RunRResult } from '../process/RProcessRunner'
import { countCsvDataRows, parseCsv, writeXlsx } from '../util/csv'
import { copyAllFigures, copyFigure } from '../util/figureExport'

/** 一次 SAM：200 次置换在 5.6 万基因 × 21 样本上不到 10 秒，给 10 分钟足够宽 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
const CURVES_TIMEOUT_MS = 5 * 60 * 1000

export interface TimeSeriesServiceDeps {
  runner: RRunner
  projectStore: { getRoot(): string | null }
  emit: (channel: IpcEventChannel, payload: unknown) => void
}

/**
 * R 侧 `auto_unbox` 会把**长度为 1 的数组**塌缩成标量（字符串/对象）。
 *
 * 于是 `summary$genes` 在「只查 1 个基因」时是 `"LOC_Os03g54160"` 而不是数组，
 * 直接 `.map()` 会抛 `is not a function`（实测踩过：曲线那一步整块报 E_UNKNOWN）。
 * 所有来自 R 的列表字段一律过这个函数。
 */
function toArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  if (v == null) return []
  return [v as T]
}

/** 读文件头：BOM 判断编码（客户的 .txt 是 UTF-16LE + BOM） */
function detectEncoding(buf: Buffer): 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'UTF-16LE'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'UTF-16BE'
  return 'UTF-8'
}

function decode(buf: Buffer, enc: 'UTF-8' | 'UTF-16LE' | 'UTF-16BE'): string {
  if (enc === 'UTF-8') return buf.toString('utf8')
  return iconv.decode(buf, enc === 'UTF-16LE' ? 'utf16-le' : 'utf16-be')
}

/**
 * 统计**有效基因行数**（第一列非空的数据行），并报告被忽略的行数。
 *
 * ★ 不能只数换行符：客户的 `fpkm109dtck.txt` 末尾多一个空行
 *   （`NF=1`，只有一个分隔符）。`read.table` 会正确忽略它，分析用的是 55,801；
 *   但按换行数统计会多算 1 个 —— 预览显示 55,802，用户拿去和自己的表对账
 *   就会发现「少了一个基因」，进而怀疑分析丢数据。
 *   实测踩过：预览 55,802 vs 结果卡 55,801。
 *
 * @returns rows 有效行数；ignored 被忽略的空行/首列为空的行数
 */
function countGeneRows(text: string): { rows: number; ignored: number } {
  const lines = text.split('\n')
  let rows = 0
  let ignored = 0
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '')
    if (line.trim() === '') {
      // 最后一行是文件末尾的换行会产生一个空串，不算「被忽略的行」
      if (i < lines.length - 1) ignored += 1
      continue
    }
    const firstField = line.slice(0, Math.max(0, line.indexOf('\t') === -1 ? line.length : line.indexOf('\t')))
    if (firstField.trim() === '') ignored += 1
    else rows += 1
  }
  return { rows, ignored }
}

/**
 * 从样本名里抠出 (time, rep)。
 *
 * 客户的命名是 `S_IR09_W_B1`：组 W、时间 B、重复 1。
 * 支持三种常见写法：
 *   · `A1`     → time=A, rep=1
 *   · `1d`     → time=1d, rep=''（没有重复编号）
 *   · `3d2`    → time=3d, rep=2
 */
function splitTimeRep(token: string): { time: string; rep: string } {
  const t = token.trim()
  if (!t) return { time: '', rep: '' }
  let m = /^([A-Za-z]+)(\d+)$/.exec(t) // A1 → A / 1
  if (m) return { time: m[1], rep: m[2] }
  m = /^(\d+[A-Za-z]+)(\d+)$/.exec(t) // 3d2 → 3d / 2
  if (m) return { time: m[1], rep: m[2] }
  m = /^(\d+[A-Za-z]*|[A-Za-z]+\d*[A-Za-z]+)$/.exec(t) // 1d / 3 / AB
  if (m) return { time: t, rep: '' }
  return { time: t, rep: '' }
}

/** 时间点排序：有数字按数字（1d < 3d < 7d），否则按自然序（A < B < …） */
function sortTimes(times: string[]): string[] {
  const uniq = Array.from(new Set(times))
  const nums = uniq.map((t) => {
    const digits = t.replace(/[^0-9.]/g, '')
    return digits === '' ? Number.NaN : Number(digits)
  })
  if (uniq.length > 0 && nums.every((n) => Number.isFinite(n))) {
    return uniq.slice().sort((a, b) => nums[uniq.indexOf(a)] - nums[uniq.indexOf(b)])
  }
  return uniq.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

function parseSampleName(name: string, rule: TsParseRule): TsSampleMeta {
  const tokens = name.split(/[_\-.\s]+/).filter((x) => x.length > 0)
  let group = ''
  let token = ''
  if (rule === 'genotype-treatment' && tokens.length >= 3) {
    // S_IR09_D_A1 → 基因型 IR09（倒数第三段）+ 处理 D（倒数第二段）
    // 前缀 S_/T_ 是样本来源标记，不进组名（含义未知，不猜）
    //
    // ★ 分隔符必须用下划线：`-` 既不是合法的 R 因子水平（moanin 用 make.names()
    //   校验 Group levels，会报 "The levels must by syntactically valid names"），
    //   又和我们自己的对比分隔符 `<g1>-<g2>` 撞车（`IR09-D-IR09-W` 会被拆成 4 段）。
    token = tokens[tokens.length - 1]
    group = `${tokens[tokens.length - 3]}_${tokens[tokens.length - 2]}`
  } else if (rule === 'group-time-rep' && tokens.length >= 2) {
    token = tokens[tokens.length - 1]
    group = tokens[tokens.length - 2]
  } else if (tokens.length >= 1) {
    token = tokens[tokens.length - 1]
  } else {
    token = name
  }
  const { time, rep } = splitTimeRep(token)
  return { name, group, time, rep, ok: time.length > 0 }
}

export class TimeSeriesService {
  constructor(private readonly deps: TimeSeriesServiceDeps) {}

  /**
   * 只读表头 → 样本解析预览。**不起 R**。
   *
   * 用户的矩阵可能有 5 万行 × 21 列，但这里只需要第一行；
   * 行数用字节扫描数出来（不解码全文），10 MB 的 UTF-16 文件也在几十毫秒内。
   */
  inspectMatrix(input: TsInspectRequest): TsInspectResult {
    if (!input.path || !fs.existsSync(input.path)) {
      throw toAppError('E_DATA_EMPTY', {
        message: `找不到文件：${path.basename(input.path || '')}`,
        suggestion: '请重新选择表达矩阵（tab 分隔的 .txt / .tsv）。'
      })
    }
    const rule: TsParseRule =
      input.rule === 'time-rep'
        ? 'time-rep'
        : input.rule === 'genotype-treatment'
          ? 'genotype-treatment'
          : 'group-time-rep'
    const buf = fs.readFileSync(input.path)
    const enc = detectEncoding(buf)
    const text = decode(buf, enc)

    const newline = text.indexOf('\n')
    const headerLine = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, '')
    const header = headerLine.split('\t')
    if (header.length < 2) {
      throw toAppError('E_DATA_EMPTY', {
        message: '这不是 tab 分隔的矩阵（表头只有一列）。',
        suggestion: '第一列是基因 ID，其余列是样本；列之间用制表符分隔（.txt / .tsv）。'
      })
    }
    const geneRows = countGeneRows(text)
    const samples = header.slice(1).map((n) => parseSampleName(n.trim(), rule))
    const unparsed = samples.filter((s) => !s.ok).map((s) => s.name)
    logger.info(
      'timeseries',
      `解析表头：${path.basename(input.path)}（${enc}）→ ${samples.length} 样本，` +
        `时间点 ${sortTimes(samples.map((s) => s.time).filter(Boolean)).join(',')}`
    )
    return {
      path: input.path,
      encoding: enc,
      delimiter: '\t',
      geneColumn: header[0].replace(/^\uFEFF/, ''),
      samples,
      times: sortTimes(samples.map((s) => s.time).filter((t) => t.length > 0)),
      groups: Array.from(new Set(samples.map((s) => s.group).filter((g) => g.length > 0))),
      nGenes: geneRows.rows,
      ignoredRows: geneRows.ignored,
      nSamples: samples.length,
      rule,
      unparsed
    }
  }

  /** 跑一次 SAM 时序分析（返回全基因表，阈值过滤在界面做） */
  async run(input: TsRunRequest): Promise<TsRunResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行时序分析。',
        suggestion: '请先打开一个项目。'
      })
    }
    if (!input.path || !fs.existsSync(input.path)) {
      throw toAppError('E_DATA_EMPTY', { message: '找不到表达矩阵文件。', suggestion: '请重新选择。' })
    }
    const samples = (input.samples ?? []).filter((s) => s && s.name)
    if (samples.length < 6) {
      throw toAppError('E_VALIDATION', {
        message: `样本太少（${samples.length} 个）。`,
        suggestion: '时序分析至少需要 3 个时间点 × 2 个重复。'
      })
    }
    if (samples.some((s) => !s.time || !s.time.trim())) {
      throw toAppError('E_VALIDATION', {
        message: '有样本没有时间点。',
        suggestion: '在上面的预览表里补齐「时间点」列（解析失败的行已标红）。'
      })
    }

    const tsId = `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    const runDir = path.join(root, 'results', 'timeseries', tsId)
    fs.mkdirSync(runDir, { recursive: true })

    const params = {
      matrixFile: input.path,
      samples: samples.map((s) => ({
        name: s.name,
        group: s.group ?? '',
        time: s.time,
        rep: s.rep ?? ''
      })),
      log2: input.log2 !== false,
      minSamplesExpr: input.minSamplesExpr,
      nperm: input.nperm,
      fdr: input.fdr,
      absD: input.absD,
      seed: 1,
      skipFonts: true
    }
    // 曲线那一步要复用同一份映射（用户可能改了时间点），所以落一份元信息
    fs.writeFileSync(
      path.join(runDir, 'run_meta.json'),
      JSON.stringify(
        { path: input.path, samples: params.samples, log2: params.log2, minSamplesExpr: params.minSamplesExpr },
        null,
        2
      ),
      'utf8'
    )

    logger.info(
      'timeseries',
      `启动 SAM 时序 ${tsId}: ${path.basename(input.path)} / ${samples.length} 样本 / ` +
        `nperm=${input.nperm} / q<=${input.fdr} / |d|>=${input.absD}`
    )

    const result = await this.deps.runner.run({
      runId: tsId,
      scriptRelPath: 'timeseries/run_sam_timecourse.R',
      config: { runId: tsId, runDir, projectRoot: root, params },
      runDir,
      timeoutMs: RUN_TIMEOUT_MS,
      requiredPackages: ['samr'],
      onProgress: (p) => this.emitProgress(tsId, p),
      onLog: (l) => this.emitLog(tsId, l)
    })
    this.ensureOk(result, '时序分析（SAM）')

    const allCsv = path.join(runDir, 'sam_all.csv')
    const sigCsv = path.join(runDir, 'sam_sig.csv')
    if (!fs.existsSync(allCsv)) {
      throw toAppError('E_RESULT_INVALID', {
        message: 'R 报告成功，但没有写出 sam_all.csv。',
        suggestion: '请展开原始日志查看详情。'
      })
    }
    const fdr = input.fdr
    const absD = input.absD
    const rows: TsGeneRow[] = parseCsv(fs.readFileSync(allCsv, 'utf-8')).map((r) => {
      const scoreD = Number(r.score_d ?? 0)
      const qValue = Number(r.q_value ?? 1)
      return {
        gene: String(r.gene ?? ''),
        direction: scoreD >= 0 ? ('up' as const) : ('down' as const),
        scoreD,
        qValue,
        numerator: Number(r.numerator_r ?? 0),
        denominator: Number(r.denominator_s_s0 ?? 0),
        significant: Math.abs(scoreD) >= absD && qValue <= fdr
      }
    })

    const raw = (result.summary ?? {}) as Record<string, unknown>
    const summary: TsRunSummary = {
      matrixFile: String(raw.matrixFile ?? path.basename(input.path)),
      encoding: String(raw.encoding ?? ''),
      nGenesInput: Number(raw.nGenesInput ?? 0),
      nGenes: Number(raw.nGenes ?? rows.length),
      nSig: Number(raw.nSig ?? 0),
      nUp: Number(raw.nUp ?? 0),
      nDown: Number(raw.nDown ?? 0),
      times: toArray<string>(raw.times).map(String),
      nSamples: Number(raw.nSamples ?? samples.length),
      nSeries: Number(raw.nSeries ?? 0),
      log2: raw.log2 !== false,
      minSamplesExpr: Number(raw.minSamplesExpr ?? input.minSamplesExpr),
      nperm: Number(raw.nperm ?? input.nperm),
      fdr: Number(raw.fdr ?? input.fdr),
      absD: Number(raw.absD ?? input.absD),
      dRange: toArray<number>(raw.dRange).map(Number),
      qRange: toArray<number>(raw.qRange).map(Number),
      durationMs: Number(raw.durationMs ?? result.durationMs ?? 0)
    }

    return {
      tsId,
      runDir,
      rows,
      summary,
      files: {
        all: allCsv,
        sig: sigCsv,
        delta: path.join(runDir, 'delta_table.csv')
      }
    }
  }

  /**
   * 两组 × 时间（moanin）。与单序列的 SAM 是两套统计，各自一个通道。
   *
   * 一次跑完：样条模型 → 每个对比的 DE → 五种 lfc → Fisher 合并 → k-means → 5 张图。
   * 实测（39 样本 / 18,740 基因）约 7 秒。
   */
  async runMoanin(input: TsMoaninRequest): Promise<TsMoaninResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', {
        message: '还没有打开项目，无法运行两组时序分析。',
        suggestion: '请先打开一个项目。'
      })
    }
    if (!input.path || !fs.existsSync(input.path)) {
      throw toAppError('E_DATA_EMPTY', { message: '找不到表达矩阵文件。', suggestion: '请重新选择。' })
    }
    const samples = (input.samples ?? []).filter((s) => s && s.name)
    const groups = Array.from(new Set(samples.map((s) => s.group).filter(Boolean)))
    const times = Array.from(new Set(samples.map((s) => s.time).filter(Boolean)))
    if (groups.length < 2) {
      throw toAppError('E_VALIDATION', {
        message: `两组模式至少需要 2 个组，当前只有 ${groups.length} 个。`,
        suggestion: '只有一组（单序列）请用上面的 SAM 模式；或在预览表里把「组」改成两组。'
      })
    }
    // ★ df 的上限 = 时间点数 - 2：df = nTime-1 时样条基饱和，所有 p/q 变成 NA
    const maxDf = Math.max(2, times.length - 2)
    if (input.degreesOfFreedom < 2 || input.degreesOfFreedom > maxDf) {
      throw toAppError('E_VALIDATION', {
        message: `degrees_of_freedom 必须在 2 ~ ${maxDf} 之间（当前 ${input.degreesOfFreedom}，时间点 ${times.length} 个）。`,
        suggestion: `df ≥ ${times.length - 1} 会让样条基饱和、所有 q 值变成 NA（看起来像「0 个显著基因」）。`
      })
    }

    const tsId = `mo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    const runDir = path.join(root, 'results', 'timeseries', tsId)
    fs.mkdirSync(runDir, { recursive: true })

    logger.info(
      'timeseries',
      `启动 moanin 两组时序 ${tsId}: ${path.basename(input.path)} / ${samples.length} 样本 / ` +
        `${groups.length} 组 / df=${input.degreesOfFreedom} / nClusters=${input.nClusters}`
    )
    const result = await this.deps.runner.run({
      runId: tsId,
      scriptRelPath: 'timeseries/run_moanin_timecourse.R',
      config: {
        runId: tsId,
        runDir,
        projectRoot: root,
        params: {
          matrixFile: input.path,
          samples: samples.map((s) => ({
            name: s.name,
            group: s.group ?? '',
            time: s.time,
            rep: s.rep ?? ''
          })),
          degreesOfFreedom: input.degreesOfFreedom,
          varianceCutoff: input.varianceCutoff,
          contrasts: input.contrasts ?? [],
          nClusters: input.nClusters,
          fdr: input.fdr,
          lfcCutoff: input.lfcCutoff,
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: RUN_TIMEOUT_MS,
      requiredPackages: ['moanin'],
      onProgress: (p) => this.emitProgress(tsId, p),
      onLog: (l) => this.emitLog(tsId, l)
    })
    this.ensureOk(result, '两组时序分析（moanin）')

    const deCsv = path.join(runDir, 'de_all.csv')
    if (!fs.existsSync(deCsv)) {
      throw toAppError('E_RESULT_INVALID', {
        message: 'R 报告成功，但没有写出 de_all.csv。',
        suggestion: '请展开原始日志查看详情。'
      })
    }
    const rows: TsMoaninRow[] = parseCsv(fs.readFileSync(deCsv, 'utf-8')).map((r) => {
      const fisherQ = Number(r.fisher_q ?? Number.NaN)
      const lfcMax = Number(r.lfc_max ?? 0)
      return {
        gene: String(r.gene ?? ''),
        contrast: String(r.contrast ?? ''),
        stat: Number(r.stat ?? Number.NaN),
        pval: Number(r.pval ?? Number.NaN),
        qval: Number(r.qval ?? Number.NaN),
        lfcTimecourse: Number(r.lfc_timecourse ?? 0),
        lfcSum: Number(r.lfc_sum ?? 0),
        lfcMax,
        lfcMin: Number(r.lfc_min ?? 0),
        fisherQ: Number.isFinite(fisherQ) ? fisherQ : Number.NaN,
        cluster: r.cluster && r.cluster !== 'NA' ? Number(r.cluster) : null,
        selected:
          Number.isFinite(fisherQ) && fisherQ < input.fdr && lfcMax > input.lfcCutoff
      }
    })

    const raw = (result.summary ?? {}) as Record<string, unknown>
    const summary: TsMoaninSummary = {
      matrixFile: String(raw.matrixFile ?? path.basename(input.path)),
      encoding: String(raw.encoding ?? ''),
      nGenesRaw: Number(raw.nGenesRaw ?? 0),
      nGenesNonZero: Number(raw.nGenesNonZero ?? 0),
      nGenesFiltered: Number(raw.nGenesFiltered ?? 0),
      madThreshold: Number(raw.madThreshold ?? 0),
      varianceCutoff: Number(raw.varianceCutoff ?? input.varianceCutoff),
      degreesOfFreedom: Number(raw.degreesOfFreedom ?? input.degreesOfFreedom),
      maxDegreesOfFreedom: Number(raw.maxDegreesOfFreedom ?? maxDf),
      nTime: Number(raw.nTime ?? times.length),
      times: toArray<string>(raw.times).map(String),
      groups: toArray<string>(raw.groups).map(String),
      nSamples: Number(raw.nSamples ?? samples.length),
      contrasts: toArray<string>(raw.contrasts).map(String),
      qCounts: toArray<Record<string, unknown>>(raw.qCounts).map((q) => ({
        contrast: String(q.contrast ?? ''),
        q05: Number(q.q05 ?? 0),
        q01: Number(q.q01 ?? 0)
      })),
      nSelected: Number(raw.nSelected ?? 0),
      nClusters: Number(raw.nClusters ?? input.nClusters),
      clusterSizes: toArray<number>(raw.clusterSizes).map(Number),
      seed: Number(raw.seed ?? 42),
      lfcCutoff: Number(raw.lfcCutoff ?? input.lfcCutoff),
      fdr: Number(raw.fdr ?? input.fdr),
      durationMs: Number(raw.durationMs ?? result.durationMs ?? 0)
    }

    const plotRows = toArray<{ id: string; file: string; caption: string; contrast?: string }>(
      raw.plots
    )
    return {
      tsId,
      runDir,
      rows,
      summary,
      files: {
        all: deCsv,
        sig: path.join(runDir, 'de_sig.csv'),
        timely: path.join(runDir, 'lfc_timely.csv'),
        clusters: path.join(runDir, 'gene_clusters.csv')
      },
      plots: plotRows.map((pl) => ({
        id: String(pl.id ?? ''),
        caption: String(pl.caption ?? ''),
        contrast: String(pl.contrast ?? ''),
        file: String(pl.file ?? ''),
        dataUrl: this.readPlot(runDir, String(pl.file ?? ''))
      }))
    }
  }

  /**
   * 两组模式的「自选基因曲线」：读主分析存下的 `moanin_bundle.rds`，
   * 不重跑拟合（否则画 3 个基因要等 20 秒）。
   */
  async moaninCurves(input: TsMoaninCurvesRequest): Promise<TsMoaninCurvesResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    const runDir = path.join(root, 'results', 'timeseries', input.tsId)
    const bundle = path.join(runDir, 'moanin_bundle.rds')
    if (!fs.existsSync(bundle)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到这次分析保存的模型（moanin_bundle.rds）。',
        suggestion: '请重新运行两组分析（旧版本跑的结果没有保存模型）。'
      })
    }
    const genes = (input.genes ?? []).map((g) => g.trim()).filter((g) => g.length > 0)
    if (genes.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有填基因。',
        suggestion: '在输入框里粘贴基因名（换行 / 逗号 / 空格分隔都行）。'
      })
    }

    const result = await this.deps.runner.run({
      runId: `${input.tsId}-mocurves`,
      scriptRelPath: 'timeseries/run_moanin_curves.R',
      config: {
        runId: `${input.tsId}-mocurves`,
        runDir,
        projectRoot: root,
        params: { bundleFile: bundle, genes, skipFonts: true }
      },
      runDir,
      timeoutMs: CURVES_TIMEOUT_MS,
      requiredPackages: ['moanin', 'ggplot2'],
      onProgress: (p) => this.emitProgress(input.tsId, p),
      onLog: (l) => this.emitLog(input.tsId, l)
    })
    this.ensureOk(result, '两组自选基因曲线')

    const raw = (result.summary ?? {}) as Record<string, unknown>
    const plotRows = toArray<{ id: string; file: string; caption: string }>(raw.plots)
    return {
      tsId: input.tsId,
      genes: toArray<string>(raw.genes).map(String),
      missingGenes: toArray<string>(raw.missingGenes).map(String),
      notSignificant: toArray<string>(raw.notSignificant).map(String),
      groups: toArray<string>(raw.groups).map(String),
      times: toArray<string>(raw.times).map(String),
      nGenes: Number(raw.nGenes ?? 0),
      plots: plotRows.map((pl) => ({
        id: String(pl.id ?? ''),
        caption: String(pl.caption ?? ''),
        file: String(pl.file ?? ''),
        dataUrl: this.readPlot(runDir, String(pl.file ?? ''))
      })),
      durationMs: Number(raw.durationMs ?? result.durationMs ?? 0)
    }
  }

  /** 自选基因的时序曲线（复用同一次运行的样本映射与过滤口径） */
  async curves(input: TsCurvesRequest): Promise<TsCurvesResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) {
      throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    }
    const runDir = path.join(root, 'results', 'timeseries', input.tsId)
    const metaPath = path.join(runDir, 'run_meta.json')
    if (!fs.existsSync(metaPath)) {
      throw toAppError('E_RESULT_INVALID', {
        message: '找不到这次运行的元信息（run_meta.json）。',
        suggestion: '请重新运行时序分析。'
      })
    }
    const genes = (input.genes ?? []).map((g) => g.trim()).filter((g) => g.length > 0)
    if (genes.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '还没有填基因。',
        suggestion: '在上面的输入框里粘贴基因名（换行 / 逗号 / 空格分隔都行）。'
      })
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      path: string
      samples: { name: string; group: string; time: string; rep: string }[]
      log2: boolean
      minSamplesExpr: number
    }

    const result = await this.deps.runner.run({
      runId: `${input.tsId}-curves`,
      scriptRelPath: 'timeseries/run_timecourse_curves.R',
      config: {
        runId: `${input.tsId}-curves`,
        runDir,
        projectRoot: root,
        params: {
          matrixFile: meta.path,
          samples: meta.samples,
          genes,
          log2: meta.log2,
          minSamplesExpr: meta.minSamplesExpr,
          skipFonts: true
        }
      },
      runDir,
      timeoutMs: CURVES_TIMEOUT_MS,
      requiredPackages: ['ggplot2'],
      onProgress: (p) => this.emitProgress(input.tsId, p),
      onLog: (l) => this.emitLog(input.tsId, l)
    })
    this.ensureOk(result, '时序曲线')

    const raw = (result.summary ?? {}) as Record<string, unknown>
    const plotRows = toArray<{ id: string; file: string; caption: string }>(raw.plots)
    return {
      tsId: input.tsId,
      genes: toArray<string>(raw.genes).map(String),
      missingGenes: toArray<string>(raw.missingGenes).map(String),
      notSignificant: toArray<string>(raw.notSignificant).map(String),
      times: toArray<string>(raw.times).map(String),
      groups: toArray<string>(raw.groups).map(String),
      nSamples: Number(raw.nSamples ?? 0),
      multiGroup: raw.multiGroup === true,
      plots: plotRows.map((p) => ({
        id: String(p.id ?? ''),
        caption: String(p.caption ?? ''),
        file: String(p.file ?? ''),
        dataUrl: this.readPlot(runDir, String(p.file ?? ''))
      })),
      durationMs: Number(raw.durationMs ?? result.durationMs ?? 0)
    }
  }

  /** 导出单张图（png / pdf）到用户选的位置 */
  exportPlot(input: { tsId: string; file: string; format: 'png' | 'pdf'; outPath: string }) {
    const root = this.deps.projectStore.getRoot()
    if (!root) throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    return copyFigure({
      runDir: path.join(root, 'results', 'timeseries', input.tsId),
      file: input.file,
      format: input.format,
      outPath: input.outPath
    })
  }

  /** 批量导出该次分析的全部图（pdf） */
  exportAllPlots(input: { tsId: string; outDir: string; files?: string[] }) {
    const root = this.deps.projectStore.getRoot()
    if (!root) throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    return copyAllFigures({
      runDir: path.join(root, 'results', 'timeseries', input.tsId),
      outDir: input.outDir,
      files: input.files
    })
  }

  /** 导出结果表：csv 直拷（几十万行也不进内存），xlsx 由主进程转 */
  async exportTable(input: TsExportTableRequest): Promise<TsExportTableResult> {
    const root = this.deps.projectStore.getRoot()
    if (!root) throw toAppError('E_VALIDATION', { message: '还没有打开项目。' })
    const runDir = path.join(root, 'results', 'timeseries', input.tsId)
    // sam_* 是单序列 SAM 的表；moanin_* 是两组模式的两张表
    const name =
      input.which === 'sig'
        ? 'sam_sig.csv'
        : input.which === 'moanin_all'
          ? 'de_all.csv'
          : input.which === 'moanin_sig'
            ? 'de_sig.csv'
            : 'sam_all.csv'
    const src = path.join(runDir, name)
    if (!fs.existsSync(src)) {
      throw toAppError('E_RESULT_INVALID', {
        message: `找不到 ${name}。`,
        suggestion: '请先完成一次时序分析。'
      })
    }
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true })
    if (input.format === 'csv') {
      fs.copyFileSync(src, input.outPath)
    } else {
      await writeXlsx(src, input.outPath, 'timeseries')
    }
    return {
      outPath: input.outPath,
      bytes: fs.statSync(input.outPath).size,
      rows: countCsvDataRows(src)
    }
  }

  private readPlot(runDir: string, file: string): string | null {
    if (!file) return null
    const p = path.join(runDir, file)
    if (!fs.existsSync(p)) {
      logger.warn('timeseries', `图未生成：${file}`)
      return null
    }
    return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
  }

  private ensureOk(result: RunRResult, label: string): void {
    if (result.ok) return
    if (result.stderr) {
      logger.error('timeseries', `${label}失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2500)}`)
    }
    throw (
      result.error ??
      toAppError('E_R_GENERIC', { message: `${label}失败。`, suggestion: '请展开原始日志查看详情。' })
    )
  }

  private emitProgress(runId: string, p: ProgressMessage): void {
    this.deps.emit(IPC.event.analysisProgress, { runId, stage: p.stage, pct: p.pct, msg: p.msg })
  }

  private emitLog(runId: string, l: LogMsg): void {
    this.deps.emit(IPC.event.analysisLog, { runId, ts: l.ts, level: l.level, line: l.line })
  }
}
