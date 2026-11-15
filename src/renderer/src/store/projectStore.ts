/**
 * 项目状态：当前项目元数据、数据集摘要、全量表达数据、最近项目列表。
 *
 * 演示模式（AppInfo.mock）下所有读操作返回内置假数据，写操作只改内存 ——
 * 目的是让 UI 在「R 装不全、跑不了真实分析」的机器上仍可完整走查。
 */
import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type { DatasetSummary, ExpressionPayload } from '@shared/types/dataset'
import type {
  DemoVariant,
  OpenProjectResult,
  ProjectCreateRequest,
  ProjectMeta,
  RecentProject
} from '@shared/types/project'
import { call, normalizeError } from '../utils/ipc'
import { isMockMode } from './appStore'
import { resetProjectScopedState } from './projectScopedState'
import { useAppStore } from './appStore'
import {
  mockAnalysisSnapshot,
  mockDatasetSummary,
  mockDeRows,
  mockExpression,
  mockRecentProjects
} from '../dev/mockData'

interface ProjectStoreState {
  meta: ProjectMeta | null
  dataset: DatasetSummary | null
  expression: ExpressionPayload | null
  recent: RecentProject[]
  busy: boolean
  error: AppError | null
  loadRecent(): Promise<void>
  openProject(dir: string): Promise<boolean>
  /**
   * 启动时自动恢复上次打开的项目（失败**静默**，不打扰用户）。
   *
   * 为什么需要：主进程的 `ProjectStore` 是纯内存态，应用退出即丢失；
   * 而 `project.json` 里什么都没少。没有这一步，用户第二天打开软件点「转录组」
   * 就会看到红色横幅「当前没有打开的项目」——数据其实还在磁盘上。
   *
   * 复用 `project.recent()` + `project.open()` 两个已有通道，不新增 IPC。
   * 失败（项目被移动/删除/损坏）时**不设 error**：启动就弹错误比不恢复更糟，
   * 用户仍可从工作台手动打开。
   */
  restoreLast(): Promise<boolean>
  createProject(input: ProjectCreateRequest): Promise<boolean>
  /**
   * 载入内置示例项目。
   * `variant='stress'` 用 20000×48 的压力数据（实测 2.8 秒），默认是 2000×24（约 1.1 秒）。
   */
  loadDemo(variant?: DemoVariant): Promise<boolean>
  closeProject(): Promise<void>
  /** 分析完成后同步 project.json（主进程 save 返回完整 meta） */
  resync(): Promise<void>
  /** 演示模式：直接注入内置项目（让分析配置页/结果页在无 R 环境可走查） */
  hydrateMock(): void
  clearError(): void
}

/** 演示项目元数据（与 mockDatasetSummary 对应） */
function mockProjectMeta(): ProjectMeta {
  const now = new Date().toISOString()
  // 演示项目带一条**已完成**的分析记录，两个原因：
  //  ① 模块首页的「最近任务」有真实内容可看 —— 空表格最容易掩盖渲染 bug；
  //  ② 从「最近任务」点进结果页走的是真实 runId 路径（`/result/<id>`），
  //     不是为演示单独开的后门，因此这条链路也被走查到了。
  const snapshot = mockAnalysisSnapshot(mockDeRows(5000))
  return {
    schemaVersion: 1,
    projectId: 'mock-project-0001',
    name: '示例项目（demo）',
    species: 'human',
    createdAt: now,
    updatedAt: now,
    appVersion: '1.0.0',
    status: 'analyzed',
    dataType: 'counts',
    dataset: mockDatasetSummary(),
    analyses: [snapshot],
    activeAnalysisId: snapshot.id,
    enrichRuns: [],
    plots: {}
  }
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  meta: null,
  dataset: null,
  expression: null,
  recent: [],
  busy: false,
  error: null,

  async loadRecent(): Promise<void> {
    if (isMockMode()) {
      set({ recent: mockRecentProjects() })
      return
    }
    // appInfo 还没回来时不要发 IPC：此时无法判断是否演示模式，
    // 真实调用会返回空列表并**覆盖**随后注入的演示项目（竞态）
    if (!useAppStore.getState().info) return
    try {
      const recent = await call(window.deg.project.recent())
      set({ recent })
    } catch (err) {
      // 最近项目读不出来不该阻断启动（文件可能损坏），只记错误不弹窗
      set({ error: normalizeError(err) })
    }
  },

  async openProject(dir: string): Promise<boolean> {
    if (isMockMode()) {
      const meta = mockProjectMeta()
      resetProjectScopedState()
      set({ meta, dataset: meta.dataset ?? null, expression: mockExpression(), error: null })
      return true
    }
    set({ busy: true, error: null })
    try {
      const result: OpenProjectResult = await call(window.deg.project.open({ dir }))
      // 换项目先清空上一个项目的分析结果/阈值/外部导入表（详见 projectScopedState.ts）
      resetProjectScopedState()
      set({
        meta: result.meta,
        dataset: result.dataset ?? result.meta.dataset ?? null,
        expression: result.expression ?? null,
        busy: false
      })
      void get().loadRecent()
      return true
    } catch (err) {
      set({ error: normalizeError(err), busy: false })
      return false
    }
  },

  async restoreLast(): Promise<boolean> {
    if (isMockMode()) return false
    // 已经有项目了（演示注入 / 用户抢先打开了）就别覆盖
    if (get().meta) return false
    try {
      const recent = await call(window.deg.project.recent())
      const last = recent[0]
      // recent.list() 已在主进程剔除不存在的目录，这里不再二次校验
      if (!last) return false
      // 两次 await 之间用户可能已经手动打开了别的项目 —— 别把人家刚打开的项目盖掉
      if (get().meta) return false
      const result: OpenProjectResult = await call(window.deg.project.open({ dir: last.dir }))
      if (get().meta) return false
      set({
        meta: result.meta,
        dataset: result.dataset ?? result.meta.dataset ?? null,
        expression: result.expression ?? null
      })
      return true
    } catch {
      // 自动恢复失败不设 error：项目可能被移动或损坏，用户仍可从工作台手动打开
      return false
    }
  },

  async createProject(input: ProjectCreateRequest): Promise<boolean> {
    set({ busy: true, error: null })
    try {
      const meta = await call(window.deg.project.create(input))
      resetProjectScopedState()
      set({ meta, dataset: meta.dataset ?? null, expression: null, busy: false })
      void get().loadRecent()
      return true
    } catch (err) {
      set({ error: normalizeError(err), busy: false })
      return false
    }
  },

  async loadDemo(variant: DemoVariant = 'default'): Promise<boolean> {
    if (isMockMode()) {
      const meta = mockProjectMeta()
      resetProjectScopedState()
      set({ meta, dataset: meta.dataset ?? null, expression: mockExpression(), error: null })
      return true
    }
    set({ busy: true, error: null })
    try {
      // 示例项目落在用户数据目录下的 demo-projects（避免污染用户选择的位置）
      const parentDir = ''
      const meta = await call(window.deg.project.loadDemo({ parentDir, variant }))
      resetProjectScopedState()
      set({ meta, dataset: meta.dataset ?? null, busy: false })
      void get().loadRecent()
      return true
    } catch (err) {
      set({ error: normalizeError(err), busy: false })
      return false
    }
  },

  async closeProject(): Promise<void> {
    try {
      if (!isMockMode()) await call(window.deg.project.close())
    } catch (err) {
      set({ error: normalizeError(err) })
    }
    resetProjectScopedState()
    set({ meta: null, dataset: null, expression: null })
  },

  async resync(): Promise<void> {
    if (isMockMode()) return
    try {
      const meta = await call(window.deg.project.save({ patch: {} }))
      set({ meta, dataset: meta.dataset ?? get().dataset })
    } catch {
      // 同步失败不影响已展示的结果，下次打开项目会读到最新 project.json
    }
  },

  hydrateMock(): void {
    if (get().meta) return
    const meta = mockProjectMeta()
    set({ meta, dataset: meta.dataset ?? null, expression: mockExpression() })
  },

  clearError(): void {
    set({ error: null })
  }
}))
