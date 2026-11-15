/**
 * 路由路径构造器 —— **唯一**允许拼路径的地方。
 *
 * 为什么放在 shared 而不是 renderer：
 *  `shared/modules.ts` 里的分析条目需要写明「点这个卡片去哪」（`AnalysisEntry.route`），
 *  而渲染层页面也需要同一套地址。若两边各写一份字符串，改一次路由就要改两处，
 *  漏改一处就会得到「卡片跳 404」这种最难查的问题。放在 shared 后，
 *  模块目录与页面导航共用同一组构造函数。
 *
 * 为什么不写在 router.tsx：
 *  页面组件要 `routes.analysis(...)`，若这些函数定义在 router.tsx，会形成
 *  「router → 页面 → router」的循环 import。Vite 下多数情况能跑，但热更新时
 *  容易出现 `routes is undefined` 的诡异问题，因此拆成独立模块。
 *
 * 路由结构（与 docs/ARCHITECTURE-MODULES.md §3.1 一致，两级）：
 *   /                                        工作台
 *   /module/:omicsId                         模块首页
 *   /module/:omicsId/data                    数据导入
 *   /module/:omicsId/analysis/:analysisId    分析配置（analysisId 决定分析类型）
 *   /module/:omicsId/result/:runId           结果总览（runId=latest 表示当前活动分析）
 *   /module/:omicsId/plot/:runId             作图
 *   /module/:omicsId/enrich/:runId           富集
 *   /module/:omicsId/venn                    绘图模块：Venn 图
 *   /module/:omicsId/violin                  绘图模块：分面小提琴 / 蜂群
 *   /module/:omicsId/survival                绘图模块：生存曲线
 *   /settings                                设置 / 诊断
 */

/** `latest` 是保留值：表示「项目当前的活动分析」，不是真实 runId */
export const LATEST_RUN = 'latest'

export const routes = {
  workspace: '/',
  module: (omicsId: string): string => `/module/${omicsId}`,
  data: (omicsId: string): string => `/module/${omicsId}/data`,
  analysis: (omicsId: string, analysisId: string): string => `/module/${omicsId}/analysis/${analysisId}`,
  /** runId 省略时用 `latest` 表示「当前活动分析」 */
  result: (omicsId: string, runId: string = LATEST_RUN): string => `/module/${omicsId}/result/${runId}`,
  plot: (omicsId: string, runId: string = LATEST_RUN): string => `/module/${omicsId}/plot/${runId}`,
  enrich: (omicsId: string, runId: string = LATEST_RUN): string => `/module/${omicsId}/enrich/${runId}`,
  /**
   * 时序转录组分析。
   *
   * 也是即时分析（一次配置一次出结果），但它有两种输入形态（单序列 / 两组），
   * 所以地址里不带 runId，模式由页面内部切换。
   */
  timeseries: (omicsId: string): string => `/module/${omicsId}/timeseries`,
  /** GSEA：即时分析，不依赖 runId */
  gsea: (omicsId: string): string => `/module/${omicsId}/gsea`,
  /**
   * WGCNA：两段式即时分析（先定软阈值，再建网络），同样不挂 runId。
   *
   * 但它的耗时量级和 GSEA 完全不同（TOM 要跑几分钟），所以界面自己会带
   * `?wgcnaId=` 来恢复已算过的结果 —— 见 `WgcnaPage` 的会话恢复逻辑。
   */
  wgcna: (omicsId: string): string => `/module/${omicsId}/wgcna`,
  /**
   * 单细胞流程（向导式，9 个步骤线性依赖）。
   *
   * 不挂 runId：流程的状态在页面里按步骤推进，每一步自己把产物写进
   * `results/scrna/<scrnaId>/`；把某个 runId 写进地址反而会让人以为
   * 「换个 id 就能看别人的流程」。
   */
  scrnaPipeline: (omicsId: string): string => `/module/${omicsId}/pipeline`,
  /**
   * 绘图模块的三张图。
   *
   * 这里没有 `runId`：这三张图是**即时出图**（改一个参数就重画），
   * 不产生需要回访的运行记录，硬塞一个 runId 只会让人以为结果被存了下来。
   */
  venn: (omicsId: string): string => `/module/${omicsId}/venn`,
  violin: (omicsId: string): string => `/module/${omicsId}/violin`,
  survival: (omicsId: string): string => `/module/${omicsId}/survival`,
  settings: '/settings'
} as const

/**
 * 当前唯一开放（`available`）的模块。
 * 工作台的新建/打开项目还没有「选择模块」这一步，先落到转录组；
 * 等模块选择器做出来后，这里换成项目元数据里的 omicsId 即可，调用点不用改。
 */
export const DEFAULT_OMICS_ID = 'transcriptome'
