/**
 * 图表主题（渲染进程侧）。
 *
 * 真源是 `resources/plotTheme.json`，由主进程通过 `deg:system:plotTheme` 下发。
 * 这里只做「取一次 + 缓存 + 失败兜底」，**不允许**在渲染进程另建一份可编辑配色表 ——
 * 否则前端预览与 R 导出图迟早出现颜色不一致（§6.8 强化点 2）。
 */
import { useEffect, useState } from 'react'
import type { PlotThemeSpec } from '@shared/types/plot'
import { call } from '../../utils/ipc'

/** 与 resources/plotTheme.json 内容一致的兜底（仅用于主进程下发失败时） */
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

let cache: PlotThemeSpec | null = null
let inflight: Promise<PlotThemeSpec> | null = null

/** 取主题（进程内缓存，失败回落内置） */
export async function loadPlotTheme(): Promise<PlotThemeSpec> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const theme = await call(window.deg.system.plotTheme())
      cache = theme
      return theme
    } catch {
      cache = FALLBACK_PLOT_THEME
      return FALLBACK_PLOT_THEME
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 取配色（未知配色回落 red-blue） */
export function paletteOf(theme: PlotThemeSpec, name: string): string[] {
  const found = theme.palettes[name]
  if (found && found.length >= 2) return found
  return theme.palettes['red-blue'] ?? FALLBACK_PLOT_THEME.palettes['red-blue']
}

/**
 * 火山图可选配色（与主进程 `resolveVolcanoPresets` 同一套规则）。
 *
 * 为什么不把这份列表写死在界面上：加一个配色要同时改 JSON、主进程、前端三处，
 * 迟早漏一处，表现就是「theme 里有但下拉里没有」。
 */
export function resolveVolcanoPresets(theme: PlotThemeSpec): string[] {
  const declared = theme.volcanoPresets?.filter((name) => (theme.palettes[name]?.length ?? 0) >= 2)
  if (declared && declared.length > 0) return declared
  return Object.keys(theme.palettes).filter((name) => name !== 'set2' && name !== 'heat')
}

/** 配色的中文名（未登记的显示原名，不要留空） */
const PALETTE_LABELS: Record<string, string> = {
  'red-blue': '经典红蓝',
  'nature-npg': 'Nature NPG',
  'nature-deep': 'Nature 深蓝红',
  'nature-soft': 'Nature 青绿橙',
  viridis: 'Viridis'
}

export function paletteLabel(name: string): string {
  return PALETTE_LABELS[name] ?? name
}

/** 组件里用：返回主题（首帧给兜底值，异步到达后替换） */
export function usePlotTheme(): PlotThemeSpec {
  const [theme, setTheme] = useState<PlotThemeSpec>(cache ?? FALLBACK_PLOT_THEME)
  useEffect(() => {
    let alive = true
    void loadPlotTheme().then((next) => {
      if (alive) setTheme(next)
    })
    return () => {
      alive = false
    }
  }, [])
  return theme
}
