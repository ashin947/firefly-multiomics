/**
 * 分析运行状态机：idle → running → success / failed / cancelled。
 *
 * 设计要点：
 *  1. 进度事件由主进程按 100ms 节流推送，这里只做「单调收敛 + 阶段推进」，
 *     不自己算百分比 —— 前端算的百分比永远会和 R 真实进度不一致。
 *  2. 日志环形缓冲上限 2000 行（与主进程 LIMITS.logRingBuffer 对齐），
 *     避免长跑任务把渲染进程内存吃掉。
 *  3. `cancelled` 不是失败：UI 只弹一条「已取消」，不显示错误横幅。
 */
import { create } from 'zustand'
import { DEFAULT_THRESHOLDS, METHOD_STAGES, STAGE_LABELS, type Stage } from '@shared/constants'
import type { AppError } from '@shared/errors'
import type { AnalysisPreflightResult, DEConfig, DEResultRow, DEStats } from '@shared/types/analysis'
import type { AnalysisLogEvent, AnalysisProgressEvent, AnalysisRunRequest } from '@shared/types/ipc-contract'
import type { AnalysisSnapshot } from '@shared/types/project'
import { call, normalizeError } from '../utils/ipc'
import { isMockMode } from './appStore'
import { usePlotDataStore } from './plotDataStore'
import { mockAnalysisSnapshot, mockDeConfig, mockDeRows, mockPreflight } from '../dev/mockData'

export type RunPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

const LOG_LIMIT = 2000

/** 演示模式的定时器句柄（模块级，避免把可变引用塞进 store state） */
let mockTimers: ReturnType<typeof setTimeout>[] = []

function clearMockTimers(): void {
  for (const timer of mockTimers) clearTimeout(timer)
  mockTimers = []
}

/**
 * 预检请求序号：只接受最新一次请求的响应。
 * 用户连点滑块会连续触发预检，早发后到的响应会把界面刷回旧结论。
 */
let preflightSeq = 0

interface AnalysisStoreState {
  phase: RunPhase
  runId: string | null
  stage: Stage
  pct: number
  /** 已完成的阶段（用于进度条点亮） */
  doneStages: Stage[]
  /**
   * 当前阶段的**细粒度说明**（R 在每条进度消息里带 `msg`，如「running voom」）。
   * 之前这里只保留了 pct，把 msg 丢了 —— 于是 1 秒跑完的任务界面上只剩一个数字，
   * 用户不知道正在干什么。现在原样透传给运行遮罩展示。
   */
  stageMessage: string | null
  logs: AnalysisLogEvent[]
  startedAt: number | null
  finishedAt: number | null
  error: AppError | null
  rows: DEResultRow[] | null
  stats: DEStats | null
  snapshot: AnalysisSnapshot | null
  loadingResult: boolean
  hoveredGene: string | null
  /** 配置草稿（分析配置页 ↔ 运行态共用） */
  draft: DEConfig
  /**
   * 运行前预检结果（**主进程产出**，这里只缓存）。
   * 前端不再自己算预检规则：规则只在 `AnalysisRunner.collect()` 里实现一次。
   */
  preflight: AnalysisPreflightResult | null
  preflightBusy: boolean
  /** 预检通道本身失败（IPC 不可用）—— 与「预检不通过」是两件事，界面提示也不同 */
  preflightError: AppError | null

  setDraft(patch: Partial<DEConfig>): void
  setMethod(method: DEConfig['method']): void
  setContrast(numerator: string, denominator: string): void
  swapContrast(): void
  requestPreflight(config: DEConfig): Promise<void>
  startRun(request: AnalysisRunRequest): Promise<boolean>
  cancelRun(): Promise<void>
  applyProgress(event: AnalysisProgressEvent): void
  appendLog(event: AnalysisLogEvent): void
  handleDone(payload: { status: 'success' | 'failed' | 'cancelled'; result?: unknown; error?: AppError }): Promise<void>
  loadResult(analysisId: string): Promise<void>
  /** 演示模式：直接载入一份假结果（结果页/截图用） */
  loadMockResult(): void
  setHoveredGene(geneId: string | null): void
  reset(): void
}

/** 从 done 事件里取 analysisId（result 是 unknown，必须窄化后再用） */
function extractAnalysisId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'analysisId' in result) {
    const value = (result as { analysisId?: unknown }).analysisId
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

export const useAnalysisStore = create<AnalysisStoreState>((set, get) => ({
  phase: 'idle',
  runId: null,
  stage: 'read',
  pct: 0,
  doneStages: [],
  stageMessage: null,
  logs: [],
  startedAt: null,
  finishedAt: null,
  error: null,
  rows: null,
  stats: null,
  snapshot: null,
  loadingResult: false,
  hoveredGene: null,
  draft: mockDeConfig(),
  preflight: null,
  preflightBusy: false,
  preflightError: null,

  /**
   * 请求预检（只读，不起 R 进程）。
   * 防抖由调用方（usePreflight）负责，这里只保证「并发时只认最新一次响应」。
   */
  async requestPreflight(config: DEConfig): Promise<void> {
    const seq = (preflightSeq += 1)

    // 演示模式没有真实项目，主进程预检会直接报「没有打开的项目」。
    // 这里用内置假预检，保证无 R 环境下仍能走查完整界面（仅 dev 可达）。
    if (isMockMode()) {
      set({ preflight: mockPreflight(config), preflightBusy: false, preflightError: null })
      return
    }

    set({ preflightBusy: true })
    try {
      const result = await call(window.deg.analysis.preflight({ method: config.method, config }))
      if (seq !== preflightSeq) return
      set({ preflight: result, preflightBusy: false, preflightError: null })
    } catch (err) {
      if (seq !== preflightSeq) return
      // 预检通道挂了不等于不能跑：保留上一次结论，界面提示「预检暂不可用」并放行
      set({ preflightBusy: false, preflightError: normalizeError(err) })
    }
  },

  setDraft(patch: Partial<DEConfig>): void {
    set({ draft: { ...get().draft, ...patch } })
  },

  setMethod(method: DEConfig['method']): void {
    set({ draft: { ...get().draft, method } })
  },

  setContrast(numerator: string, denominator: string): void {
    const draft = get().draft
    set({ draft: { ...draft, contrast: { ...draft.contrast, numerator, denominator } } })
  },

  swapContrast(): void {
    const draft = get().draft
    set({
      draft: {
        ...draft,
        contrast: {
          ...draft.contrast,
          numerator: draft.contrast.denominator,
          denominator: draft.contrast.numerator
        }
      }
    })
  },

  async startRun(request: AnalysisRunRequest): Promise<boolean> {
    clearMockTimers()
    set({
      phase: 'running',
      runId: null,
      stage: 'read',
      pct: 0,
      doneStages: [],
      stageMessage: null,
      logs: [],
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      rows: null,
      stats: null,
      snapshot: null
    })

    if (isMockMode()) {
      startMockSimulation(set)
      return true
    }

    try {
      const { runId } = await call(window.deg.analysis.run(request))
      set({ runId })
      return true
    } catch (err) {
      set({ phase: 'failed', error: normalizeError(err), finishedAt: Date.now() })
      return false
    }
  },

  async cancelRun(): Promise<void> {
    const { runId } = get()
    clearMockTimers()
    if (isMockMode()) {
      set({ phase: 'cancelled', finishedAt: Date.now() })
      return
    }
    if (!runId) {
      set({ phase: 'cancelled', finishedAt: Date.now() })
      return
    }
    try {
      await call(window.deg.analysis.cancel({ runId }))
    } catch {
      // 取消失败也要让 UI 回到可操作状态：主进程的 kill 兜底会保证进程最终消失
      set({ phase: 'cancelled', finishedAt: Date.now() })
    }
  },

  applyProgress(event: AnalysisProgressEvent): void {
    const state = get()
    // 迟到的事件可能来自上一次运行，必须按 runId 过滤
    if (state.runId && event.runId !== state.runId) return
    const pct = Math.max(state.pct, Math.min(100, event.pct))

    /**
     * 已完成阶段 = 当前阶段之前的**全部**阶段。
     *
     * ★ 为什么不能只靠「上一次 event.stage」推断（2025-11 实测踩到）：
     *   主进程对进度事件有节流（窗口内只补发最新一条，见 `RProcessRunner.handleProgress`），
     *   1–3 秒的任务会丢中间事件。于是界面出现过「正在标准化 / 已完成：读取数据」——
     *   低表达过滤那一格永远是灰的，用户会以为这一步被跳过了。
     *   阶段本身是**有序**的（METHOD_STAGES）：跑到第 N 个阶段，前 N-1 个必然已完成。
     *   按顺序推导天然抗丢包，也不依赖事件一条不漏。
     */
    const order = METHOD_STAGES[state.draft.method] ?? []
    const index = order.indexOf(event.stage)
    const previous = state.doneStages
    const doneStages =
      index > 0
        ? [...new Set([...previous, ...order.slice(0, index)])]
        : event.stage !== state.stage && !previous.includes(state.stage)
          ? [...previous, state.stage]
          : previous

    // msg 可能是空串（R 侧没给），此时沿用上一条 —— 阶段内多条消息里
    // 后一条往往更具体，但空串不该把已有说明清掉。
    const stageMessage = event.msg && event.msg.length > 0 ? event.msg : state.stageMessage
    set({ pct, stage: event.stage, doneStages, stageMessage })
  },

  appendLog(event: AnalysisLogEvent): void {
    const state = get()
    if (state.runId && event.runId !== state.runId) return
    const logs = state.logs.length >= LOG_LIMIT ? [...state.logs.slice(-LOG_LIMIT + 1), event] : [...state.logs, event]
    set({ logs })
  },

  async handleDone(payload: {
    status: 'success' | 'failed' | 'cancelled'
    result?: unknown
    error?: AppError
  }): Promise<void> {
    clearMockTimers()
    if (payload.status === 'cancelled') {
      set({ phase: 'cancelled', finishedAt: Date.now() })
      return
    }
    if (payload.status === 'failed') {
      set({
        phase: 'failed',
        error: payload.error ?? {
          code: 'E_R_GENERIC',
          title: '分析失败',
          message: 'R 运行失败，但没有返回可识别的错误信息。'
        },
        finishedAt: Date.now()
      })
      return
    }
    const analysisId = extractAnalysisId(payload.result)
    set({ phase: 'success', pct: 100, finishedAt: Date.now() })
    /*
     * ★ 分析成功拿到新结果时，清掉「外部导入的绘图数据」。
     *
     * 不清的后果：用户导入过一张别人的表、之后跑了真实分析，结果页仍然显示外部
     * 数据 —— 他刚看完「分析完成」的提示，看到的却是别人的表，还以为分析没生效。
     * 这是「不报错但界面在说谎」的典型，比崩溃更难察觉。
     *
     * 只在 **success** 时清：失败/取消时用户还可能想接着用外部表画图，
     * 这时把数据抹掉反而让他白导一次。
     */
    usePlotDataStore.getState().clearExternal()
    if (analysisId) await get().loadResult(analysisId)
  },

  async loadResult(analysisId: string): Promise<void> {
    set({ loadingResult: true, error: null })
    try {
      const loaded = await call(window.deg.analysis.loadResult({ analysisId }))
      set({
        rows: loaded.rows,
        stats: loaded.stats,
        snapshot: loaded.snapshot,
        loadingResult: false
      })
    } catch (err) {
      set({ error: normalizeError(err), loadingResult: false })
    }
  },

  loadMockResult(): void {
    const rows = mockDeRows()
    const snapshot = mockAnalysisSnapshot(rows)
    set({
      phase: 'success',
      rows,
      stats: snapshot.stats,
      snapshot,
      pct: 100,
      stage: 'write',
      startedAt: Date.now() - snapshot.durationMs,
      finishedAt: Date.now(),
      error: null,
      loadingResult: false
    })
  },

  setHoveredGene(geneId: string | null): void {
    set({ hoveredGene: geneId })
  },

  reset(): void {
    clearMockTimers()
    set({
      phase: 'idle',
      runId: null,
      stage: 'read',
      pct: 0,
      doneStages: [],
      stageMessage: null,
      logs: [],
      startedAt: null,
      finishedAt: null,
      error: null,
      rows: null,
      stats: null,
      snapshot: null,
      loadingResult: false,
      hoveredGene: null
    })
  }
}))

/**
 * 演示模式的假运行：按方法的真实阶段序列推进，并伪造几行像样的日志。
 * 只为让「运行态 UI」可验收，不参与任何真实计算。
 */
function startMockSimulation(set: (partial: Partial<AnalysisStoreState>) => void): void {
  const stages = METHOD_STAGES['limma-voom'] ?? ['read', 'filter', 'normalize', 'fit', 'test', 'write']
  const stagePcts: Record<string, number> = {
    read: 15,
    filter: 30,
    normalize: 48,
    dispersion: 65,
    fit: 78,
    test: 92,
    write: 100
  }
  // 演示模式的阶段说明：与真实 R 的 msg 同形（技术细节），让运行遮罩的两行文字都能验收
  const stageMessages: Record<string, string> = {
    read: 'reading expression matrix',
    filter: 'genes kept after low-expression filter',
    normalize: 'running voom (mean-variance modelling)',
    dispersion: 'estimating dispersion',
    fit: 'fitting weighted linear model',
    test: 'extracting moderated t-statistics',
    write: 'writing de.csv'
  }
  const runId = 'run-mock-0001'
  set({ runId })

  stages.forEach((stage, index) => {
    const timer = setTimeout(() => {
      const pct = stagePcts[stage] ?? Math.round(((index + 1) / stages.length) * 100)
      const logs: AnalysisLogEvent[] = [
        {
          runId,
          ts: Date.now(),
          level: 'info',
          line: `[${STAGE_LABELS[stage as Stage]}] 开始（演示数据）`
        }
      ]
      set({ stage: stage as Stage, pct, stageMessage: stageMessages[stage] ?? null })
      for (const log of logs) {
        useAnalysisStore.getState().appendLog(log)
      }
      if (index === stages.length - 1) {
        const rows = mockDeRows()
        const snapshot = mockAnalysisSnapshot(rows)
        set({
          phase: 'success',
          rows,
          stats: snapshot.stats,
          snapshot,
          finishedAt: Date.now()
        })
        useAnalysisStore.getState().appendLog({
          runId,
          ts: Date.now(),
          level: 'info',
          line: `分析完成：${rows.length} 个基因通过过滤（演示数据，未调用 R）`
        })
      }
    }, 420 * (index + 1))
    mockTimers.push(timer)
  })
}

/** 结果页展示用阈值（与快照默认值一致） */
export const RESULT_DEFAULT_THRESHOLDS = { ...DEFAULT_THRESHOLDS }
