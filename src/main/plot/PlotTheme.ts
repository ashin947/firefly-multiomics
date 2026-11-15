/**
 * 图表主题（resources/plotTheme.json）的读取与校验。
 *
 * 为什么放在主进程：
 *  - 渲染进程不允许直接读文件（contextIsolation + 无 fs）；
 *  - 更重要的是「唯一真源」——前端 ECharts 与 R/ggplot2 必须用同一份配色与字号，
 *    如果让渲染进程内置一份默认表，两边迟早会分叉（§6.8 强化点 2）。
 *
 * 读取策略：进程内缓存 + mtime 失效。主题文件很小（<1KB），
 * 但每次重绘都读盘没有必要，而开发期改完主题文件希望立刻生效，所以按 mtime 失效。
 */
import fs from 'node:fs'
import { z } from 'zod'
import type { PlotThemeSpec } from '@shared/types/plot'
import { logger } from '../logger'

const themeSchema = z.object({
  palettes: z.record(z.string(), z.array(z.string().min(1)).min(2)),
  /**
   * 火山图配色下拉的白名单（palettes 的 key，按展示顺序）。
   * 缺失时回落「除 set2/heat 之外的全部」——见 `resolveVolcanoPresets`。
   */
  volcanoPresets: z.array(z.string()).optional(),
  defaults: z.object({
    fontSize: z.number().positive(),
    widthIn: z.number().positive(),
    heightIn: z.number().positive(),
    dpi: z.number().positive(),
    pointSize: z.number().positive()
  })
})

/**
 * 内置兜底主题。
 * 与 resources/plotTheme.json 的内容必须保持一致 —— 这里的存在意义只是
 * 「主题文件被误删/损坏时界面仍然能出图」，而不是第二份可调参数。
 *
 * ★ 真实事故：`resources/plotTheme.json` 曾整份变成 573 字节的 NUL（0x00），
 *   JSON.parse 抛出 → 这里静默兜底 → 界面、出图、测试**全部正常**，
 *   没有任何人发现配色文件已经没了。所以：
 *    ① 两边内容必须逐字同步，`PlotTheme.test.ts` 有一条断言直接比对；
 *    ② 读取失败一律 warn 到日志（下面已经做了），不要静默。
 */
export const FALLBACK_PLOT_THEME: PlotThemeSpec = {
  palettes: {
    'red-blue': ['#2166AC', '#F7F7F7', '#B2182B'],
    'nature-npg': ['#4DBBD5', '#B0B7C3', '#E64B35'],
    'nature-deep': ['#3C5488', '#C8CDD4', '#DC0000'],
    'nature-soft': ['#00A087', '#C8CDD4', '#F39B7F'],
    viridis: ['#440154', '#21918C', '#FDE725'],
    set2: ['#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F'],
    heat: ['#313695', '#ABD9E9', '#FFFFBF', '#FDAE61', '#A50026']
  },
  volcanoPresets: ['red-blue', 'nature-npg', 'nature-deep', 'nature-soft', 'viridis'],
  defaults: { fontSize: 12, widthIn: 8, heightIn: 6, dpi: 300, pointSize: 1.6 }
}

interface CacheEntry {
  mtimeMs: number
  size: number
  theme: PlotThemeSpec
}

let cache: CacheEntry | null = null

/**
 * 读取主题。
 *
 * 任何异常（文件不存在、JSON 语法错误、字段缺失）都**不抛错**：
 * 出图是主链路，主题是装饰，不能因为一个配色文件让整个作图页打不开。
 * 但一定要 warn 到日志，否则用户改了配色没生效却查不到原因。
 */
export function loadPlotTheme(filePath: string): PlotThemeSpec {
  try {
    const stat = fs.statSync(filePath)
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.theme
    }
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const parsed = themeSchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')
      logger.warn('plot', `主题文件校验失败，改用内置主题：${detail}（${filePath}）`)
      return FALLBACK_PLOT_THEME
    }
    const theme: PlotThemeSpec = parsed.data
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, theme }
    return theme
  } catch (err) {
    logger.warn(
      'plot',
      `读取主题文件失败，改用内置主题：${err instanceof Error ? err.message : String(err)}（${filePath}）`
    )
    return FALLBACK_PLOT_THEME
  }
}

/** 取某个配色的色板（未知配色回落到 red-blue，绝不返回空数组） */
export function paletteOf(theme: PlotThemeSpec, name: string): string[] {
  const found = theme.palettes[name]
  if (found && found.length >= 2) return found
  const fallback = theme.palettes['red-blue'] ?? FALLBACK_PLOT_THEME.palettes['red-blue']
  return fallback
}

/**
 * 火山图可选配色列表。
 *
 * 优先用主题文件声明的 `volcanoPresets`；没声明时退化为「全部配色减去
 * 分类色/连续色」——`set2` 是 6 色分类板、`heat` 是连续色阶，把它们取头尾
 * 当上调/下调色会得到一对毫无对比度的颜色。
 */
export function resolveVolcanoPresets(theme: PlotThemeSpec): string[] {
  const declared = theme.volcanoPresets?.filter((name) => (theme.palettes[name]?.length ?? 0) >= 2)
  if (declared && declared.length > 0) return declared
  return Object.keys(theme.palettes).filter((name) => name !== 'set2' && name !== 'heat')
}

/** 清空缓存（测试与「重新加载主题」用） */
export function resetPlotThemeCache(): void {
  cache = null
}
