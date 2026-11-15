/**
 * 单细胞（scrna）模块的共享类型。
 *
 * 只覆盖**第 1 步：数据导入与对象构建**。后续步骤（质控 / 聚类 / 注释 …）
 * 的类型等各自落地时再加，不预先占位 —— 占位类型最容易和实现对不上。
 *
 * ## 为什么样本是 `{name, dir}` 而不是只给目录
 *
 * 目录名未必是用户想要的组名（`MD` / `WW` 是测序批次号，不是生物学分组）。
 * 用户确认时可以改名，而改名即 `orig.ident` —— 下游所有分组、配色、差异比较
 * 都靠它。所以 name 必须由界面显式传下来，不能让 R 侧再从路径猜。
 */

/** 一个 10x 样本目录（用户确认后的最终形态） */
export interface ScrnaSampleRef {
  /** 用户确认后的样本名，会写成 orig.ident */
  name: string
  /** 含三件套的目录绝对路径 */
  dir: string
}

/** CellRanger 的两种目录风格：v2 用 genes.tsv，v3 用 features.tsv */
export type ScrnaMatrixLayout = 'v2' | 'v3'

/** 扫描到的一个候选样本 */
export interface ScrnaScanSample {
  name: string
  dir: string
  layout: ScrnaMatrixLayout
  /** 三件套的实际文件名（只用于界面展示，R 侧仍交给 Read10X 自己找） */
  files: { matrix: string; barcodes: string; features: string }
}

export interface ScrnaScanRequest {
  rootDir: string
}

export interface ScrnaScanResult {
  rootDir: string
  samples: ScrnaScanSample[]
  /** 实际遍历过的目录数（给「扫了这么久都扫了些什么」一个交代） */
  scannedDirs: number
  elapsedMs: number
}

export interface ScrnaImportRequest {
  rootDir: string
  samples: ScrnaSampleRef[]
}

export interface ScrnaPerSampleStat {
  sample: string
  cells: number
  /** 该样本细胞的中位基因数；算不出来给 0 */
  genesMedian: number
}

export interface ScrnaImportResult {
  scrnaId: string
  runDir: string
  nSamples: number
  nCells: number
  nGenes: number
  perSample: ScrnaPerSampleStat[]
  /**
   * 被 `min.cells=3 / min.features=100` 过滤掉的细胞数（读入数 − 保留数）。
   * 这两个过滤是客户指定的固定值，不是可调参数，所以这里只报告不暴露。
   */
  filteredByMinFeatures: number | null
  /** 两个固定参数的当前取值，回显给界面以便写进方法学描述 */
  minCells: number
  minFeatures: number
  /** 每样本细胞数柱状图（data URL）；生成失败给 null，不影响分析结果 */
  plotDataUrl: string | null
  /**
   * 两两样本的基因重叠率（交集 / 较小方），< 0.5 说明注释体系可能不一致。
   * 不阻断导入，但界面要标出来 —— 否则 merge「成功」了，后面聚类会按样本劈开。
   */
  sampleOverlap: ScrnaSampleOverlap[]
  /** rds 的绝对路径（「下载对象」时直接复制它） */
  objectPath: string
  durationMs: number
  /** R 侧原始 summary（排查用，字段可能比上面多） */
  summary: Record<string, unknown>
}

/** 一对样本的基因重叠 */
export interface ScrnaSampleOverlap {
  a: string
  b: string
  /** 交集 / 较小方基因数，0~1 */
  overlap: number
  shared: number
  smaller: number
}

/** 低于这个值就认为「注释体系可能不一致」，界面标红 */
export const SCRNA_OVERLAP_WARN = 0.5

/* ------------------------------------------------------------------ *
 * 第 2 步：质控与过滤
 * ------------------------------------------------------------------ */

/**
 * QC 阈值。三个字段都可以为 null —— **null 表示「不启用这条」，不是「用默认值」**。
 * 默认值只用于界面预填（200 / 500 / 0.2），用户清空输入框就是 null。
 */
export interface ScrnaQcThresholds {
  minFeature: number | null
  minCount: number | null
  /** 线粒体比例上限，0~1（0.2 = 20%） */
  maxMt: number | null
}

export interface ScrnaQcSampleStat {
  sample: string
  cells: number
  medianFeature: number
  medianCount: number
  /** 没有线粒体基因时为 null */
  medianMt: number | null
  passFeature: number
  passCount: number
  passMt: number
  /** 三条同时满足的数量 */
  passAll: number
}

export interface ScrnaPlotImage {
  id: string
  caption: string
  /**
   * runDir 里的 PNG 文件名。导出 PDF 时按它找同名 .pdf ——
   * 界面不拼路径，也不重新渲染（R 已经把图写好了）。
   */
  file: string
  /** 图缺失时给 null（单张图失败不该让整步失败） */
  dataUrl: string | null
}

export interface ScrnaQcRequest {
  scrnaId: string
  thresholds: ScrnaQcThresholds
}

export interface ScrnaQcResult {
  scrnaId: string
  nCells: number
  nGenes: number
  /** 匹配 `^mt-`（不区分大小写）的基因数；0 = 该数据集没有线粒体基因 */
  mtGeneCount: number
  mtExamples: string[]
  qcSummary: ScrnaQcSampleStat[]
  plots: ScrnaPlotImage[]
  /** 实际生效的阈值（null = 未启用），回显给界面 */
  thresholds: ScrnaQcThresholds
  /** obj_qc.rds 的路径（段 B 的输入） */
  objectPath: string
  durationMs: number
}

export interface ScrnaFilterRequest {
  scrnaId: string
  thresholds: ScrnaQcThresholds
}

export interface ScrnaFilterPerSample {
  sample: string
  before: number
  after: number
}

export interface ScrnaFilterResult {
  scrnaId: string
  cellsBefore: number
  cellsAfter: number
  removed: number
  removedPct: number
  perSample: ScrnaFilterPerSample[]
  /** 过滤后细胞数归零、已从对象里消失的样本 */
  emptySamples: string[]
  thresholds: ScrnaQcThresholds
  /** 设了 maxMt 但数据里没有 mt 基因时为 false */
  mtFilterApplied: boolean
  plotDataUrl: string | null
  /** qc_summary.csv 的绝对路径（下载时直接复制） */
  summaryCsvPath: string
  objectPath: string
  durationMs: number
}

/**
 * 可导出的对象文件（**白名单**，不拼接用户输入，避免路径穿越）。
 *
 * ★ 为什么必须带这个参数：`exportObject` 原来硬编码复制 `obj_step1.rds`，
 *   所以第 2 步、第 3 步点「下载当前对象」拿到的都是**第 1 步的对象** ——
 *   文件名叫 obj_step3.rds，内容却是 68 MB 的 step1，用户完全看不出来。
 */
export type ScrnaObjectFile =
  | 'obj_step1'
  | 'obj_step2'
  | 'obj_step3'
  | 'obj_step4'
  | 'obj_step5'
  | 'obj_step6'

export interface ScrnaExportObjectRequest {
  scrnaId: string
  outPath: string
  /** 省略时按第 1 步（兼容旧调用） */
  file?: ScrnaObjectFile
}

/** 导出第 2 步的统计表（qc_summary.csv） */
export interface ScrnaExportSummaryRequest {
  scrnaId: string
  outPath: string
  /** 哪张统计表（白名单）：qc_summary / cluster_summary / celltype_annotation */
  file?: 'qc_summary' | 'cluster_summary' | 'celltype_annotation'
}

export interface ScrnaExportObjectResult {
  outPath: string
  bytes: number
  /** 对象所在目录（用户可能想连带拿走图与统计表） */
  runDir: string
}

/* ------------------------------------------------------------------ *
 * 第 3 步：标准化 · PCA · 批次校正
 * ------------------------------------------------------------------ */

/**
 * 下游用的降维结果名。
 *
 * ★ 只有两个取值，且**由 R 侧一次算定**（`activeReduction`）：
 *   多样本走 harmony → `"harmony"`；单样本没有批次可校正 → `"pca"`。
 *   第 4 步及以后一律读这个字段，**不要各自再判断样本数** ——
 *   两处判断迟早会分叉，表现是「图空白」或「reduction not found」。
 */
export type ScrnaActiveReduction = 'harmony' | 'pca'

export interface ScrnaPrepRequest {
  scrnaId: string
  /** 高变基因数，默认 2000（客户脚本 nfeatures = 2000） */
  nFeatures: number
  /** PCA 维数，默认 30（客户脚本 npcs = 30） */
  nPcs: number
}

export interface ScrnaPrepPerSample {
  sample: string
  cells: number
}

export interface ScrnaPrepResult {
  scrnaId: string
  nCells: number
  nGenes: number
  nSamples: number
  perSample: ScrnaPrepPerSample[]
  nFeatures: number
  /** 实际选出的高变基因数（可能因数据不足少于 nFeatures） */
  nHVG: number
  nPcs: number
  /** 单样本时为 false —— 不是错误，是「没有批次可校正」 */
  harmonyApplied: boolean
  harmonySeconds: number
  activeReduction: ScrnaActiveReduction
  /** 对象里实际存在的 reduction 名（排查用） */
  reductions: string[]
  plots: ScrnaPlotImage[]
  objectPath: string
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * 第 4 步：聚类 · UMAP · tSNE
 * ------------------------------------------------------------------ */

export interface ScrnaEmbedRequest {
  scrnaId: string
  /** 聚类分辨率，默认 0.25（客户从 0.1 改的：0.1 在 2.6 万细胞上只切出几个大类） */
  resolution: number
  /** PCA 维数；省略时用第 3 步记在对象里的值 */
  dims?: number
}

export interface ScrnaClusterPerSample {
  sample: string
  cells: number
}

export interface ScrnaClusterStat {
  cluster: string
  cells: number
  perSample: ScrnaClusterPerSample[]
}

export interface ScrnaEmbedResult {
  scrnaId: string
  nCells: number
  nClusters: number
  resolution: number
  dims: number
  /** 本次聚类用的是哪个 reduction（多样本 harmony / 单样本 pca） */
  activeReduction: ScrnaActiveReduction
  /** 对象里实际存在的 reduction 名：pca / harmony? / umap / tsne */
  reductions: string[]
  /** 固定为 "clusters"（不带 harmony 前缀 —— 单样本没有 harmony） */
  clusterColumn: string
  perCluster: ScrnaClusterStat[]
  umapSeconds: number
  tsneSeconds: number
  clusterSeconds: number
  plots: ScrnaPlotImage[]
  /** cluster_summary.csv 的绝对路径 */
  summaryCsvPath: string
  objectPath: string
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * 第 5 步：Marker 基因
 * ------------------------------------------------------------------ */

export interface ScrnaMarkersRequest {
  scrnaId: string
  /** 传给 FindAllMarkers 的 logfc.threshold，默认 0.5（客户脚本 logFCfilter） */
  logfcThreshold: number
  /** 结果表二次筛选用，默认 0.05（客户脚本 adjPvalFilter） */
  adjPvalFilter: number
}

/** 每簇 top N marker 的一行 */
export interface ScrnaMarkerTop {
  gene: string
  avgLog2FC: number
  pvalAdj: number
  /** 该基因在本簇的检出比例 */
  pct1: number
  /** 在其余细胞的检出比例 */
  pct2: number
}

export interface ScrnaMarkerCluster {
  cluster: string
  cells: number
  /** 当前阈值下该簇的显著 marker 数 */
  sigCount: number
  /** 按 avg_log2FC 降序的前 10 个 */
  top10: ScrnaMarkerTop[]
}

export interface ScrnaMarkersResult {
  scrnaId: string
  nCells: number
  nClusters: number
  clusters: string[]
  /** 写死 0.25（客户脚本 min.pct） */
  minPct: number
  logfcThreshold: number
  adjPvalFilter: number
  /** FindAllMarkers 原始行数 */
  totalMarkers: number
  /** 二次筛选后行数（界面统计条与表格用的是它） */
  sigMarkers: number
  findSeconds: number
  perCluster: ScrnaMarkerCluster[]
  plots: ScrnaPlotImage[]
  /** markers_sig.csv 绝对路径（全量，不是界面可见行） */
  sigCsvPath: string
  top10CsvPath: string
  objectPath: string
  durationMs: number
}

/** 导出 marker 表：csv 直接复制，xlsx 由主进程从 csv 生成 */
export interface ScrnaExportMarkersRequest {
  scrnaId: string
  outPath: string
  table: 'sig' | 'top10'
  format: 'csv' | 'xlsx'
}

export interface ScrnaExportMarkersResult {
  outPath: string
  bytes: number
  rows: number
}

/** marker 表的一行（服务端查询用） */
export interface ScrnaMarkerRow {
  cluster: string
  gene: string
  avgLog2FC: number
  pval: number
  pvalAdj: number
  pct1: number
  pct2: number
}

export interface ScrnaMarkersTableRequest {
  scrnaId: string
  /** 只保留该 cluster；省略 = 全部 */
  cluster?: string
  /** 基因名子串（不区分大小写） */
  search?: string
  limit: number
  offset: number
}

export interface ScrnaMarkersTableResult {
  rows: ScrnaMarkerRow[]
  /** 过滤后的总行数（可能远大于 rows.length） */
  matched: number
  /** 表里的总行数（未过滤） */
  total: number
}

/* ------------------------------------------------------------------ *
 * 从已有 rds 继续（第 4/5/6 步的入口）
 * ------------------------------------------------------------------ */

/** 可以从哪一步接着做 */
export type ScrnaTargetStep = 4 | 5 | 6

/** 只读检查：这个 rds 能不能作为某一步的输入 */
export interface ScrnaInspectRequest {
  path: string
  targetStep: ScrnaTargetStep
}

export interface ScrnaInspectResult {
  path: string
  nCells: number
  nGenes: number
  reductions: string[]
  hasClusters: boolean
  /** "clusters" / "seurat_clusters" / "" */
  clusterColumn: string
  /**
   * 每簇细胞数（按簇号数字序）。
   *
   * 检查阶段就带出来，是因为第 6 步的填表界面要显示它，而「从 obj_step5.rds 直接
   * 开始」的 runDir 里没有第 4 步写的 cluster_summary.csv —— 不带上就得为一个
   * 数字再起一次 R（读几百 MB 的 rds）。
   */
  clusterSizes: { cluster: string; cells: number }[]
  hasVariableFeatures: boolean
  nVariableFeatures: number
  hasScaleData: boolean
  scaleRows: number
  /** 推断出来的降维名（misc 优先，其次 harmony → pca），下游直接用 */
  suggestedReduction: string
  suggestedNpcs: number
  /** 基因名看起来像人 / 鼠 / 其它（只用于界面提示，不参与计算） */
  strain: 'human' | 'mouse' | 'other'
  targetStep: ScrnaTargetStep
  /** 能否作为**目标步骤**的输入 */
  ok: boolean
  /** 每一步各自能不能开始 */
  readyFor: Record<string, boolean>
  /** 缺什么（英文键，界面翻成中文） */
  missing: string[]
  message: string
  durationMs: number
}

export interface ScrnaImportObjectRequest {
  path: string
  targetStep: ScrnaTargetStep
  /** 省略时新建一个 run 目录（客户可能根本没跑过第 1 步） */
  scrnaId?: string
}

export interface ScrnaImportObjectResult {
  scrnaId: string
  runDir: string
  /** 落成了哪个文件名（obj_step3.rds / obj_step4.rds / obj_step5.rds） */
  importedAs: string
  importedAt: string
  summary: ScrnaInspectResult
}

/* ------------------------------------------------------------------ *
 * 第 5 步：自选基因「一键出两张图」（DotPlot + 小提琴）
 * ------------------------------------------------------------------ */

/**
 * 单个基因的稀疏程度。
 *
 * 为什么界面需要它：单细胞数据里多数基因在多数细胞里是 0。一个基因 79% 的细胞为 0 时，
 * 密度峰值全压在 y=0，小提琴的琴身必然缩成一根竖线 —— 这是**数据形态**，不是画错。
 * 不给这个数字，用户只会觉得「图坏了」；给了之后，他能立刻明白「该看 DotPlot」。
 */
export interface ScrnaGeneStat {
  gene: string
  /** 表达该基因的细胞比例（0~1），越小越稀疏 */
  pctExpressing: number
  mean: number
  max: number
}

/**
 * 独立的出图调用 —— **不重跑 FindAllMarkers**。
 *
 * 客户要的是「填基因 → 按一下 → 出图」。挂在 markers 里意味着换一组基因要重跑
 * 四分钟的差异分析，而这两张图只依赖 `data` 层，跟 marker 无关。
 */
export interface ScrnaCustomPlotsRequest {
  scrnaId: string
  genes: string[]
}

export interface ScrnaCustomPlotsResult {
  scrnaId: string
  /** 实际画进图里的基因（按输入顺序，已去重、去掉不存在的） */
  genes: string[]
  /** 用户填了但数据里没有的基因（界面列出，不阻断） */
  missingGenes: string[]
  /** 实际画出来的基因的稀疏程度（界面据此解释「为什么是竖线」） */
  geneStats: ScrnaGeneStat[]
  nCells: number
  nGroups: number
  plots: ScrnaPlotImage[]
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * 第 6 步：细胞注释
 * ------------------------------------------------------------------ */

/** 一个簇的注释行（表格用） */
export interface ScrnaCelltypeRow {
  cluster: string
  cells: number
  celltype: string
  top10: { gene: string; avgLog2FC: number }[]
}

export interface ScrnaAnnotateRequest {
  scrnaId: string
  /** 人工注释：来自界面表格 */
  assignments?: { cluster: string; celltype: string }[]
  /** 人工注释：来自导入的注释表（客户格式：两列、制表符、无表头） */
  annotationFile?: string
}

export interface ScrnaAnnotateMerged {
  celltype: string
  clusters: string[]
}

export interface ScrnaAnnotateResult {
  scrnaId: string
  nCells: number
  nClusters: number
  mode: 'manual' | 'singleR'
  nCelltypes: number
  /** 有多少个细胞类型是由多个簇合并来的 */
  renamed: number
  merged: ScrnaAnnotateMerged[]
  /** 留空因而取了 cluster_N 的簇数 */
  unnamed: number
  celltypes: ScrnaCelltypeRow[]
  /**
   * 细胞类型 → 颜色（由簇色调色板派生，取该类型第一个簇的颜色）。
   *
   * 为什么要回给界面：客户会盯着「注释前那块粉色，注释后还是不是粉色」这件事看，
   * 界面上要能直接核对，而不是让他去猜。
   */
  celltypePalette: ScrnaCelltypePaletteEntry[]
  plots: ScrnaPlotImage[]
  annotationCsvPath: string
  objectPath: string
  durationMs: number
}

/** 预览：每簇的细胞数 + top10，供界面填表 */
export interface ScrnaAnnotatePreviewRequest {
  scrnaId: string
  /** 可选的注释表（导入后立刻回填输入框） */
  annotationFile?: string
}

export interface ScrnaAnnotatePreviewResult {
  clusters: string[]
  /**
   * 样本名（第 1 步写的 sample_stats.csv；外部导入的对象没有这个文件时为空）。
   *
   * 用来在「按样本拆分」前就提示「样本多时图会非常大」，而不是等用户跑完才说。
   */
  samples: string[]
  rows: ScrnaCelltypeRow[]
  /** 注释表里的 cluster → celltype（没有导入文件时为空） */
  imported: { cluster: string; celltype: string }[]
  /** 注释表与对象对不上的差异（空 = 对得上） */
  diff: { missing: string[]; extra: string[] }
}

/** SingleR 预览（只出建议，不写对象） */
export interface ScrnaSingleRRequest {
  scrnaId: string
  refRds: string
  labelColumn?: string
}

export interface ScrnaSingleRSuggestion {
  cluster: string
  celltype: string
  pruned: string
  score: number
}

export interface ScrnaSingleRResult {
  refLabel: string
  nClusters: number
  suggestions: ScrnaSingleRSuggestion[]
  singleRSeconds: number
  durationMs: number
}

/** 导出注释模板（cluster, celltype 两列，celltype 留空） */
export interface ScrnaExportTemplateRequest {
  scrnaId: string
  outPath: string
}

/* ------------------------------------------------------------------ *
 * 第 6 步·基因查询（注释之后的三张图）
 * ------------------------------------------------------------------ */

/** 分组依据：细胞类型（注释后）/ 簇（注释前后都能用） */
export type ScrnaGeneQueryGroupBy = 'celltype' | 'clusters'

export interface ScrnaGeneQueryRequest {
  scrnaId: string
  genes: string[]
  groupBy: ScrnaGeneQueryGroupBy
  /** '' = 不拆分；'orig.ident' = 按样本分面 */
  splitBy?: string
}

export interface ScrnaGeneQueryResult {
  scrnaId: string
  genes: string[]
  missingGenes: string[]
  geneStats: ScrnaGeneStat[]
  groupBy: ScrnaGeneQueryGroupBy
  splitBy: string
  nGroups: number
  /** 拆分出的样本名（不拆分时为空） */
  samples: string[]
  nCells: number
  /** 分组 → 颜色（与 UMAP 同一套：celltype 色由簇色派生） */
  palette: { group: string; color: string }[]
  plots: ScrnaPlotImage[]
  durationMs: number
}

/** 注释结果里的配色映射（用于核对「celltype 颜色确实由簇色派生」） */
export interface ScrnaCelltypePaletteEntry {
  celltype: string
  color: string
  /** 这个颜色来自哪个（些）簇，按 levels 顺序 */
  fromClusters: string[]
}
