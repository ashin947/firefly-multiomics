/**
 * IPC 契约层：每个通道的入参 / 出参类型映射 + 渲染进程可见的桥接接口。
 *
 * 三重收益：
 *  1. 主进程 handler 的入参出参被 IpcInvokeMap 约束，写错字段编译期就报错；
 *  2. preload 桥按 DegBridge 实现，漏方法/签名不一致编译期报错；
 *  3. 渲染进程 window.deg 有完整补全（vite-env.d.ts 里声明）。
 */
import { IPC } from '../ipc'
import type { AppError, IpcResult } from '../errors'
import type { Stage } from '../constants'
import type {
  AnalysisMethodId,
  DemoVariant,
  LoadedDEResult,
  OpenProjectResult,
  ProjectCreateRequest,
  ProjectMeta,
  RecentProject
} from './project'
import type {
  DatasetSummary,
  DuplicateStrategy,
  GeneIdMap,
  GeneIdType,
  GroupImportResult,
  ImportMatrixResult,
  Issue
} from './dataset'
import type {
  AnalysisPreflightResult,
  DEConfig,
  DEResultRow,
  ThresholdState,
  DETableImportRequest,
  DETableImportResult,
  DETableInspectRequest,
  DETableInspectResult
} from './analysis'
import type { EnrichResultRow } from './enrich'
import type {
  ScrnaAnnotatePreviewRequest,
  ScrnaAnnotatePreviewResult,
  ScrnaAnnotateRequest,
  ScrnaAnnotateResult,
  ScrnaCustomPlotsRequest,
  ScrnaCustomPlotsResult,
  ScrnaGeneQueryRequest,
  ScrnaGeneQueryResult,
  ScrnaExportObjectRequest,
  ScrnaExportObjectResult,
  ScrnaExportTemplateRequest,
  ScrnaEmbedRequest,
  ScrnaEmbedResult,
  ScrnaExportMarkersRequest,
  ScrnaExportMarkersResult,
  ScrnaMarkersRequest,
  ScrnaMarkersResult,
  ScrnaMarkersTableRequest,
  ScrnaMarkersTableResult,
  ScrnaExportSummaryRequest,
  ScrnaFilterRequest,
  ScrnaFilterResult,
  ScrnaImportObjectRequest,
  ScrnaImportObjectResult,
  ScrnaImportRequest,
  ScrnaImportResult,
  ScrnaInspectRequest,
  ScrnaInspectResult,
  ScrnaPrepRequest,
  ScrnaPrepResult,
  ScrnaQcRequest,
  ScrnaQcResult,
  ScrnaScanRequest,
  ScrnaScanResult,
  ScrnaSingleRRequest,
  ScrnaSingleRResult
} from './scrna'
import type {
  TsCurvesRequest,
  TsCurvesResult,
  TsExportTableRequest,
  TsExportTableResult,
  TsInspectRequest,
  TsInspectResult,
  TsMoaninCurvesRequest,
  TsMoaninCurvesResult,
  TsMoaninRequest,
  TsMoaninResult,
  TsRunRequest,
  TsRunResult
} from './timeseries'
import type { GseaRunRequest, GseaRunResult } from './gsea'
import type {
  WgcnaExportAllRequest,
  WgcnaExportAllResult,
  WgcnaExportModuleGenesRequest,
  WgcnaExportModuleGenesResult,
  WgcnaModuleGenesRequest,
  WgcnaModuleGenesResult,
  WgcnaExportPlotRequest,
  WgcnaExportPlotResult,
  WgcnaExportTableRequest,
  WgcnaExportTableResult,
  WgcnaLoadRequest,
  WgcnaLoadResult,
  WgcnaNetworkRequest,
  WgcnaNetworkResult,
  WgcnaPrepareRequest,
  WgcnaPrepareResult
} from './wgcna'
import type {
  VizInspectRequest,
  VizInspectResult,
  VizRenderRequest,
  VizRenderResult
} from './viz'
import type { PlotConfig, PlotPayload, PlotThemeSpec, PlotType } from './plot'
import type {
  AppInfo,
  AppSettings,
  DiagnosticsReport,
  RRuntimeInfo,
  ValidateRPathResult
} from './runtime'

/* ------------------------------------------------------------------ *
 * 事件载荷
 * ------------------------------------------------------------------ */

export interface AnalysisProgressEvent {
  runId: string
  stage: Stage
  /** 0..100，主进程已保证单调不回退 */
  pct: number
  msg?: string
}

export type AnalysisLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'raw'

export interface AnalysisLogEvent {
  runId: string
  /** 毫秒时间戳 */
  ts: number
  level: AnalysisLogLevel
  line: string
}

export interface AnalysisDoneEvent {
  runId: string
  status: 'success' | 'failed' | 'cancelled'
  result?: unknown
  error?: AppError
}

/* ------------------------------------------------------------------ *
 * 请求 DTO
 * ------------------------------------------------------------------ */

export interface RuntimeProbeRequest {
  /** true = 跳过缓存强制重探 */
  force?: boolean
}

export interface PickFileRequest {
  filters: { name: string; extensions: string[] }[]
  multi?: boolean
}

export interface SaveFileRequest {
  defaultName: string
  filters: { name: string; extensions: string[] }[]
}

export interface MatrixImportRequest {
  filePath: string
  dataType: 'counts' | 'normalized'
  species: 'human' | 'mouse'
  geneIdColumn?: string
  duplicateStrategy?: DuplicateStrategy
}

export interface GroupImportRequest {
  filePath: string
  sampleColumn?: string
  groupColumn?: string
}

export interface ValidateDataRequest {
  /** 用户在向导里手工覆盖的项（如强制指定 counts 类型） */
  overrides?: Record<string, unknown>
}

export interface ValidateDataResult {
  issues: Issue[]
  summary: DatasetSummary
}

export interface ResolveGeneIdsRequest {
  target: GeneIdType
}

export interface ResolveGeneIdsResult {
  mapping: GeneIdMap['mapping']
  /** 未映射的基因数 */
  unmapped: number
  /** 参与转换的基因总数 */
  total: number
  /** 未映射比例 0..1（> 0.05 时 UI 显示黄色提示） */
  unmappedRatio: number
  /** 实际转换到的目标类型 */
  target: Exclude<GeneIdType, 'UNKNOWN'>
  /** 未映射比例过高时的中文提示 */
  warning?: string
}

export interface AnalysisRunRequest {
  method: AnalysisMethodId
  config: DEConfig
}

export interface AnalysisRunStartResult {
  runId: string
}

export interface AnalysisCancelRequest {
  runId: string
}

export interface AnalysisCancelResult {
  killed: boolean
}

/**
 * 预检请求：与 `run` 用同一个入参形状。
 * 这样「预检通过 → 点开始分析」之间不存在参数被替换的可能，
 * 前端也不需要为两个通道各拼一份 config。
 */
export interface AnalysisPreflightRequest {
  method: AnalysisMethodId
  config: DEConfig
}

export interface LoadDEResultRequest {
  analysisId: string
}

/**
 * 载入内置示例项目。
 *
 * `parentDir` 空串 = 用默认位置（userData/demo-projects）——渲染进程不想为了看
 * 示例数据先逼用户选目录，所以这个字段是可选语义，不能写成 `.min(1)`。
 *
 * `variant` 决定用哪份示例数据：默认 2000×24（实测 1.1 秒），stress 为 20000×48
 * （实测 2.8 秒、8 个进度台阶，用于观察进度粒度）。**默认值必须是 default**。
 */
export interface LoadDemoRequest {
  parentDir?: string
  variant?: DemoVariant
}

/**
 * 导出 GSEA 图片。
 *
 * 图是 R 在跑分析时就已经画好并落在 runDir 里的，这里只做「复制到用户选的位置」——
 * 不重新跑一遍 R。重画会带来两秒等待，还可能因为随机种子/设备差异让导出的图
 * 和屏幕上看到的不完全一样。
 */
export interface GseaExportPlotRequest {
  gseaId: string
  /** top = 前 N 个基因集总览；detail = 用户指定通路的详情 */
  which: 'top' | 'detail'
  outPath: string
  /**
   * 省略按 png。
   *
   * `pdf` 拷的是 R 用 `pdf()` 矢量设备画的另一份文件，不是把 png 包一层容器 ——
   * 后者投稿放大就是马赛克。两份文件在跑 GSEA 时就一起生成了。
   */
  format?: 'png' | 'pdf'
}

/** 导出 GSEA 完整结果表（转 runDir 里的 gsea_result.csv，不受界面行数影响） */
export interface GseaExportTableRequest {
  gseaId: string
  outPath: string
  format: 'csv' | 'xlsx'
}

export interface GseaExportTableResult {
  outPath: string
  bytes: number
  rows: number
}

export interface GseaExportPlotResult {
  outPath: string
  bytes: number
}

export interface EnrichRunRequest {
  /** 参与富集的基因（由渲染进程按当前阈值选出，或用户手填） */
  genes: string[]
  geneIdType: string
  species: 'human' | 'mouse' | 'rice' | 'other'
  sources: ('go' | 'kegg')[]
  ontology: 'BP' | 'MF' | 'CC' | 'ALL'
  pvalueCutoff: number
  qvalueCutoff: number
  customGoPath?: string
  customPathwayPath?: string
  customTermPrefix?: string
}

/**
 * 富集是**同步等待**的（不是像差异分析那样后台跑）：
 * 一次 ORA 通常 1~5 秒，值得直接等结果；做成异步要引入一整套进度/取消，
 * 对这个体量的计算是过度设计。
 */
export interface EnrichRunStartResult {
  enrichId: string
  rows: EnrichResultRow[]
  /** R 侧汇总（term 数、基因数、耗时、各库分布） */
  summary: Record<string, unknown>
}

/** 富集气泡图：给了 outPath 就是导出，否则返回 dataURL 预览 */
export interface EnrichPlotRequest {
  enrichId: string
  outPath?: string
  format?: 'png' | 'pdf'
  widthIn: number
  heightIn: number
  dpi?: number
  /** 每个（分面）取前 N */
  topN: number
  /** GO 的 BP/MF/CC 是否分开画 */
  splitByOntology: boolean
  title?: string
  palette?: string[]
}

export interface EnrichPlotResult {
  dataUrl?: string
  outPath?: string
  bytes: number
  terms: number
  durationMs: number
}

export interface EnrichLoadRequest {
  enrichId: string
}

/**
 * 富集结果表导出。
 *
 * ★ 导出的是 **R 侧写出的完整结果表**（`enrich_result.csv`），不是界面上
 *   筛选/折叠之后的视图。用户在页面上按 P 值筛剩 3 行、导出却拿到 41 行，
 *   很容易被当成 bug —— 所以按钮的 tooltip 里写明了这一点。
 *
 * csv 走 `fs.copyFile` 直拷（结果可能上万行，没必要读进内存再写一遍）；
 * xlsx 用 exceljs 从同一份 CSV 生成。
 */
export interface EnrichExportTableRequest {
  enrichId: string
  outPath: string
  format: 'csv' | 'xlsx'
}

export interface EnrichExportTableResult {
  outPath: string
  bytes: number
  rows: number
}

export interface PlotComputeRequest {
  type: PlotType
  config: PlotConfig
  analysisId: string
}

/**
 * 火山图导出（走 R / ggplot2，出版级）。
 *
 * 为什么带 `rows` 而不是文件路径：
 *   用户可能画的是**外部导入的表**（plotDataStore），它没有落在项目目录里。
 *   统一由渲染进程把「当前显示的这批行」传过来，主进程写临时 CSV 给 R，
 *   两种数据源走同一条路，也保证「导出的一定是屏幕上这批数据」。
 */
export interface PlotExportRequest {
  outPath: string
  format: 'png' | 'pdf'
  widthIn: number
  heightIn: number
  dpi: number
  /** 阈值（含 basis：判定用 P 还是校正 P）—— 必须与界面完全一致 */
  thresholds: ThresholdState
  /** 当前配色（界面里选的预设或自定义三色） */
  colors: { up: string; down: string; ns: string }
  rows: DEResultRow[]
  title?: string
}

/**
 * 预览图（同样走 R/ggplot2）。
 *
 * 为什么预览也要跑 R：客户要求「示意图和导出的图一样」。ECharts 无论怎么调参，
 * 网格、字号、图例排布都和 theme_bw 有肉眼可见的差别 —— 预览与成品不一致，
 * 用户就没法在导出前判断图好不好看。
 *
 * 代价：每次刷新要起一个 R 进程（约 1~2 秒）。所以前端**必须防抖**，
 * 且只在「松开滑块 / 切完配色」后请求，不能跟着 slider 的每一帧走。
 */
export interface PlotPreviewRequest {
  rows: DEResultRow[]
  thresholds: ThresholdState
  colors: { up: string; down: string; ns: string }
  /** 预览图物理宽度（英寸），由前端按容器尺寸换算 */
  widthIn: number
  heightIn: number
  title?: string
}

export interface PlotPreviewResult {
  /** data:image/png;base64,... 前端直接丢给 <img src> */
  dataUrl: string
  widthPx: number
  heightPx: number
  durationMs: number
}

/**
 * 热图请求（pheatmap）。
 *
 * 与火山图的差别：热图**必须有表达矩阵**，而矩阵只在项目里（`data/expression.clean.csv`）。
 * 所以这里不传矩阵，由主进程按当前项目根去读 —— 但**选哪些基因**仍然由前端传
 * `rows` + `geneList` 决定，保证「屏幕上筛出来的基因 = 画出来的基因」。
 */
export interface HeatmapPlotConfig {
  /** 用户自定义基因列表；非空时**完全忽略 topN**（这是客户明确要求的独立路径） */
  geneList: string[]
  /** geneList 为空时，按当前阈值筛出的显著基因、FDR 升序取前 N */
  topN: number
  clusterRows: boolean
  clusterCols: boolean
  /** pheatmap 的 scale：none / row（按基因标准化）/ column（按样本） */
  scale: 'none' | 'row' | 'column'
  showGeneNames: boolean
  showSampleNames: boolean
  /** 是否在顶部画样本分组色条（pheatmap 的 annotation_col） */
  showGroupAnnotation: boolean
  colors: { low: string; mid: string; high: string }
  title?: string
}

export interface HeatmapPreviewRequest extends HeatmapPlotConfig {
  rows: DEResultRow[]
  thresholds: ThresholdState
  widthIn: number
  heightIn: number
}

export interface HeatmapExportRequest extends HeatmapPreviewRequest {
  outPath: string
  format: 'png' | 'pdf'
  dpi: number
}

export interface HeatmapPlotResult {
  /** 预览时返回 */
  dataUrl?: string
  /** 导出时返回 */
  outPath?: string
  bytes: number
  /** 实际画进图的基因数（可能少于请求数：矩阵里没有的会被剔除） */
  genes: number
  samples: number
  durationMs: number
}

export interface PlotExportResult {
  outPath: string
  files: string[]
  bytes: number
  durationMs: number
  /** R 侧算出的三分类计数，用于和界面核对 */
  counts: { up: number; down: number; stable: number }
}

export interface PlotExportAllRequest {
  outDir: string
  analysisId: string
}

export interface PlotExportAllResult {
  files: string[]
}

/** 把 canvas dataURL 落盘成图片（前端 ECharts 导出，不是 R 绘图） */
export interface SaveImageRequest {
  /** 由 `system.saveFile` 拿到的绝对路径（扩展名决定编码后的文件类型） */
  outPath: string
  /** `canvas.toDataURL()` 的结果，形如 `data:image/png;base64,....` */
  dataUrl: string
}

export interface SaveImageResult {
  outPath: string
  bytes: number
}

export type ExportTableKind = 'de' | 'enrich'

export interface ExportTableRequest {
  kind: ExportTableKind
  format: 'csv' | 'xlsx'
  rows: Record<string, unknown>[]
  outPath: string
}

export interface ExportTableResult {
  outPath: string
}

export interface ExportLogRequest {
  runId: string
  outPath: string
}

export interface ExportLogResult {
  outPath: string
}

/* ------------------------------------------------------------------ *
 * invoke 契约映射（主进程 handler 用）
 * ------------------------------------------------------------------ */

export interface IpcInvokeMap {
  [IPC.runtime.probe]: { req: RuntimeProbeRequest | undefined; res: RRuntimeInfo }
  [IPC.runtime.diagnostics]: { req: undefined; res: DiagnosticsReport }
  [IPC.runtime.validatePath]: { req: { path: string }; res: ValidateRPathResult }
  [IPC.system.pickFile]: { req: PickFileRequest; res: string[] }
  [IPC.system.pickDir]: { req: undefined; res: string | null }
  [IPC.system.saveFile]: { req: SaveFileRequest; res: string | null }
  [IPC.system.revealPath]: { req: { path: string }; res: void }
  /** 白名单内的 https 链接，交给系统浏览器打开（celldex / SingleR 的下载页） */
  [IPC.system.openExternal]: { req: { url: string }; res: boolean }
  [IPC.system.appInfo]: { req: undefined; res: AppInfo }
  [IPC.system.plotTheme]: { req: undefined; res: PlotThemeSpec }
  [IPC.system.settings]: { req: undefined; res: AppSettings }
  [IPC.system.setSettings]: { req: Partial<AppSettings>; res: AppSettings }
  [IPC.project.create]: { req: ProjectCreateRequest; res: ProjectMeta }
  [IPC.project.open]: { req: { dir: string }; res: OpenProjectResult }
  [IPC.project.save]: { req: { patch: Partial<ProjectMeta> }; res: ProjectMeta }
  [IPC.project.close]: { req: undefined; res: void }
  [IPC.project.recent]: { req: undefined; res: RecentProject[] }
  [IPC.project.loadDemo]: { req: LoadDemoRequest; res: ProjectMeta }
  [IPC.data.importMatrix]: { req: MatrixImportRequest; res: ImportMatrixResult }
  [IPC.data.importGroups]: { req: GroupImportRequest; res: GroupImportResult }
  [IPC.data.validate]: { req: ValidateDataRequest | undefined; res: ValidateDataResult }
  [IPC.data.setGeneIdColumn]: { req: { column: string }; res: ImportMatrixResult }
  [IPC.data.aggregateDuplicates]: { req: { strategy: DuplicateStrategy }; res: ImportMatrixResult }
  [IPC.data.resolveGeneIds]: { req: ResolveGeneIdsRequest; res: ResolveGeneIdsResult }
  [IPC.data.inspectDETable]: { req: DETableInspectRequest; res: DETableInspectResult }
  [IPC.data.importDETable]: { req: DETableImportRequest; res: DETableImportResult }
  [IPC.analysis.run]: { req: AnalysisRunRequest; res: AnalysisRunStartResult }
  [IPC.analysis.cancel]: { req: AnalysisCancelRequest; res: AnalysisCancelResult }
  [IPC.analysis.loadResult]: { req: LoadDEResultRequest; res: LoadedDEResult }
  [IPC.analysis.preflight]: { req: AnalysisPreflightRequest; res: AnalysisPreflightResult }
  [IPC.enrich.run]: { req: EnrichRunRequest; res: EnrichRunStartResult }
  [IPC.enrich.loadResult]: { req: EnrichLoadRequest; res: EnrichResultRow[] }
  [IPC.enrich.plot]: { req: EnrichPlotRequest; res: EnrichPlotResult }
  [IPC.enrich.exportTable]: { req: EnrichExportTableRequest; res: EnrichExportTableResult }
  [IPC.scrna.scanDir]: { req: ScrnaScanRequest; res: ScrnaScanResult }
  [IPC.scrna.import]: { req: ScrnaImportRequest; res: ScrnaImportResult }
  [IPC.scrna.exportObject]: { req: ScrnaExportObjectRequest; res: ScrnaExportObjectResult }
  [IPC.scrna.qc]: { req: ScrnaQcRequest; res: ScrnaQcResult }
  [IPC.scrna.filter]: { req: ScrnaFilterRequest; res: ScrnaFilterResult }
  [IPC.scrna.exportSummary]: {
    req: ScrnaExportSummaryRequest
    res: ScrnaExportObjectResult
  }
  [IPC.scrna.prep]: { req: ScrnaPrepRequest; res: ScrnaPrepResult }
  [IPC.scrna.embed]: { req: ScrnaEmbedRequest; res: ScrnaEmbedResult }
  [IPC.scrna.markers]: { req: ScrnaMarkersRequest; res: ScrnaMarkersResult }
  [IPC.scrna.exportMarkers]: {
    req: ScrnaExportMarkersRequest
    res: ScrnaExportMarkersResult
  }
  [IPC.scrna.markersTable]: {
    req: ScrnaMarkersTableRequest
    res: ScrnaMarkersTableResult
  }
  [IPC.scrna.inspectObject]: { req: ScrnaInspectRequest; res: ScrnaInspectResult }
  [IPC.scrna.importObject]: { req: ScrnaImportObjectRequest; res: ScrnaImportObjectResult }
  [IPC.scrna.annotatePreview]: {
    req: ScrnaAnnotatePreviewRequest
    res: ScrnaAnnotatePreviewResult
  }
  [IPC.scrna.annotate]: { req: ScrnaAnnotateRequest; res: ScrnaAnnotateResult }
  [IPC.scrna.exportTemplate]: {
    req: ScrnaExportTemplateRequest
    res: ScrnaExportObjectResult
  }
  [IPC.scrna.singleRPreview]: { req: ScrnaSingleRRequest; res: ScrnaSingleRResult }
  [IPC.scrna.customPlots]: { req: ScrnaCustomPlotsRequest; res: ScrnaCustomPlotsResult }
  [IPC.scrna.geneQuery]: { req: ScrnaGeneQueryRequest; res: ScrnaGeneQueryResult }
  [IPC.scrna.exportPlot]: {
    req: { scrnaId: string; file: string; format: 'png' | 'pdf'; outPath: string }
    res: { outPath: string; bytes: number }
  }
  [IPC.scrna.exportAllPlots]: {
    req: { scrnaId: string; outDir: string; files?: string[] }
    res: { count: number; skipped: string[]; outDir: string }
  }
  [IPC.timeseries.inspectMatrix]: { req: TsInspectRequest; res: TsInspectResult }
  [IPC.timeseries.run]: { req: TsRunRequest; res: TsRunResult }
  [IPC.timeseries.runMoanin]: { req: TsMoaninRequest; res: TsMoaninResult }
  [IPC.timeseries.moaninCurves]: { req: TsMoaninCurvesRequest; res: TsMoaninCurvesResult }
  [IPC.timeseries.exportPlot]: {
    req: { tsId: string; file: string; format: 'png' | 'pdf'; outPath: string }
    res: { outPath: string; bytes: number }
  }
  [IPC.timeseries.exportAllPlots]: {
    req: { tsId: string; outDir: string; files?: string[] }
    res: { count: number; skipped: string[]; outDir: string }
  }
  [IPC.timeseries.curves]: { req: TsCurvesRequest; res: TsCurvesResult }
  [IPC.timeseries.exportTable]: { req: TsExportTableRequest; res: TsExportTableResult }
  [IPC.gsea.run]: { req: GseaRunRequest; res: GseaRunResult }
  [IPC.gsea.exportPlot]: { req: GseaExportPlotRequest; res: GseaExportPlotResult }
  [IPC.gsea.exportTable]: { req: GseaExportTableRequest; res: GseaExportTableResult }
  [IPC.wgcna.prepare]: { req: WgcnaPrepareRequest; res: WgcnaPrepareResult }
  [IPC.wgcna.network]: { req: WgcnaNetworkRequest; res: WgcnaNetworkResult }
  [IPC.wgcna.exportPlot]: { req: WgcnaExportPlotRequest; res: WgcnaExportPlotResult }
  [IPC.wgcna.exportAll]: { req: WgcnaExportAllRequest; res: WgcnaExportAllResult }
  [IPC.wgcna.exportTable]: { req: WgcnaExportTableRequest; res: WgcnaExportTableResult }
  [IPC.wgcna.loadResult]: { req: WgcnaLoadRequest; res: WgcnaLoadResult }
  [IPC.wgcna.moduleGenes]: { req: WgcnaModuleGenesRequest; res: WgcnaModuleGenesResult }
  [IPC.wgcna.exportModuleGenes]: {
    req: WgcnaExportModuleGenesRequest
    res: WgcnaExportModuleGenesResult
  }
  [IPC.viz.render]: { req: VizRenderRequest; res: VizRenderResult }
  [IPC.viz.inspectSource]: { req: VizInspectRequest; res: VizInspectResult }
  [IPC.plot.compute]: { req: PlotComputeRequest; res: PlotPayload }
  [IPC.plot.export]: { req: PlotExportRequest; res: PlotExportResult }
  [IPC.plot.preview]: { req: PlotPreviewRequest; res: PlotPreviewResult }
  [IPC.plot.previewHeatmap]: { req: HeatmapPreviewRequest; res: HeatmapPlotResult }
  [IPC.plot.exportHeatmap]: { req: HeatmapExportRequest; res: HeatmapPlotResult }
  [IPC.plot.exportAll]: { req: PlotExportAllRequest; res: PlotExportAllResult }
  [IPC.plot.saveImage]: { req: SaveImageRequest; res: SaveImageResult }
  [IPC.export.table]: { req: ExportTableRequest; res: ExportTableResult }
  [IPC.export.log]: { req: ExportLogRequest; res: ExportLogResult }
}

/** 所有 invoke 通道名的字面量联合 */
export type IpcInvokeChannel = keyof IpcInvokeMap

/** 事件通道 → 载荷类型 */
export interface IpcEventMap {
  [IPC.event.analysisProgress]: AnalysisProgressEvent
  [IPC.event.analysisLog]: AnalysisLogEvent
  [IPC.event.analysisDone]: AnalysisDoneEvent
  [IPC.event.runtimeChanged]: RRuntimeInfo
}

/** 事件取消订阅函数（preload 的 on* 方法必须返回它） */
export type Unsubscribe = () => void

/* ------------------------------------------------------------------ *
 * 渲染进程可见的桥接接口（window.deg）
 * ------------------------------------------------------------------ */

export interface DegBridge {
  runtime: {
    probe(req?: RuntimeProbeRequest): Promise<IpcResult<RRuntimeInfo>>
    diagnostics(): Promise<IpcResult<DiagnosticsReport>>
    validatePath(req: { path: string }): Promise<IpcResult<ValidateRPathResult>>
  }
  system: {
    pickFile(req: PickFileRequest): Promise<IpcResult<string[]>>
    pickDir(): Promise<IpcResult<string | null>>
    saveFile(req: SaveFileRequest): Promise<IpcResult<string | null>>
    revealPath(req: { path: string }): Promise<IpcResult<void>>
    openExternal(req: { url: string }): Promise<IpcResult<boolean>>
    appInfo(): Promise<IpcResult<AppInfo>>
    plotTheme(): Promise<IpcResult<PlotThemeSpec>>
    settings(): Promise<IpcResult<AppSettings>>
    setSettings(req: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
  }
  project: {
    create(req: ProjectCreateRequest): Promise<IpcResult<ProjectMeta>>
    open(req: { dir: string }): Promise<IpcResult<OpenProjectResult>>
    save(req: { patch: Partial<ProjectMeta> }): Promise<IpcResult<ProjectMeta>>
    close(): Promise<IpcResult<void>>
    recent(): Promise<IpcResult<RecentProject[]>>
    loadDemo(req: LoadDemoRequest): Promise<IpcResult<ProjectMeta>>
  }
  data: {
    importMatrix(req: MatrixImportRequest): Promise<IpcResult<ImportMatrixResult>>
    importGroups(req: GroupImportRequest): Promise<IpcResult<GroupImportResult>>
    validate(req?: ValidateDataRequest): Promise<IpcResult<ValidateDataResult>>
    setGeneIdColumn(req: { column: string }): Promise<IpcResult<ImportMatrixResult>>
    aggregateDuplicates(req: { strategy: DuplicateStrategy }): Promise<IpcResult<ImportMatrixResult>>
    resolveGeneIds(req: ResolveGeneIdsRequest): Promise<IpcResult<ResolveGeneIdsResult>>
    /** 外部差异表：探列（只读文件，不写任何东西） */
    inspectDETable(req: DETableInspectRequest): Promise<IpcResult<DETableInspectResult>>
    /** 外部差异表：按列映射解析成结果行（只读文件，不写任何东西） */
    importDETable(req: DETableImportRequest): Promise<IpcResult<DETableImportResult>>
  }
  analysis: {
    run(req: AnalysisRunRequest): Promise<IpcResult<AnalysisRunStartResult>>
    cancel(req: AnalysisCancelRequest): Promise<IpcResult<AnalysisCancelResult>>
    loadResult(req: LoadDEResultRequest): Promise<IpcResult<LoadedDEResult>>
    preflight(req: AnalysisPreflightRequest): Promise<IpcResult<AnalysisPreflightResult>>
  }
  enrich: {
    run(req: EnrichRunRequest): Promise<IpcResult<EnrichRunStartResult>>
    loadResult(req: EnrichLoadRequest): Promise<IpcResult<EnrichResultRow[]>>
    plot(req: EnrichPlotRequest): Promise<IpcResult<EnrichPlotResult>>
    exportTable(req: EnrichExportTableRequest): Promise<IpcResult<EnrichExportTableResult>>
  }
  gsea: {
    run(req: GseaRunRequest): Promise<IpcResult<GseaRunResult>>
    exportPlot(req: GseaExportPlotRequest): Promise<IpcResult<GseaExportPlotResult>>
    exportTable(req: GseaExportTableRequest): Promise<IpcResult<GseaExportTableResult>>
  }
  wgcna: {
    prepare(req: WgcnaPrepareRequest): Promise<IpcResult<WgcnaPrepareResult>>
    network(req: WgcnaNetworkRequest): Promise<IpcResult<WgcnaNetworkResult>>
    exportPlot(req: WgcnaExportPlotRequest): Promise<IpcResult<WgcnaExportPlotResult>>
    exportAll(req: WgcnaExportAllRequest): Promise<IpcResult<WgcnaExportAllResult>>
    exportTable(req: WgcnaExportTableRequest): Promise<IpcResult<WgcnaExportTableResult>>
    loadResult(req: WgcnaLoadRequest): Promise<IpcResult<WgcnaLoadResult>>
    moduleGenes(req: WgcnaModuleGenesRequest): Promise<IpcResult<WgcnaModuleGenesResult>>
    exportModuleGenes(
      req: WgcnaExportModuleGenesRequest
    ): Promise<IpcResult<WgcnaExportModuleGenesResult>>
  }
  /** 单细胞流程（当前只有第 1 步：数据导入与对象构建） */
  scrna: {
    scanDir(req: ScrnaScanRequest): Promise<IpcResult<ScrnaScanResult>>
    import(req: ScrnaImportRequest): Promise<IpcResult<ScrnaImportResult>>
    exportObject(req: ScrnaExportObjectRequest): Promise<IpcResult<ScrnaExportObjectResult>>
    qc(req: ScrnaQcRequest): Promise<IpcResult<ScrnaQcResult>>
    filter(req: ScrnaFilterRequest): Promise<IpcResult<ScrnaFilterResult>>
    exportSummary(req: ScrnaExportSummaryRequest): Promise<IpcResult<ScrnaExportObjectResult>>
    prep(req: ScrnaPrepRequest): Promise<IpcResult<ScrnaPrepResult>>
    embed(req: ScrnaEmbedRequest): Promise<IpcResult<ScrnaEmbedResult>>
    markers(req: ScrnaMarkersRequest): Promise<IpcResult<ScrnaMarkersResult>>
    exportMarkers(req: ScrnaExportMarkersRequest): Promise<IpcResult<ScrnaExportMarkersResult>>
    markersTable(req: ScrnaMarkersTableRequest): Promise<IpcResult<ScrnaMarkersTableResult>>
    inspectObject(req: ScrnaInspectRequest): Promise<IpcResult<ScrnaInspectResult>>
    importObject(req: ScrnaImportObjectRequest): Promise<IpcResult<ScrnaImportObjectResult>>
    annotatePreview(req: ScrnaAnnotatePreviewRequest): Promise<IpcResult<ScrnaAnnotatePreviewResult>>
    annotate(req: ScrnaAnnotateRequest): Promise<IpcResult<ScrnaAnnotateResult>>
    exportTemplate(req: ScrnaExportTemplateRequest): Promise<IpcResult<ScrnaExportObjectResult>>
    singleRPreview(req: ScrnaSingleRRequest): Promise<IpcResult<ScrnaSingleRResult>>
    customPlots(req: ScrnaCustomPlotsRequest): Promise<IpcResult<ScrnaCustomPlotsResult>>
    geneQuery(req: ScrnaGeneQueryRequest): Promise<IpcResult<ScrnaGeneQueryResult>>
    exportPlot(req: {
      scrnaId: string
      file: string
      format: 'png' | 'pdf'
      outPath: string
    }): Promise<IpcResult<{ outPath: string; bytes: number }>>
    exportAllPlots(req: {
      scrnaId: string
      outDir: string
      files?: string[]
    }): Promise<IpcResult<{ count: number; skipped: string[]; outDir: string }>>
  }
  /** 时序转录组（当前只有单序列 SAM） */
  timeseries: {
    inspectMatrix(req: TsInspectRequest): Promise<IpcResult<TsInspectResult>>
    run(req: TsRunRequest): Promise<IpcResult<TsRunResult>>
    runMoanin(req: TsMoaninRequest): Promise<IpcResult<TsMoaninResult>>
    moaninCurves(req: TsMoaninCurvesRequest): Promise<IpcResult<TsMoaninCurvesResult>>
    exportPlot(req: {
      tsId: string
      file: string
      format: 'png' | 'pdf'
      outPath: string
    }): Promise<IpcResult<{ outPath: string; bytes: number }>>
    exportAllPlots(req: {
      tsId: string
      outDir: string
      files?: string[]
    }): Promise<IpcResult<{ count: number; skipped: string[]; outDir: string }>>
    curves(req: TsCurvesRequest): Promise<IpcResult<TsCurvesResult>>
    exportTable(req: TsExportTableRequest): Promise<IpcResult<TsExportTableResult>>
  }
  /** 绘图模块：三张图共用一个通道，按 `kind` 分派 */
  viz: {
    render(req: VizRenderRequest): Promise<IpcResult<VizRenderResult>>
    inspectSource(req: VizInspectRequest): Promise<IpcResult<VizInspectResult>>
  }
  plot: {
    compute(req: PlotComputeRequest): Promise<IpcResult<PlotPayload>>
    export(req: PlotExportRequest): Promise<IpcResult<PlotExportResult>>
    preview(req: PlotPreviewRequest): Promise<IpcResult<PlotPreviewResult>>
    previewHeatmap(req: HeatmapPreviewRequest): Promise<IpcResult<HeatmapPlotResult>>
    exportHeatmap(req: HeatmapExportRequest): Promise<IpcResult<HeatmapPlotResult>>
    exportAll(req: PlotExportAllRequest): Promise<IpcResult<PlotExportAllResult>>
    saveImage(req: SaveImageRequest): Promise<IpcResult<SaveImageResult>>
  }
  export: {
    table(req: ExportTableRequest): Promise<IpcResult<ExportTableResult>>
    log(req: ExportLogRequest): Promise<IpcResult<ExportLogResult>>
  }
  events: {
    onAnalysisProgress(cb: (payload: AnalysisProgressEvent) => void): Unsubscribe
    onAnalysisLog(cb: (payload: AnalysisLogEvent) => void): Unsubscribe
    onAnalysisDone(cb: (payload: AnalysisDoneEvent) => void): Unsubscribe
    onRuntimeChanged(cb: (payload: RRuntimeInfo) => void): Unsubscribe
  }
}
