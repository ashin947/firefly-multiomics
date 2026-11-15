/**
 * 渲染进程调用 IPC 的统一封装。
 *
 * 为什么要包一层：
 *  1. `window.deg` 可能不存在（preload 构建失败 / 单元测试环境），裸调用会抛
 *     "Cannot read properties of undefined"，用户看到的是一片白屏而不是可读提示；
 *  2. 主进程永远返回 `IpcResult` 信封，业务代码里到处写 `if (res.ok)` 会把
 *     正常逻辑淹掉 —— 这里统一转成「成功返回数据 / 失败抛 BridgeError」；
 *  3. 错误对象必须是 `AppError`（带 code/title/suggestion），UI 才能按 §11.3 分级呈现。
 */
import type { AppError, IpcResult } from '@shared/errors'

/** 携带结构化 AppError 的异常（只在渲染进程内部流转，不会跨进程） */
export class BridgeError extends Error {
  readonly appError: AppError

  constructor(appError: AppError) {
    super(appError.message)
    this.name = 'BridgeError'
    this.appError = appError
  }
}

/** 把任意异常收敛成 AppError（渲染进程侧的兜底，与主进程 toAppError 语义一致） */
export function normalizeError(err: unknown): AppError {
  if (err instanceof BridgeError) return err.appError
  if (err && typeof err === 'object' && 'appError' in err) {
    const candidate = (err as { appError?: unknown }).appError
    if (candidate && typeof candidate === 'object' && 'code' in candidate) {
      return candidate as AppError
    }
  }
  return {
    code: 'E_UNKNOWN',
    title: '发生了未预期的错误',
    message: err instanceof Error ? err.message : String(err),
    suggestion: '请重试；若持续出现，请打开「环境诊断」导出报告。'
  }
}

/** preload 桥是否就绪（没有它一切 IPC 都不可用，首页需要给出明确提示） */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.deg)
}

/** 解包信封：成功返回 data，失败抛 BridgeError */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  if (!hasBridge()) {
    throw new BridgeError({
      code: 'E_UNKNOWN',
      title: '主进程通道未就绪',
      message: 'preload 桥未注入（window.deg 不存在），请重新启动应用。'
    })
  }
  const res = await promise
  if (res.ok) return res.data
  throw new BridgeError(res.error)
}
