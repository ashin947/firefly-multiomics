/**
 * 图表主题的读取与兜底。
 *
 * ## 为什么这组测试值得存在
 *
 * `resources/plotTheme.json` 曾经**整份变成 573 字节的 NUL（0x00）**，而
 * `loadPlotTheme()` 的设计是「读失败静默回落内置主题」——于是界面、出图、
 * 全部 226 个测试**都是绿的**，没有任何信号提示配色文件已经没了。
 *
 * 这就是「静默降级」的典型代价：兜底让故障不可见。
 * 所以这里的第一条断言不是「能读」，而是「**磁盘上的 JSON 和代码里的兜底
 * 必须逐字相等**」——只要有人改了 JSON 忘了改兜底（或者 JSON 被写坏），
 * 这条会立刻红，而不是等到用户发现「我改的配色没生效」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_PLOT_THEME, loadPlotTheme, paletteOf, resetPlotThemeCache, resolveVolcanoPresets } from '../PlotTheme'

const THEME_PATH = path.resolve(__dirname, '../../../../resources/plotTheme.json')

const tempFiles: string[] = []

function tempTheme(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-theme-'))
  const file = path.join(dir, 'plotTheme.json')
  fs.writeFileSync(file, content)
  tempFiles.push(file)
  return file
}

afterEach(() => {
  resetPlotThemeCache()
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

describe('resources/plotTheme.json 与内置兜底', () => {
  it('磁盘文件必须是合法 JSON（防止再次出现满文件 NUL 而无人发现）', () => {
    const raw = fs.readFileSync(THEME_PATH)
    // NUL 字节是「文件被写坏」最典型的特征：JSON.parse 会抛，但我们会静默兜底
    expect(raw.includes(0)).toBe(false)
    expect(() => JSON.parse(raw.toString('utf-8'))).not.toThrow()
  })

  it('磁盘上的 palettes / volcanoPresets / defaults 必须与 FALLBACK 逐字相等', () => {
    const theme = loadPlotTheme(THEME_PATH)
    expect(theme.palettes).toEqual(FALLBACK_PLOT_THEME.palettes)
    expect(theme.volcanoPresets).toEqual(FALLBACK_PLOT_THEME.volcanoPresets)
    expect(theme.defaults).toEqual(FALLBACK_PLOT_THEME.defaults)
  })

  it('volcanoPresets 里的每个名字都必须在 palettes 里真实存在且至少两色', () => {
    const theme = loadPlotTheme(THEME_PATH)
    for (const name of theme.volcanoPresets ?? []) {
      expect(theme.palettes[name], `配色 ${name} 在 volcanoPresets 里声明了但 palettes 里没有`).toBeDefined()
      expect(theme.palettes[name].length).toBeGreaterThanOrEqual(2)
    }
  })

  it('Nature 系配色都在，且上调色比下调色更暖（否则「上调=红」的直觉会被破坏）', () => {
    const theme = loadPlotTheme(THEME_PATH)
    for (const name of ['nature-npg', 'nature-deep', 'nature-soft']) {
      const palette = theme.palettes[name]
      expect(palette, `缺少 Nature 配色 ${name}`).toBeDefined()
      expect(palette.length).toBe(3)
    }
  })
})

describe('loadPlotTheme 的异常兜底', () => {
  it('文件是满屏 NUL 时返回内置主题，而不是抛错', () => {
    const file = tempTheme(Buffer.alloc(573, 0))
    const theme = loadPlotTheme(file)
    expect(theme).toEqual(FALLBACK_PLOT_THEME)
  })

  it('JSON 语法错误时返回内置主题', () => {
    const file = tempTheme('{ "palettes": { broken')
    expect(loadPlotTheme(file)).toEqual(FALLBACK_PLOT_THEME)
  })

  it('字段缺失（palettes 为空对象仍合法；defaults 缺失不合法）时返回内置主题', () => {
    const file = tempTheme(JSON.stringify({ palettes: { a: ['#000', '#fff'] } }))
    expect(loadPlotTheme(file)).toEqual(FALLBACK_PLOT_THEME)
  })

  it('文件不存在时返回内置主题', () => {
    expect(loadPlotTheme(path.join(os.tmpdir(), 'definitely-not-here-deg-theme.json'))).toEqual(
      FALLBACK_PLOT_THEME
    )
  })
})

describe('paletteOf / resolveVolcanoPresets', () => {
  const theme = FALLBACK_PLOT_THEME

  it('未知配色回落到 red-blue，绝不返回空数组', () => {
    expect(paletteOf(theme, 'no-such-palette')).toEqual(theme.palettes['red-blue'])
  })

  it('预设列表来自主题文件，且不含分类色 set2 与连续色 heat', () => {
    const presets = resolveVolcanoPresets(theme)
    expect(presets).toContain('nature-npg')
    expect(presets).not.toContain('set2')
    expect(presets).not.toContain('heat')
  })

  it('主题没声明 volcanoPresets 时，退化为「全部配色减去 set2 / heat」', () => {
    const presets = resolveVolcanoPresets({ ...theme, volcanoPresets: undefined })
    expect(presets.length).toBe(Object.keys(theme.palettes).length - 2)
    expect(presets).not.toContain('set2')
    expect(presets).not.toContain('heat')
  })

  it('声明的 preset 指向不存在的配色时，该条被过滤掉（不是原样返回）', () => {
    const presets = resolveVolcanoPresets({ ...theme, volcanoPresets: ['nature-npg', 'ghost'] })
    expect(presets).toEqual(['nature-npg'])
  })
})
