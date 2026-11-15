/**
 * @vitest-environment jsdom
 *
 * 小提琴页「基因输入」的提交行为。
 *
 * ## 这条断言在防什么（客户实际踩到的）
 *
 * 客户在基因框里粘贴了 `RB1 CDKN2A ALK` 就去点别处，右侧一直是空图。
 * 原因有两层，两层都要钉：
 *
 *  1. MUI Autocomplete 在 `freeSolo` 下按回车会把**整段文本**当成一个值提交，
 *     得到的是一个名字里带空格的「基因」，R 侧按它去矩阵里查必然查不到；
 *  2. 不按回车就失焦，输入根本不会被提交，`genes` 仍是空数组 ——
 *     而界面上没有任何提示说明「还要再按一下回车」。
 *
 * 所以这里验证两件事：粘贴多基因后失焦能自动拆成 3 个，且真的以 3 个基因去请求出图。
 * 断言落在**发给 R 的请求**上（不是界面上出现了几个 chip）—— chip 数量对但请求
 * 里是 1 个带空格的字符串，这个 bug 照样存在。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VizInspectResult, VizRenderRequest } from '@shared/types/viz'
import { ViolinPage } from '../ViolinPage'

const renderSpy = vi.fn()

const MATRIX_INFO: VizInspectResult = {
  delimiter: ',',
  columns: ['gene', 'N1', 'N2', 'C1', 'C2'],
  rowKeys: ['RB1', 'CDKN2A', 'ALK', 'TP53'],
  rowKeyTotal: 4,
  totalRows: 4,
  totalColumns: 5,
  suggested: { geneColumn: 'gene' },
  roleValues: {},
  preview: []
}

const GROUPS_INFO: VizInspectResult = {
  delimiter: ',',
  columns: ['sample', 'group'],
  rowKeys: ['N1', 'N2', 'C1', 'C2'],
  rowKeyTotal: 4,
  totalRows: 4,
  totalColumns: 2,
  suggested: { sampleColumn: 'sample', groupColumn: 'group' },
  roleValues: { group: ['normal', 'cancer'] },
  preview: []
}

function installBridge(): void {
  let pickCount = 0
  const bridge = {
    system: {
      // 第一次给矩阵、第二次给分组表（与页面上的点击顺序一致）
      pickFile: (): Promise<unknown> => {
        pickCount += 1
        return Promise.resolve({
          ok: true,
          data: [pickCount === 1 ? '/fake/matrix.csv' : '/fake/groups.csv']
        })
      },
      saveFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: null }),
      revealPath: (): Promise<unknown> => Promise.resolve({ ok: true, data: undefined })
    },
    viz: {
      inspectSource: (req: { filePath: string }): Promise<unknown> =>
        Promise.resolve({
          ok: true,
          data: req.filePath.includes('matrix') ? MATRIX_INFO : GROUPS_INFO
        }),
      render: (req: VizRenderRequest): Promise<unknown> => {
        renderSpy(req)
        return Promise.resolve({
          ok: true,
          data: { dataUrl: 'data:image/png;base64,AAAA', bytes: 4, durationMs: 1, summary: {} }
        })
      }
    }
  }
  ;(window as unknown as { deg: unknown }).deg = bridge
}

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/viz/violin']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/violin" element={<ViolinPage />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  renderSpy.mockClear()
  installBridge()
})

afterEach(() => {
  cleanup()
})

async function selectBothFiles(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '选择表达矩阵' }))
  // 读完矩阵后按钮文案变「重新选择」，且出现行×列提示
  await waitFor(() => expect(screen.getByText(/4 行 × 5 列/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '选择分组表' }))
  await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeTruthy())
}

describe('ViolinPage 基因输入', () => {
  it('粘贴「RB1 CDKN2A ALK」后失焦，按 3 个基因请求出图', async () => {
    renderPage()
    await selectBothFiles()

    const geneBox = screen.getByPlaceholderText('选或输入基因名，多个用空格/逗号分隔')
    fireEvent.change(geneBox, { target: { value: 'RB1 CDKN2A ALK' } })
    // 关键动作：不按回车，直接失焦
    fireEvent.blur(geneBox)

    await waitFor(() => expect(renderSpy).toHaveBeenCalled(), { timeout: 4000 })

    const request = renderSpy.mock.calls.at(-1)?.[0] as VizRenderRequest
    expect(request.kind).toBe('violin')
    if (request.kind !== 'violin') throw new Error('kind 不是 violin')
    // 必须是 3 个独立基因名，而不是一个 "RB1 CDKN2A ALK"
    expect(request.source.genes).toEqual(['RB1', 'CDKN2A', 'ALK'])
  })

  it('逗号分隔同样能拆开，且重复基因被去掉', async () => {
    renderPage()
    await selectBothFiles()

    const geneBox = screen.getByPlaceholderText('选或输入基因名，多个用空格/逗号分隔')
    fireEvent.change(geneBox, { target: { value: 'RB1,ALK, RB1' } })
    fireEvent.blur(geneBox)

    await waitFor(() => expect(renderSpy).toHaveBeenCalled(), { timeout: 4000 })
    const request = renderSpy.mock.calls.at(-1)?.[0] as VizRenderRequest
    if (request.kind !== 'violin') throw new Error('kind 不是 violin')
    expect(request.source.genes).toEqual(['RB1', 'ALK'])
  })
})

describe('ViolinPage 括号标注', () => {
  it('默认标 p 值，切到 FDR 后请求里跟着变', async () => {
    renderPage()
    await selectBothFiles()

    const geneBox = screen.getByPlaceholderText('选或输入基因名，多个用空格/逗号分隔')
    fireEvent.change(geneBox, { target: { value: 'RB1 ALK' } })
    fireEvent.blur(geneBox)

    await waitFor(() => expect(renderSpy).toHaveBeenCalled(), { timeout: 4000 })
    const first = renderSpy.mock.calls.at(-1)?.[0] as VizRenderRequest
    if (first.kind !== 'violin') throw new Error('kind 不是 violin')
    // 客户要的就是未校正的 p 值，默认必须是 p —— 默认值写错的话，
    // 图上会标一个和「两组 Wilcoxon 得 p=…」对不上的数字，很难自己发现
    expect(first.options.pLabel).toBe('p')

    // 切到 FDR 后重新出图，请求里应该带上 fdr
    fireEvent.change(screen.getByLabelText('括号标注'), { target: { value: 'fdr' } })
    await waitFor(
      () => {
        const latest = renderSpy.mock.calls.at(-1)?.[0] as VizRenderRequest
        expect(latest.kind === 'violin' && latest.options.pLabel).toBe('fdr')
      },
      { timeout: 4000 }
    )
  })
})

describe('ViolinPage 空态提示', () => {
  it('两个文件都选好但没选基因时，提示指到「基因」这一步', async () => {
    renderPage()
    await selectBothFiles()
    // 注意匹配空态那句话本身：输入框下面还有一条 helperText 也含「输入后按回车」，
    // 用 /输入后按回车/ 会同时命中两处（getByText 直接报多元素错误）
    expect(screen.getByText(/在「基因」里选或输入基因名/)).toBeTruthy()
  })

  it('只选了矩阵时，提示指向还缺的分组表', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '选择表达矩阵' }))
    await waitFor(() => expect(screen.getByText(/4 行 × 5 列/)).toBeTruthy())
    expect(screen.getByText(/再选择分组表/)).toBeTruthy()
  })
})
