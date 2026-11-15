/**
 * 阈值判定 —— **全项目唯一实现**。
 *
 * 三处调用点（统计卡 / 结果表筛选 / 火山图着色）必须调用这里的函数，
 * 否则「火山图显著点数 == 表格行数」这条验收标准在数学上就不成立了。
 * 三个调用点都加了 `// SYNC: isSignificant 唯一实现` 注释，改动时请一起看。
 *
 * 边界语义（PRD R-15 / ARCHITECTURE §6.7，QA 会拿边界值验）：
 *   - logFC：`>=` 阈值（PRD 写「logFC ≥ 1.0」，含等号）
 *   - FDR  ：`<`  阈值（PRD 写「FDR < 0.05」，不含等号）
 *   - pValue 必须是有限值且 <1（过滤掉 R 里 NaN / 1 的退化行）
 * R 侧 export_volcano.R 用逐字相同的谓词着色，两边都有 SYNC 注释。
 */
import type { DEResultRow, PValueBasis, ThresholdState } from '@shared/types/analysis'

/** 三分类标签 */
export type RegulationClass = 'up' | 'down' | 'ns'

/** 当前判定依据（省略时按校正 p 值，与历史行为一致） */
export function basisOf(thresholds: ThresholdState): PValueBasis {
  return thresholds.basis ?? 'adjPValue'
}

/**
 * 取该行在「当前判定依据」下的 p 值。
 *
 * ★ 这一个函数是「图 / 表 / 统计卡口径一致」的关键：
 *   火山图的纵轴、显著性判定、结果表里显示的那一列，全都要读它。
 *   任何一处自己去 `row.pValue` 或 `row.adjPValue`，口径就会分叉 ——
 *   表现为「图上有 123 个点过了虚线，统计卡写 75 个」。
 */
export function basisPValue(row: DEResultRow, thresholds: ThresholdState): number {
  return basisOf(thresholds) === 'pValue' ? row.pValue : row.adjPValue
}

/** 该行在当前阈值下是否显著（唯一实现，见文件头注释） */
export function isSignificant(row: DEResultRow, thresholds: ThresholdState): boolean {
  const p = basisPValue(row, thresholds)
  return (
    // pValue 有限且 <1 是「这一行真的被检验过」的守卫，与用哪一列判定无关
    Number.isFinite(row.pValue) &&
    row.pValue < 1 &&
    Math.abs(row.logFC) >= thresholds.logFC &&
    Number.isFinite(p) &&
    p < thresholds.fdr
  )
}

/**
 * 三分类。
 * 注意 logFC 恰为 0 且阈值恰为 0 时会被判为 `down`（因为 `0 > 0` 为 false）——
 * 这是刻意的确定性行为：宁可把边界值归入 down，也不要出现「既不 up 也不 down 也不 ns」
 * 的第四种状态，否则三分类就不完备，统计卡与图例会对不上。
 */
export function classify(row: DEResultRow, thresholds: ThresholdState): RegulationClass {
  if (!isSignificant(row, thresholds)) return 'ns'
  return row.logFC > 0 ? 'up' : 'down'
}

/** 阈值统计（统计卡与图例共用） */
export interface ThresholdCounts {
  total: number
  up: number
  down: number
  ns: number
}

/** 按阈值计数（up + down + ns 恒等于 total） */
export function countByThreshold(rows: readonly DEResultRow[], thresholds: ThresholdState): ThresholdCounts {
  let up = 0
  let down = 0
  let ns = 0
  for (const row of rows) {
    const cls = classify(row, thresholds)
    if (cls === 'up') up += 1
    else if (cls === 'down') down += 1
    else ns += 1
  }
  return { total: rows.length, up, down, ns }
}

/** 按阈值筛选（onlySignificant=true 时只留 up/down） */
export function filterByThreshold(
  rows: readonly DEResultRow[],
  thresholds: ThresholdState,
  onlySignificant: boolean
): DEResultRow[] {
  if (!onlySignificant) return rows.slice()
  return rows.filter((row) => isSignificant(row, thresholds))
}

/** 阈值边界收敛（滑块/输入框可能给出越界值） */
export function clampThresholds(thresholds: ThresholdState): ThresholdState {
  return {
    logFC: Math.min(4, Math.max(0, thresholds.logFC)),
    fdr: Math.min(0.2, Math.max(0.0001, thresholds.fdr)),
    // basis 原样透传：收敛数值时把用户的判定依据悄悄改回默认，会让图突然变样
    ...(thresholds.basis ? { basis: thresholds.basis } : {})
  }
}
