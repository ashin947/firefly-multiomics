/**
 * 诊断页「R 包搜索路径」清单的构造。
 *
 * 这组测试守的是「装完了还说缺包」这个具体场景：用户把包装进了某个目录，
 * 而那个目录**没有**出现在 R 的 `.libPaths()` 里（R 会静默跳过不存在的目录）。
 * 诊断页必须能把这一行显示出来并标成「未生效」，否则用户永远查不出来。
 */
import { describe, expect, it } from 'vitest'
import { buildLibPathEntries, splitLibPath } from '../libPathRoles'

const BUNDLED = 'D:/app/resources/runtime/R-libs'
const APP_USER = 'C:/Users/Ashin/AppData/Roaming/deg-studio/r-libs-user'
const R_USER_DEFAULT = 'C:/Users/Ashin/AppData/Local/R/win-library/4.3'
const R_SITE_DEFAULT = 'D:/R-4.3.2/site-library'
const R_HOME = 'D:/R-4.3.2'
const R_BASE = 'D:/R-4.3.2/library'

/** 所有目录都「存在」的假文件系统 */
const allExist = (): boolean => true

describe('splitLibPath', () => {
  it('按平台分隔符拆分并去掉空项', () => {
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(splitLibPath(`a${sep}b${sep}${sep}c`)).toEqual(['a', 'b', 'c'])
  })

  it('空串 → 空数组', () => {
    expect(splitLibPath('')).toEqual([])
    expect(splitLibPath('   ')).toEqual([])
  })
})

describe('buildLibPathEntries', () => {
  const base = {
    bundled: BUNDLED,
    appUser: APP_USER,
    rUserDefault: R_USER_DEFAULT,
    rSiteDefault: R_SITE_DEFAULT,
    rHome: R_HOME,
    exists: allExist
  }

  it('按 R 的优先级顺序输出，且逐条标注来历', () => {
    const entries = buildLibPathEntries({
      ...base,
      effective: [BUNDLED, APP_USER, R_BASE]
    })
    expect(entries.map((e) => e.path)).toEqual([
      BUNDLED,
      APP_USER,
      R_BASE,
      // 后面是「配了但没生效」的：R 个人库 / site-library（本例都不在 effective 里）
      R_USER_DEFAULT,
      R_SITE_DEFAULT
    ])
    expect(entries.map((e) => e.role)).toEqual([
      'bundled',
      'app-user',
      'r-base',
      'r-user-default',
      'r-site-default'
    ])
    expect(entries.filter((e) => e.effective).map((e) => e.path)).toEqual([BUNDLED, APP_USER, R_BASE])
  })

  it('R 的默认个人库生效时排在内置库之后（受控版本仍优先）', () => {
    const entries = buildLibPathEntries({
      ...base,
      effective: [BUNDLED, APP_USER, R_USER_DEFAULT, R_SITE_DEFAULT, R_BASE]
    })
    expect(entries.map((e) => e.path)).toEqual([BUNDLED, APP_USER, R_USER_DEFAULT, R_SITE_DEFAULT, R_BASE])
    expect(entries.every((e) => e.effective)).toBe(true)
  })

  it('「包装进了不存在的目录」必须出现在清单里并标未生效', () => {
    const entries = buildLibPathEntries({
      ...base,
      // R 只报告了内置库：说明 R 个人库目录不存在
      effective: [BUNDLED],
      exists: (dir) => dir !== R_USER_DEFAULT
    })
    const missing = entries.find((e) => e.path === R_USER_DEFAULT)
    expect(missing).toBeDefined()
    expect(missing?.effective).toBe(false)
    expect(missing?.exists).toBe(false)
    expect(missing?.role).toBe('r-user-default')
  })

  it('未知目录归入 other（用户自己设了 R_LIBS 的情况）', () => {
    const entries = buildLibPathEntries({
      ...base,
      effective: ['E:/somewhere/else']
    })
    expect(entries[0].role).toBe('other')
  })

  it('角色判定不被用户改过的 R_LIBS_USER 带偏：bundled 优先于 r-user-default', () => {
    // 用户把 R_LIBS_USER 指到了应用自己的可写库
    const entries = buildLibPathEntries({
      ...base,
      rUserDefault: APP_USER,
      effective: [APP_USER]
    })
    expect(entries[0].role).toBe('app-user')
  })

  it('同一目录不会出现两次（effective 与 configured 重叠时）', () => {
    const entries = buildLibPathEntries({ ...base, effective: [BUNDLED, BUNDLED] })
    expect(entries.filter((e) => e.path === BUNDLED)).toHaveLength(1)
  })

  it('rHome 未知时不猜 .Library，也不崩', () => {
    const entries = buildLibPathEntries({ ...base, rHome: null, effective: [BUNDLED] })
    expect(entries.some((e) => e.role === 'r-base')).toBe(false)
  })

  it('rUserDefault 是多路径时逐个登记', () => {
    const sep = process.platform === 'win32' ? ';' : ':'
    const entries = buildLibPathEntries({
      ...base,
      rUserDefault: `${R_USER_DEFAULT}${sep}E:/second/lib`,
      effective: [BUNDLED]
    })
    const roles = entries.map((e) => `${e.path}=${e.role}`)
    expect(roles).toContain(`${R_USER_DEFAULT}=r-user-default`)
    expect(roles).toContain('E:/second/lib=r-user-default')
  })

  it('exists 抛异常时按不存在处理（权限不足的目录不能让诊断页崩掉）', () => {
    const entries = buildLibPathEntries({
      ...base,
      effective: [BUNDLED],
      exists: () => {
        throw new Error('EPERM')
      }
    })
    expect(entries.every((e) => e.exists === false)).toBe(true)
  })
})
