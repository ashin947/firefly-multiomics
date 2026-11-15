/**
 * 外部差异结果表的读取与列映射（旁路数据源）。
 *
 * ## 这个模块存在的意义
 *
 * 用户常常不是在软件里算差异，而是从 GEO、公司报告、文献附表拿到一张
 * `gene / logFC / p` 的表，只想画图。这条路走的是「只读文件 → 内存里的行」，
 * **绝不写项目目录**（见 types/analysis.ts 里那段注释）。
 *
 * ## 为什么需要「探列 + 映射」两步
 *
 * 外部表的列名没有任何标准：`logFC` / `log2FoldChange` / `log2.fold_change.` /
 * `avg_log2FC`（Seurat）都见过；FDR 列可能叫 `padj` / `FDR` / `adj.P.Val` /
 * `p_val_adj`。硬编码一种写法必然对不上，所以：
 *   ① 先探：把列名 + 样例值返回给前端，顺带给一份"猜测"；
 *   ② 再导：用户确认/修正映射后，按映射真正解析。
 * 猜测只是省事，最终以用户的选择为准。
 *
 * ## 为什么列名猜测有固定顺序
 *
 * `adj.P.Val` 同时匹配「p 值」和「校正 p 值」两类正则，先判校正列再判原始列，
 * 否则所有表都会被猜成「两张 p 值列」而校正列丢失 —— 用户看到的 FDR 会变成原始 p，
 * 显著基因数直接翻几倍，且**不会有任何报错**。
 */
import Papa from 'papaparse'
import { toAppError } from '@shared/errors'
import type {
  DEResultRow,
  DETableColumn,
  DETableImportRequest,
  DETableImportResult,
  DETableInspectResult,
  DETableRole
} from '@shared/types/analysis'
import { FileSniffer } from './FileSniffer'

/** 表头前的标题行最多容忍多少行（超过就认为这文件不是表格） */
const MAX_HEADER_SCAN_ROWS = 10

/** 每列取几个样例值给用户看 */
const SAMPLE_COUNT = 3

interface Matrix {
  /** 含表头的原始矩阵（每行是字符串数组） */
  matrix: string[][]
  encoding: string
  delimiter: string
}

/** 一列的正则 → 角色。
 *
 * ★ 「校正 p 值」这条排在前面是**防御性**的，不是它生效的原因。
 *   真正保证 `adj.P.Val` 不被误判成 `pValue` 的是正则里的 `^...$` 锚定：
 *   `padj` / `p_val_adj` / `adj.P.Val` 都**不以 `p$` 结尾、也不等于 `pval`**，
 *   所以即使顺序反过来也匹配不上。
 *
 *   反过来说：一旦有人把 pValue 的正则写成宽松的 `/(p|pval)/i`，
 *   `padj` 会立刻被吃掉，用户看到的 FDR 变成原始 p，显著基因数翻几倍 ——
 *   而且**不会有任何报错**。`DETableReader.test.ts` 里「常见的 FDR 别名都能认出来」
 *   和 limma 表头那条断言就是钉这个的（已做过反向验证：改宽松后精确变红）。
 */
const ROLE_PATTERNS: { role: DETableRole; pattern: RegExp }[] = [
  // 校正 p 值（必须最先判：adj.P.Val / padj / FDR / qvalue / p_val_adj）
  {
    role: 'adjPValue',
    pattern: /^(adj[._\s-]?p[._\s-]?val(ue)?|adj[._\s-]?p|padj|p[._\s-]?adjust(ed)?|fdr|q[._\s-]?val(ue)?|p[._\s-]?val[._\s-]?adj)$/i
  },
  // 原始 p 值
  { role: 'pValue', pattern: /^(p|p[._\s-]?val(ue)?|pval|p[._\s-]?value)$/i },
  // logFC（log2FoldChange / log2FC / log2.fold_change. / avg_log2FC）
  {
    role: 'logFC',
    pattern: /^(log2?[._\s-]?(fold[._\s-]?change|fc)|logfc|log2fc|avg[._\s-]?log2fc|fc)$/i
  },
  // 基因名（放在 geneId 之前判：symbol / gene_name 更像"名字"）
  { role: 'geneName', pattern: /^(gene[._\s-]?name|symbol|gene[._\s-]?symbol|name)$/i },
  // 基因 ID
  {
    role: 'geneId',
    pattern: /^(gene[._\s-]?id|gene|id|ensembl[._\s-]?id|ensembl|probe[._\s-]?id|probe|geneid)$/i
  },
  { role: 'aveExpr', pattern: /^(ave[._\s-]?expr(ession)?|logcpm|base[._\s-]?mean|basemean|mean)$/i },
  { role: 't', pattern: /^(t|stat|t[._\s-]?value|statistic|f)$/i }
]

function guessRole(columnName: string): DETableRole {
  const name = columnName.trim()
  if (!name) return 'ignore'
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(name)) return role
  }
  return 'ignore'
}

/** 把文本按分隔符切成矩阵（不做任何类型转换） */
function parseText(text: string, delimiter: string): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    delimiter,
    // ★ 必须保留空行：`headerRow` 要报告「表头在文件的第几行」给用户看，
    //   用 'greedy' 把空行吃掉会让行号与用户在 Excel 里看到的对不上
    //   （文件第 4 行表头 → 报告第 2 行，用户会以为软件读错了文件）。
    //   空行在下面统一用 isBlankRow 过滤。
    skipEmptyLines: false,
    dynamicTyping: false
  })
  return parsed.data.map((row) => row.map((cell) => String(cell ?? '').trim()))
}

/** 该行是否完全空白 */
function isBlankRow(row: string[] | undefined): boolean {
  if (!row) return true
  return row.every((cell) => String(cell ?? '').trim() === '')
}

/** 'NA' / '' / 'NaN' / '-' → NaN（外部表里这些占位符都很常见） */
function toNumber(value: string | undefined): number {
  const text = String(value ?? '').trim()
  if (text === '' || text === '-' || text === '—') return Number.NaN
  const upper = text.toUpperCase()
  if (upper === 'NA' || upper === 'NAN' || upper === 'NULL' || upper === 'INF' || upper === '-INF') {
    return Number.NaN
  }
  // 容忍千分位与前后空白；科学计数法 Number() 原生支持
  const parsed = Number(text.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function toNullableText(value: string | undefined): string | null {
  const text = String(value ?? '').trim()
  if (text === '' || text.toUpperCase() === 'NA' || text === '-') return null
  return text
}

export class DETableReader {
  constructor(private readonly sniffer: FileSniffer = new FileSniffer()) {}

  /** 读成统一的字符串矩阵（CSV/TSV/TXT 与 Excel 同一形态） */
  private readMatrix(filePath: string): Matrix {
    const outcome = this.sniffer.sniff(filePath)
    if (outcome.rows && outcome.rows.length > 0) {
      // Excel：Sniffer 已经给出 行×列 字符串矩阵（含表头）
      return {
        matrix: outcome.rows.map((row) => row.map((cell) => String(cell ?? '').trim())),
        encoding: outcome.encoding,
        delimiter: ''
      }
    }
    if (!outcome.text) {
      throw toAppError('E_DATA_EMPTY', {
        message: '这个文件里没有可读取的表格内容。',
        suggestion: '请确认文件不是空的，且第一行是列名。'
      })
    }
    return {
      matrix: parseText(outcome.text, outcome.delimiter),
      encoding: outcome.encoding,
      delimiter: outcome.delimiter
    }
  }

  /**
   * 找表头行。
   *
   * 外部表经常在真正的表头之前有标题（`"差异基因列表"`）、导出时间、空行。
   * 判据：第一行「非空单元格 ≥ 2」且下一行也至少有同样多的列。
   * 只看首行会把标题行当表头，结果所有列名都是 "Unnamed"。
   */
  private findHeaderRow(matrix: string[][]): number {
    for (let i = 0; i < Math.min(matrix.length, MAX_HEADER_SCAN_ROWS); i += 1) {
      const row = matrix[i]
      if (isBlankRow(row)) continue
      const filled = row.filter((cell) => cell.trim() !== '').length
      if (filled < 2) continue
      const next = matrix[i + 1]
      if (!next || isBlankRow(next)) continue
      const nextFilled = next.filter((cell) => cell.trim() !== '').length
      if (nextFilled >= Math.min(filled, 2)) return i
    }
    // 兜底：第一个非空行
    const fallback = matrix.findIndex((row) => !isBlankRow(row))
    return fallback >= 0 ? fallback : 0
  }

  /** 第一步：探列（只返回列名 + 样例，不返回全量数据） */
  inspect(filePath: string): DETableInspectResult {
    const { matrix, encoding, delimiter } = this.readMatrix(filePath)
    if (matrix.length === 0) {
      throw toAppError('E_DATA_EMPTY', { message: '表格是空的，没有任何行。' })
    }

    const headerIndex = this.findHeaderRow(matrix)
    const header = matrix[headerIndex]
    const body = matrix.slice(headerIndex + 1).filter((row) => !isBlankRow(row))

    if (body.length === 0) {
      throw toAppError('E_DATA_EMPTY', {
        message: '表格只有表头，没有数据行。',
        suggestion: '请确认导出时包含了数据。'
      })
    }

    const columns: DETableColumn[] = header.map((rawName, colIndex) => {
      // 空列名补成「第 N 列」，否则前端下拉里会出现一堆空选项，用户无法区分
      const name = rawName.trim() || `第 ${colIndex + 1} 列`
      const samples: string[] = []
      for (const row of body) {
        if (samples.length >= SAMPLE_COUNT) break
        const value = String(row[colIndex] ?? '').trim()
        if (value !== '') samples.push(value.length > 40 ? `${value.slice(0, 40)}…` : value)
      }
      return { name, guessedRole: guessRole(name), samples }
    })

    /*
     * ★ 后处理：`geneId` 是必需角色，而 `geneName` 只是装饰。
     *
     * 真实场景：GEO2R / 很多在线工具导出的表只有一列基因标识，列名叫
     * `Gene.symbol`。按正则它命中「基因名」，于是用户的表里**没有基因 ID 列**，
     * 导入按钮直接变灰，而界面上明明有一列基因名。用户会觉得软件坏了。
     *
     * 规则：如果整张表没有任何 `geneId` 候选，就把第一个「基因名」列提升为 `geneId`。
     * 只是猜测阶段的兜底，用户在下拉里改回来即可。
     */
    if (!columns.some((c) => c.guessedRole === 'geneId')) {
      const firstGeneish = columns.find((c) => c.guessedRole === 'geneName')
      if (firstGeneish) firstGeneish.guessedRole = 'geneId'
    }

    return {
      filePath,
      fileName: filePath.split(/[\\/]/).pop() ?? filePath,
      encoding,
      delimiter,
      headerRow: headerIndex + 1,
      rowCount: body.length,
      columns
    }
  }

  /**
   * 第二步：按映射解析成 DEResultRow[]。
   *
   * 关键取舍：**坏行跳过并计数，不整表失败**。
   * 外部表里常有注释行、汇总行（"Total"）、末尾的空行。ResultLoader 对
   * 自家 de.csv 是"坏一行就整表报错"（那是我们自己写的，坏了就是 bug），
   * 但对外部文件必须宽容 —— 否则用户拿到别人给的表永远导不进来。
   * 代价是被跳过的行数必须回传并在界面上显示，不能静默吞掉。
   */
  importRows(request: DETableImportRequest): DETableImportResult {
    const { matrix } = this.readMatrix(request.filePath)
    const headerIndex = this.findHeaderRow(matrix)
    const header = matrix[headerIndex]
    const body = matrix.slice(headerIndex + 1).filter((row) => !isBlankRow(row))

    // 列名 → 列下标（重名列取第一个，避免映射错位）
    const indexOf = new Map<string, number>()
    header.forEach((rawName, idx) => {
      const name = rawName.trim() || `第 ${idx + 1} 列`
      if (!indexOf.has(name)) indexOf.set(name, idx)
    })

    // 最终角色：用户映射优先，否则用猜测
    const roleToIndex = new Map<DETableRole, number>()
    for (const [name, idx] of indexOf) {
      const role = request.mapping[name] ?? guessRole(name)
      if (role === 'ignore') continue
      if (!roleToIndex.has(role)) roleToIndex.set(role, idx)
    }

    const pickIndex = (role: DETableRole): number | undefined => roleToIndex.get(role)

    const geneIdIdx = pickIndex('geneId') ?? pickIndex('geneName')
    const logFCIdx = pickIndex('logFC')
    const pIdx = pickIndex('pValue')
    const adjIdx = pickIndex('adjPValue')

    if (geneIdIdx === undefined) {
      throw toAppError('E_VALIDATION', {
        message: '没有指定「基因 ID」列。',
        suggestion: '请在下拉里把存放基因名/基因 ID 的那一列选为「基因 ID」。',
      })
    }
    if (logFCIdx === undefined) {
      throw toAppError('E_VALIDATION', {
        message: '没有指定「logFC（差异倍数）」列。',
        suggestion: '火山图的横轴必须是 log2 倍数变化，请指定对应的列。'
      })
    }
    if (pIdx === undefined && adjIdx === undefined) {
      throw toAppError('E_VALIDATION', {
        message: '没有指定 P 值列，无法绘制火山图。',
        suggestion: '火山图的纵轴是 -log10(P)，请至少指定「P 值」或「校正 P 值」一列。'
      })
    }

    const warnings: string[] = []
    if (adjIdx === undefined) {
      warnings.push('表格里没有校正 P 值（FDR）列，已用原始 P 值代替 —— 显著基因数会偏多，结论请谨慎。')
    }
    if (pIdx === undefined) {
      warnings.push('表格里没有原始 P 值列，已用校正 P 值绘制纵轴。')
    }

    const geneNameIdx = pickIndex('geneName')
    const aveExprIdx = pickIndex('aveExpr')
    const tIdx = pickIndex('t')

    const rows: DEResultRow[] = []
    let skipped = 0
    let missingLogFC = 0

    for (const row of body) {
      const geneId = String(row[geneIdIdx] ?? '').trim()
      const logFC = toNumber(row[logFCIdx])
      // 基因 ID 为空 / logFC 不是数字 → 跳过（多见于汇总行与注释行）
      if (geneId === '') {
        skipped += 1
        continue
      }
      if (!Number.isFinite(logFC)) {
        skipped += 1
        missingLogFC += 1
        continue
      }

      const pValue = pIdx !== undefined ? toNumber(row[pIdx]) : Number.NaN
      const adjRaw = adjIdx !== undefined ? toNumber(row[adjIdx]) : Number.NaN
      // 没有 FDR 列时用 P 值代替（已在 warnings 里声明）
      const adjPValue = Number.isFinite(adjRaw) ? adjRaw : pIdx !== undefined ? pValue : adjRaw

      rows.push({
        geneId,
        geneName: geneNameIdx !== undefined ? toNullableText(row[geneNameIdx]) : null,
        logFC,
        aveExpr: aveExprIdx !== undefined ? toNumber(row[aveExprIdx]) : Number.NaN,
        t: tIdx !== undefined ? toNumber(row[tIdx]) : Number.NaN,
        pValue,
        adjPValue,
        // 外部表没有 B 列（limma 的 Bayes 因子），置 null
        b: null,
        // 这个字段界面**不读**（ResultTable 用 classify() 现算），填占位值即可。
        // 不要在这里按某个阈值算死，否则「导入后拖滑块」时会出现两套口径。
        regulation: 'ns'
      })
    }

    if (rows.length === 0) {
      throw toAppError('E_DATA_EMPTY', {
        message: `表格里没有一行能解析成有效的差异结果（跳过 ${skipped} 行）。`,
        suggestion: '请检查「基因 ID」和「logFC」两列是否选对了 —— 常见原因是选了表头或数字格式异常的列。'
      })
    }

    if (skipped > 0) {
      const hint = missingLogFC > 0 ? `，其中 ${missingLogFC} 行的 logFC 不是数值` : ''
      warnings.push(`跳过了 ${skipped} 行无法解析的数据（基因 ID 为空或 logFC 非数值${hint}）。`)
    }
    if (rows.length < 30) {
      warnings.push(`只解析出 ${rows.length} 行数据，火山图的点会很少 —— 请确认这份表是否完整。`)
    }

    return { rows, warnings, skippedRows: skipped }
  }
}
