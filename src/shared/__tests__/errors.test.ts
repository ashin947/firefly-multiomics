import { describe, expect, it } from 'vitest'
import {
  ERROR_META,
  ERROR_RULES,
  EXIT_CODE_ERROR,
  isDataError,
  isErrorCode,
  isRuntimeError,
  matchErrorRule,
  toAppError,
  truncateDetail
} from '../errors'

describe('ERROR_RULES —— 每条规则都有独立用例', () => {
  const cases: { code: string; stderr: string }[] = [
    {
      code: 'E_RT_PKG_MISSING',
      stderr: `Error in library(DESeq2) : there is no package called 'DESeq2'`
    },
    {
      code: 'E_R_MEMORY',
      stderr: 'Error: cannot allocate vector of size 2.4 Gb'
    },
    {
      code: 'E_DATA_NOT_INTEGER',
      stderr: 'Error in DESeqDataSetFromMatrix(...) : counts must be integers'
    },
    {
      code: 'E_DATA_SAMPLE_MISMATCH',
      stderr: 'Error: sample names mismatch between matrix columns and groups table'
    },
    {
      code: 'E_R_GENEID_MAP',
      stderr: `Error in .testForValidKeys(x, keys, keytype) : None of the keys entered are valid keys for 'SYMBOL'`
    },
    {
      code: 'E_KEGG_NETWORK',
      stderr: `Error in download.file(...) : cannot open URL 'https://rest.kegg.jp/link/pathway/hsa'`
    },
    {
      code: 'E_IO_PERMISSION',
      stderr: 'Error in file(file, "w") : cannot open the connection'
    },
    {
      code: 'E_RT_FONT_MISSING',
      stderr: 'Error in grid.Call(L_textBounds, ...) : font family not found in Windows font database'
    },
    {
      code: 'E_DATA_NON_NUMERIC',
      stderr: 'Error in log(x) : non-numeric argument to mathematical function'
    },
    {
      code: 'E_R_GENERIC',
      stderr: 'Error: something completely unexpected happened'
    }
  ]

  for (const testCase of cases) {
    it(`命中 ${testCase.code}`, () => {
      const rule = matchErrorRule(testCase.stderr)
      expect(rule).not.toBeNull()
      expect(rule?.code).toBe(testCase.code)
    })
  }

  it('规则表共 10 条且每条都有中文 title', () => {
    expect(ERROR_RULES).toHaveLength(10)
    for (const rule of ERROR_RULES) {
      expect(rule.title.length).toBeGreaterThan(0)
      // 禁止 g 标志：带 lastIndex 状态会让 test() 结果不稳定
      expect(rule.pattern.global).toBe(false)
      expect(rule.pattern.flags).toContain('i')
    }
  })

  it('优先级：缺包规则先于内存规则', () => {
    const stderr = `there is no package called 'limma'\ncannot allocate vector of size 1 Gb`
    expect(matchErrorRule(stderr)?.code).toBe('E_RT_PKG_MISSING')
  })

  it('空 stderr 返回 null（交由退出码判断）', () => {
    expect(matchErrorRule('')).toBeNull()
    expect(matchErrorRule('   \n  ')).toBeNull()
  })
})

describe('toAppError', () => {
  it('从 ERROR_META 补齐中文标题与建议', () => {
    const err = toAppError('E_DATA_NOT_INTEGER')
    expect(err.code).toBe('E_DATA_NOT_INTEGER')
    expect(err.title).toBe(ERROR_META.E_DATA_NOT_INTEGER.title)
    expect(err.suggestion).toBe(ERROR_META.E_DATA_NOT_INTEGER.suggestion)
  })

  it('overrides 可覆盖标题与说明', () => {
    const err = toAppError('E_R_GENERIC', {
      title: '任务超时',
      message: 'R 计算超过预定时间',
      detail: 'x'.repeat(30_000)
    })
    expect(err.title).toBe('任务超时')
    expect(err.message).toBe('R 计算超过预定时间')
    // detail 必须被截断到 20k
    expect((err.detail ?? '').length).toBeLessThan(21_000)
    expect(err.detail).toContain('已截断')
  })

  it('未提供 message 时回落到 title（保证 UI 永远有话可说）', () => {
    const err = toAppError('E_CANCELLED')
    expect(err.message.length).toBeGreaterThan(0)
  })

  it('E_CANCELLED 不带 suggestion（它不是错误）', () => {
    expect(toAppError('E_CANCELLED').suggestion).toBeUndefined()
  })
})

describe('错误码分类与工具函数', () => {
  it('isRuntimeError / isDataError 前缀判断', () => {
    expect(isRuntimeError('E_RT_MISSING')).toBe(true)
    expect(isRuntimeError('E_DATA_EMPTY')).toBe(false)
    expect(isDataError('E_DATA_DUP_GENE')).toBe(true)
    expect(isDataError('E_R_MEMORY')).toBe(false)
  })

  it('isErrorCode 只认 ERROR_META 里的键', () => {
    expect(isErrorCode('E_R_GENERIC')).toBe(true)
    expect(isErrorCode('E_NOT_A_REAL_CODE')).toBe(false)
    expect(isErrorCode(null)).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })

  it('truncateDetail 保留头部并标注总长度', () => {
    expect(truncateDetail('short')).toBe('short')
    expect(truncateDetail('', 10)).toBe('')
    const long = truncateDetail('a'.repeat(100), 20)
    expect(long.startsWith('a'.repeat(20))).toBe(true)
    expect(long).toContain('共 100 字符')
  })

  it('EXIT_CODE_ERROR 覆盖 §5.5 约定的退出码', () => {
    expect(EXIT_CODE_ERROR[10]).toBe('E_R_GENERIC')
    expect(EXIT_CODE_ERROR[11]).toBe('E_VALIDATION')
    expect(EXIT_CODE_ERROR[12]).toBe('E_RT_PKG_MISSING')
    expect(EXIT_CODE_ERROR[14]).toBe('E_IO_PERMISSION')
  })
})
