/**
 * 把「R 最终报告的 `.libPaths()`」+「我们配置过的目录」拼成诊断用的清单。
 *
 * 纯函数（只依赖注入的 `exists`），因此可以脱离 Electron / R 单测。
 *
 * 排序规则刻意做成「先按 R 的优先级，再列配置了但没生效的」：
 *   ① R 报上来的每一条都保留原顺序 —— 这是包**实际**的查找顺序，用户最需要看的就是它；
 *   ② 之后补上「我们配了、但 R 没有列出来」的目录。这类目录几乎都是**不存在**
 *      （R 会静默跳过不存在的库目录），而「装完了还说缺包」十有八九就发生在这里：
 *      用户把包装进了 A 目录，而 A 目录根本没进 `.libPaths()`。
 */
import fs from 'node:fs'
import type { LibPathEntry, LibPathRole } from '@shared/types/runtime'
import { libSeparator, normalizeForCompare } from './RDefaultLibs'

export interface LibPathRoleInput {
  /** R 最终报告的 `.libPaths()`（顺序即优先级） */
  effective: readonly string[]
  /** resources/runtime/R-libs */
  bundled: string
  /** userData/r-libs-user */
  appUser: string
  /** R 的原始 R_LIBS_USER 默认值（可能是多路径） */
  rUserDefault: string
  /** R 的原始 R_LIBS_SITE 默认值（可能是多路径） */
  rSiteDefault: string
  /** R.home()；未知时传 null */
  rHome: string | null
  /** 目录是否存在（默认 fs.existsSync，测试可注入） */
  exists?(dir: string): boolean
}

/** 拆分多路径环境变量值（空串 → 空数组） */
export function splitLibPath(value: string): string[] {
  if (!value || value.trim().length === 0) return []
  return value
    .split(libSeparator())
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 构造诊断清单。
 *
 * 角色判定的顺序很重要：bundled / appUser 必须排在 rUserDefault 之前判断 ——
 * 否则用户把 `R_LIBS_USER` 指到应用自己的库时，那个目录会被误标成「R 个人库」。
 */
export function buildLibPathEntries(input: LibPathRoleInput): LibPathEntry[] {
  const exists = input.exists ?? ((dir: string): boolean => fs.existsSync(dir))

  /** 归一化路径 → 角色（同一目录只保留最先命中的角色） */
  const roleByPath = new Map<string, LibPathRole>()
  const register = (dir: string, role: LibPathRole): void => {
    const key = normalizeForCompare(dir)
    if (key.length === 0 || roleByPath.has(key)) return
    roleByPath.set(key, role)
  }

  register(input.bundled, 'bundled')
  register(input.appUser, 'app-user')
  for (const dir of splitLibPath(input.rUserDefault)) register(dir, 'r-user-default')
  for (const dir of splitLibPath(input.rSiteDefault)) register(dir, 'r-site-default')
  if (input.rHome) register(joinHome(input.rHome, 'library'), 'r-base')

  const entries: LibPathEntry[] = []
  const seen = new Set<string>()
  const push = (dir: string, effective: boolean): void => {
    const key = normalizeForCompare(dir)
    if (key.length === 0 || seen.has(key)) return
    seen.add(key)
    entries.push({
      path: dir,
      role: roleByPath.get(key) ?? 'other',
      exists: safeExists(exists, dir),
      effective
    })
  }

  // ① R 真正生效的顺序
  for (const dir of input.effective) push(dir, true)

  // ② 配了但没生效的（几乎都是目录不存在，所以 R 跳过了它）
  const configured = [
    input.bundled,
    input.appUser,
    ...splitLibPath(input.rUserDefault),
    ...splitLibPath(input.rSiteDefault),
    ...(input.rHome ? [joinHome(input.rHome, 'library')] : [])
  ]
  for (const dir of configured) push(dir, false)

  return entries
}

/** `<R_HOME>/library`（跨平台拼路径；R_HOME 可能用 `/` 也可能用 `\`） */
function joinHome(rHome: string, child: string): string {
  const trimmed = rHome.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}${child}`
}

function safeExists(fn: (dir: string) => boolean, dir: string): boolean {
  try {
    return fn(dir)
  } catch {
    return false
  }
}
