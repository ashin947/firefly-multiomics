/**
 * R 运行时状态（首页三盏灯 / 侧栏底部状态 / 诊断弹窗的唯一来源）。
 *
 * 注意：这里**不做任何判定**。绿灯/黄灯/红灯一律来自 `@shared/runtimeStatus`，
 * 组件只负责把 StatusLight 映射成颜色。这样「物种库缺失永不红灯」这条产品决策
 * 不会因为某个组件自己写了一套 if 而失效。
 */
import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type { RRuntimeInfo } from '@shared/types/runtime'
import { call, normalizeError } from '../utils/ipc'
import { isMockMode } from './appStore'
import { mockRuntimeInfo } from '../dev/mockData'

interface RuntimeStoreState {
  info: RRuntimeInfo | null
  probing: boolean
  error: AppError | null
  diagnosticsOpen: boolean
  /** 探测（force=true 会清掉主进程磁盘缓存后重探） */
  probe(force?: boolean): Promise<void>
  /** 主进程主动推送的运行时变化（deg:event:runtimeChanged） */
  setInfo(info: RRuntimeInfo): void
  openDiagnostics(): void
  closeDiagnostics(): void
}

export const useRuntimeStore = create<RuntimeStoreState>((set, get) => ({
  info: null,
  probing: false,
  error: null,
  diagnosticsOpen: false,

  async probe(force = false): Promise<void> {
    if (get().probing) return
    // 演示模式：不探真实环境（本机没有 R），直接给一份健康运行时，
    // 让三盏灯与方法卡呈现产品设计上的正常形态。
    if (isMockMode()) {
      set({ info: mockRuntimeInfo(), probing: false, error: null })
      return
    }
    set({ probing: true, error: null })
    try {
      const info = await call(window.deg.runtime.probe({ force }))
      set({ info, probing: false })
    } catch (err) {
      set({ error: normalizeError(err), probing: false })
    }
  },

  setInfo(info: RRuntimeInfo): void {
    set({ info })
  },

  openDiagnostics(): void {
    set({ diagnosticsOpen: true })
  },

  closeDiagnostics(): void {
    set({ diagnosticsOpen: false })
  }
}))
