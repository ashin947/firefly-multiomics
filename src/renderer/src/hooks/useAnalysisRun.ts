/**
 * 分析运行 hook：把 3 个 IPC 事件接到 analysisStore 状态机上。
 *
 * 组件只关心 `phase / pct / logs / error`，不关心事件从哪来。
 * 取消不是失败：`cancel()` 之后 phase 变 cancelled，界面只提示「已取消」。
 */
import { IPC } from '@shared/ipc'
import type { AnalysisRunRequest } from '@shared/types/ipc-contract'
import { useAnalysisStore } from '../store/analysisStore'
import { useIpcEvent } from './useIpcEvent'

export interface AnalysisRunApi {
  phase: ReturnType<typeof useAnalysisStore.getState>['phase']
  runId: string | null
  stage: ReturnType<typeof useAnalysisStore.getState>['stage']
  pct: number
  doneStages: ReturnType<typeof useAnalysisStore.getState>['doneStages']
  /** 当前阶段的细粒度说明（R 的 progress.msg 原文） */
  stageMessage: string | null
  logs: ReturnType<typeof useAnalysisStore.getState>['logs']
  error: ReturnType<typeof useAnalysisStore.getState>['error']
  startedAt: number | null
  finishedAt: number | null
  rows: ReturnType<typeof useAnalysisStore.getState>['rows']
  stats: ReturnType<typeof useAnalysisStore.getState>['stats']
  snapshot: ReturnType<typeof useAnalysisStore.getState>['snapshot']
  loadingResult: boolean
  start(request: AnalysisRunRequest): Promise<boolean>
  cancel(): Promise<void>
  reset(): void
}

export function useAnalysisRun(): AnalysisRunApi {
  const store = useAnalysisStore()

  useIpcEvent(IPC.event.analysisProgress, (payload) => {
    useAnalysisStore.getState().applyProgress(payload)
  })

  useIpcEvent(IPC.event.analysisLog, (payload) => {
    useAnalysisStore.getState().appendLog(payload)
  })

  useIpcEvent(IPC.event.analysisDone, (payload) => {
    void useAnalysisStore.getState().handleDone(payload)
  })

  return {
    phase: store.phase,
    runId: store.runId,
    stage: store.stage,
    pct: store.pct,
    doneStages: store.doneStages,
    stageMessage: store.stageMessage,
    logs: store.logs,
    error: store.error,
    startedAt: store.startedAt,
    finishedAt: store.finishedAt,
    rows: store.rows,
    stats: store.stats,
    snapshot: store.snapshot,
    loadingResult: store.loadingResult,
    start: store.startRun,
    cancel: store.cancelRun,
    reset: store.reset
  }
}
