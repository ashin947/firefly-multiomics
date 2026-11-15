/**
 * @vitest-environment jsdom
 *
 * 模块首页「最近任务」的归属测试。
 *
 * ## 这条断言在防什么
 *
 * `AnalysisSnapshot` 里**没有 omicsId** —— 项目里存的分析记录分不清是哪个模块跑的。
 * 于是模块首页只能靠 `ModuleDef.tracksRuns` 自己声明要不要读这份记录。
 *
 * 这个声明一旦丢失，后果不是报错而是**误导**：绘图模块首页会把转录组跑过的
 * 差异分析列成自己的「最近任务」，还给一个「去导入数据」的按钮指向
 * `/module/viz/data`（绘图模块根本没有导入流程）。
 *
 * 所以这里同时钉三件事：
 *  1. 转录组（tracksRuns）能看到记录；
 *  2. 绘图（不 tracksRuns）看不到记录，即使 store 里确实有；
 *  3. 绘图模块的空态文案不出现「差异分析 / 导入数据」这些跟它无关的说法。
 *
 * 注意断言 2 必须在「store 里**有**记录」的前提下做，否则记录本来就不显示，
 * 测试会永远绿 —— 那正是假绿。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnalysisSnapshot } from '@shared/types/project'
import { ModuleHomePage } from '../ModuleHomePage'
import { useProjectStore } from '../../store/projectStore'

function snapshot(label: string): AnalysisSnapshot {
  return {
    id: 'analysis-1',
    moduleId: 'de',
    method: 'limma-voom',
    label,
    contrast: { numerator: 'Tumor', denominator: 'Normal' },
    params: {},
    thresholds: { logFC: 1, fdr: 0.05 },
    stats: {
      totalGenesAfterFilter: 1400,
      upCount: 75,
      downCount: 48,
      nsCount: 1277,
      filteredOutCount: 600
    },
    resultPath: 'results/de/limma-voom/de.csv',
    createdAt: '2026-11-10T15:56:00.000Z',
    durationMs: 230,
    status: 'success'
  } as unknown as AnalysisSnapshot
}

function renderModule(omicsId: string): void {
  render(
    <MemoryRouter
      initialEntries={[`/module/${omicsId}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId" element={<ModuleHomePage />} />
      </Routes>
    </MemoryRouter>
  )
}

const ANALYSIS_LABEL = 'Tumor vs Normal（limma-voom）'

beforeEach(() => {
  // 关键前提：store 里**确实有**一条转录组的分析记录
  useProjectStore.setState({
    meta: {
      schemaVersion: 1,
      id: 'proj-1',
      name: '示例项目',
      omicsId: 'transcriptome',
      createdAt: '2026-11-10T15:00:00.000Z',
      updatedAt: '2026-11-10T15:56:00.000Z',
      dataType: 'counts',
      analyses: [snapshot(ANALYSIS_LABEL)]
    } as unknown as ReturnType<typeof useProjectStore.getState>['meta']
  })
})

afterEach(() => {
  cleanup()
  useProjectStore.setState({ meta: null })
})

describe('模块首页 · 最近任务的归属', () => {
  it('转录组能看到自己的分析记录', () => {
    renderModule('transcriptome')
    expect(screen.getByText(ANALYSIS_LABEL)).toBeTruthy()
  })

  it('绘图模块看不到转录组的分析记录', () => {
    renderModule('viz')
    // 前提复核：这条记录确实在 store 里（否则下面的断言就是假绿）
    expect(useProjectStore.getState().meta?.analyses?.length).toBe(1)
    expect(screen.queryByText(ANALYSIS_LABEL)).toBeNull()
  })

  it('绘图模块的空态说的是「不产生任务记录」，不是「去导入数据」', () => {
    renderModule('viz')
    expect(screen.getByText('这个模块不产生任务记录')).toBeTruthy()
    expect(screen.queryByText('去导入数据')).toBeNull()
    // 「差异分析」属于转录组的话术，不该出现在绘图的空态里
    expect(screen.queryByText(/校验通过后即可运行差异分析/)).toBeNull()
  })
})
