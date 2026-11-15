/**
 * WGCNA（加权基因共表达网络分析）的共享类型。
 *
 * ## 为什么要分两段（prepare → network）
 *
 * 客户实验室的流程是「先算软阈值，看拟合曲线，再决定 β」。这不是可有可无的
 * 交互 —— 软阈值选错会让整个网络失去无标度特性，后面所有模块都不可信。
 * 所以第一段只做到 `pickSoftThreshold` 为止，把拟合表和三张质控图交给用户，
 * 用户点完 β 再跑第二段。
 *
 * 还有一个更实际的理由：第二段（TOM + 层次聚类）在上万基因时要跑几分钟到
 * 十几分钟。如果合成一次调用，用户改一个 `minModuleSize` 就得连 TOM 一起
 * 重算 —— 而 TOM 与 `minModuleSize` 完全无关。分开之后第二段带 TOM 缓存，
 * 调模块粒度只花几秒。
 *
 * ## 与富集 / GSEA 的差别
 *
 * 那两个模块的产物是「一张表 + 一两张图」，这里是一整套诊断图（12 张）。
 * 每张图都要能单独看、单独导出，所以结果里给的是 `plots[]` 而不是几个具名
 * 字段 —— 加一张图不用改类型、不用改界面布局。
 */

/** 方差过滤档位（客户脚本默认 top50：`quantile(m.vars, 0.5)` 以上） */
export type WgcnaVarianceFilter = 'top25' | 'top50' | 'all'

/**
 * 表达矩阵的数值变换。
 *
 * `auto` 是默认：客户给的是 `count.gene.TMM.logCPM.tsv`（**已经是 logCPM**），
 * 而他们脚本里又无条件 `log2(data+1)` 了一次 —— 等于对已经取过对数的数据
 * 再取一次对数。这在他们的数据上「看起来也能出图」，但会压缩动态范围、削弱
 * 模块结构。默认 `auto` 按数值范围判断（最大值 > 50 认为没取过对数），
 * 并在结果里明确告诉用户这次到底做没做变换。
 */
export type WgcnaTransform = 'auto' | 'log2' | 'none'

/**
 * 模块-性状热图的配色（labeledHeatmap 的 `colors`）。
 *
 * 全部是**发散型**配色：相关系数有正负、有零点，单色渐变会把「无关」画成
 * 浅色而不是中性色，读图的人容易把 0.05 当成强相关。
 */
export type WgcnaHeatmapPalette =
  | 'blueWhiteRed'
  | 'greenWhiteRed'
  | 'rdbu'
  | 'rdylbu'
  | 'coolwarm'
  | 'puor'

export interface WgcnaPaletteOption {
  id: WgcnaHeatmapPalette
  label: string
  /** 一句话说明适用场景，界面上显示在色条旁边 */
  hint: string
  /** 三档色标（低 / 中 / 高），用于界面上的 CSS 渐变预览 */
  stops: [string, string, string]
}

/**
 * 可选配色表。
 *
 * `blueWhiteRed` / `greenWhiteRed` 是 WGCNA 官方教程与客户脚本在用的那两套；
 * 其余四套来自 ColorBrewer / ParaView 的经典发散色阶，色盲友好度和打印灰度
 * 层次都比纯红绿更好。
 */
export const WGCNA_HEATMAP_PALETTES: WgcnaPaletteOption[] = [
  {
    id: 'blueWhiteRed',
    label: '蓝-白-红（WGCNA 经典）',
    hint: '客户脚本默认，与官方教程一致，投稿最不容易被问',
    stops: ['#313695', '#FFFFFF', '#A50026']
  },
  {
    id: 'greenWhiteRed',
    label: '绿-白-红（WGCNA 经典）',
    hint: '同为 WGCNA 内置色阶，正的相关系数更醒目',
    stops: ['#006837', '#FFFFFF', '#A50026']
  },
  {
    id: 'rdbu',
    label: 'RdBu（ColorBrewer）',
    hint: '深蓝-白-深红，两端对比强，适合相关系数跨度大的图',
    stops: ['#2166AC', '#F7F7F7', '#B2182B']
  },
  {
    id: 'rdylbu',
    label: 'RdYlBu（ColorBrewer）',
    hint: '蓝-黄-红，中间调偏暖，黑白打印层次最清楚',
    stops: ['#313695', '#FFFFBF', '#A50026']
  },
  {
    id: 'coolwarm',
    label: 'CoolWarm（ParaView）',
    hint: '钢蓝-浅灰-砖红，饱和度和明度都柔和，色弱也能分辨',
    stops: ['#3B4CC0', '#DDDDDD', '#B40426']
  },
  {
    id: 'puor',
    label: 'PuOr（ColorBrewer）',
    hint: '紫-白-橙，避开红绿，适合已有大量红蓝图的稿子',
    stops: ['#542788', '#F7F7F7', '#B35806']
  }
]

/** 一张诊断图。`dataUrl` 为 null 表示 R 侧画失败（不阻断整次分析） */
/**
 * 诊断图的导出格式。
 *
 * `pdf` 是**用 R 的 pdf() 矢量设备重画一遍**，不是把 png 包进 pdf ——
 * 后者只是把位图塞进 PDF 容器，投稿时放大照样模糊，等于没做。
 * 所以 R 在分析阶段就把每张图同时画成 png 和 pdf，导出只是拷文件。
 * 代价是分析时多花几秒画图（矢量输出比 200 dpi 位图还快），换来的是
 * 论文里直接能用的矢量图 —— 这个交换很值。
 */
export type WgcnaPlotFormat = 'png' | 'pdf'

export interface WgcnaPlot {
  id: string
  title: string
  /** 这张图该看什么、什么算「不合格」，直接显示在图下面 */
  caption: string
  dataUrl: string | null
  /** 有没有同时生成矢量 PDF；老运行（加 PDF 之前跑的）没有，界面要引导重跑 */
  hasPdf: boolean
}

/** 软阈值拟合表的一行（对应 pickSoftThreshold 的 fitIndices） */
export interface WgcnaPowerRow {
  power: number
  /** 无标度拓扑拟合指数 R²（已按符号校正，越大越接近无标度） */
  signedR2: number
  /** 拟合斜率，理论上应接近 -1 */
  slope: number
  meanK: number
  medianK: number
  maxK: number
}

/** 第一段：读矩阵 + 质控 + 软阈值 */
export interface WgcnaPrepareRequest {
  /** 表达矩阵（行=基因，列=样本，第一列基因 ID）；Tab 或逗号分隔 */
  matrixPath: string
  /** 性状表（行=样本，列=性状，数值）；可空，为空时跳过性状相关分析 */
  traitPath?: string
  varianceFilter: WgcnaVarianceFilter
  transform: WgcnaTransform
  /** 样本离群剔除高度；不传/传 null 表示不剔除（默认） */
  sampleCutHeight?: number | null
  /** 最小样本数保护，默认 8 */
  minSamples?: number
}

export interface WgcnaPrepareResult {
  wgcnaId: string
  runDir: string
  /** 矩阵里的基因数（去重、去全零之后） */
  nGenesInput: number
  /** 方差过滤后真正进入网络的基因数 */
  nGenesUsed: number
  nSamples: number
  nSamplesRemoved: number
  /** 本次实际用的变换，auto 解析后的结果 */
  transformUsed: 'log2' | 'none'
  /** 方差过滤的分位阈值（all 时为 0） */
  varianceCutoff: number
  /** 性状列名；没有性状表时为空数组 */
  traits: string[]
  /** 矩阵里没能在性状表中找到的样本数 */
  unmatchedSamples: number
  powers: WgcnaPowerRow[]
  /** 首个 signedR2 ≥ 0.85 的 power；没有则为 null（界面提示手工挑） */
  recommendedPower: number | null
  plots: WgcnaPlot[]
  summary: Record<string, unknown>
}

/** 第二段：建网络 + 切模块 + 合并 + 关联性状 */
export interface WgcnaNetworkRequest {
  wgcnaId: string
  softPower: number
  /** 动态树剪切的最小模块基因数，客户脚本默认 100 */
  minModuleSize: number
  /** 模块特征向量聚类树上的合并高度，客户脚本用 0.25 */
  mergeHeight: number
  heatmapPalette: WgcnaHeatmapPalette
  /** 画单模块表达热图用哪个模块（颜色名）；留空取基因数最多的模块 */
  profileModule?: string
  /** 网络热图抽样基因数，默认 1000（全量 TOMplot 画不动也看不清） */
  tomSampleSize?: number
}

export interface WgcnaModuleRow {
  /** 模块颜色名，如 'turquoise' */
  module: string
  genes: number
}

/** 模块-性状相关表的一行（长表，便于直接导 CSV） */
export interface WgcnaTraitRow {
  module: string
  trait: string
  cor: number
  pvalue: number
  fdr: number
}

export interface WgcnaTableInfo {
  id: WgcnaTableId
  label: string
  /** runDir 内的文件名 */
  file: string
  rows: number
  /** 列说明，界面上做 tooltip */
  columns: string
}

export type WgcnaTableId = 'powers' | 'genes' | 'modules' | 'traits' | 'eigengenes'

export interface WgcnaNetworkResult {
  wgcnaId: string
  runDir: string
  geneCount: number
  /** 合并后各模块的基因数（不含 grey） */
  modules: WgcnaModuleRow[]
  traitRows: WgcnaTraitRow[]
  plots: WgcnaPlot[]
  tables: WgcnaTableInfo[]
  /** 本次是否命中了 TOM 缓存（决定「改模块粒度」是不是秒出） */
  tomCached: boolean
  summary: Record<string, unknown>
}

/**
 * 某个模块的基因列表。
 *
 * 客户的真实下一步动作就是「拿到 yellow 模块的基因去做富集 / 挑 hub」，
 * 所以这里按需读 `wgcna_genes.csv` 现切，而不是把上万条基因一次性塞进
 * 网络构建的返回值里（那会让每次「改模块粒度重跑」都多传几十 KB JSON）。
 */
export interface WgcnaModuleGenesRequest {
  wgcnaId: string
  /** 模块颜色名，如 'turquoise' */
  module: string
}

export interface WgcnaModuleGenesResult {
  module: string
  genes: string[]
  total: number
}

export interface WgcnaExportModuleGenesRequest {
  wgcnaId: string
  /** 留空 = 全部模块（长表 module,gene），便于一次导全 */
  module?: string
  outPath: string
  /**
   * csv / xlsx：带表头的表；txt：一行一个基因，直接贴进 DAVID、
   * clusterProfiler、metascape 这类只认基因列表的工具。
   */
  format: 'csv' | 'xlsx' | 'txt'
}

export interface WgcnaExportModuleGenesResult {
  outPath: string
  bytes: number
  genes: number
}

/** 导出某张诊断图（复制 runDir 里已生成的 png） */
export interface WgcnaExportPlotRequest {
  wgcnaId: string
  plotId: string
  outPath: string
  /** 省略按 png（保持老调用方不用改） */
  format?: WgcnaPlotFormat
}

export interface WgcnaExportPlotResult {
  outPath: string
  bytes: number
}

/** 导出结果表（main 直接把 runDir 里的 csv 转成 csv/xlsx） */
export interface WgcnaExportTableRequest {
  wgcnaId: string
  table: WgcnaTableId
  outPath: string
  format: 'csv' | 'xlsx'
}

export interface WgcnaExportTableResult {
  outPath: string
  bytes: number
  rows: number
}

/**
 * 一次导出全部诊断图。
 *
 * 默认两种格式都给：做论文要 PDF（矢量可放大），做 PPT/汇报要 PNG。
 * 让用户为这个再点一次菜单没有意义 —— 反正文件都在 runDir 里。
 */
export interface WgcnaExportAllRequest {
  wgcnaId: string
  /** 用户选的目录 */
  dir: string
  /** 省略 = ['png','pdf'] */
  formats?: WgcnaPlotFormat[]
}

export interface WgcnaExportAllResult {
  dir: string
  /** 实际写出的文件数（两种格式合计） */
  files: number
  png: number
  pdf: number
  /** 老运行没有 pdf 时，这里给出数量，界面据此提示重跑 */
  missingPdf: number
}

/** 会话恢复：项目里已有的 wgcna 运行 */
export interface WgcnaLoadRequest {
  wgcnaId: string
}

export interface WgcnaLoadResult {
  wgcnaId: string
  prepare: WgcnaPrepareResult | null
  network: WgcnaNetworkResult | null
}
