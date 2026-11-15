/**
 * 数据集相关类型（ARCHITECTURE §4.2）。
 * 主进程与渲染进程同源 import —— 字段名不一致这类最高频 bug 在这里被消灭。
 */

export type GeneIdType = 'SYMBOL' | 'ENSEMBL' | 'ENTREZ' | 'UNKNOWN'

export type DuplicateStrategy = 'mean' | 'sum' | 'max' | 'first'

export type IssueLevel = 'error' | 'warning' | 'info'

/**
 * PRD §8.3 的 13 条校验规则 ID（KEGG 无网络那条属于富集运行期，不在此列）。
 * 规则 ID 让单测能断言「13 条规则一条不少」，也便于 UI 做定向跳转。
 */
export type ValidationRuleId =
  | 'sample-mismatch'
  | 'group-too-few'
  | 'group-too-small'
  | 'group-small-power'
  | 'dup-gene'
  | 'dup-sample'
  | 'non-numeric'
  | 'counts-not-integer'
  | 'all-zero-gene'
  | 'na-ratio'
  | 'encoding'
  | 'empty-matrix'
  | 'memory-risk'

/** 一条数据问题（PRD §8.3 的 13 条规则每条都产出它） */
export interface Issue {
  /** 对应 errors.ts 的错误码 */
  code: string
  /** 对应的 PRD §8.3 规则（便于测试断言与 UI 跳转） */
  rule?: ValidationRuleId
  level: IssueLevel
  /** 中文人话：「组 Normal 只有 1 个样本，无法估计组内方差」 */
  message: string
  /** 建议动作 */
  suggestion?: string
  locator?: { row?: number; column?: string; sample?: string; gene?: string }
  /** 同类问题聚合数量 */
  count?: number
  /** 差集清单（最多列 20 个） */
  samples?: string[]
}

/** 重复基因聚合选项（PRD §8.1：绝不允许静默保留） */
export interface DuplicateGeneChoice {
  /** 重复基因名的个数（不同名字） */
  totalDuplicateGenes: number
  /** 涉及的总行数（含第一次出现） */
  affectedRows: number
  /** 前 50 个重复名及出现次数，供 UI 展示 */
  names: { name: string; count: number }[]
  /** 4 个聚合选项（顺序固定：均值/求和/最大/第一条） */
  strategies: { value: DuplicateStrategy; label: string }[]
}

/** 导入完成后的矩阵摘要（落 project.json 的 dataset 字段） */
export interface DatasetSummary {
  /** 用户原始文件名（仅展示） */
  matrixSourceFile: string
  /** 项目内副本 data/expression.clean.csv（相对项目根） */
  matrixPath: string
  /** data/expression.raw.csv */
  rawMatrixPath: string
  encoding: 'utf-8' | 'gb18030'
  delimiter: ',' | '\t' | ';'
  /** 基因 ID 列名 */
  geneIdColumn: string
  geneIdType: GeneIdType
  duplicateStrategy: DuplicateStrategy
  /** 清洗后基因数 */
  geneCount: number
  sampleCount: number
  /** 顺序即矩阵列顺序 */
  samples: string[]
  /** 分组列名（默认 'group'） */
  groupColumn: string
  /** 样本列名（默认 'sample'） */
  sampleColumn: string
  /** { Tumor: ['S01', ...], Normal: [...] } */
  groups: Record<string, string[]>
  /** 0..1 */
  naRatio: number
  allZeroGeneCount: number
  issues: Issue[]
  /** 任一 level==='error' */
  hasBlockingIssue: boolean
}

/** 矩阵导入结果（含前 100 行预览，供向导展示） */
export interface ImportMatrixResult {
  summary: DatasetSummary
  preview: { columns: string[]; rows: (string | number)[][] }
  detectedGeneIdType: GeneIdType
  /** 前 5 个基因 ID，供用户确认 */
  geneIdSample: string[]
  /**
   * 存在重复基因名且尚未选择聚合策略时为 true。
   * 此时 `data/expression.clean.csv` **不会**写出（含重复基因 ID 的矩阵会让 R 的
   * rownames 报错），UI 必须先让用户选聚合方式再调 aggregateDuplicates。
   */
  requiresChoice: boolean
  duplicateChoice?: DuplicateGeneChoice
  /**
   * 全量表达数据（供渲染进程箱线图 / PCA 兜底渲染）。
   * 仅在矩阵规模不大时下发（> 50 万单元格时省略，改用打开项目时的 expression 通道），
   * 避免一次 IPC 传输几 MB 的 JSON。
   */
  expression?: ExpressionPayload
}

/** 分组表导入结果 */
export interface GroupImportResult {
  groups: Record<string, string[]>
  issues: Issue[]
  preview: { columns: string[]; rows: (string | number)[][] }
  /** 实际使用的样本列名（用户可能手工指定过） */
  sampleColumn: string
  /** 实际使用的分组列名 */
  groupColumn: string
}

/** 基因 ID 映射表（data/gene_id_map.json） */
export interface GeneIdEntry {
  symbol: string | null
  ensembl: string | null
  entrez: string | null
}

export interface GeneIdMap {
  mapping: Record<string, GeneIdEntry>
  unmapped: string[]
}

/** 渲染进程持有的全量表达数据（供箱线图 / PCA 兜底渲染） */
export interface ExpressionPayload {
  geneIds: string[]
  geneNames: string[]
  samples: string[]
  /** 行优先扁平数组：values[g * sampleCount + s] */
  values: Float64Array | number[]
  /** 1 = 该位置为 NA */
  naMask?: Uint8Array
}

/** 编码嗅探结果 */
export interface SniffResult {
  encoding: 'utf-8' | 'gb18030'
  delimiter: ',' | '\t' | ';'
  hasHeader: boolean
  /** 预览的前几行原始文本（诊断用） */
  headLines: string[]
}
