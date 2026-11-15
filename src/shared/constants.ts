/**
 * 全项目共享常量（主进程 / 渲染进程 / preload 三侧通用）。
 *
 * 为什么集中在这里：阶段名、物种、图表类型这些字符串一旦在两侧各写一遍，
 * 拼写错误只会在运行时暴露（TS 无法跨文件校验字符串字面量的一致性）。
 */

/**
 * 应用展示名（出现在侧栏、窗口标题、关于框、诊断报告里）。
 *
 * ★ 只改这个名字不会动用户的已有数据：userData 目录来自 package.json 的 `name`
 *   （`deg-studio`），与这里无关。**不要**为了让名字出现得更多而去改 package.json
 *   的 name 或加 productName —— `app.getPath('userData')` 由 app.getName() 决定，
 *   一改用户之前建的项目、设置、临时目录就全"消失"了（其实是换了目录）。
 */
export const APP_NAME = 'Firefly'

/** 英文标识（侧栏副标题用；也方便日志里用 ASCII 指代这个应用） */
export const APP_NAME_EN = 'Firefly'

/** 应用 ID（electron-builder 用，单实例锁的 userData 目录名依赖它） */
export const APP_ID = 'com.degstudio.app'

/** 协议版本（R 侧与主进程必须一致，不一致直接报 E_RT_VERSION） */
export const PROTOCOL_VERSION = 1

/** 单行协议消息的最大字节数；超长必须改为「写文件 + artifact 引用」 */
export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024

/** 支持的最低 R 版本 */
export const MIN_R_VERSION = '4.2.0'

/** 探测结果缓存的有效期：7 天 */
export const PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ *
 * 进度阶段（顺序即进度条阶段，PRD R-28）
 * ------------------------------------------------------------------ */

export const STAGES = [
  'read',
  'filter',
  'normalize',
  'dispersion',
  'fit',
  'test',
  'enrich',
  'plot',
  'write'
] as const

export type Stage = (typeof STAGES)[number]

/** 阶段中文标签（进度条与日志面板共用） */
export const STAGE_LABELS: Record<Stage, string> = {
  read: '读取数据',
  filter: '低表达过滤',
  normalize: '标准化',
  dispersion: '估计离散度',
  fit: '拟合模型',
  test: '统计检验',
  enrich: '富集计算',
  plot: '绘图',
  write: '写出结果'
}

/**
 * 各分析方法的阶段序列（进度条只点亮该方法真正会经过的阶段）。
 * 与 ARCHITECTURE §5.2 的 pct 区间表一一对应。
 */
export const METHOD_STAGES: Record<string, Stage[]> = {
  'limma-voom': ['read', 'filter', 'normalize', 'fit', 'test', 'write'],
  'limma-lm': ['read', 'filter', 'fit', 'test', 'write'],
  deseq2: ['read', 'filter', 'normalize', 'dispersion', 'fit', 'test', 'write'],
  // edgeR QL F-test：与 deseq2 同一套阶段序列（都要估计离散度），
  // 这样两边的进度条节奏一致，用户切换方法时不会觉得「卡在别的地方」
  edger: ['read', 'filter', 'normalize', 'dispersion', 'fit', 'test', 'write'],
  'ora-go': ['read', 'enrich', 'write'],
  'ora-kegg': ['read', 'enrich', 'write'],
  export: ['read', 'write']
}

/* ------------------------------------------------------------------ *
 * 物种 / 数据类型
 * ------------------------------------------------------------------ */

export const SPECIES = ['human', 'mouse'] as const

export const SPECIES_LABELS: Record<string, string> = {
  human: '人 (Homo sapiens)',
  mouse: '小鼠 (Mus musculus)'
}

/** 物种 → org.*.eg.db 包名（R 侧与自检清单共用） */
export const SPECIES_ORG_DB: Record<string, string> = {
  human: 'org.Hs.eg.db',
  mouse: 'org.Mm.eg.db'
}

export const DATA_TYPES = ['counts', 'normalized'] as const

export const DATA_TYPE_LABELS: Record<string, string> = {
  counts: '原始 counts（整数）',
  normalized: '已归一化（log2 表达值）'
}

/* ------------------------------------------------------------------ *
 * 图表
 * ------------------------------------------------------------------ */

export const PLOT_TYPES = [
  'volcano',
  'heatmap',
  'pca',
  'boxplot',
  'enrich-bubble',
  'enrich-bar'
] as const

export const PLOT_TYPE_LABELS: Record<string, string> = {
  volcano: '火山图',
  heatmap: '热图',
  pca: 'PCA 图',
  boxplot: '箱线图',
  'enrich-bubble': '富集气泡图',
  'enrich-bar': '富集条形图'
}

/** 图表配色主题名（与 resources/plotTheme.json 的 palettes 键一致） */
export const PLOT_PALETTES = ['red-blue', 'viridis', 'set2', 'heat'] as const

/** 默认阈值（PRD R-15：logFC ≥ 1.0 且 FDR < 0.05） */
export const DEFAULT_THRESHOLDS = { logFC: 1.0, fdr: 0.05 } as const

/* ------------------------------------------------------------------ *
 * 项目目录结构
 * ------------------------------------------------------------------ */

export const PROJECT_SUFFIX = '.degproj'

export const PROJECT_FILE = 'project.json'

/** 新建项目时必须创建的目录（相对项目根） */
export const PROJECT_DIRS = [
  'data',
  'results',
  'results/de',
  'results/enrich',
  'figures',
  'cache',
  'logs'
] as const

/** 项目内固定文件名（相对路径） */
export const PROJECT_FILES = {
  rawMatrix: 'data/expression.raw.csv',
  cleanMatrix: 'data/expression.clean.csv',
  groups: 'data/groups.csv',
  geneIdMap: 'data/gene_id_map.json'
} as const

/* ------------------------------------------------------------------ *
 * 运行期限制（集中定义，便于单测与文档对照）
 * ------------------------------------------------------------------ */

export const LIMITS = {
  /** 日志环形缓冲条数（主进程内存，供「导出日志」） */
  logRingBuffer: 2000,
  /** 单个日志文件上限 10 MB，超出后切分 */
  logFileMaxBytes: 10 * 1024 * 1024,
  /** stderr 收集上限 */
  stderrMaxLines: 2000,
  stderrMaxBytes: 512 * 1024,
  /** raw 输出转发到 UI 的节流：每秒最多 50 行 */
  rawLinesPerSecond: 50,
  /** 进度事件节流 100 ms */
  progressThrottleMs: 100,
  /** 单个分析任务默认超时 30 min */
  runTimeoutMs: 30 * 60 * 1000,
  /** kill 后等待进程退出的上限 */
  killWaitMs: 3000,
  /** 最近项目列表上限 */
  recentProjects: 20,
  /** 结果表软上限（超过提示内存风险） */
  maxResultRows: 60_000,
  /** 错误详情截断长度 */
  errorDetailMaxChars: 20_000,
  /** stdout 连续解析失败多少行后触发 events.jsonl 兜底 */
  parseFailureFallbackThreshold: 3
} as const

/* ------------------------------------------------------------------ *
 * 文件对话框过滤器
 * ------------------------------------------------------------------ */

export interface FileFilter {
  name: string
  extensions: string[]
}

export const FILE_FILTERS: Record<string, FileFilter[]> = {
  matrix: [
    { name: '表达矩阵', extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xls'] },
    { name: 'CSV', extensions: ['csv'] },
    { name: 'Excel', extensions: ['xlsx', 'xls'] },
    { name: '全部文件', extensions: ['*'] }
  ],
  groups: [
    { name: '分组表', extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xls'] },
    { name: '全部文件', extensions: ['*'] }
  ],
  table: [
    { name: 'CSV', extensions: ['csv'] },
    { name: 'Excel', extensions: ['xlsx'] }
  ],
  figure: [
    { name: 'PNG', extensions: ['png'] },
    { name: 'PDF', extensions: ['pdf'] }
  ],
  log: [{ name: '日志', extensions: ['log', 'txt'] }],
  project: [{ name: 'Firefly 项目', extensions: ['degproj'] }]
}

/* ------------------------------------------------------------------ *
 * 运行 ID
 * ------------------------------------------------------------------ */

/** runId 形如 run-20250612T102233-a1b2（见 ARCHITECTURE §11.1） */
export const RUN_ID_PATTERN = /^run-\d{8}T\d{6}-[0-9a-z]{4}$/

/* ------------------------------------------------------------------ *
 * R 库路径角色标签
 * ------------------------------------------------------------------ */

/**
 * 诊断页 / 诊断报告里每个库目录的来历说明。
 *
 * 放在 shared 是因为主进程（Markdown 报告）与渲染进程（诊断弹窗）必须用**同一套**文案：
 * 两处措辞不一致时，用户拿着报告问「这个『应用可写库』和弹窗里那个是同一个吗」，
 * 排查就白做了。
 */
export const LIB_PATH_ROLE_LABELS: Record<string, string> = {
  bundled: '随包受控库（随软件分发，优先级最高）',
  'app-user': '应用可写库（经本软件安装的包）',
  'r-user-default': 'R 个人库（你自己在 R 里 install.packages 装的）',
  'r-site-default': 'R site-library',
  'r-base': 'R 自带 library（.Library）',
  other: '其他（环境变量自定义）'
}
