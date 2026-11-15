/**
 * 项目切换时必须清空前一个项目的状态。
 *
 * ## 这一组守的是客户反馈
 *
 * 「我打开新项目也会有之前的残留。」
 *
 * 根因：`analysisStore` / `thresholdStore` / `plotDataStore` 都是全局单例，
 * 只有 `loadResult()` 会覆盖 `rows`。新项目没有任何分析结果 →
 * `loadResult` 根本不会被调用 → 结果页继续显示**上一个项目**的数据。
 *
 * 这类「数据串项目」不会报错，只会让用户把 A 项目的结论当成 B 项目的。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import type { DEResultRow } from '@shared/types/analysis'
import type { AnalysisSnapshot } from '@shared/types/project'
import { useAnalysisStore } from '../analysisStore'
import { usePlotDataStore } from '../plotDataStore'
import { useThresholdStore } from '../thresholdStore'
import { resetProjectScopedState } from '../projectScopedState'

function makeRow(geneId: string): DEResultRow {
  return {
    geneId,
    geneName: null,
    logFC: 2,
    aveExpr: 5,
    t: 2,
    pValue: 0.01,
    adjPValue: 0.02,
    b: null,
    regulation: 'ns'
  }
}

const SNAPSHOT: AnalysisSnapshot = {
  id: 'ana-old',
  method: 'deseq2',
  label: 'DESeq2 · 旧项目',
  config: {} as never,
  resultPath: 'results/de/run-old/de.csv',
  stats: { totalGenesAfterFilter: 1, upCount: 1, downCount: 0, nsCount: 0, filteredOutCount: 0 },
  thresholds: { logFC: 1, fdr: 0.05 },
  durationMs: 1000,
  createdAt: '2026-11-11T12:00:00.000Z',
  rLogPath: 'logs/run-old.log'
}

/** 把三个 store 都装满「上一个项目」的状态 */
function fillWithPreviousProject(): void {
  useAnalysisStore.setState({
    rows: [makeRow('OLD1'), makeRow('OLD2')],
    snapshot: SNAPSHOT,
    logs: [{ ts: 0, level: 'info', scope: 'analysis', message: '旧项目的日志' } as never],
    phase: 'success'
  })
  useThresholdStore.setState({ logFC: 2.5, fdr: 0.01, basis: 'pValue' })
  usePlotDataStore.getState().setExternal({
    rows: [makeRow('EXT1')],
    label: '上一个项目导的表.csv',
    warnings: []
  })
}

beforeEach(() => {
  resetProjectScopedState()
})

describe('resetProjectScopedState', () => {
  it('★ 清空上一个项目的分析结果（否则新项目会显示旧数据）', () => {
    fillWithPreviousProject()
    resetProjectScopedState()

    expect(useAnalysisStore.getState().rows).toBeNull()
    expect(useAnalysisStore.getState().snapshot).toBeNull()
    expect(useAnalysisStore.getState().logs).toEqual([])
    expect(useAnalysisStore.getState().phase).toBe('idle')
  })

  it('清空外部导入的绘图表（它连项目都不依赖，最容易串）', () => {
    fillWithPreviousProject()
    resetProjectScopedState()

    expect(usePlotDataStore.getState().external).toBeNull()
  })

  it('阈值与判定依据回到默认（新项目应从默认口径开始）', () => {
    fillWithPreviousProject()
    resetProjectScopedState()

    expect(useThresholdStore.getState().logFC).toBe(DEFAULT_THRESHOLDS.logFC)
    expect(useThresholdStore.getState().fdr).toBe(DEFAULT_THRESHOLDS.fdr)
    expect(useThresholdStore.getState().basis).toBe('adjPValue')
  })

  it('在干净状态上调用是幂等的（重复打开项目不会出错）', () => {
    resetProjectScopedState()
    resetProjectScopedState()
    expect(useAnalysisStore.getState().rows).toBeNull()
    expect(usePlotDataStore.getState().external).toBeNull()
  })
})
