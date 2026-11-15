/**
 * RDefaultLibs 的纯函数部分。
 *
 * 为什么不测 `ensure()`：它要起一个真的 R 进程。那部分由
 * `scripts/verify-r-runtime.mjs`（真实 R）+ `npm run verify:r-failures`（真实
 * RProcessRunner）覆盖 —— 单测里塞一个假 R 只会测到假 R 的行为。
 *
 * 这里盯的是三个**静默失效**的点：
 *  ① 分隔符写错（Windows 上写成 `:`）→ R 把整串当成一个不存在的目录，一条都不生效；
 *  ② 空串/重复项没剔除 → `.libPaths()` 里出现重复行；
 *  ③ 探测输出解析错 → 把「没有默认库」和「解析失败」混为一谈。
 */
import { describe, expect, it } from 'vitest'
import { composeLibPath, libSeparator, normalizeForCompare, parseProbeStdout } from '../RDefaultLibs'

describe('composeLibPath', () => {
  it('按平台分隔符拼接（Windows ; / POSIX :）', () => {
    const joined = composeLibPath(['D:/a', 'D:/b'])
    expect(joined).toBe(`D:/a${libSeparator()}D:/b`)
    expect(libSeparator()).toBe(process.platform === 'win32' ? ';' : ':')
  })

  it('剔除空串与纯空白项（探测失败时 user 就是空串）', () => {
    expect(composeLibPath(['D:/a', '', '  ', 'D:/b'])).toBe(`D:/a${libSeparator()}D:/b`)
  })

  it('全部为空时返回空串，而不是一个分隔符', () => {
    expect(composeLibPath(['', ' '])).toBe('')
  })

  it('去重时忽略大小写与末尾分隔符（Windows 上 D:\\a 与 d:/a/ 是同一目录）', () => {
    const joined = composeLibPath(['D:/a', 'd:/a/', 'D:\\a'])
    expect(joined).toBe('D:/a')
  })

  it('保持传入顺序（顺序就是优先级，绝不能排序）', () => {
    expect(composeLibPath(['D:/z', 'D:/a'])).toBe(`D:/z${libSeparator()}D:/a`)
  })
})

describe('normalizeForCompare', () => {
  it('反斜杠转正斜杠并去掉末尾分隔符', () => {
    expect(normalizeForCompare('D:\\x\\y\\')).toBe(normalizeForCompare('D:/x/y'))
  })
})

describe('parseProbeStdout', () => {
  const STDOUT = [
    '##RLIBS:user=C:/Users/Ashin/AppData/Local/R/win-library/4.3',
    '##RLIBS:site=D:/R-4.3.2/site-library',
    '##RLIBS:rver=4.3.2',
    '##RLIBS:rhome=D:/R-4.3.2',
    '##RLIBS:lib=D:/R-4.3.2/library|D:/a'
  ].join('\n')

  it('解析出全部字段（含 .libPaths 列表）', () => {
    const parsed = parseProbeStdout(STDOUT)
    expect(parsed).not.toBeNull()
    expect(parsed?.user).toBe('C:/Users/Ashin/AppData/Local/R/win-library/4.3')
    expect(parsed?.site).toBe('D:/R-4.3.2/site-library')
    expect(parsed?.rVersion).toBe('4.3.2')
    expect(parsed?.rHome).toBe('D:/R-4.3.2')
    expect(parsed?.baseLibPaths).toEqual(['D:/R-4.3.2/library', 'D:/a'])
  })

  it('容忍 R 启动噪音与 CRLF', () => {
    const noisy = `During startup - Warning messages:\r\n1: Setting LC_CTYPE failed\r\n${STDOUT.replace(/\n/g, '\r\n')}\r\n`
    expect(parseProbeStdout(noisy)?.rVersion).toBe('4.3.2')
  })

  it('user 为空串是合法结果（不是解析失败）', () => {
    const parsed = parseProbeStdout('##RLIBS:user=\n##RLIBS:rver=4.3.2\n')
    expect(parsed).not.toBeNull()
    expect(parsed?.user).toBe('')
    expect(parsed?.site).toBe('')
    expect(parsed?.baseLibPaths).toEqual([])
  })

  it('完全没有 ##RLIBS: 行时返回 null（说明探测进程根本没跑起来）', () => {
    expect(parseProbeStdout('')).toBeNull()
    expect(parseProbeStdout('Error: Rscript not found\n')).toBeNull()
  })

  it('没有 user 键但有别的键时仍判为失败（缺了最关键的一项）', () => {
    expect(parseProbeStdout('##RLIBS:rver=4.3.2\n')).toBeNull()
  })
})
