/**
 * 绘图模块（`/module/viz`）的请求/响应类型。
 *
 * ## 为什么这个模块和转录组的作图不一样
 *
 * 转录组那几张图（火山、热图）画的是**项目里已算出的结果**，数据在
 * `results/` 下面，图是分析的延伸。而绘图模块的三张图（Venn / 分面小提琴 /
 * 生存曲线）画的是**用户手头任意一份数据**，与分析结果无关 —— 它更像一个
 * 「带 GUI 的作图小工具」。
 *
 * 因此这一层的数据来源有两种，刻意分开：
 *
 *  - **Venn**：用户在界面上直接粘贴基因列表（每组一列）。列表很小（几千个字符串），
 *    直接走 IPC 传进 R，不需要落文件，也不该强迫用户先准备一个文件。
 *  - **小提琴 / 生存曲线**：数据在用户自己的矩阵 / 临床表里，可能有几千基因 ×
 *    几十上百样本。**这种情况下只传文件路径，让 R 自己去读**，不要把整张表
 *    塞进 IPC —— 2000×24 的矩阵序列化成 JSON 是几 MB，来回两趟只为了画 4 个基因。
 *    界面上需要下拉选基因时，另走 `viz.inspectSource` 只取「列名 + 第一列候选值」。
 *
 * ## 输出约定
 *
 * `outPath` 不传 = 返回 PNG 的 dataURL 供界面预览；传了 = 写到那个路径（导出）。
 * 这与 `plot.preview` / `plot.export` 的语义一致，但合成一个通道：绘图参数
 * 预览与导出必须完全相同，分成两个通道迟早出现「屏幕上是这样、导出是那样」。
 */

/** 支持的三张图 */
export type VizKind = 'venn' | 'violin' | 'survival'

/** 所有图共用的**输出**参数（与「画什么」无关的那部分） */
export interface VizOutputSpec {
  widthIn: number
  heightIn: number
  /** 仅导出时使用，默认 300 */
  dpi?: number
  /** 传了就是导出；不传就是预览（返回 dataURL） */
  outPath?: string
  format?: 'png' | 'pdf'
}

/* -------------------------------------------------------------------------- */
/* Venn                                                                        */
/* -------------------------------------------------------------------------- */

/** 一个圈：名称 + 基因列表 */
export interface VennSet {
  name: string
  genes: string[]
}

export interface VennOptions {
  /** 是否填充颜色（参考站默认填充） */
  fill: boolean
  /** 显示交集数字 */
  showCount: boolean
  /** 显示占比（占该圈基因数） */
  showPercent: boolean
  /** 每个圈一个颜色，长度不足时循环使用 */
  palette: string[]
  /** 圈名与数字的字号（pt），不传按画布自适应 */
  labelSize?: number
}

/* -------------------------------------------------------------------------- */
/* 分面小提琴 / 蜂群                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 表达矩阵的定位信息。
 *
 * 矩阵按「行 = 基因，列 = 样本」读，第一列是基因 ID。`geneColumn` 不传时
 * 由 R 侧取第一列 —— 但界面会尽量把它探出来并显式传下去，避免「用户以为
 * 第一列是基因、其实前面还有一列序号」这类静默错位。
 */
export interface ExpressionSource {
  matrixPath: string
  /** 分组表（sample, group 两列）。不传则只能用矩阵列名当组 */
  groupsPath?: string
  geneColumn?: string
}

export interface ViolinSource extends ExpressionSource {
  /** 要画的基因，顺序即分面顺序 */
  genes: string[]
}

export interface ViolinOptions {
  /** 画法：小提琴 / 箱线 / 蜂群点 */
  plotType: 'violin' | 'box' | 'beeswarm'
  /**
   * 矩阵是否已经 log2 过。
   * 和差异分析里的同名开关一样：没 log 的一律不自动取 log（会改变分布形状），
   * 只在坐标轴标签上体现出来，避免用户以为「标准化过」。
   */
  inputIsLog2: boolean
  /** 组间检验方法 */
  testMethod: 'wilcox' | 't'
  /**
   * 图上括号标注哪个值。
   *
   * `p`（默认）：原始的组间 p 值，和「两组 Wilcoxon 得到 p=0.0002」这件事一一对应，
   * 客户直接要的就是这个。
   * `fdr`：BH 校正后的值，适合「一张图里有几十个基因，要控制假阳性」的场景。
   * 两者都在结果表里，切换只影响图上的标签，不影响检验本身。
   */
  pLabel: 'p' | 'fdr'
  /**
   * 两两比较的参照组。
   * 空 = 所有两两组合都画（组数多时括号会挤，由 R 侧限制最多画几条并告警）；
   * 指定某组 = 只画「其他组 vs 该组」。
   */
  refGroup?: string
  /** 叠画原始数据点 */
  showPoints: boolean
  /** 每组是否画均值横线（截图里那根黑横杠） */
  showMean: boolean
  /** 配色：ggsci 名称（lancet/jco/npg/aaas/nejm/...) 或逗号分隔的自定义色值 */
  palette: string
  /** 分面 y 轴是否各自独立 */
  facetFreeY: boolean
  yLabel?: string
  xLabel?: string
}

/* -------------------------------------------------------------------------- */
/* 生存曲线                                                                     */
/* -------------------------------------------------------------------------- */

export interface SurvivalSource {
  /** 临床/随访表：至少含 sample、time、status 三列 */
  clinicalPath: string
  /** groupBy='gene' 时必填 */
  matrixPath?: string
}

export interface SurvivalOptions {
  /**
   * 分组方式。
   *  - `table`：用临床表里的分组列（用户自己给的组，可以 >2 组）
   *  - `gene` ：按某基因表达量切分（经典 KM-by-gene）
   */
  groupBy: 'table' | 'gene'
  /** groupBy='table' 时：列名（不传则自动探测 group/condition/分组） */
  groupColumn?: string
  timeColumn?: string
  statusColumn?: string
  /** groupBy='gene' 时：基因名 */
  gene?: string
  /** groupBy='gene' 时的切分方式 */
  cutMethod?: 'median' | 'tertile' | 'quartile' | 'optimal'
  /** 表达矩阵是否已 log2（仅影响提示文案，不改变切分逻辑） */
  inputIsLog2?: boolean
  /** ggsurvplot 的 palette：ggsci 名 / RColorBrewer 名 / 自定义色值串 */
  palette: string
  confInt: boolean
  pval: boolean
  /** 显示 log-rank 检验方法名 */
  pvalMethod: boolean
  /** log-rank 权重，"1" 即标准 log-rank */
  logRankWeights: string
  riskTable: boolean
  /** risk table 高度占整图比例，ggsurvplot 默认 0.25 */
  riskTableHeight: number
  /** 图例标签，空的项按组名填 */
  legendLabs?: string[]
  xLabel?: string
  yLabel?: string
}

/* -------------------------------------------------------------------------- */
/* 请求 / 响应                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 「画什么」—— 三张图各自的数据与参数。
 *
 * ★ 刻意与 `VizOutputSpec` 分开，而不是写成一个带 `widthIn/heightIn` 的大联合：
 *   渲染进程的预览组件只负责「量尺寸 → 请求」，它需要的是一个**不含输出字段**的
 *   规格；用 `Omit<VizRenderRequest, 'widthIn'|...>` 是不行的 ——
 *   `Omit` 作用在联合类型上取的是各分支键的**交集**，会把 `sets`/`source`
 *   这些真正有用的字段一起丢掉，类型检查就此失效。
 */
export type VizPlotSpec =
  | { kind: 'venn'; sets: VennSet[]; options: VennOptions; title?: string }
  | { kind: 'violin'; source: ViolinSource; options: ViolinOptions; title?: string }
  | { kind: 'survival'; source: SurvivalSource; options: SurvivalOptions; title?: string }

/** 一次出图请求 = 画什么 + 怎么输出 */
export type VizRenderRequest = VizPlotSpec & VizOutputSpec

export interface VizRenderResult {
  /** 预览时返回；导出时为空 */
  dataUrl?: string
  outPath?: string
  bytes: number
  widthPx?: number
  heightPx?: number
  durationMs: number
  /**
   * R 侧的结构化摘要。三张图内容不同：
   *  - venn    ：各交集大小、每组基因数、实际用到的画法
   *  - violin  ：每组 n、每个基因的检验 p / FDR、画了几条括号
   *  - survival：每组 n、事件数、log-rank p、切分阈值
   */
  summary: Record<string, unknown>
}

/** 只读探测一个表格文件：给界面填下拉框，不解析整张表 */
export interface VizInspectRequest {
  filePath: string
}

export interface VizInspectResult {
  /** 分隔符与表头是否存在的判断结果，只用于显示 */
  delimiter: string
  columns: string[]
  /** 矩阵：第一列候选值（去重、截断） */
  rowKeys: string[]
  /** 第一列候选值的真实总数（可能远大于 rowKeys.length） */
  rowKeyTotal: number
  totalRows: number
  totalColumns: number
  /**
   * 按列名猜测的角色，界面用来预选下拉框。
   * 猜不到就是 undefined，不要瞎填 —— 猜错比不猜更糟。
   */
  suggested: {
    sampleColumn?: string
    groupColumn?: string
    timeColumn?: string
    statusColumn?: string
    geneColumn?: string
  }
  /**
   * 建议角色列的去重取值（最多 50 个）。
   *
   * 目前只给分组列的：界面要用它填「参照组」「图例标签个数」这类下拉，
   * 而这些值在探测阶段已经随文件解析出来了，没必要再为此开一个通道。
   * 时间/状态列不给 —— 那是连续值或 0/1，列出来没有意义。
   */
  roleValues: {
    group?: string[]
  }
  /** 前几行原样返回，界面用来做「这文件读对了吗」的肉眼确认 */
  preview: Record<string, string>[]
}
