/**
 * 运行时「两级判定」策略 —— 首页三盏灯的**唯一真源**。
 *
 * 背景（产品决策，2025-06 定稿）：
 *   早先的实现是「缺任何一个物种库就整体 ok:false」，结果做 Mouse 项目的人
 *   会因为机器上没装 org.Hs.eg.db 而被拦在分析页外——这是错的。
 *
 * 现在的两级语义：
 *   ┌ 核心必需：R 运行时本身 + limma / DESeq2 / clusterProfiler / AnnotationDbi …
 *   │   → 缺失即**黄灯**（部分方法不可用），不再阻断进入分析页
 *   └ 按物种必需：org.Hs.eg.db / org.Mm.eg.db
 *       → **只有当前项目所选物种**对应的库缺失时才提示（黄灯，不阻断）
 *
 * 红灯只留给「R 运行时不可用」，这样用户看到红/黄两色就能立刻判断
 * 「是环境坏了」还是「这个物种的注释包没装」。
 *
 * ★ 2025-11 修订（客户机器实测后）：核心包缺失**不再是红灯、也不再阻断入口**。
 *   原因：包是**按方法**需要的 —— 客户机器上缺 DESeq2，但 limma-voom 完全能跑。
 *   按全局清单拦门的结果是「预检全绿、按钮可点、一点报缺 DESeq2」，比直接置灰更糟。
 *   现在灯保持黄、展开能看到「哪些方法能用」，能不能跑由所选方法自己说了算
 *   （`AnalysisRunner` 按 `module.requiredPackages` 判）。
 */
import type { Species } from './types/project'
import type { RRuntimeInfo, RuntimeMethodStatus } from './types/runtime'
import { SPECIES_ORG_DB } from './constants'

/** 状态灯颜色（绿=就绪 / 黄=可用但缺东西 / 红=不可用） */
export type StatusLight = 'green' | 'yellow' | 'red'

/** 物种 → 注释包名（人类可读文案用） */
export function speciesLibName(species: Species): string {
  return SPECIES_ORG_DB[species] ?? `org.${species}.eg.db`
}

/**
 * 某个方法「声明了、但 R 环境里没有」的包。
 *
 * ★ 这是**唯一**的缺失包计算入口：`RRuntimeResolver` 用它填 `info.methods`，
 *   `RProcessRunner.resolveRscript()` 用它判能不能起进程。
 *   任何地方再写一遍 `requiredPackages.filter(pkg => missing.includes(pkg))`
 *   都会让「首页说能用、跑起来说缺包」重新出现。
 */
export function missingPackagesFor(
  info: Pick<RRuntimeInfo, 'missingPackages' | 'packages'>,
  requiredPackages: readonly string[]
): string[] {
  if (requiredPackages.length === 0) return []
  const missing = new Set(info.missingPackages)
  const probed = new Map(info.packages.map((pkg) => [pkg.name, pkg.ok]))
  return requiredPackages.filter((pkg) => {
    if (missing.has(pkg)) return true
    const ok = probed.get(pkg)
    if (ok !== undefined) return !ok
    // 清单里没有这个包 = 自检根本没探它。按「缺」处理：宁可预检拦下，
    // 也不要起一个注定在 library() 处失败的 R 进程（30 秒后才报错，体验最差）。
    // 探测结果为空（自检没跑起来）时不臆断，交给「R 不可用」那条去报。
    return info.packages.length > 0
  })
}

/**
 * 当前 R 环境下**不可用**的方法（缺包的那些）。
 * `info.methods` 为空时（老缓存 / 未注册模块）返回空数组 —— 不凭空报缺。
 */
export function unavailableMethods(info: RRuntimeInfo): RuntimeMethodStatus[] {
  const methods = info.methods ?? []
  return methods.filter((m) => !m.available)
}

/** 所有方法都不可用吗？（用于「没有一个方法能跑」的措辞） */
export function allMethodsUnavailable(info: RRuntimeInfo): boolean {
  const methods = info.methods ?? []
  return methods.length > 0 && methods.every((m) => !m.available)
}

/**
 * 当前物种的注释库是否就绪。
 * 注意：RRuntimeInfo.speciesLibs 只有 human/mouse 两个键（§4.6），
 * 未知物种按「不阻断」处理，避免把未来新增物种的用户挡在门外。
 */
export function isSpeciesLibReady(info: RRuntimeInfo, species: Species): boolean {
  const flags = info.speciesLibs as Record<string, boolean | undefined>
  const flag = flags[species]
  return flag === true
}

/**
 * R 运行时灯：只有「R 不存在 / 探测跑不通 / 版本过低」才是红灯。
 *
 * ★ 缺包**不给红**（2025-11 修订）：`info.ok` 里含着「核心包齐全」这个条件，
 *   如果直接拿它判红，客户机器上只缺 DESeq2 时首页会出现「R 运行时 🔴」——
 *   而 R 明明跑得好好的，limma-voom 也能用。红灯必须专指「R 本身不可用」，
 *   否则红黄两色就失去了区分能力（这正是客户投诉「看着像整个软件坏了」的来源）。
 *   缺包由核心包灯（黄）表达。
 */
export function runtimeLight(info: RRuntimeInfo): StatusLight {
  if (!info.rscriptPath) return 'red'
  // 有 Rscript 但版本读不出来 = 自检没跑通，实际用不了
  if (info.version === '') return 'red'
  // ok=false 且没有缺包 → 只剩版本过低这一种可能
  if (!info.ok && info.missingPackages.length === 0) return 'red'
  return info.fontAvailable ? 'green' : 'yellow'
}

/**
 * 三盏灯里的「总体状态」：取最差的那一盏（红 > 黄 > 绿）。
 *
 * 侧边栏只有一个点，必须由这里算，不能让每个组件自己挑一盏灯来代表整体 ——
 * 否则会出现「侧边栏绿、首页黄」这种自相矛盾的画面。
 * `species` 省略时不参与（不知道当前项目物种的场合，如侧边栏）。
 */
export function overallLight(info: RRuntimeInfo, species?: Species): StatusLight {
  const lights: StatusLight[] = [runtimeLight(info), corePackagesLight(info)]
  if (species) lights.push(speciesLibLight(info, species))
  if (lights.includes('red')) return 'red'
  if (lights.includes('yellow')) return 'yellow'
  return 'green'
}

/**
 * 物种注释库灯：当前物种的库在位 = 绿，缺失 = 黄（**永远不红**）。
 *
 * 连「R 都没装」的情况也不给红：这盏灯只回答「这个物种的注释包在不在」，
 * R 本身的问题由上面那盏灯表达。两盏灯都红只会让用户不知道该修哪个。
 */
export function speciesLibLight(info: RRuntimeInfo, species: Species): StatusLight {
  if (!info.rscriptPath) return 'yellow'
  return isSpeciesLibReady(info, species) ? 'green' : 'yellow'
}

/**
 * 核心分析包灯：绿 = 全部方法都齐；黄 = 有方法缺包。
 *
 * **不再给红**：红灯的语义被独占给「R 运行时不可用」（见文件头）。包缺失是
 * 「这台机器能跑一部分方法」，不是「软件废了」—— 红黄两色必须能区分这两件事。
 *
 * 没有 Rscript 时给黄而不是红：此时「缺 limma」这个结论根本无从谈起
 * （探测都没跑起来），断言缺包是错误信息，真正的阻断原因由 `blockingReason()` 说。
 */
export function corePackagesLight(info: RRuntimeInfo): StatusLight {
  if (!info.rscriptPath) return 'yellow'
  if (unavailableMethods(info).length > 0) return 'yellow'
  if (info.missingPackages.length > 0) return 'yellow'
  // 没探到缺失包但 ok=false：可能是版本过低，也可能是自检本身失败 —— 都不能给绿
  return info.ok ? 'green' : 'yellow'
}

/** 把包名列表拼成「DESeq2、clusterProfiler」 */
function joinPackages(packages: readonly string[]): string {
  return packages.join('、')
}

/** 不可用方法所缺的包（去重，保持出现顺序） */
function missingPackagesOfUnavailable(info: RRuntimeInfo): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const method of unavailableMethods(info)) {
    for (const pkg of method.missingPackages) {
      if (seen.has(pkg)) continue
      seen.add(pkg)
      result.push(pkg)
    }
  }
  return result
}

/**
 * 核心包灯的中文文案。
 *
 * 措辞原则（客户视角）：先说**R 可用**，再说**部分方法暂不可用**并点出缺什么。
 * 旧文案「缺少：DESeq2（差异分析会被阻断）」会让只做 limma 的用户以为整个软件坏了。
 */
export function corePackagesMessage(info: RRuntimeInfo): string {
  if (!info.rscriptPath) return '未检测到 R，暂时无法确认分析包是否齐全。'

  const unavailable = unavailableMethods(info)
  if (unavailable.length > 0) {
    const pkgs = missingPackagesOfUnavailable(info)
    const methodLabels = unavailable.map((m) => m.label).join('、')
    return `R 可用，部分方法暂不可用（缺 ${joinPackages(pkgs)}）：${methodLabels} 暂不可选。`
  }

  // 没有方法需要、但清单里标了 required 的包（典型：富集分析用的 clusterProfiler/DOSE/enrichplot）
  const orphan = info.missingPackages
  if (orphan.length > 0) {
    return `R 可用，差异分析方法齐全；另缺 ${joinPackages(orphan)}（富集分析与基因名映射会受影响）。`
  }

  if (!info.ok) return '核心包清单未能完整探测，请运行诊断确认。'
  return 'limma / DESeq2 等核心包就绪。'
}

/**
 * 黄灯的补充说明（首页信息框用）。返回 null 表示没有需要提醒的部分可用问题。
 *
 * 与 `corePackagesMessage()` 的分工：灯下面那行是**一句话结论**，
 * 这个信息框是**怎么修**。两者都从 `info.methods` 读，不各算一套。
 */
export function partialAvailabilityReason(info: RRuntimeInfo): string | null {
  if (!info.rscriptPath) return null
  const unavailable = unavailableMethods(info)
  if (unavailable.length === 0) return null
  const parts = unavailable.map((m) => `${m.label} 需要 ${joinPackages(m.missingPackages)}`)
  return `部分方法暂不可用：${parts.join('；')}。其余方法不受影响，可直接使用。在 R 里执行 install.packages() 安装缺失的包后重新检测即可。`
}

/** 物种库缺失时的中文文案（供首页/分析页直接展示，避免各页面各写一套） */
export function speciesLibMessage(info: RRuntimeInfo, species: Species): string {
  const pkg = speciesLibName(species)
  if (!info.rscriptPath) {
    // 没有 R 就无从判断注释包在不在；不能凭空说「缺少 org.Hs.eg.db」
    return `未检测到 R，暂时无法确认注释库 ${pkg} 是否就绪。`
  }
  if (isSpeciesLibReady(info, species)) {
    return `当前物种注释库 ${pkg} 已就绪。`
  }
  const speciesLabel = species === 'mouse' ? 'Mouse' : 'Human'
  return `当前项目为 ${speciesLabel}，缺少 ${pkg}。请运行「环境诊断」修复后再做基因名映射与 GO 富集。`
}

/**
 * 进入分析页的总闸门：返回 null 表示放行，否则返回阻断原因（中文）。
 *
 * ★ 包缺失**不是**阻断原因（2025-11 修订）：差异分析按方法判包，
 *   缺 DESeq2 时 limma-voom 仍然能跑，拦在入口等于把能用的功能也关掉。
 *   能不能跑由预检的方法卡（`AnalysisPreflightResult.methods`）逐方法回答。
 *   这里只阻断「R 根本没有 / 版本过低」——那是所有方法都用不了的情况。
 */
export function blockingReason(info: RRuntimeInfo): string | null {
  if (!info.rscriptPath) return '未检测到 R 运行环境，无法进行差异分析。'
  if (!info.ok && info.version !== '' && info.missingPackages.length === 0) {
    return `R 版本 ${info.version || '未知'} 低于要求的 4.2.0。`
  }
  return null
}
