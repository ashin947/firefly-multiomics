/**
 * R 运行时相关类型（ARCHITECTURE §4.6）。
 *
 * 说明：RRuntimeInfo 是「能否跑」的唯一判据，UI 的三盏状态灯完全由它驱动。
 */
import type { AnalysisMethodId } from './project'

/**
 * Rscript 来源。
 *  `custom` = 用户在「设置」里手工指定的路径（客户机器上 R 装在 D:\R-4.3.2 且不在 PATH，
 *  这是真实用户最常见的场景，必须支持不改 PATH 也能用）。
 */
export type RuntimeSource = 'bundled' | 'system' | 'custom'

export interface RPackageStatus {
  name: string
  version: string | null
  ok: boolean
  required: boolean
}

/** 探测到的一个候选 Rscript（诊断页展示三级路径与存在性） */
export interface RuntimeCandidate {
  path: string
  source: RuntimeSource
  exists: boolean
  /** 人类可读的级别说明：「打包内置」「开发期目录」「系统 PATH」 */
  label: string
}

/**
 * 一种分析方法在**当前 R 环境**下的可用性。
 *
 * 为什么需要它（而不是只看 `missingPackages`）：
 *   客户机器上通常只缺一两个包（装了 limma 但没装 DESeq2）。如果只报「缺 DESeq2」，
 *   用户会以为整个软件不能做差异分析，实际上 limma-voom 完全能用。
 *   这份数据把「哪些方法能用、各自缺什么」逐行讲清楚，首页黄灯的展开详情直接消费它。
 *
 * ★ 它**只回答 R 包层面**的可用性，与数据无关：数据是否够（分组数、样本数、整数性）
 *   由预检的 `AnalysisPreflightResult.methods` 表达。两处语义不同，不要混用：
 *   首页没有打开项目时也能回答「这台机器能跑哪些方法」，靠的就是这份。
 */
export interface RuntimeMethodStatus {
  id: AnalysisMethodId
  label: string
  /** 该方法声明的 R 包（来自模块 `requiredPackages`，不在这里二次判断） */
  requiredPackages: string[]
  /** requiredPackages 中 R 环境实际缺失的部分（空数组 = 包齐全） */
  missingPackages: string[]
  /** 仅表示「R 包齐全」；不代表当前数据满足该方法的业务前置条件 */
  available: boolean
}

export interface RRuntimeInfo {
  /**
   * 可运行 = R 存在 + 版本达标 + **核心分析包**齐全。
   * 物种注释库（org.Hs.eg.db / org.Mm.eg.db）不参与该判定：做 Mouse 项目的人
   * 不该因为缺 Human 库被整体拦住，按物种的判定见 missingSpeciesLibs + runtimeStatus.ts。
   */
  ok: boolean
  source: RuntimeSource
  /** 绝对路径；未找到时为空字符串 */
  rscriptPath: string
  rHome: string | null
  /** "4.3.2"；未找到时为空字符串 */
  version: string
  /** "x86_64-w64-mingw32" */
  arch: string
  libPaths: string[]
  packages: RPackageStatus[]
  /** 核心必需包缺失（不再阻断入口：按方法判定，见 methods / runtimeStatus.ts） */
  missingPackages: string[]
  /** 物种注释库缺失（非阻断级：仅当前物种的项目提示黄灯） */
  missingSpeciesLibs: string[]
  speciesLibs: { human: boolean; mouse: boolean }
  /** 中文出图字体 */
  fontAvailable: boolean
  /** ISO 8601 UTC */
  probedAt: string
  warnings: string[]
  /**
   * 每种分析方法在**当前 R 环境**下是否可跑（按方法分别判包，不再一刀切）。
   * 首页「核心分析包」灯的展开详情直接渲染它；缺失包的计算只在
   * `RRuntimeResolver` 里做一次（见 `missingPackagesFor()`），别处不许重算。
   */
  methods: RuntimeMethodStatus[]
}

/** check_runtime.R 的 result.summary 结构 */
export interface RuntimeProbeResult {
  rVersion: string
  rArch: string
  platform: string
  packages: RPackageStatus[]
  speciesLibs: { human: boolean; mouse: boolean }
  fontFamilies: string[]
  /** R 的 .libPaths()，诊断用 */
  libPaths?: string[]
  /** R.home()，诊断用 */
  rHome?: string
}

/** 探测缓存（userData/runtime-probe.json） */
export interface RuntimeProbeCache {
  rscriptPath: string
  rscriptMtimeMs: number
  rscriptSize: number
  /** sha1 of r-libs-manifest.json */
  manifestHash: string
  result: RuntimeProbeResult
  probedAt: string
}

/**
 * R 库搜索路径里一个目录的角色。
 *
 * 为什么要有它：用户报「我明明装好了包，软件还说缺包」时，唯一能一眼定位的办法
 * 就是让他看到 `.libPaths()` 的**最终结果**和每一行的来历。角色标签比路径本身更重要 ——
 * 用户认不出 `C:/Users/x/AppData/Local/R/win-library/4.3` 是什么，但看得懂
 * 「R 个人库（你自己 install.packages 装的）」。
 */
export type LibPathRole =
  /** 随包分发的受控库（resources/runtime/R-libs）—— 优先级最高，同名包永远用它 */
  | 'bundled'
  /** 应用自己的可写库（userData/r-libs-user）—— 用户经本软件安装的包 */
  | 'app-user'
  /** R 自己的个人库（用户直接开 R 用 install.packages 装到这里） */
  | 'r-user-default'
  /** R 的 site-library（<R_HOME>/site-library） */
  | 'r-site-default'
  /** R 自带 library（.Library = <R_HOME>/library） */
  | 'r-base'
  /** 以上都不是（用户自定义 R_LIBS 等） */
  | 'other'

/** 诊断页展示的一行库路径 */
export interface LibPathEntry {
  path: string
  role: LibPathRole
  /** 目录当前是否存在（不存在的目录会被 R 静默跳过） */
  exists: boolean
  /** 是否真的出现在 R 最终报告的 `.libPaths()` 里 */
  effective: boolean
}

/** 环境诊断结果（DiagnosticsDialog 用） */
export interface DiagnosticsReport {
  runtime: RRuntimeInfo
  /** Markdown 文本报告，可直接复制/导出 */
  report: string
  /** 三级候选路径清单（UI 明确展示「我找过这些地方」） */
  candidates: RuntimeCandidate[]
  /**
   * R 包搜索路径的最终解析结果（按优先级排列）。
   * 前半部分是 R 真正生效的 `.libPaths()`，后半部分是「配了但没生效」的目录
   * （典型原因：目录不存在，R 会静默跳过）。
   */
  libPaths: LibPathEntry[]
  /** 未设置 R_LIBS_USER 时 R 的原始默认个人库（诊断对照用；探测失败时为空串） */
  rUserDefault: string
}

/** appInfo 出参 */export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  /** 开发期指向 <repo>/resources，打包后指向 <install>/resources */
  resourcesRoot: string
  /** R 脚本根（诊断用） */
  rScriptsRoot: string
  isDev: boolean
  platform: string
  arch: string
  userDataDir: string
  /**
   * 开发期演示数据开关（`DEG_DEV_MOCK=1` 且未打包时 true）。
   *
   * 客户机器上 R 已安装但缺少 limma/DESeq2，无法跑真实分析，而 UI 必须先验收。
   * 打开后渲染进程用内置的确定性假数据填充导入预览、结果表与火山图。
   * **生产构建恒为 false**（`isDev` 是硬门），因此打包产物里这条路径不可达。
   */
  mock: boolean
}

/**
 * 用户级设置（userData/settings.json）。
 *
 * 目前只有一项：自定义 Rscript 路径。放在 shared 是因为「设置页写入」与
 * 「RRuntimeResolver 读取」必须用同一个字段名 —— 否则用户填了路径却探测不到，
 * 这种 bug 表现为「明明填对了却提示找不到 R」，排查成本极高。
 */
export interface AppSettings {
  /**
   * 用户指定的 Rscript 可执行文件路径，或 R 安装根目录。
   * null 表示未指定（按 内置 → 开发期目录 → PATH 的顺序探测）。
   */
  customRPath: string | null
}

/** 校验自定义 R 路径的结果 */
export interface ValidateRPathResult {
  /** 该路径能否跑起来（能跑则为 true，即使缺包） */
  usable: boolean
  /** 规范化后的 Rscript 路径（目录入参会被补成 <dir>/bin/Rscript） */
  rscriptPath: string
  /** 探测到的运行时信息（usable=false 时为 undefined） */
  runtime?: RRuntimeInfo
  /** 失败原因（中文，直接展示在设置页） */
  reason?: string
}
