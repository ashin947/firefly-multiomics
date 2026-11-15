/**
 * 应用级状态：appInfo（版本 / 演示开关）+ 用户设置（自定义 R 路径）。
 *
 * 与 runtimeStore 的分工：
 *  - appStore    = 「软件是什么」（版本、是否开发期、是否演示模式、用户偏好）
 *  - runtimeStore = 「R 能不能跑」（探测结果、诊断弹窗）
 */
import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type { AppInfo, AppSettings, ValidateRPathResult } from '@shared/types/runtime'
import { call, normalizeError } from '../utils/ipc'

interface AppStoreState {
  info: AppInfo | null
  settings: AppSettings
  loading: boolean
  error: AppError | null
  /** 启动时拉一次 appInfo + settings（幂等，可重复调用） */
  bootstrap(): Promise<void>
  /** 保存自定义 R 路径（null 表示清除） */
  saveCustomRPath(customRPath: string | null): Promise<boolean>
  /** 只校验不保存 */
  validateRPath(path: string): Promise<ValidateRPathResult | null>
  clearError(): void
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  info: null,
  settings: { customRPath: null },
  loading: false,
  error: null,

  async bootstrap(): Promise<void> {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [info, settings] = await Promise.all([call(window.deg.system.appInfo()), call(window.deg.system.settings())])
      set({ info, settings, loading: false })
    } catch (err) {
      set({ error: normalizeError(err), loading: false })
    }
  },

  async saveCustomRPath(customRPath: string | null): Promise<boolean> {
    try {
      const settings = await call(window.deg.system.setSettings({ customRPath }))
      set({ settings, error: null })
      return true
    } catch (err) {
      set({ error: normalizeError(err) })
      return false
    }
  },

  async validateRPath(path: string): Promise<ValidateRPathResult | null> {
    try {
      return await call(window.deg.runtime.validatePath({ path }))
    } catch (err) {
      set({ error: normalizeError(err) })
      return null
    }
  },

  clearError(): void {
    set({ error: null })
  }
}))

/** 演示模式是否开启（组件里用这个，而不是各自读 info?.mock） */
export function isMockMode(): boolean {
  return useAppStore.getState().info?.mock === true
}
