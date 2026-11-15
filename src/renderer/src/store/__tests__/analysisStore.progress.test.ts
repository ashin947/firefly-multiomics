/**
 * @vitest-environment jsdom
 *
 * `analysisStore.applyProgress` 的状态机测试。
 *
 * ## 这里锁的是什么
 *
 * 1. **抗丢包**：主进程对进度事件有节流（窗口内只补发最新一条），1–3 秒的任务
 *    必然丢中间事件。真机上因此出现过「正在标准化 / 已完成：读取数据」——
 *    低表达过滤那一格永远灰着，用户会以为这一步被跳过。
 *    正确做法是**按阶段顺序推导**：跑到第 N 个阶段，前 N-1 个必然已完成。
 * 2. **阶段说明不被空串冲掉**：R 有的进度消息不带 `msg`，不能把上一条更具体的说明清空。
 * 3. **pct 单调**：R 各阶段独立上报百分比，跨阶段可能回退，UI 不能跟着回退。
 * 4. **runId 过滤**：上一次运行的迟到事件不能污染这一次。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AnalysisProgressEvent } from '@shared/types/ipc-contract'
import { useAnalysisStore } from '../analysisStore'

function progress(partial: Partial<AnalysisProgressEvent> & { stage: AnalysisProgressEvent['stage']; pct: number }): AnalysisProgressEvent {
  return { runId: 'run-1', ...partial }
}

beforeEach(() => {
  useAnalysisStore.getState().reset()
  useAnalysisStore.setState({
    phase: 'running',
    runId: 'run-1',
    draft: { ...useAnalysisStore.getState().draft, method: 'limma-voom' }
  })
})

describe('applyProgress —— 已完成阶段按顺序推导（抗节流丢包）', () => {
  it('跳过 filter 事件时，filter 仍被标成已完成', () => {
    const store = useAnalysisStore.getState()
    store.applyProgress(progress({ stage: 'read', pct: 3 }))
    // 模拟 filter(25%) 被节流丢掉，直接收到 normalize
    store.applyProgress(progress({ stage: 'normalize', pct: 28, msg: 'calculating TMM normalization factors' }))

    const state = useAnalysisStore.getState()
    expect(state.stage).toBe('normalize')
    expect(state.doneStages).toEqual(['read', 'filter'])
    expect(state.stageMessage).toBe('calculating TMM normalization factors')
  })

  it('连跳多个阶段也全部补齐（read → fit）', () => {
    useAnalysisStore.getState().applyProgress(progress({ stage: 'fit', pct: 50 }))
    expect(useAnalysisStore.getState().doneStages).toEqual(['read', 'filter', 'normalize'])
  })

  it('同一阶段内多条消息不会把该阶段提前标成完成', () => {
    const store = useAnalysisStore.getState()
    store.applyProgress(progress({ stage: 'normalize', pct: 28 }))
    store.applyProgress(progress({ stage: 'normalize', pct: 36 }))
    expect(useAnalysisStore.getState().doneStages).toEqual(['read', 'filter'])
  })

  it('不带 msg 的进度不会清掉上一条阶段说明', () => {
    const store = useAnalysisStore.getState()
    store.applyProgress(progress({ stage: 'normalize', pct: 36, msg: 'running voom' }))
    store.applyProgress(progress({ stage: 'normalize', pct: 45 }))
    expect(useAnalysisStore.getState().stageMessage).toBe('running voom')
  })

  it('pct 单调不回退（R 跨阶段独立上报）', () => {
    const store = useAnalysisStore.getState()
    store.applyProgress(progress({ stage: 'normalize', pct: 45 }))
    store.applyProgress(progress({ stage: 'fit', pct: 50 }))
    store.applyProgress(progress({ stage: 'fit', pct: 20 }))
    expect(useAnalysisStore.getState().pct).toBe(50)
  })

  it('上一次运行的迟到事件被丢弃', () => {
    const store = useAnalysisStore.getState()
    store.applyProgress(progress({ stage: 'read', pct: 15 }))
    store.applyProgress(progress({ runId: 'run-old', stage: 'write', pct: 100 }))
    const state = useAnalysisStore.getState()
    expect(state.pct).toBe(15)
    expect(state.stage).toBe('read')
  })

  it('阶段不在本方法序列里时，退回「上一阶段」推断而不是乱标', () => {
    // limma-voom 没有 dispersion 阶段：收到这种事件（不该发生）也不能把整串标成完成
    useAnalysisStore.getState().applyProgress(progress({ stage: 'dispersion', pct: 60 }))
    const state = useAnalysisStore.getState()
    expect(state.stage).toBe('dispersion')
    expect(state.doneStages).toEqual(['read'])
  })
})
