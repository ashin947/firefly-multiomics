/**
 * @vitest-environment jsdom
 *
 * 路由错误兜底的行为测试。
 *
 * ## 为什么要测这个「只会在出错时才用到」的组件
 *
 * 客户点 Venn 交集行时页面变成一屏红字堆栈，整个应用不可用、只能重开。
 * 那条 bug 已修，但兜底页面本身如果没被验证过，下次真出事时我们只会
 * 得到「兜底也没生效」—— 防御代码不测，等于没有。
 *
 * 这里用一个最小路由真造一次渲染期异常，确认：
 *  1. 异常被 `errorElement` 接住（而不是冒到顶层白屏）；
 *  2. 错误原文被展示出来（排障唯一线索）；
 *  3. 有「重试」和「返回工作台」两个出口。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouteErrorBoundary } from '../RouteErrorBoundary'

/** 渲染期必然抛错的页面 */
function ThrowingPage(): JSX.Element {
  throw new TypeError('item.genes.join is not a function')
}

function renderWithCrash(): void {
  // 注意：不能再套一层「父路由 element + children」的布局路由 ——
  // 父 element 里不写 <Outlet /> 的话子路由根本不会渲染，异常也就无从发生，
  // 测试会「通过」得莫名其妙（第一版就踩了这个，两个断言全红但原因是没渲染）。
  const router = createMemoryRouter(
    [{ path: '/boom', element: <ThrowingPage />, errorElement: <RouteErrorBoundary /> }],
    // 这里不传 future flags：`v7_startTransition` 是 RouterProvider 的选项，
    // 塞进 createMemoryRouter 会被 TS 拒掉（本项目的 react-router 版本如此）。
    { initialEntries: ['/boom'] }
  )
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RouteErrorBoundary', () => {
  it('接住子路由的渲染异常，并显示错误原文', () => {
    // React 会把捕获到的错误打到 console.error，测试里静音避免噪音
    vi.spyOn(console, 'error').mockImplementation(() => {})

    renderWithCrash()

    expect(screen.getByText('页面渲染时出错')).toBeTruthy()
    // 原文必须露出来：没有它就只剩「出错了」三个字，无法排查
    expect(screen.getByText(/item\.genes\.join is not a function/)).toBeTruthy()
  })

  it('给出「重试」和「返回工作台」两个出口', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithCrash()

    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '返回工作台' })).toBeTruthy()
  })
})
