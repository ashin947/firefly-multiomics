/**
 * 图表类型与数据载荷（ARCHITECTURE §4.5）。
 *
 * 双实现约定：交互预览用 ECharts（本地数据），最终导出用 R/ggplot2。
 * 因此「预览所需数据」与「导出所需参数」是两件事：
 *   - PlotConfig 是**参数**（可序列化，落 project.json.plots，重开还原）
 *   - PlotPayload 是**数据**（每次 compute 得到，不落盘）
 */
import type { EnrichResultRow, EnrichSource } from './enrich'
import type { ThresholdState } from './analysis'

export type PlotType = 'volcano' | 'heatmap' | 'pca' | 'boxplot' | 'enrich-bubble' | 'enrich-bar'

export interface PlotBaseConfig {
  type: PlotType
  title: string
  /** 主题名，如 'red-blue' | 'viridis' | 'set2' */
  palette: string
  fontSize: number
  /** 英寸 */
  widthIn: number
  heightIn: number
  /** 默认 300 */
  dpi: number
  formats: ('png' | 'pdf')[]
  showGeneLabels: boolean
}

export interface VolcanoConfig extends PlotBaseConfig {
  type: 'volcano'
  logFC: number
  fdr: number
  /** 标注 Top N */
  topN: number
  pointSize: number
}

export interface HeatmapConfig extends PlotBaseConfig {
  type: 'heatmap'
  /** 默认 50 */
  topN: number
  /** 默认 true */
  zScore: boolean
  clusterRows: boolean
  clusterCols: boolean
  clusterMethod: 'complete' | 'average' | 'ward.D2' | 'single'
  distance: 'euclidean' | 'correlation' | 'manhattan'
  showGroupAnnotation: boolean
}

export interface PcaConfig extends PlotBaseConfig {
  type: 'pca'
  /** 默认 500 */
  topVariableGenes: number
  /** 1..5 */
  pcX: 1 | 2 | 3 | 4 | 5
  pcY: 1 | 2 | 3 | 4 | 5
  showEllipse: boolean
  logTransform: boolean
}

export interface BoxplotConfig extends PlotBaseConfig {
  type: 'boxplot'
  mode: 'gene' | 'qc'
  /** mode==='gene' */
  genes: string[]
  overlayPoints: boolean
  logAxis: boolean
}

export interface EnrichPlotConfig extends PlotBaseConfig {
  type: 'enrich-bubble' | 'enrich-bar'
  source: EnrichSource
  /** 默认 20 */
  topN: number
  orderBy: 'p.adjust' | 'count'
  sizeByCount: boolean
  colorByPAdjust: boolean
}

export type PlotConfig =
  | VolcanoConfig
  | HeatmapConfig
  | PcaConfig
  | BoxplotConfig
  | EnrichPlotConfig

/* ------------------------------------------------------------------ *
 * 数据载荷（R compute_* 产出，或前端本地构造）
 * ------------------------------------------------------------------ */

export interface PcaPayload {
  /** [42.3, 18.1, ...] */
  varianceExplained: number[]
  points: { sample: string; group: string; pc: number[] }[]
}

export interface HeatmapPayload {
  genes: string[]
  samples: string[]
  /** ★ 聚类顺序由 R 给出，保证预览与导出完全一致 */
  rowOrder: number[]
  colOrder: number[]
  /** z-score 后矩阵（已按 rowOrder/colOrder 排好） */
  values: number[][]
  /** sample -> group */
  groups: Record<string, string>
}

export interface BoxplotPayload {
  gene: string
  groups: string[]
  values: { group: string; sample: string; value: number }[]
}

/** 火山图载荷：前端由 DEResultRow[] 本地构造（不调 R） */
export interface VolcanoPayload {
  points: {
    geneId: string
    geneName: string | null
    logFC: number
    pValue: number
    adjPValue: number
  }[]
  thresholds: ThresholdState
}

/** 富集图载荷：前端由 EnrichResultRow[] 本地构造 */
export interface EnrichPlotPayload {
  rows: EnrichResultRow[]
}

/**
 * PlotPayload 判别联合。
 *
 * 说明：ARCHITECTURE §4.5 使用了 `PlotPayload` 这个名字但未给出联合定义，
 * 这里按「type 判别 + data」的形式补齐（见交付说明中的「需澄清项」）。
 */
export type PlotPayload =
  | { type: 'volcano'; data: VolcanoPayload }
  | { type: 'heatmap'; data: HeatmapPayload }
  | { type: 'pca'; data: PcaPayload }
  | { type: 'boxplot'; data: BoxplotPayload }
  | { type: 'enrich-bubble'; data: EnrichPlotPayload }
  | { type: 'enrich-bar'; data: EnrichPlotPayload }

/** 图表主题契约（resources/plotTheme.json，前端与 R 共用同一份） */
export interface PlotThemeSpec {
  palettes: Record<string, string[]>
  /**
   * 火山图配色下拉里展示的预设（palettes 的 key，按展示顺序）。
   *
   * 为什么不直接用「palettes 里所有长度 ≥3 的项」：
   * `set2`（6 色分类色）和 `heat`（连续热图色）取头尾当上/下调色会得到
   * 一对毫无对比度的颜色，列出来只会让用户选到难看的组合。
   * 这份白名单由主题文件控制，前端不硬编码 —— 加一个配色只改 JSON。
   */
  volcanoPresets?: string[]
  defaults: {
    fontSize: number
    widthIn: number
    heightIn: number
    dpi: number
    pointSize: number
  }
}
