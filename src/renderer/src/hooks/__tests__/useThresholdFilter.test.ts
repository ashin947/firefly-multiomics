/**
 * @vitest-environment jsdom
 *
 * `useThresholdFilter` 必须跟着「显著性依据」一起变。
 *
 * ## 这条测试的来历
 *
 * 加了「P 值 / 校正 P 值」切换后，火山图和结果表都正确地跟着变了，
 * **但统计卡没变** —— 因为 hook 里只读了 `logFC` 和 `fdr`，构造的 thresholds
 * 没带 `basis`，`countByThreshold` 于是永远按 `adjPValue` 算。
 *
 * 表现出来就是客户最初报的那个问题的翻版：**图和数字对不上**。
 * 端到端验证抓到了它（切到 P 值后统计卡数字一动不动），这条单测把它钉死。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DEResultRow } from '@shared/types/analysis'
import { useThresholdStore } from '../../store/thresholdStore'
import { useThresholdFilter } from '../useThresholdFilter'

/** 一行「原始 P 显著、校正后不显著」的数据 */
function row(geneId: string, pValue: number, adjPValue: number): DEResultRow {
  return {
    geneId,
    geneName: null,
    logFC: 2,
    aveExpr: 5,
    t: 2,
    pValue,
    adjPValue,
    b: null,
    regulation: 'ns'
  }
}

const ROWS: DEResultRow[] = [
  row('A', 0.001, 0.2), // P 显著、FDR 不显著
  row('B', 0.0001, 0.001), // 两者都显著
  row('C', 0.5, 0.9) // 都不显著
]

beforeEach(() => {
  useThresholdStore.getState().reset()
})

describe('useThresholdFilter 跟随显著性依据', () => {
  it('默认（FDR）只把 B 算显著', () => {
    const { result } = renderHook(() => useThresholdFilter(ROWS))
    expect(result.current.thresholds.basis).toBe('adjPValue')
    expect(result.current.counts.up).toBe(1)
  })

  it('★ 切到原始 P 值后，A 也算显著（切之前 hook 漏读 basis，这里会红）', () => {
    const { result } = renderHook(() => useThresholdFilter(ROWS))
    expect(result.current.counts.up).toBe(1)

    act(() => {
      useThresholdStore.getState().setBasis('pValue')
    })

    expect(result.current.thresholds.basis).toBe('pValue')
    expect(result.current.counts.up).toBe(2)
  })

  it('thresholds 对象里带 basis，调用方拿到的就是当前口径', () => {
    const { result } = renderHook(() => useThresholdFilter(ROWS))
    act(() => {
      useThresholdStore.getState().setBasis('pValue')
    })
    expect(result.current.thresholds).toMatchObject({ basis: 'pValue' })
  })

  it('significantRows 与 counts 同源（改依据后两者一起变）', () => {
    const { result } = renderHook(() => useThresholdFilter(ROWS))
    act(() => {
      useThresholdStore.getState().setBasis('pValue')
    })
    expect(result.current.significantRows.map((r) => r.geneId)).toEqual(['A', 'B'])
    expect(result.current.counts.up).toBe(result.current.significantRows.length)
  })
})
