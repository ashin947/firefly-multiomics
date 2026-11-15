/**
 * @vitest-environment jsdom
 *
 * `FigureImage` 的**导出契约**（单细胞 9 处、时序 2 处图都靠它）。
 *
 * 为什么值得单独测：图本身是 R 画好的，界面这里只做「复制那份文件」，
 * 于是最容易错的就是**接线**——`file` 传空或传错，按钮会静默消失或导出别张图
 * （实测踩过：`gq.plots.map` 里错用了 `current.file`）。
 * 这里把三条契约钉死：
 *  1. 有 `file` + `onExport` 才出按钮（宁可没有按钮，也不要导出错图）；
 *  2. 点 PDF 传的是 `'pdf'`，点 PNG 传的是 `'png'`；
 *  3. 导出失败要把主进程的 message 显示出来，不能静默。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigureImage } from '../FigureImage'

afterEach(() => {
  cleanup()
})

function renderFig(overrides: Partial<Parameters<typeof FigureImage>[0]> = {}): void {
  render(
    <FigureImage
      src="data:image/png;base64,AAA"
      alt="测试图"
      file="p04_dotplot_custom.png"
      onExport={async () => undefined}
      {...overrides}
    />
  )
}

describe('FigureImage 导出工具条', () => {
  it('有 file 且给到 onExport 时出现 PDF / PNG 两个按钮', () => {
    renderFig()
    expect(screen.getByRole('button', { name: 'PDF' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'PNG' })).toBeTruthy()
  })

  it('file 为空时不显示按钮（避免导出错图）', () => {
    renderFig({ file: '' })
    expect(screen.queryByRole('button', { name: 'PDF' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'PNG' })).toBeNull()
  })

  it('没给 onExport 时不显示按钮', () => {
    renderFig({ onExport: undefined })
    expect(screen.queryByRole('button', { name: 'PDF' })).toBeNull()
  })

  it('点 PDF 调 onExport("pdf")，点 PNG 调 onExport("png")', async () => {
    const onExport = vi.fn(async () => undefined)
    renderFig({ onExport })
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }))
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'PNG' }))
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
  })

  it('导出失败把 message 显示出来（不静默）', async () => {
    const onExport = vi.fn(async () => {
      throw new Error('该图没有 PDF 版本：p04_dotplot_custom.pdf')
    })
    renderFig({ onExport })
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }))
    expect(await screen.findByText(/该图没有 PDF 版本/)).toBeTruthy()
  })
})
