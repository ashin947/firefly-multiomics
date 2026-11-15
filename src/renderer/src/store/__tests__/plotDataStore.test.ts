/**
 * 旁路数据源与分析结果的隔离。
 *
 * ## 这条测试守的是用户明确提出的要求
 *
 * 「自定义不影响上游跑分析下来的数据，接下来分析还是按流程走。」
 *
 * 具体来说：往 `plotDataStore` 里塞一张外部表，`analysisStore.rows` /
 * `snapshot` 必须一个字节都不变。一旦有人图省事把外部行 `set` 进 analysisStore，
 * 结果页会开始说谎：统计卡显示的是别人表的数字，标题却写着「limma-voom 耗时 1.8s」，
 * 而且用户点「重新分析」时这份数据会被无声抹掉。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DEResultRow } from '@shared/types/analysis'
import type { AnalysisSnapshot } from '@shared/types/project'
import { useAnalysisStore } from '../analysisStore'
import { usePlotDataStore } from '../plotDataStore'

function makeRow(geneId: string, logFC: number): DEResultRow {
  return {
    geneId,
    geneName: null,
    logFC,
    aveExpr: 5,
    t: 2,
    pValue: 0.01,
    adjPValue: 0.02,
    b: null,
    regulation: 'ns'
  }
}

/** 一份"分析结果"（模拟 R 跑出来的） */
const ANALYSIS_ROWS: DEResultRow[] = [makeRow('A1', 2), makeRow('A2', -1.5)]
/** 一份"别人给的"外部表 */
const EXTERNAL_ROWS: DEResultRow[] = [makeRow('E1', 3), makeRow('E2', -2), makeRow('E3', 1.2)]

const SNAPSHOT: AnalysisSnapshot = {
  id: 'ana-test',
  method: 'limma-voom',
  label: 'limma-voom · Tumor vs Normal',
  config: {} as never,
  resultPath: 'results/de/run-test/de.csv',
  stats: { totalGenesAfterFilter: 2, upCount: 1, downCount: 1, nsCount: 0, filteredOutCount: 0 },
  thresholds: { logFC: 1, fdr: 0.05 },
  durationMs: 1800,
  createdAt: '2026-11-11T12:00:00.000Z',
  rLogPath: 'logs/run-test.log'
}

beforeEach(() => {
  usePlotDataStore.setState({ external: null })
  useAnalysisStore.setState({ rows: ANALYSIS_ROWS, snapshot: SNAPSHOT })
})

describe('外部导入不污染分析结果', () => {
  it('导入后 analysisStore.rows 与 snapshot 保持原样', () => {
    const rowsBefore = useAnalysisStore.getState().rows
    const snapshotBefore = useAnalysisStore.getState().snapshot

    usePlotDataStore.getState().setExternal({
      rows: EXTERNAL_ROWS,
      label: 'my-table.csv',
      warnings: []
    })

    expect(useAnalysisStore.getState().rows).toBe(rowsBefore)
    expect(useAnalysisStore.getState().snapshot).toBe(snapshotBefore)
    // 引用相等还不够，内容也要逐字段相同
    expect(useAnalysisStore.getState().rows).toEqual(ANALYSIS_ROWS)
    expect(useAnalysisStore.getState().snapshot?.id).toBe('ana-test')
  })

  it('外部数据单独可读，行数与内容就是导入的那份', () => {
    usePlotDataStore.getState().setExternal({
      rows: EXTERNAL_ROWS,
      label: 'my-table.csv',
      warnings: ['表格里没有校正 P 值（FDR）列，已用原始 P 值代替']
    })

    const external = usePlotDataStore.getState().external
    expect(external?.rows).toHaveLength(3)
    expect(external?.rows[0].geneId).toBe('E1')
    expect(external?.label).toBe('my-table.csv')
    expect(external?.warnings).toHaveLength(1)
    expect(external?.importedAt).toBeGreaterThan(0)
  })

  it('清除外部数据后，分析结果立刻可用（不留残留）', () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'x.csv', warnings: [] })
    usePlotDataStore.getState().clearExternal()

    expect(usePlotDataStore.getState().external).toBeNull()
    expect(useAnalysisStore.getState().rows).toEqual(ANALYSIS_ROWS)
  })

  it('反复导入不会累积（只保留最后一次）', () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'a.csv', warnings: [] })
    usePlotDataStore.getState().setExternal({ rows: [makeRow('Z9', 1)], label: 'b.csv', warnings: [] })

    expect(usePlotDataStore.getState().external?.rows).toHaveLength(1)
    expect(usePlotDataStore.getState().external?.label).toBe('b.csv')
  })

  it('模拟「下次跑分析」：startRun 清空 rows 时，外部数据不受牵连也仍在', () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'x.csv', warnings: [] })
    // startRun 会把分析结果清空（真实实现在 store 内部做同样的事）
    useAnalysisStore.setState({ rows: null, snapshot: null })

    expect(useAnalysisStore.getState().rows).toBeNull()
    expect(usePlotDataStore.getState().external?.rows).toHaveLength(3)
  })
})

describe('分析成功后的自动切回', () => {
  it('★ 分析成功后清掉外部数据（否则用户刚看完「分析完成」，看到的还是别人的表）', async () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'x.csv', warnings: [] })

    await useAnalysisStore.getState().handleDone({ status: 'success', result: { analysisId: 'ana-new' } })

    expect(usePlotDataStore.getState().external).toBeNull()
  })

  it('分析失败时不清（用户可能还想接着用外部表画图，抹掉等于让他白导一次）', async () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'x.csv', warnings: [] })

    await useAnalysisStore.getState().handleDone({ status: 'failed' })

    expect(usePlotDataStore.getState().external?.rows).toHaveLength(3)
  })

  it('用户取消时不清', async () => {
    usePlotDataStore.getState().setExternal({ rows: EXTERNAL_ROWS, label: 'x.csv', warnings: [] })

    await useAnalysisStore.getState().handleDone({ status: 'cancelled' })

    expect(usePlotDataStore.getState().external?.rows).toHaveLength(3)
  })
})
