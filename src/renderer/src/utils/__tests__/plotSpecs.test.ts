/**
 * 火山图 option 的**自动化断言**（PRD S3 验收点之一）：
 * 「火山图显著点数 == 表格行数」严格相等。
 *
 * 不真渲染 ECharts（jsdom 没有 canvas），而是断言纯函数产出的
 * 三分类点集与 option 里的 series 数据长度完全一致。
 */
import { describe, expect, it } from 'vitest'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import { volcano } from '../plotSpecs'
import { classify, countByThreshold, filterByThreshold } from '../threshold'

function makeRows(count: number): DEResultRow[] {
  const rows: DEResultRow[] = []
  for (let i = 0; i < count; i += 1) {
    // 刻意构造 3 类：up / down / ns 各占一定比例
    const logFC = i % 3 === 0 ? 1.8 : i % 3 === 1 ? -1.5 : 0.2
    const adjPValue = i % 3 === 2 ? 0.4 : 0.01
    rows.push({
      geneId: `G${i}`,
      geneName: `GENE${i}`,
      logFC,
      aveExpr: 5,
      t: logFC,
      pValue: adjPValue / 3,
      adjPValue,
      b: null,
      regulation: 'ns'
    })
  }
  return rows
}

const T: ThresholdState = { logFC: 1, fdr: 0.05 }

describe('plotSpecs.volcano 与阈值筛选严格一致', () => {
  it('up/down/ns 点数之和等于总行数', () => {
    const rows = makeRows(30)
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6 })
    expect(spec.counts.up + spec.counts.down + spec.counts.ns).toBe(rows.length)
    expect(spec.series.up.length).toBe(spec.counts.up)
    expect(spec.series.down.length).toBe(spec.counts.down)
    expect(spec.series.ns.length).toBe(spec.counts.ns)
  })

  it('火山图 up 点数 === 表格 up 行数（严格相等）', () => {
    const rows = makeRows(30)
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6 })

    const tableUp = rows.filter((r) => classify(r, T) === 'up')
    const tableDown = rows.filter((r) => classify(r, T) === 'down')
    const tableSignificant = filterByThreshold(rows, T, true)

    expect(spec.counts.up).toBe(tableUp.length)
    expect(spec.counts.down).toBe(tableDown.length)
    expect(spec.counts.up + spec.counts.down).toBe(tableSignificant.length)

    const counts = countByThreshold(rows, T)
    expect(spec.counts).toEqual({ up: counts.up, down: counts.down, ns: counts.ns })
  })

  it('option 的 series 数据长度与计数一致（防止构造过程丢点）', () => {
    const rows = makeRows(30)
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6 })
    const series = spec.option.series as unknown as { name: string; data: unknown[] }[]
    expect(series).toHaveLength(3)
    expect(series[0].name).toBe('上调')
    expect(series[0].data.length).toBe(spec.counts.up)
    expect(series[1].name).toBe('下调')
    expect(series[1].data.length).toBe(spec.counts.down)
    expect(series[2].name).toBe('不显著')
    expect(series[2].data.length).toBe(spec.counts.ns)
  })

  it('阈值变化后三分类仍然互斥完备（同一份数据换阈值）', () => {
    const rows = makeRows(30)
    const loose: ThresholdState = { logFC: 0.1, fdr: 0.5 }
    const spec = volcano({ rows, thresholds: loose, topN: 3, pointSize: 1.6 })
    expect(spec.counts.up + spec.counts.down + spec.counts.ns).toBe(rows.length)
    expect(spec.counts.up).toBeGreaterThan(0)
  })

  it('topN 只标注显著基因，且不超过 N 个', () => {
    const rows = makeRows(30)
    const spec = volcano({ rows, thresholds: T, topN: 3, pointSize: 1.6 })
    expect(spec.labeled.length).toBeLessThanOrEqual(3)
    const significantNames = new Set(
      rows.filter((r) => classify(r, T) !== 'ns').map((r) => r.geneName ?? r.geneId)
    )
    for (const name of spec.labeled) {
      expect(significantNames.has(name)).toBe(true)
    }
  })

  it('空数据不崩溃', () => {
    const spec = volcano({ rows: [], thresholds: T, topN: 5, pointSize: 1.6 })
    expect(spec.counts).toEqual({ up: 0, down: 0, ns: 0 })
    expect(spec.labeled).toEqual([])
  })
})

/**
 * 显著性依据（P 值 / 校正 P 值）。
 *
 * ## 这一组守的是客户反馈的原问题
 *
 * 「火山图左边只有 FDR 选择，但是图片确是 P。」
 *
 * 修复前：纵轴固定画 `-log10(pValue)`，判定用 `adjPValue < fdr`，虚线画在
 * `-log10(fdr)` —— 三者口径不同，用户会看到「虚线以上的点没判为显著」，
 * 这张图无法解释自己，也就不能拿去写文章。
 *
 * 修复后：纵轴、着色、虚线、轴标题全部跟 `thresholds.basis` 走。
 */
describe('显著性依据切换（P 值 / 校正 P 值）', () => {
  /** 一行「原始 P 显著、校正后不显著」的数据 —— 正是两种口径会分歧的典型 */
  const divergent: DEResultRow = {
    geneId: 'G1',
    geneName: 'GENE1',
    logFC: 2,
    aveExpr: 5,
    t: 3,
    pValue: 0.001, // P 显著
    adjPValue: 0.2, // FDR 不显著
    b: null,
    regulation: 'ns'
  }

  const asAdj: ThresholdState = { logFC: 1, fdr: 0.05, basis: 'adjPValue' }
  const asP: ThresholdState = { logFC: 1, fdr: 0.05, basis: 'pValue' }

  it('默认（不传 basis）按校正 P 值判定，与历史行为一致', () => {
    const spec = volcano({ rows: [divergent], thresholds: { logFC: 1, fdr: 0.05 }, topN: 5, pointSize: 1.6 })
    expect(spec.counts.up).toBe(0)
    expect(spec.counts.ns).toBe(1)
  })

  it('同一行在两种口径下结论相反（P 显著、FDR 不显著）', () => {
    expect(volcano({ rows: [divergent], thresholds: asAdj, topN: 5, pointSize: 1.6 }).counts.up).toBe(0)
    expect(volcano({ rows: [divergent], thresholds: asP, topN: 5, pointSize: 1.6 }).counts.up).toBe(1)
  })

  it('★ 纵轴高度用的是判定依据那一列，不是固定的 pValue', () => {
    const adjSpec = volcano({ rows: [divergent], thresholds: asAdj, topN: 5, pointSize: 1.6 })
    const pSpec = volcano({ rows: [divergent], thresholds: asP, topN: 5, pointSize: 1.6 })

    // adjPValue=0.2 → -log10(0.2) ≈ 0.699
    expect(adjSpec.series.ns[0][1]).toBeCloseTo(0.69897, 4)
    // pValue=0.001 → -log10(0.001) = 3
    expect(pSpec.series.up[0][1]).toBeCloseTo(3, 6)
  })

  it('纵轴标题跟着切换（-log10(FDR) / -log10(P)）', () => {
    const adjSpec = volcano({ rows: [divergent], thresholds: asAdj, topN: 5, pointSize: 1.6 })
    const pSpec = volcano({ rows: [divergent], thresholds: asP, topN: 5, pointSize: 1.6 })
    expect((adjSpec.option.yAxis as { name?: string }).name).toBe('-log10(FDR)')
    expect((pSpec.option.yAxis as { name?: string }).name).toBe('-log10(P)')
  })

  it('阈值虚线位置 = -log10(用户设的阈值)，与点用的是同一尺度', () => {
    const spec = volcano({ rows: [divergent], thresholds: asP, topN: 5, pointSize: 1.6 })
    // 虚线在 -log10(0.05) ≈ 1.301，而该行 y=3 在线上方 —— 与「显著」判定一致
    const series = spec.option.series as { markLine?: { data?: { yAxis?: number }[] } }[]
    const yLine = series.find((s) => s.markLine?.data?.some((d) => typeof d.yAxis === 'number'))
      ?.markLine?.data?.find((d) => typeof d.yAxis === 'number')?.yAxis
    expect(yLine).toBeCloseTo(1.30103, 4)
    expect(spec.series.up[0][1]).toBeGreaterThan(yLine as number)
  })

  it('切换依据后，图上显著点数 == 表格按同一依据筛出的行数', () => {
    const rows = makeRows(30)
    for (const t of [asAdj, asP]) {
      const spec = volcano({ rows, thresholds: t, topN: 5, pointSize: 1.6 })
      const tableSig = filterByThreshold(rows, t, true)
      expect(spec.counts.up + spec.counts.down).toBe(tableSig.length)
    }
  })
})

/**
 * 布局自适应（按目标画布尺寸）。
 *
 * ## 这一组守的是客户实际遇到的导出问题
 *
 * 导出 3.5×2.5 英寸（约 336×240 CSS px）的图时：
 *  - 56px 左边距占了画布宽度的 17%，绘图区被压扁；
 *  - 三项图例横排约需 200px，塞进右上角后越界，被裁成半截字；
 *  - 4.8px 的点在 336px 画布上显得巨大，且最外侧的点被画布边缘切掉半个。
 *
 * 修法：布局参数跟 `canvasWidth/canvasHeight` 走。
 */
describe('火山图布局随画布尺寸自适应', () => {
  const rows = makeRows(60)

  function gridOf(width: number, height: number) {
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: width, canvasHeight: height })
    return spec.option.grid as { left: number; right: number; top: number; bottom: number }
  }

  function legendOf(width: number, height: number) {
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: width, canvasHeight: height })
    return spec.option.legend as { top?: number; right?: number; bottom?: number; itemWidth?: number }
  }

  it('小画布的左边距按比例缩小（不能还是 900px 时的 56）', () => {
    const big = gridOf(900, 420)
    const small = gridOf(336, 240)
    expect(small.left).toBeLessThan(big.left)
    // 但有下限：轴标签和轴标题必须放得下
    expect(small.left).toBeGreaterThanOrEqual(32)
  })

  it('★ 窄画布把图例移到底部，而不是挤在右上角被裁', () => {
    const wideLegend = legendOf(900, 420)
    const narrowLegend = legendOf(336, 240)

    expect(wideLegend.top).toBeDefined()
    expect(wideLegend.bottom).toBeUndefined()

    expect(narrowLegend.bottom).toBeDefined()
    expect(narrowLegend.top).toBeUndefined()
    // 图例图标也要缩小，否则文字依然会被挤出去
    expect((narrowLegend.itemWidth ?? 10) as number).toBeLessThanOrEqual(8)
  })

  it('窄画布的底部边距更大（要给底部图例让出一条带）', () => {
    const wide = gridOf(900, 420)
    const narrow = gridOf(336, 240)
    expect(narrow.bottom).toBeGreaterThan(wide.bottom)
  })

  it('点大小随画布缩小，但不会小到看不见', () => {
    const big = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: 900, canvasHeight: 420 })
    const small = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: 336, canvasHeight: 240 })
    const sizeOf = (spec: ReturnType<typeof volcano>): number => {
      const series = spec.option.series as { symbolSize?: number }[]
      // 第一个 series 是「上调」，用它的点大小
      return series[0].symbolSize ?? 0
    }
    expect(sizeOf(small)).toBeLessThan(sizeOf(big))
    expect(sizeOf(small)).toBeGreaterThanOrEqual(1.4)
  })

  it('★ 坐标轴范围留了余量，最外侧的点不会被画布边缘切掉', () => {
    const spec = volcano({ rows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: 336, canvasHeight: 240 })
    const xAxis = spec.option.xAxis as { min?: number; max?: number }
    const yAxis = spec.option.yAxis as { min?: number; max?: number }

    const xs = [...spec.series.up, ...spec.series.down, ...spec.series.ns].map((p) => p[0])
    const ys = [...spec.series.up, ...spec.series.down, ...spec.series.ns].map((p) => p[1])

    expect(xAxis.min as number).toBeLessThan(Math.min(...xs))
    expect(xAxis.max as number).toBeGreaterThan(Math.max(...xs))
    expect(yAxis.max as number).toBeGreaterThan(Math.max(...ys))
    // y 轴下限钳到 0，不从负数起
    expect(yAxis.min as number).toBeGreaterThanOrEqual(0)
  })

  it('阈值虚线始终落在可视范围内（数据很窄时也不会跑到范围外）', () => {
    // 造一批 logFC 全在 3~4 之间的数据，而阈值是 1
    const narrowRows = rows.map((r) => ({ ...r, logFC: r.logFC > 0 ? 3.5 : -3.5 }))
    const spec = volcano({ rows: narrowRows, thresholds: T, topN: 5, pointSize: 1.6, canvasWidth: 336, canvasHeight: 240 })
    const xAxis = spec.option.xAxis as { min?: number; max?: number }
    expect(xAxis.min as number).toBeLessThanOrEqual(-1)
    expect(xAxis.max as number).toBeGreaterThanOrEqual(1)
  })
})
