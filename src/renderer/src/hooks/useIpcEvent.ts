/**
 * IPC 事件订阅 hook。
 *
 * 必须返回并执行 unsubscribe：
 *  开发期 HMR 会反复挂载组件，如果只 `on` 不 `off`，监听器会成倍累积 ——
 *  表现是「一条日志在面板里出现 5 次」「进度条乱跳」，而且刷新页面才好。
 *
 * handler 用 ref 保存：调用方通常写内联箭头函数（每次渲染都是新引用），
 * 若把它放进依赖数组会导致每次渲染都重新订阅，等于没做清理。
 */
import { useEffect, useRef } from 'react'
import { IPC } from '@shared/ipc'
import type { IpcEventChannel } from '@shared/ipc'
import type {
  AnalysisDoneEvent,
  AnalysisLogEvent,
  AnalysisProgressEvent,
  IpcEventMap,
  Unsubscribe
} from '@shared/types/ipc-contract'
import type { RRuntimeInfo } from '@shared/types/runtime'

export function useIpcEvent<K extends IpcEventChannel>(
  channel: K,
  handler: (payload: IpcEventMap[K]) => void
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const bridge = window.deg
    if (!bridge) return undefined
    const dispatch = (payload: IpcEventMap[K]): void => handlerRef.current(payload)

    let unsubscribe: Unsubscribe = () => {}
    if (channel === IPC.event.analysisProgress) {
      unsubscribe = bridge.events.onAnalysisProgress(dispatch as (p: AnalysisProgressEvent) => void)
    } else if (channel === IPC.event.analysisLog) {
      unsubscribe = bridge.events.onAnalysisLog(dispatch as (p: AnalysisLogEvent) => void)
    } else if (channel === IPC.event.analysisDone) {
      unsubscribe = bridge.events.onAnalysisDone(dispatch as (p: AnalysisDoneEvent) => void)
    } else if (channel === IPC.event.runtimeChanged) {
      unsubscribe = bridge.events.onRuntimeChanged(dispatch as (p: RRuntimeInfo) => void)
    }
    return unsubscribe
  }, [channel])
}
