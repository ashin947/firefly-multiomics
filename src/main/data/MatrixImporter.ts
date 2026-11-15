/**
 * 表达矩阵导入器（ARCHITECTURE §9 T07 / PRD §8.1、R-04、R-06、R-07）。
 *
 * 设计要点：
 *  1. **原始文件与清洗结果分开落盘**：
 *     `data/expression.raw.csv`（原样，UTF-8 无 BOM）与 `data/expression.clean.csv`
 *     （`gene_id` + 样本列，逗号分隔，R 的 data.table::fread 可直接读）。
 *     用户改主意（换基因 ID 列 / 换重复基因聚合策略）时从 raw.csv 重跑，
 *     不必再让用户选一次文件，也不会因为反复解析原始编码而出错。
 *  2. **重复基因绝不静默处理**：发现重复名且用户没给策略时，返回
 *     `requiresChoice: true` 且**不写 clean.csv**（带重复 rownames 的矩阵会让 R 报错），
 *     UI 必须让用户选聚合方式后再调 `aggregateDuplicates`。
 *  3. **非数值单元格定位到行列**：PRD §8.3 要求「第 4 列 S03 第 128 行为 NA_1」这种精度，
 *     所以每个坏单元格都记录 {row, column, raw}（最多 200 条明细 + 总数）。
 *  4. **全零行自动过滤并告知**：不静默丢数据，也不让 0 方差基因污染下游统计。
 */
import fs from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import { PROJECT_FILES } from '@shared/constants'
import { toAppError, type AppError } from '@shared/errors'
import type {
  DatasetSummary,
  DuplicateGeneChoice,
  DuplicateStrategy,
  GeneIdType,
  ImportMatrixResult,
  Issue
} from '@shared/types/dataset'
import type { DataType, Species } from '@shared/types/project'
import { logger } from '../logger'
import { FileSniffer, SnifferError, type SniffOutcome } from './FileSniffer'

/** 携带结构化错误的导入异常（handler 统一转 IpcResult） */
export class DataImportError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'DataImportError'
  }
}

export interface MatrixImportOptions {
  filePath: string
  dataType: DataType
  species: Species
  /** 用户手工指定的基因 ID 列（默认取第一列） */
  geneIdColumn?: string
  /** 重复基因聚合策略；不给且存在重复时返回 requiresChoice */
  duplicateStrategy?: DuplicateStrategy
  /** 项目根目录；给了才落盘（单测可以不落盘） */
  projectRoot?: string
}

/**
 * 参与解析的选项子集（缓存里只留这些）。
 *
 * `dataType` / `species` 不参与任何解析或清洗计算（它们只用于落 project.json，由 handler
 * 负责），所以不进缓存。这样「重启后从 clean.csv 只读恢复」时也不必为这两个字段编造
 * 占位值——缓存里根本没有它们，就不会有人误以为它们是可信的。
 */
export type ParsingOptions = Pick<MatrixImportOptions, 'filePath' | 'geneIdColumn' | 'duplicateStrategy'>

/** 4 个聚合选项（顺序固定，UI 直接渲染） */
export const DUPLICATE_STRATEGIES: { value: DuplicateStrategy; label: string }[] = [
  { value: 'mean', label: '取均值' },
  { value: 'sum', label: '求和' },
  { value: 'max', label: '保留最大表达' },
  { value: 'first', label: '保留第一条' }
]

/** 视为缺失值的标记（PRD §8.1：允许 NA / 空 / NaN） */
const NA_TOKENS = new Set(['', 'na', 'n/a', 'nan', 'null', 'nil', 'none', '-', '.', '?'])

/** 单个文件里最多记录多少个坏单元格明细（避免上百万条 Issue 撑爆 IPC） */
const MAX_CELL_DETAILS = 200

/** 预览行数（PRD R-07：前 100 行） */
const PREVIEW_ROWS = 100

/** 超过这个单元格数就不下发全量 ExpressionPayload（避免一次 IPC 传几 MB） */
const MAX_EXPRESSION_CELLS = 500_000

/** 源文件信息（供校验规则复检编码/列数） */
export interface ImportSourceInfo {
  fileSizeBytes: number
  headerColumnCount: number
  dataRowCount: number
  encoding: 'utf-8' | 'gb18030'
}

/** 清洗后的内部状态（供校验器与重复聚合复用） */
export interface CleanedMatrix {
  geneIds: string[]
  samples: string[]
  /** 行优先扁平数组，NaN 表示缺失 */
  values: Float64Array
  /** 1 = 该位置是 NA */
  naMask: Uint8Array
  geneCount: number
  sampleCount: number
  naRatio: number
  allZeroGeneCount: number
  nonNumericCount: number
  nonNumericDetails: { row: number; column: string; raw: string }[]
  duplicateGenes: { name: string; count: number }[]
  duplicateSamples: string[]
  geneIdType: GeneIdType
  /** 原始文件行号（含表头，表头 = 1）与基因 ID 的映射，供定位 */
  rowNumbers: number[]
}

interface CachedSource {
  /** 实际解析用的文件（首次是用户文件，之后是 raw.csv） */
  sourcePath: string
  encoding: 'utf-8' | 'gb18030'
  delimiter: ',' | '\t' | ';'
  projectRoot: string | null
  options: ParsingOptions
}

export class MatrixImporter {
  private readonly sniffer = new FileSniffer()
  private cache: CachedSource | null = null

  /** 最近一次清洗结果（DataValidator / GeneIdResolver 直接取用，避免重复解析） */
  private lastCleaned: CleanedMatrix | null = null

  /** 最近一次导入的摘要（validate 时在此基础上补 groups / issues） */
  private lastSummary: DatasetSummary | null = null

  /** 源文件信息（供第 11/12 条校验规则复检） */
  private lastSource: ImportSourceInfo | null = null

  /** 导入矩阵（首次导入） */
  importMatrix(options: MatrixImportOptions): ImportMatrixResult {
    const sniff = this.sniffer.sniff(options.filePath)
    const projectRoot = options.projectRoot ?? null

    // 1) 先落 raw.csv（原样 UTF-8），后续所有「改主意」的重跑都基于它
    if (projectRoot) {
      this.writeRaw(sniff, projectRoot)
    }

    this.cache = {
      sourcePath: options.filePath,
      encoding: sniff.encoding,
      delimiter: sniff.delimiter,
      projectRoot,
      options
    }

    const result = this.build(sniff, options, projectRoot)
    logger.info(
      'data',
      `导入矩阵 ${path.basename(options.filePath)} ${result.summary.geneCount}×${result.summary.sampleCount} ` +
        `编码=${sniff.encoding} 分隔符=${JSON.stringify(sniff.delimiter)} 重复基因=${result.duplicateChoice?.totalDuplicateGenes ?? 0}`
    )
    return result
  }

  /**
   * 从项目里已落盘的 `data/expression.clean.csv` **只读**恢复内存矩阵。
   *
   * 为什么需要它：`MatrixImporter` 是纯内存态。重启软件后「自动恢复上次项目」只能把
   * meta / dataset / expression 放回渲染层，主进程这边仍然是空的——用户点「校验」得到
   * `E_DATA_EMPTY：尚未导入表达矩阵`，数据明明在磁盘上，界面却说没有。
   *
   * ★ 为什么绝不走 `importMatrix()`：它第一步就是 `writeRaw()`，把入参文件原样回写成
   *   `data/expression.raw.csv`。恢复场景传入的是 **clean.csv**，一旦回写就会用清洗结果
   *   覆盖用户的原始矩阵——NA 标记、非数值单元格、重复基因行全部消失，且**不可逆**
   *   （之后「换基因 ID 列 / 换聚合策略」都基于被污染的 raw.csv 重跑）。
   *   所以这里只做三件事：解析、填内存态、返回结果；**一个字节都不写**。
   *
   * @param projectRoot 项目根。只记进缓存，供后续 `rebuild()` 定位 raw.csv
   * @param matrixPath `data/expression.clean.csv` 的绝对路径
   * @param persistedSummary 项目里落盘的摘要。`matrixSourceFile` / `geneIdColumn` /
   *   `duplicateStrategy` / `groups` 这几项**无法**从 clean.csv 反推（clean.csv 的列名
   *   固定是 `gene_id`，重复基因在导入时就已聚合），只能从这里补。缺了它们，下一次
   *   `validate` 会把 project.json 的 dataset 覆盖成一份丢了「来源文件」的摘要。
   * @returns 恢复结果；文件不存在或解析失败返回 `null`（调用方按原有错误路径处理）
   */
  restoreFromProject(
    projectRoot: string,
    matrixPath: string,
    persistedSummary?: DatasetSummary | null
  ): ImportMatrixResult | null {
    try {
      if (!fs.existsSync(matrixPath)) return null

      const sniff = this.sniffer.sniff(matrixPath)
      // 第三个参数传 null：build() 只负责解析与组装，不许写 clean.csv，更不许碰 raw.csv
      const result = this.build(sniff, { filePath: matrixPath }, null)

      // 能从磁盘反推的字段以 clean.csv 为准（project.json 与文件不一致时，内存态说真话）；
      // 反推不出来的字段由落盘摘要补。
      const summary: DatasetSummary = {
        ...(persistedSummary ?? result.summary),
        matrixPath: PROJECT_FILES.cleanMatrix,
        rawMatrixPath: PROJECT_FILES.rawMatrix,
        geneCount: result.summary.geneCount,
        sampleCount: result.summary.sampleCount,
        samples: result.summary.samples,
        geneIdType: result.summary.geneIdType,
        naRatio: result.summary.naRatio,
        allZeroGeneCount: result.summary.allZeroGeneCount
      }
      this.lastSummary = summary

      /**
       * 源文件信息（原始文件的字节数 / 表头列数）恢复不出来：它描述的是用户当初选的那个
       * 文件，不是 clean.csv。宁可置空、让第 11、12 条按「无源信息」跳过，也不能拿
       * clean.csv 的统计冒充——那样这两条会永远通过，变成假绿。
       */
      this.lastSource = null

      this.cache = {
        sourcePath: matrixPath,
        encoding: sniff.encoding,
        delimiter: sniff.delimiter,
        // 真实项目根：后续 setGeneIdColumn / aggregateDuplicates 的 rebuild() 会优先读
        // raw.csv（原始矩阵），而不是在 clean.csv 上二次清洗。
        projectRoot,
        options: {
          filePath: matrixPath,
          geneIdColumn: summary.geneIdColumn,
          duplicateStrategy: summary.duplicateStrategy
        }
      }

      logger.info(
        'data',
        `从 ${PROJECT_FILES.cleanMatrix} 恢复内存矩阵 ${summary.geneCount}×${summary.sampleCount}（只读，未改写 raw.csv）`
      )
      return { ...result, summary }
    } catch (err) {
      // 恢复是优化，不是前置条件：失败就把内存态清干净，让调用方按原来的错误路径报错，
      // 用户看到的文案与修复前一致（不会出现「恢复失败」这种没人能处理的提示）。
      logger.warn('data', `恢复内存矩阵失败：${err instanceof Error ? err.message : String(err)}`)
      this.reset()
      return null
    }
  }

  /**
   * 换基因 ID 列后重新清洗（PRD R-07）。
   * 从 raw.csv 重跑：raw.csv 已经是 UTF-8 逗号分隔，不会再遇到编码问题。
   */
  setGeneIdColumn(column: string): ImportMatrixResult {
    const cached = this.requireCache('更换基因 ID 列')
    const next: ParsingOptions = { ...cached.options, geneIdColumn: column }
    return this.rebuild(next)
  }

  /** 选择重复基因聚合策略后重新清洗（PRD §8.1：必须显式选择） */
  aggregateDuplicates(strategy: DuplicateStrategy): ImportMatrixResult {
    const cached = this.requireCache('聚合重复基因')
    const next: ParsingOptions = { ...cached.options, duplicateStrategy: strategy }
    return this.rebuild(next)
  }

  /** 最近一次清洗结果（未导入时返回 null） */
  getCleaned(): CleanedMatrix | null {
    return this.lastCleaned
  }

  /** 当前是否已导入过矩阵 */
  hasData(): boolean {
    return this.lastCleaned !== null
  }

  /** 最近一次导入摘要（未导入时为 null） */
  getLastSummary(): DatasetSummary | null {
    return this.lastSummary
  }

  /** 源文件信息（编码/列数/行数），供 DataValidator 复检第 11、12 条 */
  getSourceInfo(): ImportSourceInfo | null {
    return this.lastSource
  }

  /** 清空缓存（关闭项目时调用，防止串项目） */
  reset(): void {
    this.cache = null
    this.lastCleaned = null
    this.lastSummary = null
    this.lastSource = null
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  private requireCache(action: string): CachedSource {
    if (!this.cache) {
      throw new DataImportError(
        toAppError('E_VALIDATION', {
          message: `尚未导入表达矩阵，无法${action}。`,
          suggestion: '请先在导入向导中选择表达矩阵文件。'
        })
      )
    }
    return this.cache
  }

  /** 从 raw.csv（若存在）重新解析并清洗 */
  private rebuild(options: ParsingOptions): ImportMatrixResult {
    const cached = this.requireCache('重新清洗')
    const rawPath = cached.projectRoot
      ? path.join(cached.projectRoot, PROJECT_FILES.rawMatrix)
      : null
    const sourcePath = rawPath && fs.existsSync(rawPath) ? rawPath : cached.sourcePath

    const sniff = this.sniffer.sniff(sourcePath)
    this.cache = {
      ...cached,
      sourcePath,
      encoding: sniff.encoding,
      delimiter: sniff.delimiter,
      options
    }
    return this.build(sniff, options, cached.projectRoot)
  }

  /** 写 data/expression.raw.csv（UTF-8 无 BOM，内容与源文件等价） */
  private writeRaw(sniff: SniffOutcome, projectRoot: string): void {
    const outPath = path.join(projectRoot, PROJECT_FILES.rawMatrix)
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      if (sniff.kind === 'text') {
        // 文本文件：直接写解码后的内容（把 GBK 转成 UTF-8，其余字节不动）
        fs.writeFileSync(outPath, sniff.text ?? '', 'utf8')
      } else {
        const rows = sniff.rows ?? []
        const body = rows
          .map((row) => row.map((cell) => escapeCsv(cell)).join(','))
          .join('\n')
        fs.writeFileSync(outPath, `${body}\n`, 'utf8')
      }
    } catch (err) {
      throw new DataImportError(
        toAppError('E_IO_PERMISSION', {
          message: '写入 data/expression.raw.csv 失败。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }

  /** 解析 + 清洗 + 落盘 + 组装结果 */
  private build(
    sniff: SniffOutcome,
    options: ParsingOptions,
    projectRoot: string | null
  ): ImportMatrixResult {
    const rows: string[][] = []
    if (sniff.kind === 'excel') {
      for (const row of sniff.rows ?? []) rows.push(row)
    } else {
      const text = sniff.text ?? ''
      // 用 papaparse 的 step 回调逐行消费：不构建 {列名: 值} 对象，
      // 大文件（200 MB）下内存占用比默认模式低一个数量级。
      Papa.parse<string[]>(text, {
        delimiter: sniff.delimiter,
        skipEmptyLines: 'greedy',
        header: false,
        step: (result) => {
          const data = result.data
          rows.push(Array.isArray(data) ? data.map((c) => String(c ?? '')) : [])
        }
      })
    }

    if (rows.length === 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '未识别到任何数据行。',
          suggestion: '请确认文件不是空的，且首行是表头。'
        })
      )
    }

    // ---- 表头 ----
    const hasHeader = sniff.hasHeader
    const header = hasHeader ? rows[0].map((c) => c.trim()) : rows[0].map((_, i) => `V${i + 1}`)
    const dataRows = hasHeader ? rows.slice(1) : rows

    // 表头行号偏移：locator.row 用「文件中的行号」，表头算第 1 行
    const rowOffset = hasHeader ? 2 : 1

    if (header.length < 2) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '未识别到有效数据列，请确认第一列为基因 ID、其后为各样本。',
          suggestion: '如果文件是用分号或制表符分隔的，请另存为 CSV（逗号分隔）后重试。'
        })
      )
    }

    // ---- 基因 ID 列 ----
    const geneIdColumn = options.geneIdColumn?.trim() || header[0]
    const geneIndex = header.indexOf(geneIdColumn)
    if (geneIndex < 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: `指定的基因 ID 列「${geneIdColumn}」在表头中不存在。`,
          suggestion: `可用列名：${header.slice(0, 12).join('、')}`
        })
      )
    }

    const sampleIndexes = header.map((_, i) => i).filter((i) => i !== geneIndex)
    if (sampleIndexes.length === 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '除基因 ID 列外没有样本列。',
          suggestion: '表达矩阵至少需要 1 个样本列。'
        })
      )
    }

    // 样本名：去首尾空格；重复样本名直接阻断（PRD §8.3）
    const rawSamples = sampleIndexes.map((i) => (header[i] ?? '').trim())
    const duplicateSamples = findDuplicates(rawSamples)
    if (duplicateSamples.length > 0) {
      throw new DataImportError(
        toAppError('E_DATA_DUP_SAMPLE', {
          message: `列名 ${duplicateSamples.slice(0, 10).join('、')} 出现多次，请检查表头。`,
          suggestion: '每个样本列名必须唯一（区分大小写）。',
          locator: { column: duplicateSamples[0] }
        })
      )
    }

    // ---- 逐行解析数值 ----
    const geneIds: string[] = []
    const rowNumbers: number[] = []
    const numeric: number[] = []
    const maskArr: number[] = []
    const nonNumericDetails: { row: number; column: string; raw: string }[] = []
    let nonNumericCount = 0
    let naCount = 0
    let allZeroGeneCount = 0

    // 清洗时用的样本名（clean.csv 的表头）；若与 gene_id 冲突则改名并提示
    const samples = rawSamples.map((s) => (s === 'gene_id' ? 'gene_id.sample' : s))

    for (let r = 0; r < dataRows.length; r += 1) {
      const row = dataRows[r] ?? []
      const geneId = (row[geneIndex] ?? '').trim()
      if (!geneId) {
        // 空基因 ID 行：跳过（Excel 常在末尾留空行），不计入统计
        continue
      }
      geneIds.push(geneId)
      rowNumbers.push(r + rowOffset)

      let allZero = true
      let anyValue = false
      for (let s = 0; s < sampleIndexes.length; s += 1) {
        const columnIndex = sampleIndexes[s]
        const rawCell = row[columnIndex] ?? ''
        const parsed = parseCell(rawCell)
        if (parsed.kind === 'na') {
          numeric.push(Number.NaN)
          maskArr.push(1)
          naCount += 1
          allZero = false
        } else if (parsed.kind === 'number') {
          numeric.push(parsed.value)
          maskArr.push(0)
          anyValue = true
          if (parsed.value !== 0) allZero = false
        } else {
          // 非数值：按缺失处理，但必须记录到具体行列（PRD §8.3）
          numeric.push(Number.NaN)
          maskArr.push(1)
          naCount += 1
          allZero = false
          nonNumericCount += 1
          if (nonNumericDetails.length < MAX_CELL_DETAILS) {
            nonNumericDetails.push({
              row: r + rowOffset,
              column: samples[s],
              raw: rawCell.slice(0, 40)
            })
          }
        }
      }
      if (allZero && anyValue) allZeroGeneCount += 1
    }

    if (geneIds.length === 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '未识别到任何基因行（基因 ID 列全为空）。',
          suggestion: '请确认第一列是基因 ID，且不是空列。'
        })
      )
    }

    const rawMatrix: CleanedMatrix = {
      geneIds,
      samples,
      values: Float64Array.from(numeric),
      naMask: Uint8Array.from(maskArr),
      geneCount: geneIds.length,
      sampleCount: samples.length,
      naRatio: maskArr.length === 0 ? 0 : naCount / maskArr.length,
      allZeroGeneCount,
      nonNumericCount,
      nonNumericDetails,
      duplicateGenes: countDuplicates(geneIds),
      duplicateSamples,
      geneIdType: detectGeneIdType(geneIds),
      rowNumbers
    }

    // ---- 重复基因：不静默处理 ----
    const hasDuplicates = rawMatrix.duplicateGenes.length > 0
    const strategy = options.duplicateStrategy
    const requiresChoice = hasDuplicates && !strategy

    // ---- 聚合 + 去全零 ----
    const cleaned = requiresChoice ? rawMatrix : aggregate(rawMatrix, strategy ?? 'first')
    this.lastCleaned = requiresChoice ? rawMatrix : cleaned

    // ---- 落盘 clean.csv ----
    if (projectRoot && !requiresChoice) {
      this.writeClean(cleaned, projectRoot)
    }

    // ---- 问题清单 ----
    const issues: Issue[] = []
    if (nonNumericCount > 0) {
      const first = nonNumericDetails[0]
      issues.push({
        code: 'E_DATA_NON_NUMERIC',
        rule: 'non-numeric',
        level: 'warning',
        message: first
          ? `第 ${first.row} 行 ${first.column} 列为「${first.raw}」，已按缺失处理（共 ${nonNumericCount} 个非数值单元格）`
          : `发现 ${nonNumericCount} 个非数值单元格，已按缺失处理`,
        suggestion: '请确认原始数据；若为 NA 标记请统一写成 NA。',
        ...(first ? { locator: { row: first.row, column: first.column } } : {}),
        count: nonNumericCount
      })
    }
    if (hasDuplicates) {
      const names = rawMatrix.duplicateGenes
        .slice(0, 10)
        .map((d) => `${d.name}×${d.count}`)
        .join('、')
      issues.push({
        code: 'E_DATA_DUP_GENE',
        rule: 'dup-gene',
        level: 'error',
        message: `发现 ${rawMatrix.duplicateGenes.length} 个重复基因名（${names}${rawMatrix.duplicateGenes.length > 10 ? '…' : ''}），请选择聚合方式`,
        suggestion: '取均值 / 求和 / 保留最大表达 / 保留第一条。',
        count: rawMatrix.duplicateGenes.length
      })
    }
    if (allZeroGeneCount > 0) {
      issues.push({
        code: 'E_DATA_ALL_ZERO',
        rule: 'all-zero-gene',
        level: 'warning',
        message: `${allZeroGeneCount} 个基因在所有样本中为 0，将被自动过滤`,
        suggestion: '这些基因无法提供差异信息，过滤后不影响结论。',
        count: allZeroGeneCount
      })
    }

    const summary: DatasetSummary = {
      matrixSourceFile: path.basename(options.filePath),
      matrixPath: PROJECT_FILES.cleanMatrix,
      rawMatrixPath: PROJECT_FILES.rawMatrix,
      encoding: sniff.encoding,
      delimiter: sniff.delimiter,
      geneIdColumn,
      geneIdType: rawMatrix.geneIdType,
      duplicateStrategy: strategy ?? 'first',
      geneCount: requiresChoice ? rawMatrix.geneCount : cleaned.geneCount,
      sampleCount: samples.length,
      samples,
      groupColumn: 'group',
      sampleColumn: 'sample',
      groups: {},
      naRatio: cleaned.naRatio,
      allZeroGeneCount,
      issues,
      hasBlockingIssue: issues.some((i) => i.level === 'error')
    }

    this.lastSummary = summary
    this.lastSource = {
      fileSizeBytes: sniff.fileSizeBytes,
      headerColumnCount: header.length,
      dataRowCount: geneIds.length,
      encoding: sniff.encoding
    }

    const result: ImportMatrixResult = {
      summary,
      preview: this.buildPreview(dataRows, geneIndex, sampleIndexes, samples),
      detectedGeneIdType: rawMatrix.geneIdType,
      geneIdSample: geneIds.slice(0, 5),
      requiresChoice
    }

    if (requiresChoice) {
      result.duplicateChoice = this.buildChoice(rawMatrix)
    }

    const cells = cleaned.geneCount * cleaned.sampleCount
    if (cells > 0 && cells <= MAX_EXPRESSION_CELLS) {
      result.expression = {
        geneIds: cleaned.geneIds,
        geneNames: cleaned.geneIds,
        samples: cleaned.samples,
        values: cleaned.values,
        naMask: cleaned.naMask
      }
    }

    return result
  }

  private buildChoice(matrix: CleanedMatrix): DuplicateGeneChoice {
    const affectedRows = matrix.duplicateGenes.reduce((sum, d) => sum + d.count, 0)
    return {
      totalDuplicateGenes: matrix.duplicateGenes.length,
      affectedRows,
      names: matrix.duplicateGenes.slice(0, 50),
      strategies: DUPLICATE_STRATEGIES
    }
  }

  /** 前 100 行预览（保留原始字符串，方便用户直接看到 NA_1 这类脏值） */
  private buildPreview(
    dataRows: string[][],
    geneIndex: number,
    sampleIndexes: number[],
    samples: string[]
  ): { columns: string[]; rows: (string | number)[][] } {
    const columns = ['gene_id', ...samples]
    const rows: (string | number)[][] = []
    for (const row of dataRows.slice(0, PREVIEW_ROWS)) {
      const geneId = (row[geneIndex] ?? '').trim()
      if (!geneId) continue
      const cells: (string | number)[] = [geneId]
      for (const idx of sampleIndexes) {
        const raw = (row[idx] ?? '').trim()
        const parsed = parseCell(raw)
        // 数值转成 number 让表格右对齐；缺失/非数值保留原文（用户要看到脏值）
        cells.push(parsed.kind === 'number' ? parsed.value : raw || 'NA')
      }
      rows.push(cells)
    }
    return { columns, rows }
  }

  /** 写 data/expression.clean.csv（逗号分隔、UTF-8 无 BOM、首列固定 gene_id） */
  private writeClean(matrix: CleanedMatrix, projectRoot: string): void {
    const outPath = path.join(projectRoot, PROJECT_FILES.cleanMatrix)
    const lines: string[] = []
    lines.push(['gene_id', ...matrix.samples.map(escapeCsv)].join(','))

    const { sampleCount } = matrix
    for (let g = 0; g < matrix.geneIds.length; g += 1) {
      const cells: string[] = [escapeCsv(matrix.geneIds[g])]
      for (let s = 0; s < sampleCount; s += 1) {
        cells.push(formatNumber(matrix.values[g * sampleCount + s]))
      }
      lines.push(cells.join(','))
    }

    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      // 显式 utf8 + 不加 BOM：fread 读带 BOM 的文件会让首列名变成 "\ufeffgene_id"
      fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
    } catch (err) {
      throw new DataImportError(
        toAppError('E_IO_PERMISSION', {
          message: '写入 data/expression.clean.csv 失败。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数工具（导出以便单测）
 * ------------------------------------------------------------------ */

/** 解析单元格：'na' 表示明确的缺失标记，'invalid' 表示脏值 */
export function parseCell(raw: string): { kind: 'number'; value: number } | { kind: 'na' } | { kind: 'invalid' } {
  const text = raw.trim()
  if (NA_TOKENS.has(text.toLowerCase())) return { kind: 'na' }
  // 千分位逗号（Excel 常见）：1,234 → 1234；但要避免把 12,4 当小数
  const normalized = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text
  const value = Number(normalized)
  if (!Number.isFinite(value)) return { kind: 'invalid' }
  return { kind: 'number', value }
}

/** 基因 ID 类型识别（PRD R-08）：ENSEMBL / ENTREZ / SYMBOL */
export function detectGeneIdType(ids: string[]): GeneIdType {
  const sample = ids.filter((id) => id.length > 0).slice(0, 200)
  if (sample.length === 0) return 'UNKNOWN'

  const ensembl = /^ENS[A-Z]*G\d{11}(\.\d+)?$/i
  const entrez = /^\d+$/
  const symbol = /^[A-Za-z][A-Za-z0-9._-]*$/

  const ratio = (re: RegExp): number => sample.filter((id) => re.test(id)).length / sample.length
  const ensemblRatio = ratio(ensembl)
  const entrezRatio = ratio(entrez)
  const symbolRatio = ratio(symbol)

  // 阈值 0.6：允许少量脏 ID（如 "---" 控制探针）不改变整体判定
  if (ensemblRatio >= 0.6) return 'ENSEMBL'
  if (entrezRatio >= 0.6) return 'ENTREZ'
  if (symbolRatio >= 0.6) return 'SYMBOL'
  return 'UNKNOWN'
}

/** 找出重复项（返回去重后的重复值，保持首次出现顺序） */
export function findDuplicates(values: string[]): string[] {
  const seen = new Map<string, number>()
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1)
  return [...seen.entries()].filter(([, count]) => count > 1).map(([value]) => value)
}

/** 统计重复基因名及出现次数（按次数降序，次数相同保持出现顺序） */
export function countDuplicates(geneIds: string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const id of geneIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const dups: { name: string; count: number }[] = []
  for (const [name, count] of counts) {
    if (count > 1) dups.push({ name, count })
  }
  return dups.sort((a, b) => b.count - a.count)
}

/**
 * 按策略聚合重复基因，并过滤全零行。
 *
 * 聚合规则：对每个样本列，取该基因所有行的非缺失值做 mean/sum/max/first；
 * 全缺失则该样本为 NA。行顺序 = 基因名首次出现的顺序（保证可复现）。
 */
export function aggregate(matrix: CleanedMatrix, strategy: DuplicateStrategy): CleanedMatrix {
  const { samples, sampleCount } = matrix
  const groups = new Map<string, number[]>()
  for (let g = 0; g < matrix.geneIds.length; g += 1) {
    const id = matrix.geneIds[g]
    const list = groups.get(id)
    if (list) list.push(g)
    else groups.set(id, [g])
  }

  const geneIds: string[] = []
  const rowNumbers: number[] = []
  const values: number[] = []
  const mask: number[] = []
  let allZeroGeneCount = 0
  let naCount = 0

  for (const [id, indexes] of groups) {
    // 全零判断按聚合后的值算：多行都是 0 才是真的全零
    const rowValues: number[] = []
    for (let s = 0; s < sampleCount; s += 1) {
      const picks: number[] = []
      for (const g of indexes) {
        const v = matrix.values[g * sampleCount + s]
        if (Number.isFinite(v)) picks.push(v)
      }
      if (picks.length === 0) {
        rowValues.push(Number.NaN)
        continue
      }
      switch (strategy) {
        case 'sum':
          rowValues.push(picks.reduce((a, b) => a + b, 0))
          break
        case 'max':
          rowValues.push(Math.max(...picks))
          break
        case 'first':
          rowValues.push(picks[0])
          break
        case 'mean':
        default:
          rowValues.push(picks.reduce((a, b) => a + b, 0) / picks.length)
          break
      }
    }

    const allZero = rowValues.every((v) => Number.isFinite(v) && v === 0)
    if (allZero) {
      allZeroGeneCount += 1
      continue
    }

    geneIds.push(id)
    rowNumbers.push(matrix.rowNumbers[indexes[0]] ?? 0)
    for (const v of rowValues) {
      values.push(v)
      const isNa = !Number.isFinite(v)
      mask.push(isNa ? 1 : 0)
      if (isNa) naCount += 1
    }
  }

  const cells = geneIds.length * sampleCount
  return {
    geneIds,
    samples,
    values: Float64Array.from(values),
    naMask: Uint8Array.from(mask),
    geneCount: geneIds.length,
    sampleCount,
    naRatio: cells === 0 ? 0 : naCount / cells,
    allZeroGeneCount,
    nonNumericCount: matrix.nonNumericCount,
    nonNumericDetails: matrix.nonNumericDetails,
    duplicateGenes: matrix.duplicateGenes,
    duplicateSamples: matrix.duplicateSamples,
    geneIdType: matrix.geneIdType,
    rowNumbers
  }
}

/** 数值 → CSV 文本（整数不带小数点；小数最多 6 位；NA → NA） */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'NA'
  if (Number.isInteger(value)) return String(value)
  // 极小值（如 log2 差异里的 1e-8）用 toFixed(6) 会被抹成 0，改用科学计数法保留有效位
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 1e-4) return value.toExponential(6)
  return String(Number(value.toFixed(6)))
}

/** CSV 字段转义（逗号/引号/换行） */
export function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export { SnifferError }
