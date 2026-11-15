/**
 * 首页三盏灯与「按方法判包」的单测。
 *
 * 这些断言锁的是**产品口径**，不是实现细节：
 *   - 缺 DESeq2 时灯是黄不是红（红只留给「R 不可用」）；
 *   - 文案必须说「R 可用，部分方法暂不可用」，不能让人以为整个软件废了；
 *   - 包缺失**不阻断**进入分析页（能不能跑由预检逐方法回答）；
 *   - 缺失包只在一处算（`missingPackagesFor`），别处读它。
 *
 * 之前这组行为是「缺任何核心包 → 红灯 + 阻断入口」，客户机器上只缺 DESeq2
 * 却被整体拦住 —— 这正是本文件要防的回归。
 */
import { describe, expect, it } from 'vitest'
import {
  blockingReason,
  corePackagesLight,
  corePackagesMessage,
  missingPackagesFor,
  partialAvailabilityReason,
  runtimeLight,
  unavailableMethods
} from '@shared/runtimeStatus'
import type { RPackageStatus, RRuntimeInfo } from '@shared/types/runtime'

function pkg(name: string, ok: boolean, required = true): RPackageStatus {
  return { name, version: ok ? '1.0.0' : null, ok, required }
}

/** 一台「R 正常、limma 齐全、只缺 DESeq2」的客户机器 */
function infoWith(overrides: Partial<RRuntimeInfo> = {}): RRuntimeInfo {
  const packages = [
    pkg('jsonlite', true),
    pkg('limma', true),
    pkg('edgeR', true),
    pkg('data.table', true),
    pkg('DESeq2', false)
  ]
  return {
    ok: false,
    source: 'custom',
    rscriptPath: 'D:/R-4.3.2/bin/x64/Rscript.exe',
    rHome: 'D:/R-4.3.2',
    version: '4.3.2',
    arch: 'x86_64',
    libPaths: ['D:/R-4.3.2/library'],
    packages,
    missingPackages: ['DESeq2'],
    missingSpeciesLibs: [],
    speciesLibs: { human: true, mouse: true },
    fontAvailable: true,
    probedAt: '2025-11-10T00:00:00.000Z',
    warnings: [],
    methods: [
      {
        id: 'limma-voom',
        label: 'limma-voom',
        requiredPackages: ['limma', 'edgeR', 'data.table'],
        missingPackages: [],
        available: true
      },
      {
        id: 'deseq2',
        label: 'DESeq2',
        requiredPackages: ['DESeq2', 'edgeR', 'data.table'],
        missingPackages: ['DESeq2'],
        available: false
      }
    ],
    ...overrides
  }
}

describe('missingPackagesFor —— 缺失包的唯一计算入口', () => {
  it('按方法声明的包逐项比对，与清单里的 missingPackages 一致', () => {
    const info = infoWith()
    expect(missingPackagesFor(info, ['limma', 'edgeR', 'data.table'])).toEqual([])
    expect(missingPackagesFor(info, ['DESeq2', 'edgeR'])).toEqual(['DESeq2'])
  })

  it('探测到 ok=false 但清单没标 required 的包，也算缺', () => {
    const info = infoWith({
      missingPackages: [],
      packages: [pkg('limma', true), pkg('apeglm', false, false)]
    })
    expect(missingPackagesFor(info, ['limma', 'apeglm'])).toEqual(['apeglm'])
  })

  it('清单里没有的包按「缺」处理（宁可预检拦下，也别起注定失败的 R 进程）', () => {
    const info = infoWith()
    expect(missingPackagesFor(info, ['someNewPkg'])).toEqual(['someNewPkg'])
  })

  it('探测结果为空（自检没跑起来）时不臆断缺包', () => {
    const info = infoWith({ packages: [], missingPackages: [] })
    expect(missingPackagesFor(info, ['limma'])).toEqual([])
  })

  it('空依赖列表返回空数组（富集类模块可能不声明 requiredPackages）', () => {
    expect(missingPackagesFor(infoWith(), [])).toEqual([])
  })
})

describe('核心分析包灯 —— 缺包是黄灯，不是红灯', () => {
  it('只缺 DESeq2 时给黄灯（红灯独占给「R 不可用」）', () => {
    const info = infoWith()
    expect(corePackagesLight(info)).toBe('yellow')
    // R 本身是好的：运行时灯仍是绿
    expect(runtimeLight(info)).toBe('green')
  })

  it('全部方法都齐时给绿灯', () => {
    const info = infoWith({
      ok: true,
      packages: [pkg('limma', true), pkg('edgeR', true), pkg('data.table', true), pkg('DESeq2', true)],
      missingPackages: [],
      methods: [
        {
          id: 'limma-voom',
          label: 'limma-voom',
          requiredPackages: ['limma', 'edgeR', 'data.table'],
          missingPackages: [],
          available: true
        },
        {
          id: 'deseq2',
          label: 'DESeq2',
          requiredPackages: ['DESeq2', 'edgeR', 'data.table'],
          missingPackages: [],
          available: true
        }
      ]
    })
    expect(corePackagesLight(info)).toBe('green')
    expect(unavailableMethods(info)).toEqual([])
  })

  it('没有 R 时给黄灯（此时「缺包」这个结论根本无从谈起）', () => {
    const info = infoWith({ rscriptPath: '', version: '', packages: [], missingPackages: [], methods: [] })
    expect(corePackagesLight(info)).toBe('yellow')
    expect(runtimeLight(info)).toBe('red')
  })
})

describe('核心分析包文案 —— 先说 R 可用，再说哪些方法不能用', () => {
  it('缺 DESeq2 的文案包含「R 可用，部分方法暂不可用（缺 DESeq2）」', () => {
    const message = corePackagesMessage(infoWith())
    expect(message).toContain('R 可用')
    expect(message).toContain('部分方法暂不可用')
    expect(message).toContain('缺 DESeq2')
    // 旧文案会说「差异分析会被阻断」——只做 limma 的用户会被这句话吓到
    expect(message).not.toContain('差异分析会被阻断')
  })

  it('补充说明逐方法给出「谁需要什么」，且声明其余方法不受影响', () => {
    const reason = partialAvailabilityReason(infoWith())
    expect(reason).not.toBeNull()
    expect(reason).toContain('DESeq2 需要 DESeq2')
    expect(reason).toContain('其余方法不受影响')
  })

  it('没有缺包方法时不给补充说明', () => {
    const info = infoWith({ ok: true, missingPackages: [], methods: [] })
    expect(partialAvailabilityReason(info)).toBeNull()
  })

  it('只缺富集类包（没有方法需要）时，说明它影响的是富集而不是差异分析', () => {
    const info = infoWith({ missingPackages: ['clusterProfiler'], methods: [] })
    const message = corePackagesMessage(info)
    expect(message).toContain('R 可用')
    expect(message).toContain('clusterProfiler')
    expect(message).toContain('富集')
  })
})

describe('blockingReason —— 包缺失不再阻断入口', () => {
  it('只缺包时放行（能不能跑由预检逐方法回答）', () => {
    expect(blockingReason(infoWith())).toBeNull()
  })

  it('没有 R 时仍然阻断', () => {
    const info = infoWith({ rscriptPath: '', packages: [], missingPackages: [], methods: [] })
    expect(blockingReason(info)).toContain('未检测到 R')
  })

  it('版本过低且不缺包时阻断，并给出实际版本', () => {
    const info = infoWith({
      ok: false,
      version: '4.1.3',
      packages: [pkg('limma', true)],
      missingPackages: [],
      methods: []
    })
    expect(blockingReason(info)).toContain('4.1.3')
    expect(blockingReason(info)).toContain('4.2.0')
  })
})
