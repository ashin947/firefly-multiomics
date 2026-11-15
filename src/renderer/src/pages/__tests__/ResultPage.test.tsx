/**
 * @vitest-environment jsdom
 *
 * 结果页吃**真实 R 产物**的渲染验证（`DEG_DEV_MOCK` 关掉时走的那条链）。
 *
 * ## 这条链是什么
 *
 *     真实 de.csv → ResultLoader → IPC loadResult → analysisStore.rows
 *                 → ResultPage（统计卡 / 工具栏 / 表格）→ VolcanoChart
 *
 * `realResultChain.test.ts` 已经覆盖了「ResultLoader → 火山图点集」；
 * 这里补的是**页面这一层**：真实行数据进到 React 之后，统计卡数字、工具栏行数、
 * 传给图表的 rows 是否还是同一份东西。
 *
 * ## 为什么要 mock `VolcanoChart`
 *
 * ECharts 在 jsdom 里 init 需要 canvas（jsdom 没有实现 `getContext`），真渲染会直接抛。
 * 图表的**数学**（分类计数、点集、topN 标注）在 `plotSpecs.volcano()` 里，
 * 已由 `realResultChain.test.ts` 逐条断言；这里只验证「页面把 1400 行原样递给了它」，
 * 所以用一个记录 props 的替身，而不是去伪造 canvas。
 *
 * ## 数据从哪来
 *
 * 与 `realResultChain.test.ts` 共用同一份夹具（`scripts/smoke-r-de.R` 的原始产物），
 * 走**同一个** `ResultLoader` 实例化路径 —— 不手写假行，避免「测试里形状对、
 * 真实文件形状不对」这种最典型的假绿。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { DEResultRow, DEStats, ThresholdState } from '@shared/types/analysis'
import type { AnalysisSnapshot, ProjectMeta } from '@shared/types/project'
import type { AppInfo } from '@shared/types/runtime'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import { ResultLoader } from '../../../../main/analysis/ResultLoader'

/** 捕获 VolcanoChart 收到的 props（vi.mock 会被提升，必须用 vi.hoisted 共享） */
const captured = vi.hoisted(() => ({
  rows: null as unknown,
  thresholds: null as unknown,
  renderCount: 0
}))

/*
 * 图表组件已从 ECharts（VolcanoChart）换成 R 渲染的静态预览
 * （GgplotVolcanoPreview）。这里仍然打桩，原因不变：它会去调
 * `window.deg.plot.preview`（要起 R 进程），测试环境里既没有 R 也没有那个 IPC。
 *
 * 断言目标仍是「页面把 1400 行原样递给了图表」—— 这一层与用哪种引擎无关。
 */
vi.mock('../../components/charts/GgplotVolcanoPreview', () => ({
  GgplotVolcanoPreview: (props: { rows: unknown; thresholds: unknown }): JSX.Element => {
    captured.rows = props.rows
    captured.thresholds = props.thresholds
    captured.renderCount += 1
    return <div data-testid="volcano-stub" />
  }
}))

/*
 * 热图面板会调 `plot.previewHeatmap`（起 R 进程），测试环境里没有 R。
 * 它不参与本文件要验的断言（统计卡 / 工具栏 / 图表 rows 三者一致），直接打桩。
 */
vi.mock('../../components/result/HeatmapPanel', () => ({
  HeatmapPanel: (): JSX.Element => <div data-testid="heatmap-stub" />
}))

vi.mock('../../components/charts/VolcanoChart', () => ({
  // ResultPage 从同一模块拿 presetColors（导出时把配色名解析成三色），
  // mock 掉了整个模块就必须把它一起补上，否则页面 import 直接报 undefined
  presetColors: (palette: string[]) => ({
    down: palette[0] ?? '#2166AC',
    ns: palette[1] ?? '#B0B7C3',
    up: palette[2] ?? '#B2182B'
  })
}))

// 这些 import 必须放在 vi.mock 之后（vi.mock 是提升的，但保持可读顺序）
import { ResultPage } from '../ResultPage'
import { useAnalysisStore } from '../../store/analysisStore'
import { useAppStore } from '../../store/appStore'
import { useProjectStore } from '../../store/projectStore'
import { useThresholdStore } from '../../store/thresholdStore'

const FIXTURE_DIR = path.join(__dirname, '../../../../main/analysis/__tests__/fixtures', 'limma-voom')
// 结果页会把自己 store 里的 basis 一并传给图表，所以期望值里也要带上，
// 否则断言比的是「旧形状 vs 新形状」，红得没有意义
const THRESHOLDS: ThresholdState = { ...DEFAULT_THRESHOLDS, basis: 'adjPValue' }

/** 真实产物（1400 行 / 上调 75 / 下调 48） */
let rows: DEResultRow[] = []
let stats: DEStats = {
  totalGenesAfterFilter: 0,
  upCount: 0,
  downCount: 0,
  nsCount: 0,
  filteredOutCount: 0
}

/** 那次真实运行的快照（project.json 里 analyses 的一条） */
function realSnapshot(): AnalysisSnapshot {
  return {
    id: 'analysis-real-0001',
    moduleId: 'de',
    method: 'limma-voom',
    label: 'Tumor vs Normal（limma-voom）',
    contrast: { numerator: 'Tumor', denominator: 'Normal' },
    params: {},
    thresholds: THRESHOLDS,
    stats,
    resultPath: 'results/de/limma-voom/de.csv',
    createdAt: '2025-11-10T15:56:00.000Z',
    durationMs: 230,
    status: 'success'
  } as unknown as AnalysisSnapshot
}

/** 最小可用的 window.deg 桥（只实现结果页会碰的那一个通道） */
function installBridge(): void {
  const bridge = {
    analysis: {
      loadResult: (): Promise<unknown> =>
        Promise.resolve({ ok: true, data: { rows, stats, snapshot: realSnapshot() } })
    }
  }
  ;(window as unknown as { deg: unknown }).deg = bridge
}

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/transcriptome/result/analysis-real-0001']}
      // 提前打开 v7 行为，消掉 react-router 的 Future Flag 警告噪音
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/result/:runId" element={<ResultPage />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeAll(() => {
  const payload = new ResultLoader().load(FIXTURE_DIR, {
    thresholds: THRESHOLDS,
    filteredOutCount: 600
  })
  rows = payload.rows
  stats = payload.stats
})

afterEach(() => {
  cleanup()
  captured.rows = null
  captured.thresholds = null
  captured.renderCount = 0
})

describe('结果页 × 真实 de.csv（DEG_DEV_MOCK 关闭）', () => {
  it('渲染真实结果：统计卡 / 工具栏行数 / 图表 rows 三处一致', async () => {
    installBridge()
    useAppStore.setState({ info: { mock: false } as AppInfo })
    useProjectStore.setState({
      meta: {
        activeAnalysisId: 'analysis-real-0001',
        analyses: [realSnapshot()]
      } as unknown as ProjectMeta
    })
    useThresholdStore.setState({ logFC: THRESHOLDS.logFC, fdr: THRESHOLDS.fdr })
    useAnalysisStore.setState({ rows, stats, snapshot: realSnapshot(), loadingResult: false, error: null })

    renderPage()

    // ① 页面标题与「不是演示数据」的事实
    expect(await screen.findByText('差异分析结果')).toBeTruthy()
    expect(document.body.textContent).not.toContain('演示数据')

    // ② 统计卡：真实数值
    //    「不显著」在页面里出现多次（统计卡标签 + 火山图右上角的计数摘要），
    //    所以用每张卡独有的提示语（logFC > 0 / logFC < 0 / 未达阈值）来定位。
    const statCardText = (label: string, hint: string): string => {
      const node = screen
        .getAllByText(label)
        .find((element) => element.closest('.MuiCard-root')?.textContent?.includes(hint))
      return node?.closest('.MuiCard-root')?.textContent ?? ''
    }
    expect(statCardText('上调基因', 'logFC > 0')).toContain('75')
    expect(statCardText('下调基因', 'logFC < 0')).toContain('48')
    expect(statCardText('不显著', '未达阈值')).toContain('1,277')
    expect(document.body.textContent).toContain('共 1,400 个基因通过过滤')

    // ③ 工具栏：可见行数 == 总行数（没有筛选时）
    expect(document.body.textContent).toContain('显示 1,400 / 1,400 行')

    // ④ 图表拿到的是**同一份**行数据，且阈值是当前阈值
    expect((captured.rows as DEResultRow[]).length).toBe(rows.length)
    expect(captured.thresholds).toEqual(THRESHOLDS)
  })

  it('从「最近任务」按 runId 进入时加载的是那一次的结果（不是上一次的行）', async () => {
    installBridge()
    useAppStore.setState({ info: { mock: false } as AppInfo })
    useProjectStore.setState({
      meta: {
        activeAnalysisId: 'analysis-other',
        analyses: [realSnapshot()]
      } as unknown as ProjectMeta
    })
    useThresholdStore.setState({ logFC: THRESHOLDS.logFC, fdr: THRESHOLDS.fdr })
    // 先塞一份「别的分析」的旧行，验证 effect 会用 runId 精确覆盖
    useAnalysisStore.setState({
      rows: rows.slice(0, 10),
      stats,
      snapshot: realSnapshot(),
      loadingResult: false,
      error: null
    })

    renderPage()

    // effect 走完 loadResult 之后，行数回到真实规模
    await screen.findByText('差异分析结果')
    expect(useAnalysisStore.getState().rows).toHaveLength(rows.length)
  })
})
