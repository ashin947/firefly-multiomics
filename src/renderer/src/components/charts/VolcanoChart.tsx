/**
 * 火山图（ECharts 预览）。
 *
 * 着色谓词来自 `utils/plotSpecs.volcano` → `utils/threshold.classify`，
 * 与统计卡、结果表**同一个函数**，这是「图上显著点数 == 表格行数」的实现基础。
 *
 * 配色两层：`paletteName` 选主题文件里的预设，`customColors` 覆盖其中任意一色。
 * 两者都在这里合成一份三元组交给 `volcano()`，下游不关心颜色从哪来。
 */
import { forwardRef, useCallback, useMemo } from 'react'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import { ChartHost, type ChartHostHandle } from './ChartHost'
import { volcano } from '../../utils/plotSpecs'
import { paletteOf, usePlotTheme } from './plotTheme'

/** 用户自定义的三色（下调 / 不显著 / 上调） */
export interface VolcanoColors {
  down: string
  ns: string
  up: string
}

interface VolcanoChartProps {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
  topN?: number
  pointSize?: number
  showGeneLabels?: boolean
  hoveredGene?: string | null
  onPointHover?: (name: string | null) => void
  height?: number
  title?: string
  paletteName?: string
  /** 覆盖预设配色；未提供的通道回落到预设 */
  customColors?: Partial<VolcanoColors>
  fontSize?: number
}

/** 预设配色名 → 三色（下调 / 不显著 / 上调） */
export function presetColors(palette: string[]): VolcanoColors {
  return {
    down: palette[0] ?? '#2166AC',
    ns: palette[1] ?? '#B0B7C3',
    up: palette[2] ?? '#B2182B'
  }
}

export const VolcanoChart = forwardRef<ChartHostHandle, VolcanoChartProps>(function VolcanoChart(
  {
    rows,
    thresholds,
    topN = 10,
    pointSize = 1.6,
    showGeneLabels = true,
    hoveredGene = null,
    onPointHover,
    height = 380,
    title,
    paletteName = 'red-blue',
    customColors,
    fontSize = 12
  },
  ref
) {
  const theme = usePlotTheme()
  const colors = paletteOf(theme, paletteName)

  const palette = useMemo(
    () => ({
      // 自定义优先，其次预设，最后兜底色
      up: customColors?.up ?? colors[2] ?? '#C62828',
      down: customColors?.down ?? colors[0] ?? '#1F6FEB',
      ns: customColors?.ns ?? '#B0B7C3',
      guide: '#9AA4B2',
      text: '#1A1D21'
    }),
    [colors, customColors]
  )

  /**
   * 与尺寸无关的那部分输入。
   *
   * 抽出来是为了让「屏显」和「按导出尺寸重算」共用同一份数据与配置，
   * 只在 canvasWidth/Height 上不同 —— 否则两处各拼一份 input，迟早改漏一处，
   * 表现为「导出的图和屏幕上的图配色/阈值不一致」。
   */
  const baseInput = useMemo(
    () => ({
      rows,
      thresholds,
      topN: showGeneLabels ? topN : 0,
      pointSize,
      title,
      fontSize,
      showGeneLabels,
      hoveredGene,
      palette
    }),
    [rows, thresholds, topN, pointSize, title, fontSize, showGeneLabels, hoveredGene, palette]
  )

  const spec = useMemo(() => volcano(baseInput), [baseInput])

  // 导出时按目标画布尺寸重算布局（边距/图例/点大小都跟尺寸有关）
  const buildOption = useCallback(
    (size: { width: number; height: number }) =>
      volcano({ ...baseInput, canvasWidth: size.width, canvasHeight: size.height }).option,
    [baseInput]
  )

  return (
    <ChartHost
      ref={ref}
      option={spec.option}
      buildOption={buildOption}
      height={height}
      hasData={rows.length > 0}
      emptyText="没有可绘制的差异结果"
      onPointHover={onPointHover}
    />
  )
})
