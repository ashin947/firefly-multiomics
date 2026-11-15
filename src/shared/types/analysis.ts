/**
 * 差异分析相关类型（ARCHITECTURE §4.3）。
 */
import type { AnalysisMethodId, DataType } from './project'

/** 差异分析配置（完整参数快照，落 project.json.analyses[].config） */
export interface DEConfig {
  method: Extract<AnalysisMethodId, 'limma-voom' | 'limma-lm' | 'deseq2' | 'edger'>
  dataType: DataType
  contrast: {
    groupColumn: string
    /** 实验组（logFC > 0 表示在此组上调） */
    numerator: string
    /** 对照（基线） */
    denominator: string
  }
  filter: {
    enabled: boolean
    mode: 'filterByExpr' | 'custom'
    /** custom: 表达量 ≥ minCount */
    minCount?: number
    /** custom: 在 ≥ N% 样本中检出 */
    minSamplesPct?: number
  }
  fdrMethod: 'BH' | 'BY' | 'holm' | 'none'
  outputGeneName: boolean
  /** 不过滤（与 filter.enabled 互斥，UI 需联动） */
  keepAllGenes: boolean
  /**
   * limma-lm 专用：输入是否**已经** log2 转换。
   *
   * 这是同一个方法的两个真实分支，不是可有可无的装饰：
   *  - `true`  → 芯片 / 已归一化的 log2 值，直接 `lmFit` + `eBayes()`（不带 trend）；
   *  - `false` → 原始 counts，先 TMM + `cpm(log=TRUE)` 转 log2-CPM，再 `eBayes(trend=TRUE)`。
   *
   * 省略时按 `true` 处理（与引入该字段前的行为一致，老项目不受影响）。
   */
  inputIsLog2?: boolean
  /**
   * limma-lm 专用：counts → log2-CPM 的先验计数（limma-trend 常用 2）。
   * 只在 `inputIsLog2 === false` 时有意义；越大越保守（把低表达基因压得更低）。
   */
  priorCount?: number
  /**
   * 本次分析使用的显著性阈值（界面滑块绑定的那一对）。
   *
   * 为什么要发给 R：`de.csv` 的 `regulation` 列由 R 写出，若它用一套口径、
   * 界面用另一套，用户把 CSV 发给导师/放进论文附表后数出来的数会和界面差一大截
   * （真实案例：界面 123、Excel 数出 216）。这类「不报错但结论不一致」的问题
   * 比崩溃更难被发现，所以阈值必须随配置一起落到 `run_config.json`。
   *
   * 省略时用 PRD 默认值（logFC 1.0 / FDR 0.05），行为与引入该字段前一致。
   * **界面仍然按滑块现算、不读 `regulation` 列** —— `isSignificant` 依旧是唯一真源，
   * 这个字段只影响 R 写进 CSV 的那一列。
   */
  thresholds?: ThresholdState
}

/**
 * 结果表一行（PRD R-13 的 9 字段）。
 *
 * 注意 `regulation` 语义：R 按**分析时配置的阈值**（`DEConfig.thresholds`，
 * 默认 1.0 / 0.05）写出这一列，谓词与界面 `utils/threshold.ts` 的 `isSignificant`
 * 逐字相同，因此「CSV 里数出来的 up/down」和界面在同一阈值下的统计卡严格相等。
 *
 * 但界面**仍然不读这一列**：用户拖动滑块后界面按新阈值现算，CSV 保持分析时的快照。
 * 这是「火山图显著点数 == 结果表行数」严格相等的前提。
 */
export interface DEResultRow {
  geneId: string
  geneName: string | null
  logFC: number
  /** DESeq2 用 baseMean */
  aveExpr: number
  /** DESeq2 用 stat */
  t: number
  pValue: number
  adjPValue: number
  /** DESeq2 无 B，置 null */
  b: number | null
  regulation: 'up' | 'down' | 'ns'
}

export interface DEStats {
  totalGenesAfterFilter: number
  /** 按 thresholds 计算 */
  upCount: number
  downCount: number
  nsCount: number
  filteredOutCount: number
}

/**
 * 判断显著性用哪一列 p 值。
 *
 * 为什么必须让用户选：火山图纵轴画的就是这一列。如果轴画 `-log10(P)`
 * 而判定用 `adjPValue < FDR`，用户会看到「虚线以上的点却不显著」——
 * 图上的一切必须来自同一列，否则这张图不能拿去写文章。
 *
 * 默认 `adjPValue`（多重检验校正后），这是期刊要求的常规口径。
 */
export type PValueBasis = 'pValue' | 'adjPValue'

/** 结果页阈值（纯前端状态，不落 R 配置） */
export interface ThresholdState {
  logFC: number
  /** 显著性阈值：basis='adjPValue' 时是 FDR 上限，basis='pValue' 时是 P 值上限 */
  fdr: number
  /** 用哪一列判显著（省略时按 adjPValue，即历史行为） */
  basis?: PValueBasis
}

/** 结果表加载结果 */
export interface DEResultPayload {
  rows: DEResultRow[]
  stats: DEStats
}

/* ------------------------------------------------------------------ *
 * 运行前预检（`deg:analysis:preflight`）
 *
 * ★ 为什么预检结果必须由主进程产出：
 *   预检规则（数据是否够、分组是否匹配、R 包是否齐全、整数性）与
 *   `AnalysisRunner` 起 R 之前的那道权威校验是**同一件事**。如果前端自己再算一遍，
 *   两处规则迟早漂移，用户会看到「按钮亮着但点了报错」—— 这是最难解释的状态。
 *   因此规则只在主进程实现一次，前端只负责渲染。
 * ------------------------------------------------------------------ */

/** 预检项级别（ok 也返回，便于界面展示「这一项查过了」而不是留白） */
export type PreflightLevel = 'ok' | 'warn' | 'error'

/** 一条预检结论 */
export interface PreflightItem {
  /** 稳定 id（前端做 key，不用下标） */
  id: string
  label: string
  level: PreflightLevel
  /** 人话说明：通过时说明查了什么，失败时说明怎么修 */
  detail: string
}

/** 一种方法的可用性（前端方法卡直接消费，不再自己判断） */
export interface MethodAvailabilityEntry {
  id: AnalysisMethodId
  label: string
  enabled: boolean
  /** 不可用原因（enabled=false 时必有） */
  reason?: string
}

/** 预检总结果 */
export interface AnalysisPreflightResult {
  /** 只要有一项 level==='error' 就是 false */
  canRun: boolean
  /** 本次校验针对的方法 */
  method: AnalysisMethodId
  items: PreflightItem[]
  /** 全部 DE 方法的可用性（含本次方法），供方法卡置灰与 hover 提示 */
  methods: MethodAvailabilityEntry[]
}

/* ------------------------------------------------------------------ *
 * 外部差异表导入（旁路数据源）
 *
 * ## 为什么需要
 *
 * 用户不一定在软件里做差异分析。从 GEO、公司报告、文献附表拿到一张
 * `gene / logFC / p` 的表，只想画个火山图 —— 这种场景很常见。
 *
 * ## 铁律：这条路径**只读文件、不写任何东西**
 *
 * 导入的数据只存在于渲染进程内存（`plotDataStore`），
 * **不写 de.csv、不改 project.json、不覆盖 analysisStore.rows**。
 * 用户切回「分析结果」就完全恢复，下次跑分析照常走原流程。
 *
 * 这条约束不是洁癖：一旦外部数据写进项目，`de.csv` 里就有了来源不明的行，
 * 用户以后想复现「当初这个 123 是怎么算出来的」永远查不清。
 * ------------------------------------------------------------------ */

/** 外部表里一列可以扮演的角色 */
export type DETableRole =
  | 'ignore'
  | 'geneId'
  | 'geneName'
  | 'logFC'
  | 'pValue'
  | 'adjPValue'
  | 'aveExpr'
  | 't'

/** 一行列描述（供用户做列映射） */
export interface DETableColumn {
  name: string
  /** 自动猜测的角色（用户可改） */
  guessedRole: DETableRole
  /** 前几个非空样例值，帮用户判断这列到底是什么 */
  samples: string[]
}

/** 第一步：探列（不返回全部数据，避免大表走两遍 IPC） */
export interface DETableInspectRequest {
  filePath: string
}

export interface DETableInspectResult {
  filePath: string
  fileName: string
  encoding: string
  delimiter: string
  /** 表头所在行（1-based；外部表常在表头前有标题行/空行） */
  headerRow: number
  /** 数据行数（不含表头） */
  rowCount: number
  columns: DETableColumn[]
}

/** 第二步：按映射真正解析 */
export interface DETableImportRequest {
  filePath: string
  /** 列名 → 角色。缺失的列按 guessedRole 处理 */
  mapping: Record<string, DETableRole>
}

export interface DETableImportResult {
  rows: DEResultRow[]
  /** 非致命问题（例：没有 FDR 列、某列全空）—— 界面必须显示出来 */
  warnings: string[]
  /** 被跳过的行数（基因 ID 为空 / logFC 不是数值） */
  skippedRows: number
}
