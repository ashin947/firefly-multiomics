/**
 * DE 模块的可用性与 run_config 组装（4 个方法：voom / lm / deseq2 / edger）。
 *
 * 为什么单独成文件：`availability()` 是「方法卡亮不亮」的唯一真源，写错不会崩溃，
 * 只会让客户看到一张点不动的卡片（或一张点了报错的卡片）——两类都是投诉，
 * 而且都很难从日志里看出来。所以每个方法的判定条件都要有断言钉住。
 *
 * ★ 本次改动的核心是 limma-lm：它过去写死「只有 dataType==='normalized' 能用」，
 *   现在两个分支（log2 直接拟合 / counts 走 limma-trend）都能处理，所以 counts 下
 *   也必须可用。这条断言做过反向对照（把 availability 改回旧判定时它变红）。
 */
import { describe, expect, it } from 'vitest'
import type { DEConfig } from '@shared/types/analysis'
import type { DataType, Species } from '@shared/types/project'
import type { AvailabilityContext } from '../registry'
import { deseq2Module } from '../modules/deseq2'
import { edgerModule } from '../modules/edger'
import { limmaNormModule } from '../modules/limmaNorm'
import { limmaVoomModule } from '../modules/limmaVoom'

function ctx(patch: Partial<AvailabilityContext> = {}): AvailabilityContext {
  return {
    dataType: 'counts',
    species: 'human' as Species,
    groups: ['Tumor', 'Normal'],
    groupSizes: { Tumor: 3, Normal: 3 },
    geneCount: 2000,
    sampleCount: 6,
    runtimeOk: true,
    speciesLibReady: true,
    ...patch
  }
}

function dataTypeOf(value: DataType): Partial<AvailabilityContext> {
  return { dataType: value }
}

const BASE_CONFIG: DEConfig = {
  method: 'limma-voom',
  dataType: 'counts',
  contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
  filter: { enabled: true, mode: 'filterByExpr' },
  fdrMethod: 'BH',
  outputGeneName: true,
  keepAllGenes: false
}

const RUN_CTX = {
  runId: 'run-test-0001',
  projectRoot: 'C:/proj',
  runDir: 'C:/proj/results/de/run-test-0001',
  species: 'human' as Species,
  dataType: 'counts' as DataType,
  matrixPath: 'C:/proj/data/expression.clean.csv',
  groupsPath: 'C:/proj/data/groups.csv',
  sampleColumn: 'sample',
  groupColumn: 'group',
  geneIdType: 'SYMBOL',
  groups: { Tumor: ['S01', 'S02', 'S03'], Normal: ['S04', 'S05', 'S06'] },
  themePath: 'C:/res/plotTheme.json',
  fontPath: 'C:/res/font.otf'
}

/** 从 buildRunConfig 的返回值里取 params（结构见 deShared.ts） */
function paramsOf(config: DEConfig, module = limmaNormModule): Record<string, unknown> {
  const raw = module.buildRunConfig(config, RUN_CTX) as { params: Record<string, unknown> }
  return raw.params
}

describe('edgeR 模块 — 可用性', () => {
  it('counts + 两组各 ≥2 样本 → 可用', () => {
    expect(edgerModule.availability(ctx())).toEqual({ enabled: true })
  })

  it('已归一化数据 → 不可用，理由里点名 counts', () => {
    const result = edgerModule.availability(ctx(dataTypeOf('normalized')))
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('counts')
  })

  it('某组只有 1 个样本 → 不可用（QL 检验估不出组内离散度）', () => {
    const result = edgerModule.availability(ctx({ groupSizes: { Tumor: 1, Normal: 3 } }))
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('Tumor')
  })

  it('R 环境不可用 → 不可用', () => {
    expect(edgerModule.availability(ctx({ runtimeOk: false })).enabled).toBe(false)
  })

  it('声明了 requiresIntegerCounts（Runner 靠这个能力位触发整数性检查）', () => {
    expect(edgerModule.requiresIntegerCounts).toBe(true)
  })

  it('requiredPackages 含 limma（makeContrasts 来自 limma，漏了会报成「R 错误」）', () => {
    expect(edgerModule.requiredPackages).toContain('limma')
    expect(edgerModule.requiredPackages).toContain('edgeR')
  })
})

describe('limma-lm 模块 — 可用性（本次改动的核心）', () => {
  it('counts 数据 → 可用（旧行为是 false，现在走 limma-trend 分支）', () => {
    expect(limmaNormModule.availability(ctx(dataTypeOf('counts')))).toEqual({ enabled: true })
  })

  it('normalized 数据 → 可用（直接拟合 log2 值）', () => {
    expect(limmaNormModule.availability(ctx(dataTypeOf('normalized')))).toEqual({ enabled: true })
  })

  it('只有一个分组 → 不可用', () => {
    const result = limmaNormModule.availability(ctx({ groups: ['Tumor'], groupSizes: { Tumor: 6 } }))
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('2 个分组')
  })

  it('R 环境不可用 → 不可用', () => {
    expect(limmaNormModule.availability(ctx({ runtimeOk: false })).enabled).toBe(false)
  })
})

describe('limma-voom / DESeq2 — 可用性不受本次改动影响', () => {
  it('voom 仍然只吃 counts', () => {
    expect(limmaVoomModule.availability(ctx()).enabled).toBe(true)
    expect(limmaVoomModule.availability(ctx(dataTypeOf('normalized'))).enabled).toBe(false)
  })

  it('DESeq2 仍然只吃 counts，且要求每组 ≥2 样本', () => {
    expect(deseq2Module.availability(ctx()).enabled).toBe(true)
    expect(deseq2Module.availability(ctx(dataTypeOf('normalized'))).enabled).toBe(false)
    expect(deseq2Module.availability(ctx({ groupSizes: { Tumor: 1, Normal: 3 } })).enabled).toBe(false)
  })
})

describe('run_config 组装 — limma-lm 的两个分支参数', () => {
  it('inputIsLog2=false + priorCount=5 必须原样进 params', () => {
    const params = paramsOf({ ...BASE_CONFIG, method: 'limma-lm', inputIsLog2: false, priorCount: 5 })
    expect(params.inputIsLog2).toBe(false)
    expect(params.priorCount).toBe(5)
  })

  it('不传时默认 true / 2（与引入该字段前的行为一致）', () => {
    const params = paramsOf({ ...BASE_CONFIG, method: 'limma-lm' })
    expect(params.inputIsLog2).toBe(true)
    expect(params.priorCount).toBe(2)
  })

  it('其它方法不会被塞进 limma-lm 的参数（避免 run_config 出现无意义字段）', () => {
    const params = paramsOf(
      { ...BASE_CONFIG, method: 'limma-voom', inputIsLog2: false, priorCount: 5 },
      limmaVoomModule
    )
    expect(params.inputIsLog2).toBeUndefined()
    expect(params.priorCount).toBeUndefined()
  })
})

describe('run_config 组装 — edgeR 与 limma-voom 同构', () => {
  it('路径、对比、过滤、阈值字段与 voom 完全一致', () => {
    const voom = paramsOf({ ...BASE_CONFIG, method: 'limma-voom' }, limmaVoomModule)
    const edger = paramsOf({ ...BASE_CONFIG, method: 'edger' }, edgerModule)

    expect(edger.matrixPath).toBe(voom.matrixPath)
    expect(edger.groupsPath).toBe(voom.groupsPath)
    expect(edger.contrast).toEqual(voom.contrast)
    expect(edger.filter).toEqual(voom.filter)
    expect(edger.logFCThreshold).toBe(voom.logFCThreshold)
    expect(edger.fdrThreshold).toBe(voom.fdrThreshold)
    // edgeR 不需要任何额外参数：QL 检验没有「收缩」之类的开关
    expect(edger.shrinkLfc).toBeUndefined()
  })
})
