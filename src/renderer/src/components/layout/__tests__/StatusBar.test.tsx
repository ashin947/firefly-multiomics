/**
 * @vitest-environment jsdom
 *
 * 状态栏的**回归锁**：探针没回来之前，不能出现「R 未检测到」。
 *
 * 这条 bug 的表现是「偶发」——只在启动后的几十毫秒到几秒里闪一下，
 * 手点根本复现不了，但客户截到了。所以只能用状态注入来测：
 * 把 store 摆成「正在探测」的形态，断言屏幕上没有一个字在说「没装 R」。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusBar } from '../StatusBar'
import { useRuntimeStore } from '../../../store/runtimeStore'
import { useProjectStore } from '../../../store/projectStore'
import type { RRuntimeInfo } from '@shared/types/runtime'

function info(overrides: Partial<RRuntimeInfo> = {}): RRuntimeInfo {
  return {
    ok: true,
    source: 'custom',
    rscriptPath: 'D:/R-4.3.2/bin/x64/Rscript.exe',
    rHome: 'D:/R-4.3.2',
    version: '4.3.2',
    arch: 'x86_64',
    libPaths: [],
    packages: [],
    missingPackages: [],
    missingSpeciesLibs: [],
    speciesLibs: { human: true, mouse: true },
    fontAvailable: true,
    probedAt: '2025-11-15T00:00:00.000Z',
    warnings: [],
    methods: [],
    ...overrides
  } as RRuntimeInfo
}

afterEach(() => {
  cleanup()
  useRuntimeStore.setState({ info: null, probing: false, error: null })
  useProjectStore.setState({ meta: null, dataset: null })
})

describe('StatusBar 的 R 状态文案', () => {
  it('正在探测：显示「正在检测 R…」，且不出现「未检测到」「环境待完善」', () => {
    useRuntimeStore.setState({ info: null, probing: true, error: null })
    render(<StatusBar />)
    expect(screen.getByText(/正在检测 R/)).toBeTruthy()
    expect(screen.queryByText(/未检测到/)).toBeNull()
    // 未探完不给结论：连「环境待完善」也不该有
    expect(screen.queryByText(/环境待完善/)).toBeNull()
  })

  it('探测出错：显示「R 检测失败」，不出现「未检测到」', () => {
    useRuntimeStore.setState({
      info: null,
      probing: false,
      error: { code: 'E_R_GENERIC', title: 'R 探测失败', message: 'spawn Rscript ENOENT' }
    })
    render(<StatusBar />)
    expect(screen.getByText(/R 检测失败/)).toBeTruthy()
    expect(screen.queryByText(/未检测到/)).toBeNull()
  })

  it('探测完成且正常：显示版本号 + 环境正常', () => {
    useRuntimeStore.setState({ info: info(), probing: false, error: null })
    render(<StatusBar />)
    expect(screen.getByText(/R 4\.3\.2/)).toBeTruthy()
    expect(screen.getByText(/环境正常/)).toBeTruthy()
  })

  it('探测完成但确实没有 R：这才显示「R 未检测到 · 环境不可用」', () => {
    useRuntimeStore.setState({ info: info({ rscriptPath: '', version: '' }), probing: false, error: null })
    render(<StatusBar />)
    expect(screen.getByText(/R 未检测到/)).toBeTruthy()
    expect(screen.getByText(/环境不可用/)).toBeTruthy()
  })
})
