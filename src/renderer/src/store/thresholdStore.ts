/**
 * 阈值 store —— **必须独立**。
 *
 * 拖动滑块是高频更新（每秒几十次）。如果把它放进 analysisStore，
 * 每次 onChange 都会让订阅 analysisStore 的所有组件重渲染（结果表 5000 行、
 * 统计卡、图表全跟着重算），拖动会明显掉帧。
 * 独立成 store 后，只有真正读阈值的组件（StatCards / 表格 / 图表）重渲染。
 */
import { create } from 'zustand'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import type { PValueBasis, ThresholdState } from '@shared/types/analysis'
import { clampThresholds } from '../utils/threshold'

interface ThresholdStoreState {
  logFC: number
  fdr: number
  /**
   * 判显著用哪一列。火山图纵轴、表格高亮、统计卡全跟着它走 ——
   * 它一变，三处必须同时变，所以放在同一个 store 里，不能各组件自己记。
   */
  basis: PValueBasis
  setLogFC(value: number): void
  setFdr(value: number): void
  setBasis(value: PValueBasis): void
  reset(): void
  /** 从快照回填（打开历史结果时） */
  hydrate(next: { logFC: number; fdr: number; basis?: PValueBasis }): void
}

export const useThresholdStore = create<ThresholdStoreState>((set) => ({
  logFC: DEFAULT_THRESHOLDS.logFC,
  fdr: DEFAULT_THRESHOLDS.fdr,
  basis: 'adjPValue',

  setLogFC(value: number): void {
    const clamped = clampThresholds({ logFC: value, fdr: 0 })
    set({ logFC: clamped.logFC })
  },

  setFdr(value: number): void {
    const clamped = clampThresholds({ logFC: 0, fdr: value })
    set({ fdr: clamped.fdr })
  },

  setBasis(value: PValueBasis): void {
    set({ basis: value })
  },

  reset(): void {
    set({ logFC: DEFAULT_THRESHOLDS.logFC, fdr: DEFAULT_THRESHOLDS.fdr, basis: 'adjPValue' })
  },

  hydrate(next: ThresholdState): void {
    const clamped = clampThresholds(next)
    set({ logFC: clamped.logFC, fdr: clamped.fdr, basis: clamped.basis ?? 'adjPValue' })
  }
}))
