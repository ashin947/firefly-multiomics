/**
 * @vitest-environment jsdom
 *
 * Venn 页的「交集明细」表。
 *
 * ## 背景：为什么不是「点图上的数字」
 *
 * 客户的原话是「点击图的数字，可以给我里面的基因」。预览图是 R 渲出来的**静态 PNG**，
 * 没有命中测试 —— 想在图上点，只能自己在前端重画一遍 Venn（那就会与导出图不一致）。
 * 所以改成：R 把每个交集区域的成员一起返回，界面在图正下方渲染一张表，
 * 点行展开基因列表。信息是同一份，而且能整段复制。
 *
 * 这里钉住三件事，任何一件坏掉用户就「看不到基因」：
 *  1. 表里只列**非空**区域，且按基因数降序（用户最想看的是最大的那个交集）；
 *  2. 点行能展开出该区域的基因；
 *  3. 每个区域都能整段复制（复制内容要是换行分隔的基因名）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VizRenderRequest, VizRenderResult } from '@shared/types/viz'
import { VennPage } from '../VennPage'

const renderSpy = vi.fn()

/** 三组：A={g1..g100, shared}, B={shared, g101..g150}, C={g201..g210} */
const SUMMARY: VizRenderResult = {
  dataUrl: 'data:image/png;base64,AAAA',
  bytes: 4,
  durationMs: 1,
  summary: {
    sets: 3,
    totalUnique: 261,
    regions: [
      // 故意乱序返回：页面要按 count 降序排，不能直接照抄 R 的顺序
      { region: '基因集 3', sets: ['基因集 3'], count: 10, genes: ['g201', 'g202'] },
      {
        region: '基因集 1',
        sets: ['基因集 1'],
        count: 100,
        genes: Array.from({ length: 100 }, (_, i) => `g${i + 1}`)
      },
      {
        region: '基因集 2',
        sets: ['基因集 2'],
        count: 50,
        genes: Array.from({ length: 50 }, (_, i) => `g${i + 101}`)
      },
      {
        region: '基因集 1 & 基因集 2',
        sets: ['基因集 1', '基因集 2'],
        count: 1,
        genes: ['shared']
      },
      // 空区域必须被过滤掉（图上不显示，表里也不该出现）
      { region: '基因集 1 & 基因集 3', sets: ['基因集 1', '基因集 3'], count: 0, genes: [] }
    ]
  }
}

function installBridge(summary: VizRenderResult = SUMMARY): void {
  const bridge = {
    system: {
      saveFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: null }),
      revealPath: (): Promise<unknown> => Promise.resolve({ ok: true, data: undefined })
    },
    viz: {
      render: (req: VizRenderRequest): Promise<unknown> => {
        renderSpy(req)
        return Promise.resolve({ ok: true, data: summary })
      },
      inspectSource: (): Promise<unknown> => Promise.resolve({ ok: true, data: null })
    }
  }
  ;(window as unknown as { deg: unknown }).deg = bridge
}

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/viz/venn']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/venn" element={<VennPage />} />
      </Routes>
    </MemoryRouter>
  )
}

/** 往三个粘贴框里填一点内容，让 ready=true */
function fillSets(): void {
  const boxes = screen.getAllByPlaceholderText('粘贴基因列表（逗号 / 空格 / 换行分隔）')
  fireEvent.change(boxes[0], { target: { value: 'g1,g2' } })
  fireEvent.change(boxes[1], { target: { value: 'g2,g3' } })
  fireEvent.change(boxes[2], { target: { value: 'g4' } })
}

beforeEach(() => {
  renderSpy.mockClear()
  installBridge()
})

afterEach(() => {
  cleanup()
})

describe('VennPage 交集明细：R 返回的形状不可信', () => {
  /**
   * R 侧协议用 `auto_unbox = TRUE`，长度为 1 的向量会被展开成标量。
   * 客户就是撞在这里：某个交集恰好只有 1 个基因时 `genes` 变成字符串，
   * 页面 `genes.join()` 抛 TypeError，整屏白。
   *
   * 根因已在 R 侧修（包成 as.list），这条测试盯的是**前端防御**：
   * 即使 R 又退化成标量，页面也只能少显示、不能崩。
   */
  const DEGENERATE: VizRenderResult = {
    dataUrl: 'data:image/png;base64,AAAA',
    bytes: 4,
    durationMs: 1,
    summary: {
      regions: [
        // 单基因 → genes 退化成字符串；sets 也退化成字符串
        { region: 'A & B', sets: 'A', count: 1, genes: 'TP53' }
      ]
    }
  }

  it('genes 是标量字符串时不崩溃，仍能展开出那一个基因', async () => {
    installBridge(DEGENERATE)
    renderPage()
    fillSets()

    await waitFor(() => expect(screen.getByText('交集明细')).toBeTruthy(), { timeout: 4000 })
    const row = document.querySelector('tbody tr')
    expect(row).toBeTruthy()
    fireEvent.click(row as Element)

    await waitFor(() => expect(screen.getByText(/TP53/)).toBeTruthy())
  })
})

describe('VennPage 交集明细', () => {
  it('只列非空区域，并按基因数降序', async () => {
    renderPage()
    fillSets()

    await waitFor(() => expect(screen.getByText('交集明细')).toBeTruthy(), { timeout: 4000 })
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('tbody tr')
      expect(found.length).toBeGreaterThan(0)
      return Array.from(found)
    })
    const labels = rows.map((row) => row.textContent ?? '')
    // 4 个非空区域；count=0 的那个不出现
    expect(labels.length).toBe(4)
    expect(labels[0]).toContain('基因集 1')
    expect(labels[0]).toContain('100')
    expect(labels.some((text) => text.includes('基因集 1 & 基因集 3'))).toBe(false)
  })

  it('点一行展开出该区域的基因', async () => {
    renderPage()
    fillSets()
    await waitFor(() => expect(screen.getByText('交集明细')).toBeTruthy(), { timeout: 4000 })

    // 展开「基因集 1 & 基因集 2」这一行（count=1，基因是 shared）
    const target = Array.from(document.querySelectorAll('tbody tr')).find((row) =>
      (row.textContent ?? '').includes('基因集 1 & 基因集 2')
    )
    expect(target).toBeTruthy()
    fireEvent.click(target as Element)

    await waitFor(() => expect(screen.getByText(/shared/)).toBeTruthy())
  })

  it('复制的是换行分隔的完整基因列表', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })

    renderPage()
    fillSets()
    await waitFor(() => expect(screen.getByText('交集明细')).toBeTruthy(), { timeout: 4000 })

    const target = Array.from(document.querySelectorAll('tbody tr')).find((row) =>
      (row.textContent ?? '').includes('基因集 1 & 基因集 2')
    )
    fireEvent.click(target as Element)
    await waitFor(() => expect(screen.getByText(/shared/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /复制/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // 单基因区域也要以换行分隔输出（粘贴回别的工具时一行一个才通用）
    expect(writeText).toHaveBeenCalledWith('shared')
  })
})
