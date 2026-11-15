/**
 * @vitest-environment jsdom
 *
 * 富集页的**交互与文案契约**测试。
 *
 * ## 为什么这几条值得单独测
 *
 * 富集能不能跑，取决于「物种 / 基因 ID 类型 / 背景来源」三者是否自洽。这三者
 * 在界面上是三个独立控件，靠 `onChange` 里的联动维持一致 —— 这种联动最容易在
 * 后续改动里被无声地拆掉，而拆掉之后的表现是**点下去才报错**（甚至报一个跟
 * 真实原因无关的错），用户根本不知道是自己选错了还是软件坏了。
 *
 * 具体钉住四件事：
 *
 *  1. 选「水稻」**不再**把背景切成「自定义文件」。产品已经随包提供
 *     `resources/annot/rice_go.tsv`（25443 个基因 / 97 个 GO Slim term），
 *     「水稻 + 内置注释库」是**能跑通**的组合。旧版本这里强制切自定义、
 *     还把物种下拉锁住 —— 那等于把功能藏起来，用户会去手工找注释表。
 *  2. 水稻仍然可以配「自定义文件」：客户手里可能还有别的注释版本。
 *  3. 自定义背景下的校验必须问「注释文件」而不是「数据库」：那个分支里 R 侧
 *     完全不读 `databases`，提示用户去开 GO/KEGG 开关是误导。
 *  4. 自定义背景下 KEGG 开关要显示成「通路」：它此时来自 pathway 注释文件，
 *     不再走 enrichKEGG，标成 KEGG 会让人以为还要联网取 KEGG 通路。
 *
 * 第 1 条额外**断言了发出去的请求体**：水稻 + 内置背景时不能带 `customGoPath`，
 * 否则 R 侧会当成用户指定了自定义文件，内置注释表反而被绕过。
 * 这一条需要伪造 `window.deg.enrich.run`，其余三条不需要 IPC。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnrichPage } from '../EnrichPage'
import { useAnalysisStore } from '../../store/analysisStore'
import { useThresholdStore } from '../../store/thresholdStore'

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/transcriptome/enrich/latest']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/enrich/:runId" element={<EnrichPage />} />
      </Routes>
    </MemoryRouter>
  )
}

/** 物种下拉是原生 <select>（MUI TextField + SelectProps.native），可按 label 取到 */
function speciesSelect(): HTMLSelectElement {
  return screen.getByLabelText('物种') as HTMLSelectElement
}

/** 背景来源的两个单选框 */
function backgroundRadio(label: string): HTMLInputElement {
  return screen.getByRole('radio', { name: label }) as HTMLInputElement
}

/** 基因 ID 类型下拉（同样是原生 <select>） */
function geneIdTypeSelect(): HTMLSelectElement {
  return screen.getByLabelText('基因 ID 类型') as HTMLSelectElement
}

beforeEach(() => {
  useAnalysisStore.getState().reset()
  useThresholdStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('EnrichPage 物种 / 背景联动', () => {
  it('选水稻时背景仍为内置注释库，物种下拉不再锁住', () => {
    renderPage()

    // 初始：内置注释库（默认），提供人类/小鼠/水稻三个选项
    expect(backgroundRadio('内置注释库').checked).toBe(true)
    expect(speciesSelect().value).toBe('human')
    // 内置背景下不出现注释文件入口
    expect(screen.queryByText('选择 GO 注释文件')).toBeNull()

    fireEvent.change(speciesSelect(), { target: { value: 'rice' } })

    // ★ 关键变化：背景**保持内置**，不接受「水稻只能自定义」的旧联动。
    //   内置注释表随包发布，水稻 + 内置是能跑通的组合。
    expect(speciesSelect().value).toBe('rice')
    expect(backgroundRadio('内置注释库').checked).toBe(true)
    expect(backgroundRadio('自定义文件').checked).toBe(false)
    expect(screen.queryByText('选择 GO 注释文件')).toBeNull()
    // 内置背景不看「物种是否被锁」—— 物种下拉必须仍然可改（否则用户回不去人类）
    expect(speciesSelect().disabled).toBe(false)

    // ★ 水稻下「基因 ID 类型」必须禁用并给出原因：
    //   走注释表那条分支时 R 侧不读 geneIdType，可点等于暗示「会帮你换算」。
    //   截图里「水稻 + Symbol（TP53）」并排出现时最容易被误读。
    expect(geneIdTypeSelect().disabled).toBe(true)
    expect(screen.getByText(/水稻内置注释按 LOC_Os 基因名直接匹配/)).toBeTruthy()
  })

  it('水稻 + 内置背景发出的请求不带 customGoPath', async () => {
    const runSpy = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        enrichId: 'enr-test-0001',
        rows: [],
        summary: { termCount: 0, geneCount: 3, durationMs: 1 }
      }
    })
    const bridge = {
      enrich: {
        run: runSpy,
        plot: vi.fn().mockResolvedValue({ ok: true, data: { plotUrl: null } })
      }
    }
    ;(window as unknown as { deg: unknown }).deg = bridge

    renderPage()
    fireEvent.change(speciesSelect(), { target: { value: 'rice' } })
    // 手动填 3 个水稻基因（LOC_Os 形态），让「开始富集」可点
    fireEvent.click(screen.getByRole('button', { name: '手动' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴基因列表（逗号/空格/换行分隔）'), {
      target: { value: 'LOC_Os01g01010 LOC_Os01g01020 LOC_Os01g01030' }
    })
    fireEvent.click(screen.getByRole('button', { name: '开始富集' }))

    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1))
    const payload = runSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload['species']).toBe('rice')
    // ★ 不带 custom 路径，R 侧才会走「内置注释表」那条分支
    expect('customGoPath' in payload).toBe(false)
    expect('customPathwayPath' in payload).toBe(false)
  })

  it('水稻 + 自定义文件仍然可用（客户可能还有别的注释版本）', () => {
    renderPage()

    fireEvent.change(speciesSelect(), { target: { value: 'rice' } })
    fireEvent.click(backgroundRadio('自定义文件'))

    expect(backgroundRadio('自定义文件').checked).toBe(true)
    expect(screen.getByText('选择 GO 注释文件')).toBeTruthy()
    // 自定义背景不看物种 → 下拉锁住，否则用户会以为物种还在起作用
    expect(speciesSelect().disabled).toBe(true)
  })

  it('选「其他（非模式生物）」→ 强制自定义背景，并隐藏「内置注释库」', () => {
    renderPage()
    expect(backgroundRadio('内置注释库')).toBeTruthy()

    fireEvent.change(speciesSelect(), { target: { value: 'other' } })

    // 背景被强制切到自定义（非模式生物没有内置注释，留「内置」只会拿到 0 命中）
    expect(backgroundRadio('自定义文件').checked).toBe(true)
    // 单选**整个消失**而不是变灰：禁用会让人问「为什么点不了」
    expect(screen.queryByRole('radio', { name: '内置注释库' })).toBeNull()
    expect(screen.getByText('选择 GO 注释文件')).toBeTruthy()
    // 物种设置此时不生效，必须说出来
    expect(screen.getByText(/用自定义注释时物种设置不生效/)).toBeTruthy()
  })

  it('结果超过 500 条时，标题旁直接写明被截断', async () => {
    const rows = Array.from({ length: 1853 }, (_, i) => ({
      id: `GO:${String(i).padStart(7, '0')}`,
      description: `term ${i}`,
      geneRatio: '3/300',
      bgRatio: '10/4589',
      pvalue: 0.001,
      pAdjust: 0.01,
      qvalue: 0.01,
      geneId: 'g1/g2/g3',
      count: 3,
      source: 'GO:BP' as const
    }))
    const bridge = {
      enrich: {
        run: vi.fn().mockResolvedValue({
          ok: true,
          data: { enrichId: 'enr-big', rows, summary: { termCount: rows.length, geneCount: 3, durationMs: 1 } }
        }),
        plot: vi.fn().mockResolvedValue({ ok: true, data: { plotUrl: null } })
      }
    }
    ;(window as unknown as { deg: unknown }).deg = bridge

    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '手动' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴基因列表（逗号/空格/换行分隔）'), {
      target: { value: 'g1 g2 g3' }
    })
    fireEvent.click(screen.getByRole('button', { name: '开始富集' }))

    // ★ 断在标题旁，不是页脚：用户滚到第 500 行就停住了，页脚说明等于没有
    await waitFor(() =>
      expect(screen.getByText(/显示前 500 \/ 共 1,853 条/)).toBeTruthy()
    )
  })

  it('自定义背景下 KEGG 开关显示为「通路」', () => {
    renderPage()

    // 内置背景：GO / KEGG
    expect(screen.getByText('KEGG')).toBeTruthy()

    fireEvent.click(backgroundRadio('自定义文件'))

    expect(screen.getByText('通路')).toBeTruthy()
    expect(screen.queryByText('KEGG')).toBeNull()
  })
})

describe('EnrichPage 运行前校验', () => {
  it('自定义背景没选注释文件时报「注释文件」，不是「数据库」', () => {
    renderPage()

    // 手动填 3 个基因，让「开始富集」按钮可用（按钮在 <3 个基因时是禁用的）
    fireEvent.click(screen.getByRole('button', { name: '手动' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴基因列表（逗号/空格/换行分隔）'), {
      target: { value: 'TP53 EGFR MYC' }
    })
    fireEvent.click(backgroundRadio('自定义文件'))
    fireEvent.click(screen.getByRole('button', { name: '开始富集' }))

    expect(screen.getByText('自定义背景下请至少选择一个注释文件（GO 或 Pathway）。')).toBeTruthy()
    expect(screen.queryByText('请至少选择一个数据库（GO 或 KEGG）。')).toBeNull()
  })

  it('内置背景关掉 GO 和 KEGG 后报「数据库」', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '手动' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴基因列表（逗号/空格/换行分隔）'), {
      target: { value: 'TP53 EGFR MYC' }
    })
    // 两个开关默认都开，逐个关掉
    fireEvent.click(screen.getByRole('checkbox', { name: 'GO' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'KEGG' }))
    fireEvent.click(screen.getByRole('button', { name: '开始富集' }))

    expect(screen.getByText('请至少选择一个数据库（GO 或 KEGG）。')).toBeTruthy()
  })
})
