import { describe, expect, it } from 'vitest'
import type { DEResultRow } from '@shared/types/analysis'
import {
  clampThresholds,
  classify,
  countByThreshold,
  filterByThreshold,
  isSignificant
} from '../threshold'

function row(partial: Partial<DEResultRow>): DEResultRow {
  return {
    geneId: 'G1',
    geneName: 'G1',
    logFC: 0,
    aveExpr: 5,
    t: 0,
    pValue: 0.5,
    adjPValue: 0.5,
    b: null,
    regulation: 'ns',
    ...partial
  }
}

const T = { logFC: 1, fdr: 0.05 }

describe('isSignificant 边界语义（PRD R-15）', () => {
  it('logFC 恰好等于阈值时算显著（>= 含等号）', () => {
    expect(isSignificant(row({ logFC: 1, pValue: 0.01, adjPValue: 0.01 }), T)).toBe(true)
    expect(isSignificant(row({ logFC: -1, pValue: 0.01, adjPValue: 0.01 }), T)).toBe(true)
  })

  it('logFC 略小于阈值时不算显著', () => {
    expect(isSignificant(row({ logFC: 0.999, pValue: 0.01, adjPValue: 0.01 }), T)).toBe(false)
    expect(isSignificant(row({ logFC: -0.999, pValue: 0.01, adjPValue: 0.01 }), T)).toBe(false)
  })

  it('FDR 恰好等于阈值时不算显著（< 不含等号）', () => {
    expect(isSignificant(row({ logFC: 2, pValue: 0.01, adjPValue: 0.05 }), T)).toBe(false)
    expect(isSignificant(row({ logFC: 2, pValue: 0.01, adjPValue: 0.0499 }), T)).toBe(true)
  })

  it('pValue 为 NaN / 1 时不显著（R 的退化行必须被排除）', () => {
    expect(isSignificant(row({ logFC: 3, pValue: Number.NaN, adjPValue: 0.001 }), T)).toBe(false)
    expect(isSignificant(row({ logFC: 3, pValue: 1, adjPValue: 0.001 }), T)).toBe(false)
  })

  it('阈值放宽到 0 时，logFC=0 且 FDR 达标也算显著（确定性归类）', () => {
    expect(isSignificant(row({ logFC: 0, pValue: 0.01, adjPValue: 0.01 }), { logFC: 0, fdr: 0.05 })).toBe(true)
  })
})

describe('classify 三分类互斥且完备', () => {
  it('上调 / 下调 / 不显著三者互斥，且覆盖全部行', () => {
    const rows = [
      row({ geneId: 'A', logFC: 2, pValue: 0.01, adjPValue: 0.01 }),
      row({ geneId: 'B', logFC: -2, pValue: 0.01, adjPValue: 0.01 }),
      row({ geneId: 'C', logFC: 2, pValue: 0.01, adjPValue: 0.5 }),
      row({ geneId: 'D', logFC: 0.2, pValue: 0.01, adjPValue: 0.01 })
    ]
    const classes = rows.map((r) => classify(r, T))
    expect(classes).toEqual(['up', 'down', 'ns', 'ns'])

    const counts = countByThreshold(rows, T)
    expect(counts.up + counts.down + counts.ns).toBe(rows.length)
    expect(counts.total).toBe(rows.length)
  })

  it('logFC=0 且阈值=0 时归为 down（不产生第四种状态）', () => {
    expect(classify(row({ logFC: 0, pValue: 0.01, adjPValue: 0.01 }), { logFC: 0, fdr: 0.05 })).toBe('down')
  })

  it('空输入返回全 0', () => {
    expect(countByThreshold([], T)).toEqual({ total: 0, up: 0, down: 0, ns: 0 })
  })
})

describe('filterByThreshold', () => {
  const rows = [
    row({ geneId: 'A', logFC: 2, pValue: 0.01, adjPValue: 0.01 }),
    row({ geneId: 'B', logFC: -2, pValue: 0.01, adjPValue: 0.01 }),
    row({ geneId: 'C', logFC: 0.1, pValue: 0.01, adjPValue: 0.01 })
  ]

  it('onlySignificant=true 只保留 up/down', () => {
    expect(filterByThreshold(rows, T, true).map((r) => r.geneId)).toEqual(['A', 'B'])
  })

  it('onlySignificant=false 原样返回（不共享引用）', () => {
    const result = filterByThreshold(rows, T, false)
    expect(result).toHaveLength(3)
    expect(result).not.toBe(rows)
  })
})

describe('clampThresholds', () => {
  it('把越界值收敛到合法区间', () => {
    expect(clampThresholds({ logFC: -1, fdr: 0 })).toEqual({ logFC: 0, fdr: 0.0001 })
    expect(clampThresholds({ logFC: 9, fdr: 9 })).toEqual({ logFC: 4, fdr: 0.2 })
  })
})
