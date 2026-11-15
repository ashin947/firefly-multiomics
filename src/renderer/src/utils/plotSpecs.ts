/**
 * ECharts option 构造器（纯函数，便于单测）。
 *
 * 为什么把 option 构造从组件里抽出来：
 *  「火山图显著点数 == 表格行数」这条验收标准必须能自动化断言，
 *  而真渲染 ECharts 需要 canvas（jsdom 里没有）。
 *  把点集与计数算在纯函数里，测试直接断言 `counts` 与 series 长度即可。
 *
 * 着色谓词调用 `utils/threshold.classify`（唯一实现），与表格/统计卡同源。
 */
import type { EChartsOption } from 'echarts'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import { basisOf, basisPValue, classify } from './threshold'

/** 纵轴标题：必须与「用哪一列判定」一致，否则图和阈值对不上 */
function basisLabel(thresholds: ThresholdState): string {
  return basisOf(thresholds) === 'pValue' ? '-log10(P)' : '-log10(FDR)'
}

/** 火山图着色（与 R 侧 export_volcano.R 的谓词逐字对应） */
export interface VolcanoPalette {
  up: string
  down: string
  ns: string
  /** 阈值线颜色 */
  guide: string
  /** 文字颜色 */
  text: string
}

export const DEFAULT_VOLCANO_PALETTE: VolcanoPalette = {
  up: '#C62828',
  down: '#1F6FEB',
  ns: '#B0B7C3',
  guide: '#9AA4B2',
  text: '#1A1D21'
}

/** 一个散点的三元组：x=logFC, y=-log10(pValue), 第三位携带基因名用于 tooltip/标注 */
export type VolcanoPoint = [number, number, string]

export interface VolcanoSpecInput {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
  /** 标注 top N（按 pValue 升序，仅显著基因） */
  topN: number
  pointSize: number
  palette?: VolcanoPalette
  title?: string
  fontSize?: number
  showGeneLabels?: boolean
  /** 表格 hover 联动高亮 */
  hoveredGene?: string | null
  /**
   * 目标画布宽度（CSS px）。用于**自适应布局**，默认 900（屏显基准）。
   *
   * ★ 为什么需要它：边距、图例位置、点大小、字号都是按像素写死的。
   *   导出一张 3.5 英寸宽的图时画布只有约 336px，而 900px 时设计的 56px 左边距
   *   在 336px 里占掉 17%，绘图区被压扁；三个图例项横排也放不下，直接被裁成半截字。
   *   布局必须跟着画布重算，不能一套像素通吃所有尺寸。
   */
  canvasWidth?: number
  /** 目标画布高度（CSS px），默认 420 */
  canvasHeight?: number
}

export interface VolcanoSpecOutput {
  option: EChartsOption
  /** 三个分类的点集（顺序：up / down / ns） */
  series: { up: VolcanoPoint[]; down: VolcanoPoint[]; ns: VolcanoPoint[] }
  /** 与 series 严格一致的三分类计数 */
  counts: { up: number; down: number; ns: number }
  /** 被标注的基因名（topN） */
  labeled: string[]
}

/** p 值 → -log10，做下限保护避免 Infinity 破坏坐标轴 */
function negLog10(p: number): number {
  const safe = Number.isFinite(p) && p > 0 ? p : 1e-300
  return Math.min(300, -Math.log10(safe))
}

/**
 * 构造火山图 option。
 *
 * ns 点用 1.5px + 半透明：5000 个点里绝大多数是 ns，把它们画成实心圆
 * 会让图变成一坨灰块，同时显著点被淹没。
 */
export function volcano(input: VolcanoSpecInput): VolcanoSpecOutput {
  const palette = input.palette ?? DEFAULT_VOLCANO_PALETTE
  const up: VolcanoPoint[] = []
  const down: VolcanoPoint[] = []
  const ns: VolcanoPoint[] = []
  const significant: { name: string; p: number }[] = []

  /*
   * ★ 纵轴用「当前判定依据」那一列，与 classify() 完全同源。
   *
   * 历史 bug：这里固定用 row.pValue 画高度，而 classify 用 adjPValue 判显著、
   * 虚线画在 -log10(FDR) 处 —— 三条线各有各的口径。结果就是用户看到
   * 「虚线以上的点却没判为显著」，图上的一切无法互相解释，这张图不能用来写文章。
   */
  const yOf = (row: (typeof input.rows)[number]): number => {
    const p = basisPValue(row, input.thresholds) // SYNC: isSignificant 唯一实现
    return negLog10(p)
  }

  for (const row of input.rows) {
    const name = row.geneName ?? row.geneId
    const point: VolcanoPoint = [row.logFC, yOf(row), name]
    const cls = classify(row, input.thresholds)
    if (cls === 'up') {
      up.push(point)
      significant.push({ name, p: basisPValue(row, input.thresholds) })
    } else if (cls === 'down') {
      down.push(point)
      significant.push({ name, p: basisPValue(row, input.thresholds) })
    } else {
      ns.push(point)
    }
  }

  // topN 标注：按 p 值升序取前 N（显著基因内部排序，不受原始行序影响）
  significant.sort((a, b) => a.p - b.p)
  const labeled = significant.slice(0, Math.max(0, input.topN)).map((item) => item.name)

  /* ---------------- 自适应布局 ----------------
   *
   * 设计基准是 900×420（结果页屏显尺寸）。所有间距/字号/点大小按
   * `k = 画布宽 / 900` 缩放，并夹在合理区间内 —— 小图不至于挤成一团，
   * 大图也不至于空旷。
   *
   * 两个硬约束（不满足就会像用户截图那样出问题）：
   *  1. 边距有下限：轴标签、轴标题必须放得下，不能无限等比缩；
   *  2. 窄画布时图例**移到底部**：三项图例横排约需 200px，塞进右上角
   *     在 336px 宽的图里必然越界被裁（截图上「上调」只剩半个字）。
   */
  const canvasWidth = input.canvasWidth ?? 900
  const canvasHeight = input.canvasHeight ?? 420
  // 宽、高各算一个比例，取较小者：又窄又扁的画布上边距必须同时放得下
  const k = Math.min(
    Math.max(0.45, Math.min(1.6, canvasWidth / 900)),
    Math.max(0.45, Math.min(1.6, canvasHeight / 420))
  )
  /** 窄图：放不下右上角横排图例 */
  const narrow = canvasWidth < 560
  /** 窄图时底部图例占用的高度 */
  const legendBand = narrow ? 20 : 0

  /*
   * 边距下限是硬约束，不能只按比例缩：
   *  - 左边 42px：刻度标签（"10" 约 16px）+ 轴标题竖排（约 12px）+ 间隙。
   *    曾经取 32px，导出小图时 y 轴标题被画布左边缘切掉一半。
   *  - 顶部 18px：最上档刻度的标签要完整显示，否则顶部会出现半截数字。
   */
  const marginLeft = Math.max(42, Math.round(56 * k))
  const marginRight = Math.max(16, Math.round(24 * k))
  const marginTop = (input.title ? Math.max(28, Math.round(40 * k)) : Math.max(18, Math.round(22 * k))) + (narrow ? 0 : 14)
  const marginBottom = Math.round(44 * Math.max(0.82, k)) + legendBand

  const fontSize = Math.max(8, Math.round((input.fontSize ?? 12) * Math.max(0.72, Math.min(1, k))))
  // 点大小缩放要温和：缩太狠在 3.5 英寸图上会看不见，不缩又显得巨大
  const pointScale = Math.max(0.62, Math.min(1.15, k))
  const symSize = Math.max(1.4, input.pointSize * 3 * pointScale)

  /**
   * 求坐标轴范围：数据范围 **并上** 阈值线位置，再左右各留 4%。
   *
   * 两个细节都不能省：
   *  - 并上阈值线：否则数据全在 logFC>2 时，±1 的虚线落在范围外看不见了；
   *  - 留余量：点画在边界上会被画布切掉半个圆（用户截图里右侧红点就是这样没的）。
   */
  const axisExtent = (values: number[], extra: number[], clampMinZero = false): [number, number] => {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const v of values) {
      if (!Number.isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    for (const v of extra) {
      if (!Number.isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return clampMinZero ? [0, 1] : [-1, 1]
    if (lo === hi) {
      lo -= 1
      hi += 1
    }
    const span = hi - lo
    const paddedLo = clampMinZero ? Math.max(0, lo - span * 0.04) : lo - span * 0.04
    return [paddedLo, hi + span * 0.04]
  }

  const makeSeries = (
    name: string,
    data: VolcanoPoint[],
    color: string,
    isNs: boolean
  ): Record<string, unknown> => ({
    name,
    type: 'scatter',
    data,
    large: true,
    largeThreshold: 2000,
    symbolSize: isNs ? Math.max(1, symSize * 0.42) : symSize,
    itemStyle: { color, opacity: isNs ? 0.35 : 0.85 },
    emphasis: { scale: 1.6, itemStyle: { opacity: 1 } },
    animation: false
  })

  /*
   * 轴范围 = 数据范围 ∪ 阈值线位置，再留 4% 余量。
   * 用一次遍历收集，避免对两万个点 map 出三个临时数组。
   */
  const xs: number[] = []
  const ys: number[] = []
  for (const group of [up, down, ns]) {
    for (const p of group) {
      xs.push(p[0])
      ys.push(p[1])
    }
  }
  const xRaw = axisExtent(xs, [-input.thresholds.logFC, input.thresholds.logFC])
  /*
   * 轴范围取整。
   *
   * 不取整的后果：y 轴 max 会算出 `13.78984` 这种数，ECharts 把它当刻度标签画出来，
   * 又长又难看，而且在小画布上直接顶出画布（客户截图左上角那串乱码就是这么来的）。
   * 两个轴都取整：logFC 的刻度用整数（-3 -2 -1 0 1 2 3）最整齐，
   * 混进一个 `2.9` 会让整排刻度看着不对齐。
   */
  const xExtent: [number, number] = [Math.floor(xRaw[0]), Math.ceil(xRaw[1])]
  // y 轴下限钳到 0：-log10(p) 本来就不该是负数，从 0 起更符合直觉
  const yRaw = axisExtent(ys, [negLog10(input.thresholds.fdr), 0], true)
  const yExtent: [number, number] = [0, Math.max(1, Math.ceil(yRaw[1]))]

  const guideLines: Record<string, unknown>[] = [
    { xAxis: input.thresholds.logFC },
    { xAxis: -input.thresholds.logFC },
    { yAxis: negLog10(input.thresholds.fdr) }
  ]

  const option: EChartsOption = {
    animation: false,
    title: input.title
      ? {
          text: input.title,
          left: 'center',
          textStyle: { fontSize, color: palette.text, fontWeight: 600 }
        }
      : undefined,
    grid: { left: marginLeft, right: marginRight, top: marginTop, bottom: marginBottom },
    xAxis: {
      type: 'value',
      name: 'log2 Fold Change',
      nameLocation: 'middle',
      nameGap: Math.max(18, Math.round(26 * Math.max(0.75, k))),
      min: xExtent[0],
      max: xExtent[1],
      axisLine: { lineStyle: { color: palette.guide } },
      splitLine: { lineStyle: { color: '#EEF1F5' } },
      axisLabel: { fontSize, color: palette.text }
    },
    yAxis: {
      type: 'value',
      name: basisLabel(input.thresholds),
      nameLocation: 'middle',
      nameGap: Math.max(28, Math.round(40 * Math.max(0.75, k))),
      min: yExtent[0],
      max: yExtent[1],
      axisLine: { lineStyle: { color: palette.guide } },
      splitLine: { lineStyle: { color: '#EEF1F5' } },
      axisLabel: { fontSize, color: palette.text }
    },
    // 窄图放底部横排（右上角会被裁），宽图放右上角
    legend: narrow
      ? {
          bottom: 2,
          left: 'center',
          itemWidth: 8,
          itemHeight: 8,
          itemGap: 8,
          data: ['上调', '下调', '不显著'],
          textStyle: { fontSize: Math.max(8, fontSize - 2), color: palette.text }
        }
      : {
          top: 2,
          right: 6,
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 12,
          data: ['上调', '下调', '不显著'],
          textStyle: { fontSize: Math.max(9, fontSize - 1), color: palette.text }
        },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (params: unknown): string => {
        const item = params as { data?: unknown }
        const data = Array.isArray(item.data) ? (item.data as VolcanoPoint) : null
        if (!data) return ''
        return `${data[2]}<br/>logFC = ${data[0].toFixed(2)}<br/>${basisLabel(input.thresholds)} = ${data[1].toFixed(2)}`
      }
    },
    series: [
      {
        ...makeSeries('上调', up, palette.up, false),
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { type: 'dashed', color: palette.guide, width: 1 },
          label: { show: false },
          data: guideLines
        }
      },
      makeSeries('下调', down, palette.down, false),
      makeSeries('不显著', ns, palette.ns, true)
    ] as EChartsOption['series']
  }

  return {
    option,
    series: { up, down, ns },
    counts: { up: up.length, down: down.length, ns: ns.length },
    labeled
  }
}

/** PCA 散点 option（前端渲染 R 算好的坐标） */
export function pca(input: {
  points: { sample: string; group: string; pc: number[] }[]
  varianceExplained: number[]
  pcX: number
  pcY: number
  title?: string
  fontSize?: number
}): EChartsOption {
  const groups = Array.from(new Set(input.points.map((p) => p.group)))
  const colors = ['#1F6FEB', '#C62828', '#2E7D32', '#7C4DFF', '#ED6C02', '#00838F']
  const series = groups.map((group, index) => ({
    name: group,
    type: 'scatter' as const,
    data: input.points.filter((p) => p.group === group).map((p) => [p.pc[input.pcX - 1], p.pc[input.pcY - 1], p.sample]),
    symbolSize: 9,
    itemStyle: { color: colors[index % colors.length], opacity: 0.9 },
    label: { show: true, position: 'right' as const, formatter: '{@[2]}', fontSize: 10 }
  }))
  return {
    animation: false,
    title: input.title
      ? { text: input.title, left: 'center', textStyle: { fontSize: input.fontSize ?? 12, fontWeight: 600 } }
      : undefined,
    grid: { left: 56, right: 24, top: input.title ? 44 : 24, bottom: 52 },
    legend: { top: 0, right: 8, textStyle: { fontSize: 11 } },
    xAxis: {
      type: 'value',
      name: `PC${input.pcX} (${((input.varianceExplained[input.pcX - 1] ?? 0) * 100).toFixed(1)}%)`,
      nameLocation: 'middle',
      nameGap: 28,
      splitLine: { lineStyle: { color: '#EEF1F5' } }
    },
    yAxis: {
      type: 'value',
      name: `PC${input.pcY} (${((input.varianceExplained[input.pcY - 1] ?? 0) * 100).toFixed(1)}%)`,
      nameLocation: 'middle',
      nameGap: 40,
      splitLine: { lineStyle: { color: '#EEF1F5' } }
    },
    series
  }
}

/** 热图 option：**严格按 R 给的 rowOrder / colOrder 渲染**，前端不重排 */
export function heatmap(input: {
  genes: string[]
  samples: string[]
  rowOrder: number[]
  colOrder: number[]
  values: number[][]
  title?: string
}): EChartsOption {
  const orderedGenes = input.rowOrder.map((i) => input.genes[i] ?? '')
  const orderedSamples = input.colOrder.map((i) => input.samples[i] ?? '')
  const data: [number, number, number][] = []
  for (let r = 0; r < input.rowOrder.length; r += 1) {
    for (let c = 0; c < input.colOrder.length; c += 1) {
      const value = input.values[r]?.[c]
      if (typeof value === 'number' && Number.isFinite(value)) data.push([c, r, value])
    }
  }
  return {
    animation: false,
    title: input.title ? { text: input.title, left: 'center', textStyle: { fontSize: 12, fontWeight: 600 } } : undefined,
    grid: { left: 110, right: 90, top: input.title ? 46 : 20, bottom: 70 },
    tooltip: {
      formatter: (params: unknown): string => {
        const item = params as { data?: unknown }
        const d = Array.isArray(item.data) ? (item.data as [number, number, number]) : null
        if (!d) return ''
        return `${orderedGenes[d[1]] ?? ''} / ${orderedSamples[d[0]] ?? ''}<br/>z = ${d[2].toFixed(2)}`
      }
    },
    xAxis: {
      type: 'category',
      data: orderedSamples,
      axisLabel: { rotate: 60, fontSize: 9 },
      splitArea: { show: false }
    },
    yAxis: {
      type: 'category',
      data: orderedGenes,
      axisLabel: { fontSize: 8 },
      splitArea: { show: false }
    },
    visualMap: {
      min: -2,
      max: 2,
      calculable: true,
      orient: 'vertical',
      right: 8,
      top: 'center',
      inRange: { color: ['#2166AC', '#F7F7F7', '#B2182B'] },
      textStyle: { fontSize: 10 }
    },
    series: [{ type: 'heatmap', data, progressive: 2000, animation: false }]
  }
}

/** 箱线图 option（前端用表达矩阵本地构造，不调 R） */
export function boxplot(input: {
  gene: string
  groups: string[]
  values: { group: string; sample: string; value: number }[]
  title?: string
  logAxis?: boolean
}): EChartsOption {
  const boxData = input.groups.map((group) => {
    const nums = input.values
      .filter((v) => v.group === group)
      .map((v) => v.value)
      .sort((a, b) => a - b)
    if (nums.length === 0) return [0, 0, 0, 0, 0]
    const q = (p: number): number => {
      const pos = (nums.length - 1) * p
      const base = Math.floor(pos)
      const rest = pos - base
      const next = nums[Math.min(nums.length - 1, base + 1)]
      return nums[base] + rest * (next - nums[base])
    }
    return [nums[0], q(0.25), q(0.5), q(0.75), nums[nums.length - 1]]
  })
  return {
    animation: false,
    title: input.title ? { text: input.title, left: 'center', textStyle: { fontSize: 12, fontWeight: 600 } } : undefined,
    grid: { left: 56, right: 24, top: input.title ? 46 : 24, bottom: 48 },
    xAxis: { type: 'category', data: input.groups, axisLabel: { fontSize: 11 } },
    yAxis: {
      type: input.logAxis ? 'log' : 'value',
      name: '表达量',
      nameLocation: 'middle',
      nameGap: 42,
      splitLine: { lineStyle: { color: '#EEF1F5' } }
    },
    series: [
      {
        type: 'boxplot',
        data: boxData,
        itemStyle: { color: '#DCE7F8', borderColor: '#1F6FEB' }
      }
    ]
  }
}
