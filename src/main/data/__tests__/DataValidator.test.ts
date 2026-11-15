/**
 * DataValidator 单测：PRD §8.3 的 13 条规则**每条一个夹具**。
 *
 * 这个文件是「规则没漏」的唯一证据：
 *  - 每条规则断言 `rule` / `level` / 关键文案；
 *  - 最后一个用例把 13 条规则汇总，与 VALIDATION_RULES 对齐，
 *    任何一条被误删都会立刻失败。
 */
import { describe, expect, it } from 'vitest'
import type { Issue } from '@shared/types/dataset'
import { DataValidator, VALIDATION_RULES, hasBlockingIssue, intersectSamples } from '../DataValidator'
import { makeMatrix } from './fixtures'

const validator = new DataValidator()

/** 6 个样本 / 2 组 × 3 个：这是「干净」基线（每组 3 个才不会触发功效警告） */
const SAMPLES6 = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06']

function cleanSubject() {
  return {
    matrix: makeMatrix({
      geneIds: ['TP53', 'EGFR', 'MYC', 'BRCA1'],
      samples: SAMPLES6,
      values: [
        [100, 120, 90, 95, 105, 110],
        [50, 55, 48, 52, 51, 49],
        [200, 210, 190, 205, 198, 202],
        [10, 12, 9, 11, 10, 13]
      ]
    }),
    groups: {
      Tumor: ['S01', 'S02', 'S03'],
      Normal: ['S04', 'S05', 'S06']
    } as Record<string, string[]>,
    groupColumn: 'group',
    dataType: 'counts' as const
  }
}

/** 4 样本 / 2 组 × 2 个：专门用来触发「统计功效较低」警告 */
function twoPerGroupSubject() {
  return {
    matrix: makeMatrix({
      geneIds: ['TP53', 'EGFR'],
      samples: ['S01', 'S02', 'S03', 'S04'],
      values: [
        [100, 120, 90, 95],
        [50, 55, 48, 52]
      ]
    }),
    groups: { Tumor: ['S01', 'S02'], Normal: ['S03', 'S04'] },
    groupColumn: 'group',
    dataType: 'counts' as const
  }
}

/** 取某条规则的第一个 Issue */
function ruleIssue(issues: Issue[], rule: string): Issue | undefined {
  return issues.find((issue) => issue.rule === rule)
}

describe('DataValidator — 基线', () => {
  it('干净数据不产生任何 Issue', () => {
    const issues = validator.validate(cleanSubject())
    expect(issues).toEqual([])
    expect(hasBlockingIssue(issues)).toBe(false)
  })
})

describe('DataValidator — 13 条规则', () => {
  it('规则 1：样本名不匹配（双向差集，各最多 20 个 + 总数）', () => {
    const subject = {
      ...cleanSubject(),
      groups: { Tumor: ['S01', 'S02', 'S49'], Normal: ['S03', 'S04', 'S05'] }
    }
    const issues = validator.validate(subject)
    const issue = ruleIssue(issues, 'sample-mismatch')
    expect(issue).toBeDefined()
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_SAMPLE_MISMATCH')
    // 分组表有矩阵没有：S49；矩阵有分组表没有：S06
    expect(issue?.message).toContain('分组表中有 1 个样本在矩阵中找不到：S49')
    expect(issue?.message).toContain('矩阵中有 1 个样本未分组：S06')
    expect(issue?.count).toBe(2)
    expect(issue?.samples).toEqual(expect.arrayContaining(['S49', 'S06']))
  })

  it('规则 1 补充：差集很大时只列 20 个但给出总数', () => {
    const samples = Array.from({ length: 30 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)
    const values = samples.map(() => [1, 2])
    const subject = {
      matrix: makeMatrix({ geneIds: ['A', 'B'], samples, values }),
      groups: { Tumor: ['X1', 'X2'], Normal: ['X3', 'X4'] },
      dataType: 'counts' as const
    }
    const issue = ruleIssue(validator.validate(subject), 'sample-mismatch')
    expect(issue?.message).toContain('分组表中有 4 个样本在矩阵中找不到')
    expect(issue?.message).toContain('矩阵中有 30 个样本未分组')
    // samples 字段：每边最多 20 个 → 4 + 20
    expect(issue?.samples?.length).toBe(24)
  })

  it('规则 2：分组列只有 1 个取值 → error', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      groups: { Tumor: SAMPLES6 }
    })
    const issue = ruleIssue(issues, 'group-too-few')
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_GROUP_TOO_FEW')
    expect(issue?.message).toContain('只检测到 1 个取值（Tumor）')
    expect(issue?.message).toContain('至少需要 2 组')
  })

  it('规则 3：某组只有 1 个样本 → error', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      groups: { Tumor: ['S01', 'S02', 'S03'], Normal: ['S04'] }
    })
    const issue = ruleIssue(issues, 'group-too-small')
    expect(issue?.level).toBe('error')
    expect(issue?.message).toBe('组 `Normal` 只有 1 个样本，无法估计组内方差')
  })

  it('规则 4：某组只有 2 个样本 → warning（建议 ≥3）', () => {
    const issues = validator.validate(twoPerGroupSubject())
    const warnings = issues.filter((i) => i.rule === 'group-small-power')
    expect(warnings).toHaveLength(2)
    expect(warnings[0].level).toBe('warning')
    expect(warnings[0].message).toContain('只有 2 个样本，统计功效较低')
  })

  it('规则 5：重复基因名 → error（需要用户选择聚合方式）', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      matrix: makeMatrix({
        geneIds: ['TP53', 'TP53', 'EGFR', 'MYC'],
        samples: SAMPLES6,
        values: [
          [1, 2, 3, 4, 5, 6],
          [5, 6, 7, 8, 9, 10],
          [1, 1, 1, 1, 1, 1],
          [2, 2, 2, 2, 2, 2]
        ]
      })
    })
    const issue = ruleIssue(issues, 'dup-gene')
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_DUP_GENE')
    expect(issue?.message).toContain('1 个重复基因名')
    expect(issue?.samples?.[0]).toBe('TP53×2')
  })

  it('规则 6：重复样本名 → error', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      matrix: makeMatrix({
        geneIds: ['TP53', 'EGFR'],
        samples: ['S01', 'S01', 'S03', 'S04', 'S05', 'S06'],
        values: [
          [1, 2, 3, 4, 5, 6],
          [7, 8, 9, 10, 11, 12]
        ]
      })
    })
    const issue = ruleIssue(issues, 'dup-sample')
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_DUP_SAMPLE')
    expect(issue?.message).toContain('S01')
    expect(issue?.message).toContain('请检查表头')
  })

  it('规则 7：非数值单元格 → warning，且定位到具体行列', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      matrix: makeMatrix({
        geneIds: ['TP53', 'EGFR'],
        samples: SAMPLES6,
        values: [
          [1, 2, 3, Number.NaN, 5, 6],
          [7, 8, 9, 10, 11, 12]
        ],
        nonNumericCount: 1,
        nonNumericDetails: [{ row: 128, column: 'S03', raw: 'NA_1' }]
      })
    })
    const issue = ruleIssue(issues, 'non-numeric')
    expect(issue?.level).toBe('warning')
    expect(issue?.code).toBe('E_DATA_NON_NUMERIC')
    // PRD 原文要求的精度：「第 4 列 S03 第 128 行为 NA_1」
    expect(issue?.message).toContain('第 128 行 S03 列为「NA_1」')
    expect(issue?.locator).toEqual({ row: 128, column: 'S03' })
  })

  it('规则 8：counts 含小数 —— 选 DESeq2 是 error，选 limma 是 info', () => {
    const matrix = makeMatrix({
      geneIds: ['TP53', 'EGFR'],
      samples: SAMPLES6,
      values: [
        [12.4, 13.1, 12.9, 13.5, 12.2, 13.0],
        [5, 6, 7, 8, 9, 10]
      ]
    })
    const groups = { Tumor: ['S01', 'S02', 'S03'], Normal: ['S04', 'S05', 'S06'] }

    const deseq2Issues = validator.validate({ matrix, groups, dataType: 'counts', method: 'deseq2' })
    const deseq2Issue = ruleIssue(deseq2Issues, 'counts-not-integer')
    expect(deseq2Issue?.level).toBe('error')
    expect(deseq2Issue?.message).toContain('DESeq2 需要原始整数 counts')
    expect(deseq2Issue?.message).toContain('limma+voom')
    expect(hasBlockingIssue(deseq2Issues)).toBe(true)

    const limmaIssues = validator.validate({ matrix, groups, dataType: 'counts', method: 'limma-voom' })
    const limmaIssue = ruleIssue(limmaIssues, 'counts-not-integer')
    expect(limmaIssue?.level).toBe('info')
    expect(hasBlockingIssue(limmaIssues)).toBe(false)
  })

  it('规则 8 补充：负数 counts 同样按方法决定级别', () => {
    const matrix = makeMatrix({
      geneIds: ['A', 'B'],
      samples: ['S01', 'S02'],
      values: [
        [-1, 2],
        [3, 4]
      ]
    })
    const issue = ruleIssue(
      validator.validate({ matrix, groups: { T: ['S01'], N: ['S02'] }, dataType: 'counts', method: 'deseq2' }),
      'counts-not-integer'
    )
    expect(issue?.message).toContain('1 个负值')
  })

  it('规则 8 补充：已归一化数据不做整数性检查', () => {
    const matrix = makeMatrix({
      geneIds: ['A', 'B'],
      samples: ['S01', 'S02'],
      values: [
        [8.23, 7.91],
        [5.4, 5.6]
      ]
    })
    const issues = validator.validate({ matrix, groups: { T: ['S01'], N: ['S02'] }, dataType: 'normalized' })
    expect(ruleIssue(issues, 'counts-not-integer')).toBeUndefined()
  })

  it('规则 9：全零基因 → warning，并给出数量', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      matrix: makeMatrix({
        geneIds: ['TP53', 'ZERO1', 'EGFR', 'ZERO2'],
        samples: SAMPLES6,
        values: [
          [1, 2, 3, 4, 5, 6],
          [0, 0, 0, 0, 0, 0],
          [5, 6, 7, 8, 9, 10],
          [0, 0, 0, 0, 0, 0]
        ]
      })
    })
    const issue = ruleIssue(issues, 'all-zero-gene')
    expect(issue?.level).toBe('warning')
    expect(issue?.code).toBe('E_DATA_ALL_ZERO')
    expect(issue?.message).toContain('2 个基因在所有样本中为 0')
    expect(issue?.count).toBe(2)
  })

  it('规则 10：某基因 NA 比例 > 20% → warning', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      matrix: makeMatrix({
        geneIds: ['TP53', 'EGFR', 'MYC', 'BRCA1'],
        samples: SAMPLES6,
        values: [
          [Number.NaN, Number.NaN, Number.NaN, Number.NaN, 5, 6],
          [5, 6, 7, 8, 9, 10],
          [1, 1, 1, 1, 1, 1],
          [2, 2, 2, 2, 2, 2]
        ]
      })
    })
    const issue = ruleIssue(issues, 'na-ratio')
    expect(issue?.level).toBe('warning')
    expect(issue?.code).toBe('E_DATA_NA_RATIO')
    expect(issue?.message).toContain('TP53（67%）')
    expect(issue?.locator?.gene).toBe('TP53')
  })

  it('规则 11：编码无法识别 → error', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      source: { fileSizeBytes: 100, headerColumnCount: 7, dataRowCount: 4, encoding: 'unknown' }
    })
    const issue = ruleIssue(issues, 'encoding')
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_ENCODING')
    expect(issue?.message).toContain('请在 Excel 中另存为 UTF-8 CSV')
  })

  it('规则 12：矩阵为空 / 只有 1 列 → error', () => {
    const emptyMatrix = makeMatrix({ geneIds: [], samples: [], values: [] })
    const issues = validator.validate({ matrix: emptyMatrix, groups: null, dataType: 'counts' })
    const issue = ruleIssue(issues, 'empty-matrix')
    expect(issue?.level).toBe('error')
    expect(issue?.code).toBe('E_DATA_EMPTY')
    expect(issue?.message).toContain('请确认第一列为基因 ID')

    // 只有 1 列（表头列数 < 2）也要命中
    const oneColumn = validator.validate({
      ...cleanSubject(),
      source: { fileSizeBytes: 10, headerColumnCount: 1, dataRowCount: 4, encoding: 'utf-8' }
    })
    expect(ruleIssue(oneColumn, 'empty-matrix')).toBeDefined()
  })

  it('规则 13：内存风险 → warning（矩阵规模 vs 可用内存）', () => {
    const issues = validator.validate({
      ...cleanSubject(),
      // 100 字节可用内存 → 4×6 的矩阵必然触发
      availableMemoryBytes: 100
    })
    const issue = ruleIssue(issues, 'memory-risk')
    expect(issue?.level).toBe('warning')
    expect(issue?.code).toBe('E_DATA_MEMORY_RISK')
    expect(issue?.message).toContain('矩阵规模 4 × 6')
    expect(issue?.message).toContain('GB')
  })

  it('13 条规则全部被覆盖（防漏测）', () => {
    const subjects = [
      // 1 sample-mismatch
      { ...cleanSubject(), groups: { Tumor: ['S01', 'S02', 'S49'], Normal: ['S03', 'S04', 'S05'] } },
      // 2 group-too-few
      { ...cleanSubject(), groups: { Tumor: SAMPLES6 } },
      // 3 group-too-small
      { ...cleanSubject(), groups: { Tumor: ['S01', 'S02', 'S03'], Normal: ['S04'] } },
      // 4 group-small-power
      twoPerGroupSubject(),
      // 5 dup-gene
      {
        ...cleanSubject(),
        matrix: makeMatrix({
          geneIds: ['TP53', 'TP53'],
          samples: SAMPLES6,
          values: [
            [1, 2, 3, 4, 5, 6],
            [7, 8, 9, 10, 11, 12]
          ]
        })
      },
      // 6 dup-sample
      {
        ...cleanSubject(),
        matrix: makeMatrix({
          geneIds: ['A'],
          samples: ['S01', 'S01', 'S03', 'S04', 'S05', 'S06'],
          values: [[1, 2, 3, 4, 5, 6]]
        })
      },
      // 7 non-numeric
      {
        ...cleanSubject(),
        matrix: makeMatrix({
          geneIds: ['A'],
          samples: SAMPLES6,
          values: [[Number.NaN, 2, 3, 4, 5, 6]],
          nonNumericCount: 1,
          nonNumericDetails: [{ row: 2, column: 'S01', raw: 'x' }]
        })
      },
      // 8 counts-not-integer
      {
        matrix: makeMatrix({
          geneIds: ['A'],
          samples: ['S01', 'S02', 'S03', 'S04'],
          values: [[1.5, 2, 3, 4]]
        }),
        groups: { T: ['S01', 'S02'], N: ['S03', 'S04'] },
        dataType: 'counts' as const,
        method: 'deseq2' as const
      },
      // 9 all-zero-gene
      {
        ...cleanSubject(),
        matrix: makeMatrix({
          geneIds: ['A', 'B'],
          samples: ['S01', 'S02', 'S03', 'S04'],
          values: [
            [0, 0, 0, 0],
            [1, 2, 3, 4]
          ]
        }),
        groups: { T: ['S01', 'S02'], N: ['S03', 'S04'] }
      },
      // 10 na-ratio
      {
        ...cleanSubject(),
        matrix: makeMatrix({
          geneIds: ['A'],
          samples: ['S01', 'S02'],
          values: [[Number.NaN, Number.NaN]]
        }),
        groups: { T: ['S01'], N: ['S02'] }
      },
      // 11 encoding
      {
        ...cleanSubject(),
        source: { fileSizeBytes: 1, headerColumnCount: 7, dataRowCount: 4, encoding: 'unknown' as const }
      },
      // 12 empty-matrix
      {
        matrix: makeMatrix({ geneIds: [], samples: [], values: [] }),
        groups: null,
        dataType: 'counts' as const
      },
      // 13 memory-risk
      { ...cleanSubject(), availableMemoryBytes: 100 }
    ]

    const seen = new Set<string>()
    for (const subject of subjects) {
      for (const issue of validator.validate(subject as never)) {
        if (issue.rule) seen.add(issue.rule)
      }
    }
    expect([...seen].sort()).toEqual([...VALIDATION_RULES].sort())
    expect(VALIDATION_RULES).toHaveLength(13)
  })
})

describe('DataValidator — 辅助能力', () => {
  it('intersectSamples 自动取交集并返回被丢弃的样本', () => {
    const result = intersectSamples(
      { Tumor: ['S01', 'S02', 'S99'], Normal: ['S03', 'S98'] },
      ['S01', 'S02', 'S03', 'S04']
    )
    expect(result.groups).toEqual({ Tumor: ['S01', 'S02'], Normal: ['S03'] })
    expect(result.dropped.fromGroups.sort()).toEqual(['S98', 'S99'])
    expect(result.dropped.fromMatrix).toEqual(['S04'])
  })

  it('hasBlockingIssue 只认 error', () => {
    expect(hasBlockingIssue([{ code: 'X', level: 'warning', message: '' }])).toBe(false)
    expect(hasBlockingIssue([{ code: 'X', level: 'error', message: '' }])).toBe(true)
  })
})
