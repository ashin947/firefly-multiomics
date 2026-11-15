/**
 * IPC 通道名常量 —— 全项目唯一真源。
 *
 * 命名规则（ARCHITECTURE §4.7 / §11.1）：
 *   请求通道：deg:<domain>:<camelCaseAction>
 *   事件通道：deg:event:<camelCase>
 *
 * 主进程 handler 注册、preload 桥、渲染进程调用都只允许引用这里的常量，
 * 任何地方写裸字符串都是 bug（拼错不会在编译期暴露）。
 */
export const IPC = {
  runtime: {
    probe: 'deg:runtime:probe',
    diagnostics: 'deg:runtime:diagnostics',
    /** 校验用户手工输入的 R 路径（不落盘，只探测） */
    validatePath: 'deg:runtime:validatePath'
  },
  system: {
    pickFile: 'deg:system:pickFile',
    pickDir: 'deg:system:pickDir',
    saveFile: 'deg:system:saveFile',
    revealPath: 'deg:system:revealPath',
    appInfo: 'deg:system:appInfo',
    /**
     * 图表主题（resources/plotTheme.json）。
     * 前端 ECharts 与 R/ggplot2 必须读同一份配色与字号（§6.8 强化点 2），
     * 因此主题只允许由主进程下发，渲染进程不得内置第二份配色表。
     */
    plotTheme: 'deg:system:plotTheme',
    /** 读取用户设置（目前只有自定义 R 路径） */
    settings: 'deg:system:settings',
    /** 写入用户设置（部分更新） */
    setSettings: 'deg:system:setSettings',
    /**
     * 用系统浏览器打开一个**白名单内**的 https 链接。
     *
     * 为什么要通道而不是让渲染进程 `window.open`：Electron 里 `window.open` 会开一个
     * 内嵌 BrowserWindow（没有地址栏、用户回不去），或者被 `setWindowOpenHandler`
     * 静默拦掉。走 `shell.openExternal` 才是「在用户自己的浏览器里打开」。
     * 白名单是硬要求：这个通道能被页面脚本调用，不做校验等于给任意 URL 开了后门。
     */
    openExternal: 'deg:system:openExternal'
  },
  project: {
    create: 'deg:project:create',
    open: 'deg:project:open',
    save: 'deg:project:save',
    close: 'deg:project:close',
    recent: 'deg:project:recent',
    loadDemo: 'deg:project:loadDemo'
  },
  data: {
    importMatrix: 'deg:data:importMatrix',
    importGroups: 'deg:data:importGroups',
    validate: 'deg:data:validate',
    setGeneIdColumn: 'deg:data:setGeneIdColumn',
    aggregateDuplicates: 'deg:data:aggregateDuplicates',
    resolveGeneIds: 'deg:data:resolveGeneIds',
    /**
     * 外部差异结果表（旁路数据源）：探列 → 按映射解析。
     *
     * ★ 这两个通道**只读文件**，不写任何东西。导入的行只活在渲染进程内存里，
     *   不落 de.csv、不改 project.json —— 用户切回分析结果即完全恢复。
     */
    inspectDETable: 'deg:data:inspectDETable',
    importDETable: 'deg:data:importDETable'
  },
  analysis: {
    run: 'deg:analysis:run',
    cancel: 'deg:analysis:cancel',
    loadResult: 'deg:analysis:loadResult',
    /**
     * 运行前预检（只读，不起 R 进程）。
     * 规则实现在 `AnalysisRunner` 里，与 `run` 起 R 前的那道校验**同一份代码**，
     * 避免「界面说能跑、主进程拒绝」的两套规则漂移。
     */
    preflight: 'deg:analysis:preflight'
  },
  enrich: {
    run: 'deg:enrich:run',
    loadResult: 'deg:enrich:loadResult',
    /** 富集气泡图：预览（返回 dataURL）或导出 */
    plot: 'deg:enrich:plot',
    /** 富集结果表导出：csv 直拷 / xlsx 由 exceljs 生成（导出的是全量结果表） */
    exportTable: 'deg:enrich:exportTable'
  },
  gsea: {
    /** 跑一次 GSEA：返回结果表 + top-N 图 + 指定通路图 */
    run: 'deg:gsea:run',
    /** 导出已生成的图（把 runDir 里的 png/pdf 复制到用户选择的位置） */
    exportPlot: 'deg:gsea:exportPlot',
    /**
     * 导出**完整**结果表。
     *
     * 界面上那张表是滚动展示的，用户要拿去排序/投稿附件的是磁盘上那份
     * `gsea_result.csv`（全部基因集，几千行也行）。所以这里不从渲染进程
     * 回传行数据，而是让主进程直接转 runDir 里的原文件 —— 既不丢精度
     * （浮点数不经过 JS 的 toFixed），也不会因为界面截断而少行。
     */
    exportTable: 'deg:gsea:exportTable'
  },
  wgcna: {
    /**
     * 第一段：读矩阵 + 质控 + 软阈值。
     *
     * 只做到 `pickSoftThreshold` 为止 —— 用户要看拟合曲线自己挑 β，所以这里
     * 必须把拟合表和三张质控图先还给界面，而不是一路跑到底。
     */
    prepare: 'deg:wgcna:prepare',
    /** 第二段：建网络（TOM 带缓存）+ 切模块 + 合并 + 关联性状 */
    network: 'deg:wgcna:network',
    /** 导出某一张诊断图（复制 runDir 里已生成的 png，不重画） */
    exportPlot: 'deg:wgcna:exportPlot',
    /** 一次把全部诊断图拷到用户选的目录 */
    exportAll: 'deg:wgcna:exportAll',
    /** 导出结果表（powers / genes / modules / traits / eigengenes） */
    exportTable: 'deg:wgcna:exportTable',
    /** 读某个模块的基因列表（按需从 wgcna_genes.csv 切，不塞进网络构建的返回值） */
    moduleGenes: 'deg:wgcna:moduleGenes',
    /** 导出模块基因：指定模块或全部模块，csv / xlsx / 纯文本 */
    exportModuleGenes: 'deg:wgcna:exportModuleGenes',
    /** 会话恢复：读回项目里已经跑过的 wgcna（免重算分钟级的网络） */
    loadResult: 'deg:wgcna:loadResult'
  },
  scrna: {
    /**
     * 扫描根目录下的 10x 样本 —— **不起 R**。
     * 只做 existsSync，用户点一下就要看到列表；40 MB 的 mtx 留到 import 再读。
     */
    scanDir: 'deg:scrna:scanDir',
    /** 构建 Seurat 对象（Read10X + CreateSeuratObject + merge），10 分钟超时 */
    import: 'deg:scrna:import',
    /** 下载当前对象 rds（复制 runDir 里的文件，不重新序列化） */
    exportObject: 'deg:scrna:exportObject',
    /** 第 2 步·段 A：QC 分布预览（只画图不删细胞，改阈值后重跑这一步） */
    qc: 'deg:scrna:qc',
    /** 第 2 步·段 B：按阈值真正过滤，产出 obj_step2.rds */
    filter: 'deg:scrna:filter',
    /** 导出 qc_summary.csv（与 exportObject 分开：一个是 rds，一个是统计表） */
    exportSummary: 'deg:scrna:exportSummary',
    /** 第 3 步：标准化 → 高变基因 → PCA → harmony 批次校正（单样本自动跳过） */
    prep: 'deg:scrna:prep',
    /** 第 4 步：FindNeighbors + FindClusters + UMAP + tSNE */
    embed: 'deg:scrna:embed',
    /** 第 5 步：FindAllMarkers + 二次筛选 + top10 + 热图 */
    markers: 'deg:scrna:markers',
    /** 导出 marker 表（csv 直拷 / xlsx 由主进程生成） */
    exportMarkers: 'deg:scrna:exportMarkers',
    /** 按条件查 marker 表（服务端过滤 + 分页，供搜索/显示全部） */
    markersTable: 'deg:scrna:markersTable',
    /** 只读检查一个外部 .rds 能否作为第 4/5/6 步的输入 */
    inspectObject: 'deg:scrna:inspectObject',
    /** 把外部对象落到 runDir，作为目标步骤的输入文件 */
    importObject: 'deg:scrna:importObject',
    /**
     * 第 6 步预览：簇 / 细胞数 / top10 —— **不起 R**。
     * 数据在第 5 步已经落盘（cluster_summary.csv + markers_top10.csv），
     * 为拼一张填表再起 R 读 200 MB rds 是白等 40 秒。
     */
    annotatePreview: 'deg:scrna:annotatePreview',
    /** 第 6 步·A：人工注释（表格映射或导入注释表），产出 obj_step6.rds */
    annotate: 'deg:scrna:annotate',
    /** 导出注释模板（cluster + 空 celltype，两列制表符无表头，与客户文件同格式） */
    exportTemplate: 'deg:scrna:exportTemplate',
    /** 第 6 步·B：SingleR 按簇注释（只出建议，不写对象） */
    singleRPreview: 'deg:scrna:singleRPreview',
    /**
     * 第 5 步：自选基因出图（DotPlot + 小提琴，一次调用两张图）。
     * 独立于 markers —— 换一组基因不该重跑四分钟的 FindAllMarkers。
     */
    customPlots: 'deg:scrna:customPlots',
    /** 第 6 步：基因查询（FeaturePlot / 小提琴 / DotPlot，支持 group.by 与 split.by） */
    geneQuery: 'deg:scrna:geneQuery',
    /** 导出单张图（png / pdf）：复制该次 scrna 运行里已生成的图 */
    exportPlot: 'deg:scrna:exportPlot',
    /** 批量导出该次 scrna 运行的全部图（pdf） */
    exportAllPlots: 'deg:scrna:exportAllPlots'
  },
  timeseries: {
    /**
     * 只读解析表头（**不起 R**）：样本名 → 组 / 时间点 / 重复。
     * 用户选完文件要立刻看到预览表并改错行，起 R 要 5~8 秒，等不起。
     */
    inspectMatrix: 'deg:timeseries:inspectMatrix',
    /** 单序列 SAM 时序分析（One class timecourse）；返回**全基因表**，阈值过滤在界面做 */
    run: 'deg:timeseries:run',
    /**
     * 两组 × 时间（moanin 样条模型）：一次跑完 DE + 五种 lfc + Fisher 合并 + 聚类 + 5 张图。
     * 与单序列 SAM 是两套统计，各自一个通道。
     */
    runMoanin: 'deg:timeseries:runMoanin',
    /** 两组模式的「自选基因曲线」：读主分析存下的 model（不重跑拟合） */
    moaninCurves: 'deg:timeseries:moaninCurves',
    /** 自选基因的时序曲线（单序列；复用同一份矩阵与样本映射） */
    curves: 'deg:timeseries:curves',
    /** 导出单张图（png / pdf）：复制 R 已生成的那份，不重新渲染 */
    exportPlot: 'deg:timeseries:exportPlot',
    /** 批量导出该次分析的全部图（pdf） */
    exportAllPlots: 'deg:timeseries:exportAllPlots',
    /** 导出结果表（csv 直拷 / xlsx 主进程生成） */
    exportTable: 'deg:timeseries:exportTable'
  },
  viz: {
    /**
     * 绘图模块（Venn / 分面小提琴 / 生存曲线）出图。
     *
     * 一个通道承载三张图，靠请求里的 `kind` 分派：三张图的输出语义完全一样
     * （给 outPath 就是导出、不给就是预览 dataURL），拆成三个通道只会让
     * 前端三份几乎相同的调用代码漂移。
     */
    render: 'deg:viz:render',
    /** 只读探测表格文件（列名 / 第一列候选 / 角色猜测），给界面填下拉框 */
    inspectSource: 'deg:viz:inspectSource'
  },
  plot: {
    compute: 'deg:plot:compute',
    export: 'deg:plot:export',
    exportAll: 'deg:plot:exportAll',
    /**
     * 把前端 canvas 导出的 dataURL 落盘成 PNG。
     *
     * 为什么不让渲染进程直接 <a download>：Electron 里那会静默存到「下载」目录，
     * 用户（科研人员，不是开发者）找不到文件，也不知道存到哪了。走主进程
     * 弹原生保存对话框，位置由用户决定，保存完再 reveal 出来。
     */
    saveImage: 'deg:plot:saveImage',
    /** 预览图（走 R/ggplot2，保证与导出图完全一致） */
    preview: 'deg:plot:preview',
    /** 热图预览 / 导出（pheatmap） */
    previewHeatmap: 'deg:plot:previewHeatmap',
    exportHeatmap: 'deg:plot:exportHeatmap'
  },
  export: {
    table: 'deg:export:table',
    log: 'deg:export:log'
  },
  event: {
    analysisProgress: 'deg:event:analysisProgress',
    analysisLog: 'deg:event:analysisLog',
    analysisDone: 'deg:event:analysisDone',
    runtimeChanged: 'deg:event:runtimeChanged'
  }
} as const

/** 所有 invoke 通道名的联合类型 */
export type IpcChannel =
  | (typeof IPC.runtime)[keyof typeof IPC.runtime]
  | (typeof IPC.system)[keyof typeof IPC.system]
  | (typeof IPC.project)[keyof typeof IPC.project]
  | (typeof IPC.data)[keyof typeof IPC.data]
  | (typeof IPC.analysis)[keyof typeof IPC.analysis]
  | (typeof IPC.enrich)[keyof typeof IPC.enrich]
  | (typeof IPC.gsea)[keyof typeof IPC.gsea]
  | (typeof IPC.wgcna)[keyof typeof IPC.wgcna]
  | (typeof IPC.scrna)[keyof typeof IPC.scrna]
  | (typeof IPC.timeseries)[keyof typeof IPC.timeseries]
  | (typeof IPC.plot)[keyof typeof IPC.plot]
  | (typeof IPC.export)[keyof typeof IPC.export]

/** 所有事件通道名的联合类型（main → renderer 单向） */
export type IpcEventChannel = (typeof IPC.event)[keyof typeof IPC.event]

/** 扁平化的通道名清单（用于诊断与「白名单」断言） */
export const ALL_IPC_CHANNELS: readonly string[] = [
  ...Object.values(IPC.runtime),
  ...Object.values(IPC.system),
  ...Object.values(IPC.project),
  ...Object.values(IPC.data),
  ...Object.values(IPC.analysis),
  ...Object.values(IPC.enrich),
  ...Object.values(IPC.gsea),
  ...Object.values(IPC.wgcna),
  ...Object.values(IPC.scrna),
  ...Object.values(IPC.timeseries),
  ...Object.values(IPC.viz),
  ...Object.values(IPC.plot),
  ...Object.values(IPC.export)
]

/** 事件通道白名单（preload 只允许订阅这些） */
export const ALL_IPC_EVENT_CHANNELS: readonly string[] = Object.values(IPC.event)
