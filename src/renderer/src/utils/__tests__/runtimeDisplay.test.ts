/**
 * `runtimeDisplay` 的单测 —— 锁的是**「界面此刻能说什么」**这条产品口径。
 *
 * 背景：状态栏曾经在 `info === null` 时直接渲染「R 未检测到 · 环境待完善」。
 * 那是探针还没回来的几十毫秒到几秒 —— 界面已经断言「没装 R」，
 * 用户会去查环境、重装包，而实际分析完全正常。
 * 所以这组断言的核心只有一条：**不知道就说不知道**。
 */
import { describe, expect, it } from 'vitest'
import type { AppError } from '@shared/errors'
import type { RRuntimeInfo } from '@shared/types/runtime'
import { runtimeDisplay } from '../runtimeDisplay'

function info(overrides: Partial<RRuntimeInfo> = {}): RRuntimeInfo {
  return {
    ok: true,
    source: 'custom',
    rscriptPath: 'D:/R-4.3.2/bin/x64/Rscript.exe',
    rHome: 'D:/R-4.3.2',
    version: '4.3.2',
    arch: 'x86_64',
    libPaths: ['D:/R-4.3.2/library'],
    packages: [{ name: 'limma', version: '3.58.1', ok: true, required: true }],
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

const probeError: AppError = {
  code: 'E_R_GENERIC',
  title: 'R 探测失败',
  message: 'spawn Rscript ENOENT'
}

describe('runtimeDisplay —— 三态不许混', () => {
  it('探测中 / 未开始：说「正在检测」，绝不说「未检测到」', () => {
    for (const probing of [true, false]) {
      const d = runtimeDisplay(null, probing)
      expect(d.state).toBe('pending')
      expect(d.label).toContain('正在检测')
      expect(d.label).not.toContain('未检测到')
      // 未探测完不给灯色：颜色本身就是一句结论
      expect(d.light).toBeNull()
    }
  })

  it('探测出错：说「检测失败」，不冒充「未检测到」', () => {
    const d = runtimeDisplay(null, false, probeError)
    expect(d.state).toBe('error')
    expect(d.label).toBe('R 检测失败')
    expect(d.label).not.toContain('未检测到')
    expect(d.light).toBeNull()
    // 错误原文要能透出（便于用户复制给支持）
    expect(d.detail).toContain('ENOENT')
  })

  it('真探完了、有 R：给版本号与灯色', () => {
    const d = runtimeDisplay(info(), false)
    expect(d.state).toBe('ready')
    expect(d.label).toBe('R 4.3.2')
    expect(d.light).toBe('green')
  })

  it('真探完了、没有 R：这时才允许说「未检测到」，且灯是红', () => {
    const d = runtimeDisplay(info({ rscriptPath: '', version: '' }), false)
    expect(d.state).toBe('ready')
    expect(d.label).toBe('R 未检测到')
    expect(d.light).toBe('red')
  })

  it('有 R 但缺包：灯黄、提示指向诊断（不冒充「环境正常」）', () => {
    const d = runtimeDisplay(info({ ok: false, missingPackages: ['DESeq2'] }), false)
    expect(d.light).toBe('yellow')
    expect(d.hint).toContain('部分分析包缺失')
  })
})
