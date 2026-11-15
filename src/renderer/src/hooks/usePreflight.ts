/**
 * 预检订阅 Hook：参数变化 → 300ms 防抖 → 调一次 `deg:analysis:preflight`。
 *
 * 为什么要防抖：预检在参数每次变化时都要重算（改方法、改对比组、改过滤阈值）。
 * 用户拖动「低表达过滤」的数字输入时每敲一个字符都会触发一次 IPC，
 * 既浪费又把界面刷得发抖。300ms 是「感觉不到延迟」与「不打爆 IPC」的折中。
 *
 * 为什么用序列化 key 做依赖：`draft` 是对象，每次 `setDraft` 都是新引用，
 * 直接把对象放进 deps 会让 effect 每帧重跑，防抖等于没有。
 */
import { useEffect, useRef } from 'react'
import type { AppError } from '@shared/errors'
import type { AnalysisPreflightResult, DEConfig } from '@shared/types/analysis'
import { useAnalysisStore } from '../store/analysisStore'

/** 防抖窗口（毫秒）。写在这里便于测试与调参时只改一处。 */
export const PREFLIGHT_DEBOUNCE_MS = 300

export interface PreflightState {
  /** 主进程给出的预检结论；null = 还没拿到 */
  result: AnalysisPreflightResult | null
  /** 有一次预检在路上 */
  busy: boolean
  /** 预检通道本身失败（IPC 挂了），与「预检不通过」是两件事 */
  error: AppError | null
}

export function usePreflight(config: DEConfig): PreflightState {
  const requestPreflight = useAnalysisStore((s) => s.requestPreflight)
  const result = useAnalysisStore((s) => s.preflight)
  const busy = useAnalysisStore((s) => s.preflightBusy)
  const error = useAnalysisStore((s) => s.preflightError)

  const key = JSON.stringify(config)
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    const timer = setTimeout(() => {
      void requestPreflight(configRef.current)
    }, PREFLIGHT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key, requestPreflight])

  return { result, busy, error }
}
