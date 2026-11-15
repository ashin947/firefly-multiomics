/**
 * Preload 桥（contextBridge）。
 *
 * 安全边界（ARCHITECTURE §3「IPC 边界铁律」）：
 *   - 只暴露白名单方法，**绝不**把 ipcRenderer / ipcRenderer.invoke 本体交出去；
 *   - 通道名来自 shared/ipc.ts 常量，渲染进程无法自造通道；
 *   - 事件订阅一律返回 unsubscribe 函数（组件卸载必须解绑，否则热更新后重复回调）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AnalysisCancelRequest,
  AnalysisLogEvent,
  AnalysisProgressEvent,
  AnalysisDoneEvent,
  AnalysisPreflightRequest,
  AnalysisRunRequest,
  DegBridge,
  EnrichLoadRequest,
  EnrichRunRequest,
  ExportLogRequest,
  ExportTableRequest,
  GroupImportRequest,
  LoadDEResultRequest,
  LoadDemoRequest,
  MatrixImportRequest,
  PickFileRequest,
  PlotComputeRequest,
  PlotExportAllRequest,
  SaveImageRequest,
  PlotExportRequest,
  ResolveGeneIdsRequest,
  RuntimeProbeRequest,
  SaveFileRequest,
  Unsubscribe,
  ValidateDataRequest
} from '../shared/types/ipc-contract'
// 外部差异表的两个请求类型定义在 analysis.ts（与 DEResultRow 同处），
// ipc-contract 只引用不 re-export，这里直接按来源导入
import type { DETableImportRequest, DETableInspectRequest } from '../shared/types/analysis'
import type { VizInspectRequest, VizRenderRequest } from '../shared/types/viz'
// GSEA 的两个类型分别来自 gsea.ts（业务入参/出参）与 ipc-contract（导出请求）
import type { GseaRunRequest } from '../shared/types/gsea'
import type {
  TsCurvesRequest,
  TsExportTableRequest,
  TsInspectRequest,
  TsMoaninCurvesRequest,
  TsMoaninRequest,
  TsRunRequest
} from '../shared/types/timeseries'
import type { GseaExportPlotRequest, GseaExportTableRequest } from '../shared/types/ipc-contract'
// WGCNA 的业务入参统一来自 wgcna.ts（与 gsea 一样，不从 ipc-contract 导业务类型）
import type {
  WgcnaExportAllRequest,
  WgcnaExportPlotRequest,
  WgcnaExportTableRequest,
  WgcnaExportModuleGenesRequest,
  WgcnaLoadRequest,
  WgcnaModuleGenesRequest,
  WgcnaNetworkRequest,
  WgcnaPrepareRequest
} from '../shared/types/wgcna'
import type {
  ScrnaAnnotatePreviewRequest,
  ScrnaAnnotateRequest,
  ScrnaCustomPlotsRequest,
  ScrnaGeneQueryRequest,
  ScrnaEmbedRequest,
  ScrnaExportTemplateRequest,
  ScrnaSingleRRequest,
  ScrnaExportMarkersRequest,
  ScrnaExportObjectRequest,
  ScrnaMarkersRequest,
  ScrnaMarkersTableRequest,
  ScrnaExportSummaryRequest,
  ScrnaFilterRequest,
  ScrnaImportObjectRequest,
  ScrnaImportRequest,
  ScrnaInspectRequest,
  ScrnaPrepRequest,
  ScrnaQcRequest,
  ScrnaScanRequest
} from '../shared/types/scrna'
import type {
  EnrichExportTableRequest,
  EnrichPlotRequest,
  HeatmapExportRequest,
  HeatmapPreviewRequest,
  PlotPreviewRequest
} from '../shared/types/ipc-contract'
import type { RRuntimeInfo } from '../shared/types/runtime'
import type { AppSettings } from '../shared/types/runtime'
import type { DuplicateStrategy } from '../shared/types/dataset'
import type { ProjectCreateRequest, ProjectMeta } from '../shared/types/project'

/**
 * 通用事件订阅。
 * 监听函数只把 payload 交给渲染进程，不泄露 IpcRendererEvent（它带有 sender，属于能力泄露）。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: DegBridge = {
  runtime: {
    probe: (req?: RuntimeProbeRequest) => ipcRenderer.invoke(IPC.runtime.probe, req),
    diagnostics: () => ipcRenderer.invoke(IPC.runtime.diagnostics),
    validatePath: (req: { path: string }) => ipcRenderer.invoke(IPC.runtime.validatePath, req)
  },
  system: {
    pickFile: (req: PickFileRequest) => ipcRenderer.invoke(IPC.system.pickFile, req),
    pickDir: () => ipcRenderer.invoke(IPC.system.pickDir),
    saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC.system.saveFile, req),
    revealPath: (req: { path: string }) => ipcRenderer.invoke(IPC.system.revealPath, req),
    openExternal: (req: { url: string }) => ipcRenderer.invoke(IPC.system.openExternal, req),
    appInfo: () => ipcRenderer.invoke(IPC.system.appInfo),
    plotTheme: () => ipcRenderer.invoke(IPC.system.plotTheme),
    settings: () => ipcRenderer.invoke(IPC.system.settings),
    setSettings: (req: Partial<AppSettings>) => ipcRenderer.invoke(IPC.system.setSettings, req)
  },
  project: {
    create: (req: ProjectCreateRequest) => ipcRenderer.invoke(IPC.project.create, req),
    open: (req: { dir: string }) => ipcRenderer.invoke(IPC.project.open, req),
    save: (req: { patch: Partial<ProjectMeta> }) => ipcRenderer.invoke(IPC.project.save, req),
    close: () => ipcRenderer.invoke(IPC.project.close),
    recent: () => ipcRenderer.invoke(IPC.project.recent),
    loadDemo: (req: LoadDemoRequest) => ipcRenderer.invoke(IPC.project.loadDemo, req)
  },
  data: {
    importMatrix: (req: MatrixImportRequest) => ipcRenderer.invoke(IPC.data.importMatrix, req),
    importGroups: (req: GroupImportRequest) => ipcRenderer.invoke(IPC.data.importGroups, req),
    validate: (req?: ValidateDataRequest) => ipcRenderer.invoke(IPC.data.validate, req),
    setGeneIdColumn: (req: { column: string }) =>
      ipcRenderer.invoke(IPC.data.setGeneIdColumn, req),
    aggregateDuplicates: (req: { strategy: DuplicateStrategy }) =>
      ipcRenderer.invoke(IPC.data.aggregateDuplicates, req),
    resolveGeneIds: (req: ResolveGeneIdsRequest) =>
      ipcRenderer.invoke(IPC.data.resolveGeneIds, req),
    inspectDETable: (req: DETableInspectRequest) =>
      ipcRenderer.invoke(IPC.data.inspectDETable, req),
    importDETable: (req: DETableImportRequest) => ipcRenderer.invoke(IPC.data.importDETable, req)
  },
  analysis: {
    run: (req: AnalysisRunRequest) => ipcRenderer.invoke(IPC.analysis.run, req),
    cancel: (req: AnalysisCancelRequest) => ipcRenderer.invoke(IPC.analysis.cancel, req),
    loadResult: (req: LoadDEResultRequest) => ipcRenderer.invoke(IPC.analysis.loadResult, req),
    preflight: (req: AnalysisPreflightRequest) => ipcRenderer.invoke(IPC.analysis.preflight, req)
  },
  enrich: {
    run: (req: EnrichRunRequest) => ipcRenderer.invoke(IPC.enrich.run, req),
    loadResult: (req: EnrichLoadRequest) => ipcRenderer.invoke(IPC.enrich.loadResult, req),
    plot: (req: EnrichPlotRequest) => ipcRenderer.invoke(IPC.enrich.plot, req),
    exportTable: (req: EnrichExportTableRequest) => ipcRenderer.invoke(IPC.enrich.exportTable, req)
  },
  gsea: {
    run: (req: GseaRunRequest) => ipcRenderer.invoke(IPC.gsea.run, req),
    exportPlot: (req: GseaExportPlotRequest) => ipcRenderer.invoke(IPC.gsea.exportPlot, req),
    exportTable: (req: GseaExportTableRequest) => ipcRenderer.invoke(IPC.gsea.exportTable, req)
  },
  wgcna: {
    prepare: (req: WgcnaPrepareRequest) => ipcRenderer.invoke(IPC.wgcna.prepare, req),
    network: (req: WgcnaNetworkRequest) => ipcRenderer.invoke(IPC.wgcna.network, req),
    exportPlot: (req: WgcnaExportPlotRequest) => ipcRenderer.invoke(IPC.wgcna.exportPlot, req),
    exportAll: (req: WgcnaExportAllRequest) => ipcRenderer.invoke(IPC.wgcna.exportAll, req),
    exportTable: (req: WgcnaExportTableRequest) => ipcRenderer.invoke(IPC.wgcna.exportTable, req),
    loadResult: (req: WgcnaLoadRequest) => ipcRenderer.invoke(IPC.wgcna.loadResult, req),
    moduleGenes: (req: WgcnaModuleGenesRequest) => ipcRenderer.invoke(IPC.wgcna.moduleGenes, req),
    exportModuleGenes: (req: WgcnaExportModuleGenesRequest) =>
      ipcRenderer.invoke(IPC.wgcna.exportModuleGenes, req)
  },
  scrna: {
    scanDir: (req: ScrnaScanRequest) => ipcRenderer.invoke(IPC.scrna.scanDir, req),
    import: (req: ScrnaImportRequest) => ipcRenderer.invoke(IPC.scrna.import, req),
    exportObject: (req: ScrnaExportObjectRequest) =>
      ipcRenderer.invoke(IPC.scrna.exportObject, req),
    qc: (req: ScrnaQcRequest) => ipcRenderer.invoke(IPC.scrna.qc, req),
    filter: (req: ScrnaFilterRequest) => ipcRenderer.invoke(IPC.scrna.filter, req),
    exportSummary: (req: ScrnaExportSummaryRequest) =>
      ipcRenderer.invoke(IPC.scrna.exportSummary, req),
    prep: (req: ScrnaPrepRequest) => ipcRenderer.invoke(IPC.scrna.prep, req),
    embed: (req: ScrnaEmbedRequest) => ipcRenderer.invoke(IPC.scrna.embed, req),
    markers: (req: ScrnaMarkersRequest) => ipcRenderer.invoke(IPC.scrna.markers, req),
    exportMarkers: (req: ScrnaExportMarkersRequest) =>
      ipcRenderer.invoke(IPC.scrna.exportMarkers, req),
    markersTable: (req: ScrnaMarkersTableRequest) =>
      ipcRenderer.invoke(IPC.scrna.markersTable, req),
    inspectObject: (req: ScrnaInspectRequest) => ipcRenderer.invoke(IPC.scrna.inspectObject, req),
    importObject: (req: ScrnaImportObjectRequest) => ipcRenderer.invoke(IPC.scrna.importObject, req),
    annotatePreview: (req: ScrnaAnnotatePreviewRequest) =>
      ipcRenderer.invoke(IPC.scrna.annotatePreview, req),
    annotate: (req: ScrnaAnnotateRequest) => ipcRenderer.invoke(IPC.scrna.annotate, req),
    exportTemplate: (req: ScrnaExportTemplateRequest) =>
      ipcRenderer.invoke(IPC.scrna.exportTemplate, req),
    singleRPreview: (req: ScrnaSingleRRequest) =>
      ipcRenderer.invoke(IPC.scrna.singleRPreview, req),
    customPlots: (req: ScrnaCustomPlotsRequest) => ipcRenderer.invoke(IPC.scrna.customPlots, req),
    geneQuery: (req: ScrnaGeneQueryRequest) => ipcRenderer.invoke(IPC.scrna.geneQuery, req),
    exportPlot: (req: { scrnaId: string; file: string; format: 'png' | 'pdf'; outPath: string }) =>
      ipcRenderer.invoke(IPC.scrna.exportPlot, req),
    exportAllPlots: (req: { scrnaId: string; outDir: string; files?: string[] }) =>
      ipcRenderer.invoke(IPC.scrna.exportAllPlots, req)
  },
  timeseries: {
    inspectMatrix: (req: TsInspectRequest) => ipcRenderer.invoke(IPC.timeseries.inspectMatrix, req),
    run: (req: TsRunRequest) => ipcRenderer.invoke(IPC.timeseries.run, req),
    runMoanin: (req: TsMoaninRequest) => ipcRenderer.invoke(IPC.timeseries.runMoanin, req),
    moaninCurves: (req: TsMoaninCurvesRequest) =>
      ipcRenderer.invoke(IPC.timeseries.moaninCurves, req),
    exportPlot: (req: { tsId: string; file: string; format: 'png' | 'pdf'; outPath: string }) =>
      ipcRenderer.invoke(IPC.timeseries.exportPlot, req),
    exportAllPlots: (req: { tsId: string; outDir: string; files?: string[] }) =>
      ipcRenderer.invoke(IPC.timeseries.exportAllPlots, req),
    curves: (req: TsCurvesRequest) => ipcRenderer.invoke(IPC.timeseries.curves, req),
    exportTable: (req: TsExportTableRequest) => ipcRenderer.invoke(IPC.timeseries.exportTable, req)
  },
  viz: {
    render: (req: VizRenderRequest) => ipcRenderer.invoke(IPC.viz.render, req),
    inspectSource: (req: VizInspectRequest) => ipcRenderer.invoke(IPC.viz.inspectSource, req)
  },
  plot: {
    compute: (req: PlotComputeRequest) => ipcRenderer.invoke(IPC.plot.compute, req),
    export: (req: PlotExportRequest) => ipcRenderer.invoke(IPC.plot.export, req),
    preview: (req: PlotPreviewRequest) => ipcRenderer.invoke(IPC.plot.preview, req),
    previewHeatmap: (req: HeatmapPreviewRequest) =>
      ipcRenderer.invoke(IPC.plot.previewHeatmap, req),
    exportHeatmap: (req: HeatmapExportRequest) => ipcRenderer.invoke(IPC.plot.exportHeatmap, req),
    exportAll: (req: PlotExportAllRequest) => ipcRenderer.invoke(IPC.plot.exportAll, req),
    saveImage: (req: SaveImageRequest) => ipcRenderer.invoke(IPC.plot.saveImage, req)
  },
  export: {
    table: (req: ExportTableRequest) => ipcRenderer.invoke(IPC.export.table, req),
    log: (req: ExportLogRequest) => ipcRenderer.invoke(IPC.export.log, req)
  },
  events: {
    onAnalysisProgress: (cb: (p: AnalysisProgressEvent) => void) =>
      subscribe<AnalysisProgressEvent>(IPC.event.analysisProgress, cb),
    onAnalysisLog: (cb: (p: AnalysisLogEvent) => void) =>
      subscribe<AnalysisLogEvent>(IPC.event.analysisLog, cb),
    onAnalysisDone: (cb: (p: AnalysisDoneEvent) => void) =>
      subscribe<AnalysisDoneEvent>(IPC.event.analysisDone, cb),
    onRuntimeChanged: (cb: (p: RRuntimeInfo) => void) =>
      subscribe<RRuntimeInfo>(IPC.event.runtimeChanged, cb)
  }
}

contextBridge.exposeInMainWorld('deg', bridge)
