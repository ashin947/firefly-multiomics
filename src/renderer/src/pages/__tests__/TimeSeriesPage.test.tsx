/**
 * @vitest-environment jsdom
 *
 * 时序转录组页面的**结构约束**（单序列已接入，两组仍待接入）。
 *
 * 这里测的不是「算得对不对」（那是 R 冒烟与真机验证的事），而是三件容易写错的事：
 *  1. 两种模式都要标「可用」，页头徽标写清各自的方法（SAM / moanin）；
 *  2. 没选文件时「开始分析」必须禁用，否则点了会弹一堆校验错误；
 *  3. 切到两组模式后内容真的换（不是只换标题）：出现 moanin 参数而不再是 SAM 的参数。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { TimeSeriesPage } from '../TimeSeriesPage'

function renderPage(): void {
  render(
    <MemoryRouter
      initialEntries={['/module/transcriptome/timeseries']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/module/:omicsId/timeseries" element={<TimeSeriesPage />} />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
})

describe('TimeSeriesPage（单序列 SAM / 两组 moanin）', () => {
  it('页头说清两种模式各自的方法', () => {
    renderPage()
    expect(screen.getByText('单序列（SAM）· 两组（moanin）')).toBeTruthy()
    expect(screen.getByText('时序差异分析（单序列）')).toBeTruthy()
    expect(screen.getByText('两组多时间点（ck vs dt）')).toBeTruthy()
    // 两张模式卡都标「可用」
    expect(screen.getAllByText('可用').length).toBe(2)
  })

  it('单序列：没选文件时「开始分析」禁用，并写明操作顺序与阈值语义', () => {
    renderPage()
    const btn = screen.getByRole('button', { name: '开始分析' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // 操作顺序：1 选矩阵 → 2 参数 →（运行后）3 结果
    expect(screen.getByText('1. 选择表达矩阵')).toBeTruthy()
    expect(screen.getByText('2. 参数')).toBeTruthy()
    // 阈值与重跑的区别必须写在参数区，否则用户每改一次阈值就白等
    expect(screen.getByText(/不需要重跑/)).toBeTruthy()
  })

  it('切到两组模式后换成 moanin 的参数（不再显示 SAM 的参数）', () => {
    renderPage()
    fireEvent.click(screen.getByText('两组多时间点（ck vs dt）'))
    // 「moanin 样条模型」在模式卡与参数卡标题里各出现一次，用 getAllByText
    expect(screen.getAllByText(/moanin 样条模型/).length).toBeGreaterThan(0)
    // MUI 的 label 与 legend 都会渲染同名文本，用 getAllByText
    expect(screen.getAllByText('degrees_of_freedom').length).toBeGreaterThan(0)
    // SAM 的「置换次数」不该再出现
    expect(screen.queryByText('置换次数')).toBeNull()
  })
})
