/**
 * 时序转录组（timeseries）模块的共享类型。
 *
 * 目前只覆盖**单序列 + SAM 时序**这一条路（两组 × 时间模式还没做）。
 *
 * ## 为什么「解析样本名」放在主进程而不是 R
 *
 * 用户选完文件要**立刻**看到「样本名 / 组 / 时间点 / 重复」的预览表，
 * 并在跑之前改错的那几行。这件事只用读表头，10 ms 就够；起 R 要 5~8 秒
 * （本项目 R 启动 + 包检查的开销）。而真正的分析必须拿到用户确认后的这份映射，
 * 所以预览在主进程算、映射由界面回传给 R —— 一处解析、一处使用，不会两边不一致。
 */

/**
 * 命名规则。
 *
 * | 规则 | 适用样本名 | 解析结果 |
 * | --- | --- | --- |
 * | `group-time-rep` | `S_IR09_W_B1` | 组 W、时间 B、重复 1 |
 * | `time-rep` | `sample_A1` | 组（空）、时间 A、重复 1 |
 * | `genotype-treatment` | `S_IR09_D_A1` | 组 `IR09_D`、时间 A、重复 1 |
 *
 * 第三条是为「两种基因型 × 两种处理」的数据加的：基因型在倒数第三段，
 * 前两条只看最后两段，只能切出 D/W 两个组（会把基因型混在一起）。
 *
 * 组名里**不允许出现 `-`**：它既不是合法 R 因子水平（moanin 用 `make.names()` 校验），
 * 也是我们对比例分符 `<组1>-<组2>` 的分隔符。所以这里用 `_` 连接（`IR09_D`），
 * 客户要 `IR109DT` 这类写法请用「组名映射」。
 */
export type TsParseRule = 'group-time-rep' | 'time-rep' | 'genotype-treatment'

/** 一个样本的解析结果（界面可编辑 time / group 后回传） */
export interface TsSampleMeta {
  /** 矩阵里的列名，原样保留 */
  name: string
  /** 组（D / W / ck / dt…），单序列时可能为空 */
  group: string
  /** 时间点（A / B / 1d / 3d…）；为空表示解析失败，必须由用户补 */
  time: string
  /** 重复编号（1 / 2 / 3…），用于「每条序列首尾打标」 */
  rep: string
  /** 解析是否成功（time 非空即为成功） */
  ok: boolean
}

export interface TsInspectRequest {
  path: string
  rule?: TsParseRule
}

export interface TsInspectResult {
  path: string
  /** 探测到的编码：客户的 .txt 是 UTF-16LE + BOM */
  encoding: 'UTF-8' | 'UTF-16LE' | 'UTF-16BE'
  /** 目前只支持 tab */
  delimiter: string
  geneColumn: string
  samples: TsSampleMeta[]
  /** 去重后的时间点（按出现顺序排好：A..I 或 1,3,5,7） */
  times: string[]
  groups: string[]
  /** 有效基因行数（第一列非空的数据行，不含表头） */
  nGenes: number
  /**
   * 被忽略的行数（空行 / 首列为空的行）。
   *
   * 客户的矩阵末尾常留一个空行（只有分隔符）：`read.table` 会忽略它，
   * 但按换行数统计会多算 1 个基因，预览与结果就对不上。
   */
  ignoredRows: number
  nSamples: number
  rule: TsParseRule
  /** 解析失败的样本名（界面标红，并要求用户补时间点） */
  unparsed: string[]
}

export interface TsRunRequest {
  path: string
  /** 用户确认 / 修正后的样本映射（不传则用 rule 重新解析） */
  samples: { name: string; group: string; time: string; rep: string }[]
  /** true = 走 log2(x+0.01)；false = 数据已 log */
  log2: boolean
  /** 保留条件：至少这么多样本里表达 > 1；改它需要重跑 */
  minSamplesExpr: number
  /** 置换次数；改它需要重跑 */
  nperm: number
  /** 逐基因 q-value 上限（0~1）；改它**只过滤表格**，不重跑 */
  fdr: number
  /** |Score(d)| 下限；改它**只过滤表格**，不重跑 */
  absD: number
}

/** 全基因表的一行（界面按 fdr/absD 实时过滤） */
export interface TsGeneRow {
  gene: string
  direction: 'up' | 'down'
  scoreD: number
  qValue: number
  numerator: number
  denominator: number
  /** 用本次运行的阈值算的「是否显著」（界面改了阈值后自己再判一次） */
  significant: boolean
}

export interface TsRunSummary {
  matrixFile: string
  encoding: string
  /** 过滤前的基因总数 */
  nGenesInput: number
  /** 参与 SAM 检验的基因数 */
  nGenes: number
  nSig: number
  nUp: number
  nDown: number
  times: string[]
  nSamples: number
  nSeries: number
  log2: boolean
  minSamplesExpr: number
  nperm: number
  fdr: number
  absD: number
  dRange: number[]
  qRange: number[]
  durationMs: number
}

export interface TsRunResult {
  tsId: string
  runDir: string
  rows: TsGeneRow[]
  summary: TsRunSummary
  /** 本次运行写出的文件（给界面显示「结果已落盘到…」） */
  files: { all: string; sig: string; delta: string }
}

export interface TsCurvesRequest {
  tsId: string
  genes: string[]
}

export interface TsCurvesResult {
  tsId: string
  /** 实际画出来的基因（数据里的真实 ID） */
  genes: string[]
  /** 名字找不到的（拼写 / ID 体系问题） */
  missingGenes: string[]
  /** 存在但没通过当前阈值的（放宽阈值就能看） */
  notSignificant: string[]
  times: string[]
  groups: string[]
  nSamples: number
  multiGroup: boolean
  plots: { id: string; caption: string; file: string; dataUrl: string | null }[]
  durationMs: number
}

export interface TsExportTableRequest {
  tsId: string
  outPath: string
  /**
   * sam_all / sam_sig 属于单序列（SAM）；moanin_all / moanin_sig 属于两组模式。
   * 两种模式的表结构不同（SAM 是逐基因，moanin 是「基因 × 对比」长表），
   * 所以不合并成一个 which。
   */
  which: 'all' | 'sig' | 'moanin_all' | 'moanin_sig'
  format: 'csv' | 'xlsx'
}

export interface TsExportTableResult {
  outPath: string
  bytes: number
  rows: number
}

/* ------------------------------------------------------------------ *
 * 两组 × 时间（moanin 样条模型）
 * ------------------------------------------------------------------ */

/**
 * 两组模式请求。
 *
 * `contrasts` 为空时由 R 侧生成所有组的两两组合（`B-A` 形式，与 limma 的写法一致）。
 */
export interface TsMoaninRequest {
  path: string
  samples: { name: string; group: string; time: string; rep: string }[]
  /**
   * 样条自由度。**必须 ≤ 时间点数 − 2**：
   * df = nTime − 1 时样条基饱和、残差自由度被吃光，所有 p/q 变成 NA
   * （moanin 不报错，界面会显示「0 个显著基因」，用户以为两组没差异）。
   */
  degreesOfFreedom: number
  /** MAD 分位数：0.5 = 保留方差前 50% 的基因 */
  varianceCutoff: number
  contrasts: string[]
  nClusters: number
  /** Fisher 合并后的 q 上限 */
  fdr: number
  /** |lfc_max| 下限（客户脚本是 2） */
  lfcCutoff: number
}

/**
 * 差异表的一行（= 一个基因 × 一个对比）。
 *
 * ★ 五种 lfc 的形状与语义不同，界面不能混着当「logFC」用：
 *   · `lfcTimecourse` 带方向（火山图用这个）
 *   · `lfcSum` 带方向但会正负抵消
 *   · `lfcMax` / `lfcMin` **非负、无方向**（客户脚本用它筛基因）
 */
export interface TsMoaninRow {
  gene: string
  contrast: string
  stat: number
  pval: number
  qval: number
  lfcTimecourse: number
  lfcSum: number
  lfcMax: number
  lfcMin: number
  /** 跨多个对比的 Fisher 合并 q（单对比时等于该对比的 q） */
  fisherQ: number
  /** k-means 簇号（未进入聚类时为空） */
  cluster: number | null
  /** 是否通过「|lfc_max| > 阈值 且 Fisher q < 阈值」 */
  selected: boolean
}

export interface TsMoaninSummary {
  matrixFile: string
  encoding: string
  /** 原始基因数（读入时） */
  nGenesRaw: number
  /** rowMeans > 0 之后的基因数 */
  nGenesNonZero: number
  /** MAD 过滤后（参与建模的基因数） */
  nGenesFiltered: number
  madThreshold: number
  varianceCutoff: number
  degreesOfFreedom: number
  maxDegreesOfFreedom: number
  nTime: number
  times: string[]
  groups: string[]
  nSamples: number
  contrasts: string[]
  /** 每个对比的 q<0.05 / q<0.01 基因数 */
  qCounts: { contrast: string; q05: number; q01: number }[]
  nSelected: number
  nClusters: number
  clusterSizes: number[]
  seed: number
  lfcCutoff: number
  fdr: number
  durationMs: number
}

export interface TsMoaninResult {
  tsId: string
  runDir: string
  rows: TsMoaninRow[]
  summary: TsMoaninSummary
  files: { all: string; sig: string; timely: string; clusters: string }
  /**
   * 图列表。`contrast` 标明这张图属于哪个对比（聚类图是跨对比的，为空串）——
   * 界面的「当前对比」选择器靠它过滤，否则 4 个对比的图会全堆在一起。
   */
  plots: { id: string; caption: string; contrast: string; file: string; dataUrl: string | null }[]
}

/* ------------------------------------------------------------------ *
 * 两组模式的「自选基因曲线」
 * ------------------------------------------------------------------ */

export interface TsMoaninCurvesRequest {
  tsId: string
  genes: string[]
}

export interface TsMoaninCurvesResult {
  tsId: string
  genes: string[]
  /** 名字找不到的（拼写 / ID 体系问题） */
  missingGenes: string[]
  /** 存在但未通过当前阈值的（曲线照画，只在提示里说明） */
  notSignificant: string[]
  groups: string[]
  times: string[]
  nGenes: number
  plots: { id: string; caption: string; file: string; dataUrl: string | null }[]
  durationMs: number
}
