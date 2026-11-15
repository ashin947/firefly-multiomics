/**
 * 绘图模块的源文件读取（**只读**）。
 *
 * ## 为什么单独写一个，不复用 `DETableReader`
 *
 * `DETableReader` 是为「差异结果表」量身定的：它按 logFC / p / FDR 的列名模式
 * 找列，并且会做「把第一个 geneName 提升成 geneId」这种针对 GEO2R 的补丁。
 * 绘图模块面对的是表达矩阵和随访表 —— 里面既没有 logFC 也没有 p 值，
 * 套用那套规则只会把 `group` 列认成什么东西都不对。
 *
 * ## 这个类只做三件事
 *
 *  1. 判断分隔符（CSV / TSV / 分号）和有没有表头；
 *  2. 取出列名、第一列候选值（基因名）、前几行样例；
 *  3. 按列名**猜**每个列的角色（样本 / 分组 / 时间 / 状态 / 基因）。
 *
 * 猜错的代价：界面把下拉框预选到一个错误的列，用户画出来是错的图。
 * 所以宁可猜不到（返回 undefined，让用户自己选），也不要用宽松正则硬套。
 * 每个模式都锚定首尾，不做「包含即匹配」。
 */
import fs from 'node:fs'
import { toAppError } from '@shared/errors'
import type { VizInspectResult } from '@shared/types/viz'

/** 超过这个大小就不读了：绘图本来也用不到这么大的表，读进来只会卡住界面 */
const MAX_FILE_BYTES = 200 * 1024 * 1024

/** 第一列候选值最多返回多少个（矩阵可能有几万基因，全传过去下拉框会卡） */
const MAX_ROW_KEYS = 5000

/** 预览返回几行 */
const PREVIEW_ROWS = 6

/**
 * 列名角色模式。
 *
 * 全部 `^...$` 锚定：`/group/i` 这种宽松写法会把 `group_size`、`subgroup_notes`
 * 也认成分组列。锚定之后只认整列名就是这几类写法的情况。
 */
const ROLE_PATTERNS = {
  sample: /^(sample|sample_?id|sample_?name|library|lib|rna_?sample|样本|样本id|样本编号|样本名称)$/i,
  group: /^(group|group_?id|group_?name|condition|treat|treatment|class|category|type|分组|组别|组名|分组名称)$/i,
  time: /^(time|os|os_?time|dfs|rfs|follow_?up|followup|survival_?time|months|days|生存时间|随访时间|时间|月|天)$/i,
  status: /^(status|event|os_?status|censor|censored|dead|death|vital_?status|state|结局|状态|生存状态|是否死亡)$/i,
  gene: /^(gene|gene_?id|gene_?symbol|gene_?name|symbol|id|probe|transcript|基因|基因id|基因名)$/i
} as const

/** 没表头时给列起的名：`c1`、`c2`…… 与 R 侧 read.delim(header=FALSE) 的 V1/V2 区分开，避免混淆 */
function fallbackColumnName(index: number): string {
  return `c${index + 1}`
}

/** 按第一行里各候选分隔符的出现次数定分隔符 */
export function detectDelimiter(firstLine: string): string {
  const candidates = ['\t', ',', ';']
  // 初值用 ',' 且门槛是 >0：整行一个分隔符都没有时（单列表）保持逗号这个
  // 文档化的兜底值。写成 -1 会让第一个候选（制表符）靠 0 次命中白赢，
  // 界面上就会显示「制表符分隔」而实际是单列 —— 用户据此排查会走错方向。
  let best = ','
  let bestCount = 0
  for (const delimiter of candidates) {
    // 引号内的分隔符不该计数，但第一行通常是表头，几乎不会有引号，这里从简
    const count = firstLine.split(delimiter).length - 1
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/**
 * 按分隔符切一行，支持双引号包裹与 `""` 转义。
 *
 * 不引 papaparse：这个场景只需要「能正确切开带引号的字段」，
 * 而引依赖会让主进程多打包几百 KB。
 */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out.map((cell) => cell.trim())
}

/** 这一行是否像表头：至少有一个非空单元格，且**没有**单元格是纯数值 */
function looksLikeHeader(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c !== '')
  if (nonEmpty.length === 0) return false
  return nonEmpty.every((cell) => !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cell))
}

/** 按列名猜角色；猜不到就不给（不猜比猜错好） */
function suggestRoles(columns: string[]): VizInspectResult['suggested'] {
  const pick = (pattern: RegExp): string | undefined =>
    columns.find((column) => pattern.test(column))

  return {
    sampleColumn: pick(ROLE_PATTERNS.sample),
    groupColumn: pick(ROLE_PATTERNS.group),
    timeColumn: pick(ROLE_PATTERNS.time),
    statusColumn: pick(ROLE_PATTERNS.status),
    geneColumn: pick(ROLE_PATTERNS.gene)
  }
}

/**
 * 读一个表格文件并给出界面需要的信息。
 *
 * 只读、不落盘、不改文件。文件不存在或为空一律抛 `AppError`（由 IPC 层统一翻译）。
 */
export function inspectTable(filePath: string): VizInspectResult {
  if (!filePath || !fs.existsSync(filePath)) {
    throw toAppError('E_VALIDATION', {
      message: `文件不存在：${filePath || '(空路径)'}`,
      suggestion: '重新选择文件。'
    })
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw toAppError('E_VALIDATION', { message: `不是文件：${filePath}` })
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw toAppError('E_VALIDATION', {
      message: `文件过大（${(stat.size / 1024 / 1024).toFixed(0)} MB），上限 200 MB。`,
      suggestion: '请先裁剪到需要的基因与样本再导入。'
    })
  }
  if (stat.size === 0) {
    throw toAppError('E_DATA_EMPTY', { message: `文件是空的：${filePath}` })
  }

  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  const allLines = text.split(/\r?\n/)
  const lines = allLines.filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    throw toAppError('E_DATA_EMPTY', { message: `文件里没有内容：${filePath}` })
  }

  const delimiter = detectDelimiter(lines[0])
  const firstCells = splitLine(lines[0], delimiter)
  const hasHeader = looksLikeHeader(firstCells)

  const headerCells = hasHeader ? firstCells : firstCells.map((_, i) => fallbackColumnName(i))
  const columnCount = headerCells.length
  // 重名列会让 Object.fromEntries 丢数据，也让人分不清哪列是哪列，统一加序号
  const columns = headerCells.map((name, i) => {
    if (name === '') return fallbackColumnName(i)
    return headerCells.indexOf(name) === i ? name : `${name}_${i + 1}`
  })

  const dataLines = hasHeader ? lines.slice(1) : lines
  const parsedRows = dataLines.map((line) => splitLine(line, delimiter))

  // 第一列候选值（矩阵的基因名）
  const seen = new Set<string>()
  const rowKeys: string[] = []
  let rowKeyTotal = 0
  for (const row of parsedRows) {
    const key = row[0]
    if (!key) continue
    if (!seen.has(key)) {
      seen.add(key)
      rowKeyTotal += 1
      if (rowKeys.length < MAX_ROW_KEYS) rowKeys.push(key)
    }
  }

  const preview: Record<string, string>[] = []
  for (const row of parsedRows.slice(0, PREVIEW_ROWS)) {
    const record: Record<string, string> = {}
    columns.forEach((column, i) => {
      record[column] = row[i] ?? ''
    })
    preview.push(record)
  }

  const suggested = suggestRoles(columns)

  // 分组列的取值：界面要拿它填「参照组」下拉、判断几组。
  // 上限 50 已经远超实际分组数（常规实验 2~6 组），超过说明这一列不是分组列，
  // 与其丢 5000 个值让下拉框卡死，不如直接截断。
  const groupValues: string[] | undefined = (() => {
    if (!suggested.groupColumn) return undefined
    const columnIndex = columns.indexOf(suggested.groupColumn)
    if (columnIndex < 0) return undefined
    const seenGroups = new Set<string>()
    for (const row of parsedRows) {
      const value = row[columnIndex]
      if (!value) continue
      seenGroups.add(value)
      if (seenGroups.size >= 50) break
    }
    return Array.from(seenGroups)
  })()

  return {
    delimiter: delimiter === '\t' ? '\\t' : delimiter,
    columns,
    rowKeys,
    rowKeyTotal,
    totalRows: parsedRows.length,
    totalColumns: columnCount,
    suggested,
    roleValues: groupValues ? { group: groupValues } : {},
    preview
  }
}
