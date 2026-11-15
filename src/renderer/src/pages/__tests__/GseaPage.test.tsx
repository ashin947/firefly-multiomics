/**
 * @vitest-environment jsdom
 *
 * GSEA 页面的交互约束。
 *
 * 这里只测**容易写错且出错后很难发现**的三件事：
 *  1. 没选差异文件时不能点「开始 GSEA」——GSEA 必须有排序，空跑只会白等；
 *  2. 切到小鼠时集合要自动回落——小鼠没有 KEGG（MSigDB 未提供 m2.cp.kegg_legacy），
 *     若还留着 `kegg`，R 侧会报「内置基因集缺失」，用户完全不知道是自己选了不存在的组合；
 *  3. 选「自定义 GMT」时必须提供 GMT 文件才允许运行。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GseaRunRequest, GseaRunResult } from '@shared/types/gsea'
import { GseaPage } from '../GseaPage'

const runSpy = vi.fn()
const exportSpy = vi.fn()

const EMPTY_RESULT: GseaRunResult = {
  gseaId: 'gsea-test',
  rows: [
    {
      pathway: 'HALLMARK_E2F_TARGETS',
      description: '',
      size: 200,
      es: 0.82,
      nes: 4.27,
      pvalue: 0.002,
      pAdjust: 0.012,
      leadingEdge: ''
    }
  ],
  summary: { geneSets: 46, significant: 8, inputGenes: 1600, topN: 5 },
  // 给一个（假的）dataURL：导出按钮只在图存在时渲染，导出用例需要它
  topPlot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  detailPlot: null
}

function installBridge(): void {
  const bridge = {
    system: {
      pickFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: ['/fake/diff.txt'] }),
      saveFile: (): Promise<unknown> => Promise.resolve({ ok: true, data: '/fake/out.bin' })
    },
    viz: {
      inspectSource: (): Promise<unknown> =>
        Promise.resolve({
          ok: true,
          data: {
            delimiter: '\t',
            columns: ['gene', 'logFC', 'P.Value'],
            rowKeys: ['TP53'],
            rowKeyTotal: 1,
            totalRows: 1600,
            totalColumns: 3,
            suggested: {},
            roleValues: {},
            preview: []
          }
        })
    },
    gsea: {
      run: (req: GseaRunRequest): Promise<unknown> => {
        runSpy(req)
        return Promise.resolve({ ok: true, data: EMPTY_RESULT })
      },
      exportPlot: (req: unknown): Promise<unknown> => {
        exportSpy(req)
        return Promise.resolve({ ok: true, data: { outPath: '/fake/out.bin', bytes: 1 } })
      }
    }
  }
  ;(window as unknown as { deg: unknown }).deg = bridge
}

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/transcriptome/gsea']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/gsea" element={<GseaPage />} />
      </Routes>
    </MemoryRouter>
  )
}

/** 选完差异文件（让「开始 GSEA」可用） */
async function pickDegFile(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '差异结果文件' }))
  await waitFor(() => expect(screen.getByText(/1600 行/)).toBeTruthy())
}

beforeEach(() => {
  runSpy.mockClear()
  exportSpy.mockClear()
  installBridge()
})

afterEach(() => {
  cleanup()
})

describe('GseaPage', () => {
  it('没选差异文件时不能开始', () => {
    renderPage()
    const btn = screen.getByRole('button', { name: '开始 GSEA' }) as HTMLButtonElement
    // GSEA 靠 logFC 排序，没有文件就等于没有输入 —— 按钮必须是禁用的，
    // 而不是点了之后弹一个「请选择文件」
    expect(btn.disabled).toBe(true)
  })

  it('切到小鼠后集合自动回落到 Hallmark（小鼠没有 KEGG）', async () => {
    renderPage()
    const speciesSelect = screen.getByLabelText('物种') as HTMLSelectElement
    fireEvent.change(speciesSelect, { target: { value: 'mouse' } })

    await waitFor(() => {
      const collection = screen.getByLabelText('集合') as HTMLSelectElement
      expect(collection.value).toBe('hallmark')
    })
    // 小鼠的集合选项里不该出现 KEGG
    const options = Array.from((screen.getByLabelText('集合') as HTMLSelectElement).options).map(
      (o) => o.value
    )
    expect(options).toEqual(['hallmark', 'reactome'])
  })

  it('选「自定义 GMT」时没有 GMT 文件不能开始', async () => {
    renderPage()
    await pickDegFile()
    // 选文件后按钮应可用（内置基因集）
    expect((screen.getByRole('button', { name: '开始 GSEA' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('物种'), { target: { value: 'custom' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'GMT 文件' })).toBeTruthy())
    // 切到自定义但还没选 GMT，必须重新变成禁用
    expect((screen.getByRole('button', { name: '开始 GSEA' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('跑通后展示结果摘要', async () => {
    renderPage()
    await pickDegFile()
    fireEvent.click(screen.getByRole('button', { name: '开始 GSEA' }))

    await waitFor(() => expect(screen.getByText('GSEA 结果')).toBeTruthy())
    expect(screen.getByText('46 个基因集')).toBeTruthy()
    // 显著性口径是 **p 值**（客户习惯），FDR 另给一个 chip 并列显示。
    // 两条都必须出现：只显示 p 会让人误以为没做多重检验校正。
    expect(screen.getByText('p < 0.05：1')).toBeTruthy()
    expect(screen.getByText('FDR < 0.05：1')).toBeTruthy()

    const req = runSpy.mock.calls[0]?.[0] as GseaRunRequest
    // 内置基因集时不该把 gmtPath 传下去（R 侧会当成用户指定文件）
    expect(req.source).toBe('human')
    expect(req.collection).toBe('hallmark')
    expect(req.gmtPath).toBeUndefined()
  })

  /**
   * 导出格式必须由按钮决定，不能靠保存框的扩展名去猜。
   *
   * PNG 和 PDF 在 R 侧是**两个独立文件**（两个图形设备分别画的）。如果按后缀猜，
   * 用户把文件名里的 .png 改成 .pdf 就会拿到一个其实是位图的「PDF」——
   * 在软件里看着一切正常，投稿放大才发现糊了。
   */
  it('「导出 PDF」把 format=pdf 传给主进程，而不是默认 png', async () => {
    renderPage()
    await pickDegFile()
    fireEvent.click(screen.getByRole('button', { name: '开始 GSEA' }))
    await waitFor(() => expect(screen.getByText('GSEA 结果')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await waitFor(() => expect(exportSpy).toHaveBeenCalled())
    const req = exportSpy.mock.calls[0]?.[0] as { which: string; format: string }
    expect(req.which).toBe('top')
    expect(req.format).toBe('pdf')

    exportSpy.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '导出 PNG' }))
    await waitFor(() => expect(exportSpy).toHaveBeenCalled())
    expect((exportSpy.mock.calls[0]?.[0] as { format: string }).format).toBe('png')
  })
})
