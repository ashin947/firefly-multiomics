/**
 * 阈值筛选 hook。
 *
 * 一次 loadResult 全量进内存，之后阈值变化纯前端重算（§6.7）：
 * 5000 行 × 4 次比较 ≈ 1–3ms，远优于 500ms 的目标，不需要 Worker。
 *
 * ★ 判定函数只有一处实现（`utils/threshold.ts` 的 isSignificant），
 *   本 hook 只是它的调用方。统计卡 / 表格 / 火山图必须都走同一条路径，
 *   否则「火山图显著点数 == 表格行数」不可能严格相等。
 */
import { useMemo } from 'react'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import { useThresholdStore } from '../store/thresholdStore'
import { countByThreshold, filterByThreshold, type ThresholdCounts } from '../utils/threshold'

// SYNC: isSignificant 唯一实现 —— 重新导出便于调用方统一从 hook 层取用
export { isSignificant, classify } from '../utils/threshold'

export interface ThresholdFilterResult {
  thresholds: ThresholdState
  counts: ThresholdCounts
  /** 当前阈值下显著的行（up + down，按原顺序） */
  significantRows: DEResultRow[]
}

export function useThresholdFilter(rows: readonly DEResultRow[] | null): ThresholdFilterResult {
  const logFC = useThresholdStore((s) => s.logFC)
  const fdr = useThresholdStore((s) => s.fdr)
  // ★ basis 必须一起读：漏了它会得到「统计卡按 FDR 算、火山图按 P 值画」的两套口径，
  //   而这正是客户报的那个 bug 的翻版（图与数字对不上）
  const basis = useThresholdStore((s) => s.basis)

  return useMemo(() => {
    const thresholds: ThresholdState = { logFC, fdr, basis }
    if (!rows || rows.length === 0) {
      return { thresholds, counts: { total: 0, up: 0, down: 0, ns: 0 }, significantRows: [] }
    }
    return {
      thresholds,
      counts: countByThreshold(rows, thresholds),
      significantRows: filterByThreshold(rows, thresholds, true)
    }
  }, [rows, logFC, fdr, basis])
}
