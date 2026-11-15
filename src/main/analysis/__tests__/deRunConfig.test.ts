/**
 * `run_config.json` 里的阈值必须真的送到 R。
 *
 * 为什么单独测这一条：`de.csv` 的 `regulation` 列由 R 写出，而阈值是 Node 侧塞进
 * config 的。这中间只要有一处漏传，R 就会安静地退回默认值 —— 于是「用户把阈值调成
 * logFC ≥ 2 跑分析，导出的 CSV 却按 1.0 标 up/down」。
 * 这类问题在界面上完全看不出来（界面不读这一列），只有拿 CSV 去数才会发现，
 * 所以必须在**参数装配这一层**就锁住。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import type { DEConfig } from '@shared/types/analysis'
import type { RunContext } from '../registry'
import { buildDeRunConfig } from '../modules/deShared'

function makeConfig(patch: Partial<DEConfig> = {}): DEConfig {
  return {
    method: 'limma-voom',
    dataType: 'counts',
    contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
    filter: { enabled: true, mode: 'filterByExpr' },
    fdrMethod: 'BH',
    outputGeneName: true,
    keepAllGenes: false,
    ...patch
  }
}

const CTX: RunContext = {
  runId: 'run-20250101T000000-abcd',
  projectRoot: 'D:/proj',
  runDir: 'D:/proj/results/de/run-20250101T000000-abcd',
  species: 'human',
  dataType: 'counts',
  matrixPath: 'D:/proj/data/expression.clean.csv',
  groupsPath: 'D:/proj/data/groups.csv',
  sampleColumn: 'sample',
  groupColumn: 'group',
  geneIdType: 'SYMBOL',
  groups: { Tumor: ['s1'], Normal: ['s2'] },
  themePath: 'D:/app/resources/plotTheme.json',
  fontPath: 'D:/app/resources/runtime/fonts/NotoSansSC-Regular.otf'
}

interface RunConfigShape {
  params: Record<string, unknown>
}

describe('buildDeRunConfig · 阈值', () => {
  it('未指定阈值时落 PRD 默认值（1.0 / 0.05），行为与引入该字段前一致', () => {
    const config = buildDeRunConfig(makeConfig(), CTX) as RunConfigShape
    expect(config.params['logFCThreshold']).toBe(DEFAULT_THRESHOLDS.logFC)
    expect(config.params['fdrThreshold']).toBe(DEFAULT_THRESHOLDS.fdr)
  })

  it('指定阈值时原样传给 R（不取整、不夹到默认值）', () => {
    const config = buildDeRunConfig(
      makeConfig({ thresholds: { logFC: 2, fdr: 0.01 } }),
      CTX
    ) as RunConfigShape
    expect(config.params['logFCThreshold']).toBe(2)
    expect(config.params['fdrThreshold']).toBe(0.01)
  })

  it('阈值为 0 时不会被当成「未设置」而退回默认值', () => {
    // 0 是合法阈值（「只看 FDR，不卡倍数」），用 `||` 或真值判断就会踩这个坑
    const config = buildDeRunConfig(makeConfig({ thresholds: { logFC: 0, fdr: 0.05 } }), CTX) as RunConfigShape
    expect(config.params['logFCThreshold']).toBe(0)
  })

  it('extraParams 仍能追加（DESeq2 的 lfcShrink 等），且不会覆盖阈值', () => {
    const config = buildDeRunConfig(makeConfig(), CTX, { lfcShrink: 'apeglm' }) as RunConfigShape
    expect(config.params['lfcShrink']).toBe('apeglm')
    expect(config.params['logFCThreshold']).toBe(DEFAULT_THRESHOLDS.logFC)
  })

  it('路径与分组等既有参数没被这次改动碰掉', () => {
    const config = buildDeRunConfig(makeConfig(), CTX) as RunConfigShape
    expect(config.params['matrixPath']).toBe(CTX.matrixPath)
    expect(config.params['contrast']).toEqual({
      groupColumn: 'group',
      numerator: 'Tumor',
      denominator: 'Normal'
    })
  })
})
