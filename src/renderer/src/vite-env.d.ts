/// <reference types="vite/client" />

import type { DegBridge } from '@shared/types/ipc-contract'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入；渲染进程访问主进程能力的唯一入口 */
    deg: DegBridge
  }
}

export {}
