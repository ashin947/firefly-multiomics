/**
 * 导入向导状态（三步：矩阵 → 分组 → 校验）。
 *
 * 关键约束：`requiresChoice` 为 true 时**不允许进入下一步** ——
 * 重复基因名会让 R 的 rownames 报错，静默保留或静默合并都会毁掉数据正确性。
 */
import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type {
  DuplicateGeneChoice,
  DuplicateStrategy,
  DatasetSummary,
  GroupImportResult,
  ImportMatrixResult,
  Issue
} from '@shared/types/dataset'
import type { DataType } from '@shared/types/project'
import { call, normalizeError } from '../utils/ipc'
import { isMockMode } from './appStore'
import { mockGroupResult, mockMatrixResult } from '../dev/mockData'

export type WizardStep = 0 | 1 | 2

interface DatasetStoreState {
  matrix: ImportMatrixResult | null
  groups: GroupImportResult | null
  issues: Issue[]
  summary: DatasetSummary | null
  step: WizardStep
  dataType: DataType
  geneIdColumn: string
  requiresChoice: boolean
  duplicateChoice: DuplicateGeneChoice | null
  importing: boolean
  validating: boolean
  error: AppError | null

  setStep(step: WizardStep): void
  setDataType(dataType: DataType): void
  importMatrix(filePath: string): Promise<boolean>
  importGroups(filePath: string): Promise<boolean>
  setGeneIdColumn(column: string): Promise<boolean>
  aggregateDuplicates(strategy: DuplicateStrategy): Promise<boolean>
  validate(): Promise<boolean>
  /** 从已打开项目回填（重新进入向导时） */
  hydrateFromProject(summary: DatasetSummary | null): void
  reset(): void
  clearError(): void
}

export const useDatasetStore = create<DatasetStoreState>((set, get) => ({
  matrix: null,
  groups: null,
  issues: [],
  summary: null,
  step: 0,
  dataType: 'counts',
  geneIdColumn: 'gene_id',
  requiresChoice: false,
  duplicateChoice: null,
  importing: false,
  validating: false,
  error: null,

  setStep(step: WizardStep): void {
    set({ step })
  },

  setDataType(dataType: DataType): void {
    set({ dataType })
  },

  async importMatrix(filePath: string): Promise<boolean> {
    set({ importing: true, error: null })
    if (isMockMode()) {
      const result = mockMatrixResult()
      set({
        matrix: result,
        summary: result.summary,
        geneIdColumn: result.summary.geneIdColumn,
        dataType: 'counts',
        requiresChoice: result.requiresChoice,
        duplicateChoice: result.duplicateChoice ?? null,
        importing: false
      })
      return true
    }
    try {
      const result = await call(
        window.deg.data.importMatrix({
          filePath,
          dataType: get().dataType,
          species: 'human'
        })
      )
      set({
        matrix: result,
        summary: result.summary,
        geneIdColumn: result.summary.geneIdColumn,
        requiresChoice: result.requiresChoice,
        duplicateChoice: result.duplicateChoice ?? null,
        importing: false
      })
      return true
    } catch (err) {
      set({ error: normalizeError(err), importing: false })
      return false
    }
  },

  async importGroups(filePath: string): Promise<boolean> {
    set({ importing: true, error: null })
    if (isMockMode()) {
      const result = mockGroupResult()
      set({ groups: result, importing: false })
      return true
    }
    try {
      const result = await call(window.deg.data.importGroups({ filePath }))
      set({ groups: result, importing: false })
      return true
    } catch (err) {
      set({ error: normalizeError(err), importing: false })
      return false
    }
  },

  async setGeneIdColumn(column: string): Promise<boolean> {
    if (isMockMode()) {
      set({ geneIdColumn: column })
      return true
    }
    try {
      const result = await call(window.deg.data.setGeneIdColumn({ column }))
      set({
        matrix: result,
        summary: result.summary,
        geneIdColumn: result.summary.geneIdColumn,
        requiresChoice: result.requiresChoice,
        duplicateChoice: result.duplicateChoice ?? null
      })
      return true
    } catch (err) {
      set({ error: normalizeError(err) })
      return false
    }
  },

  async aggregateDuplicates(strategy: DuplicateStrategy): Promise<boolean> {
    if (isMockMode()) {
      const matrix = get().matrix
      if (matrix) {
        set({
          matrix: { ...matrix, requiresChoice: false },
          summary: matrix.summary ? { ...matrix.summary, duplicateStrategy: strategy } : null,
          requiresChoice: false
        })
      }
      return true
    }
    try {
      const result = await call(window.deg.data.aggregateDuplicates({ strategy }))
      set({
        matrix: result,
        summary: result.summary,
        requiresChoice: result.requiresChoice,
        duplicateChoice: result.duplicateChoice ?? null
      })
      return true
    } catch (err) {
      set({ error: normalizeError(err) })
      return false
    }
  },

  async validate(): Promise<boolean> {
    set({ validating: true, error: null })
    if (isMockMode()) {
      const summary = get().summary
      set({
        issues: summary?.issues ?? [],
        validating: false,
        step: 2
      })
      return true
    }
    try {
      const result = await call(window.deg.data.validate({ overrides: { dataType: get().dataType } }))
      set({ issues: result.issues, summary: result.summary, validating: false, step: 2 })
      return true
    } catch (err) {
      set({ error: normalizeError(err), validating: false })
      return false
    }
  },

  hydrateFromProject(summary: DatasetSummary | null): void {
    if (!summary) return
    set({
      summary,
      issues: summary.issues,
      dataType: summary.sampleCount > 0 ? get().dataType : 'counts',
      geneIdColumn: summary.geneIdColumn,
      requiresChoice: false
    })
  },

  reset(): void {
    set({
      matrix: null,
      groups: null,
      issues: [],
      summary: null,
      step: 0,
      requiresChoice: false,
      duplicateChoice: null,
      importing: false,
      validating: false,
      error: null
    })
  },

  clearError(): void {
    set({ error: null })
  }
}))

/** 是否存在阻断级问题（error 级 issue 会让「下一步」置灰） */
export function hasBlockingIssue(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}

/** 按级别计数（徽标显示） */
export function countIssues(issues: readonly Issue[]): { error: number; warning: number; info: number } {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warning: issues.filter((i) => i.level === 'warning').length,
    info: issues.filter((i) => i.level === 'info').length
  }
}
