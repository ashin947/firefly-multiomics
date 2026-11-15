/**
 * @vitest-environment jsdom
 *
 * WGCNA 页面的交互约束。
 *
 * 只测**容易写错、且错了很难发现**的三件事：
 *  1. 没选表达矩阵时不能点「① 计算软阈值」—— WGCNA 没有矩阵就是没输入，空跑只会白等；
 *  2. 第一段返回后必须能直接看到拟合表与推荐 β —— 用户是靠这张表决定下一步的，
 *     结果没渲染出来等于整个模块不可用；
 *  3. `traits` 被 `jsonlite(auto_unbox=TRUE)` 塌成字符串时页面不能崩 ——
 *     主进程已经兜了一层，渲染层再兜一层，否则 `.map/.join` 会让整页白屏。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WgcnaNetworkRequest,
  WgcnaPrepareRequest,
  WgcnaPrepareResult
} from '@shared/types/wgcna'
import { WgcnaPage } from '../WgcnaPage'

const prepareSpy = vi.fn()
const networkSpy = vi.fn()

/** 第一段的正常返回：两行拟合结果，12 是首个 R² ≥ 0.85 的 power */
function makePrepare(overrides: Partial<WgcnaPrepareResult> = {}): WgcnaPrepareResult {
  return {
    wgcnaId: 'wgcna-test-1',
    runDir: 'C:/fake/results/wgcna/wgcna-test-1',
    nGenesInput: 12000,
    nGenesUsed: 5800,
    nSamples: 24,
    nSamplesRemoved: 0,
    transformUsed: 'none',
    varianceCutoff: 0.5,
    traits: ['group'],
    unmatchedSamples: 0,
    powers: [
      { power: 6, signedR2: 0.71, slope: -1.42, meanK: 128.4, medianK: 96.5, maxK: 431 },
      { power: 12, signedR2: 0.87, slope: -1.08, meanK: 41.2, medianK: 30.1, maxK: 188 }
    ],
    recommendedPower: 12,
    plots: [
      { id: 'sampleTree', title: 'Sample clustering', caption: '样本聚类树', dataUrl: null, hasPdf: true },
      { id: 'scaleIndependence', title: 'Scale independence', caption: '无标度拟合', dataUrl: null, hasPdf: true },
      { id: 'meanConnectivity', title: 'Mean connectivity', caption: '平均连接度', dataUrl: null, hasPdf: true }
    ],
    summary: {},
    ...overrides
  }
}

const NETWORK_RESULT = {
  wgcnaId: 'wgcna-test-1',
  runDir: 'C:/fake/results/wgcna/wgcna-test-1',
  geneCount: 5800,
  modules: [{ module: 'turquoise', genes: 820 }],
  traitRows: [{ module: 'turquoise', trait: 'group', cor: 0.78, pvalue: 0.001, fdr: 0.004 }],
  plots: [],
  tables: [],
  tomCached: true,
  summary: {}
}

/** 每次测试想换 prepare 的返回就改这个变量 */
let prepareData: WgcnaPrepareResult = makePrepare()

function installBridge(): void {
  const bridge = {
    system: {
      pickFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: ['/fake/matrix.tsv'] }),
      saveFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: null }),
      pickDir: (): Promise<unknown> => Promise.resolve({ ok: true, data: null })
    },
    wgcna: {
      prepare: (req: WgcnaPrepareRequest): Promise<unknown> => {
        prepareSpy(req)
        return Promise.resolve({ ok: true, data: prepareData })
      },
      network: (req: WgcnaNetworkRequest): Promise<unknown> => {
        networkSpy(req)
        return Promise.resolve({ ok: true, data: NETWORK_RESULT })
      },
      exportPlot: (): Promise<unknown> => Promise.resolve({ ok: true, data: { outPath: '', bytes: 0 } }),
      exportAll: (): Promise<unknown> => Promise.resolve({ ok: true, data: { dir: '', files: 0 } }),
      exportTable: (): Promise<unknown> =>
        Promise.resolve({ ok: true, data: { outPath: '', bytes: 0, rows: 0 } }),
      loadResult: (): Promise<unknown> =>
        Promise.resolve({ ok: true, data: { wgcnaId: 'wgcna-test-1', prepare: null, network: null } })
    },
    events: {
      // 页面挂载即订阅；必须返回 unsubscribe，否则 useIpcEvent 的 cleanup 会炸
      onAnalysisProgress: (): (() => void) => () => {},
      onAnalysisLog: (): (() => void) => () => {},
      onAnalysisDone: (): (() => void) => () => {},
      onRuntimeChanged: (): (() => void) => () => {}
    }
  }
  ;(window as unknown as { deg: unknown }).deg = bridge
}

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/transcriptome/wgcna']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/wgcna" element={<WgcnaPage />} />
      </Routes>
    </MemoryRouter>
  )
}

/** 选完表达矩阵（让「① 计算软阈值」可用） */
async function pickMatrix(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '表达矩阵' }))
  await waitFor(() => expect(screen.getByText('matrix.tsv')).toBeTruthy())
}

beforeEach(() => {
  prepareSpy.mockClear()
  networkSpy.mockClear()
  prepareData = makePrepare()
  installBridge()
})

afterEach(() => {
  cleanup()
})

describe('WgcnaPage', () => {
  it('没选表达矩阵时不能计算软阈值', () => {
    renderPage()
    const btn = screen.getByRole('button', { name: '① 计算软阈值' }) as HTMLButtonElement
    // 没有矩阵就等于没有输入，按钮必须禁用，而不是点了之后再弹「请选择文件」
    expect(btn.disabled).toBe(true)
  })

  it('第一段跑完后展示拟合表与推荐 β', async () => {
    renderPage()
    await pickMatrix()

    expect((screen.getByRole('button', { name: '① 计算软阈值' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '① 计算软阈值' }))

    await waitFor(() => expect(screen.getByText('第一段：数据与质控')).toBeTruthy())

    // 两个基因数要分开显示：输入的 vs 方差过滤后真正入网的
    expect(screen.getByText('12000')).toBeTruthy()
    expect(screen.getByText('5800')).toBeTruthy()
    // 这张表是用户选 β 的唯一依据
    expect(screen.getByText('软阈值拟合表（signed R² 越大越接近无标度拓扑）')).toBeTruthy()
    expect(screen.getByText('推荐 β = 12')).toBeTruthy()

    // 推荐值要预设到第二段的下拉框里，用户不该自己去表里对一遍
    const powerSelect = screen.getByLabelText('软阈值 β（soft threshold）') as HTMLSelectElement
    expect(powerSelect.value).toBe('12')

    expect((prepareSpy.mock.calls[0]?.[0] as WgcnaPrepareRequest).varianceFilter).toBe('top50')
  })

  it('prepare 的 traits 塌成字符串时不崩', async () => {
    // 模拟 jsonlite(auto_unbox = TRUE) 把长度 1 的数组写成标量
    prepareData = makePrepare({ traits: 'group' as unknown as string[] })
    renderPage()
    await pickMatrix()
    fireEvent.click(screen.getByRole('button', { name: '① 计算软阈值' }))

    await waitFor(() => expect(screen.getByText('第一段：数据与质控')).toBeTruthy())
    // 兜底成空数组后按「没有性状表」处理，而不是抛 .map is not a function
    expect(screen.getByText(/未提供性状表/)).toBeTruthy()
  })
})
