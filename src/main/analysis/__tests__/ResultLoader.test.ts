/**
 * ResultLoader 单测（T09/T10 完成标准）。
 *
 * 重点验证「坏行必须报错，而不是静默跳过」：
 * 静默跳过会让「结果表 5000 行」变成 4998 行而无人察觉，
 * 这种数据完整性问题在论文里是不可接受的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppError } from '@shared/errors'
import { DE_COLUMNS, ResultLoader, computeStats, isSignificant } from '../ResultLoader'
import { tempDir, writeFile } from '../../data/__tests__/fixtures'

const dirs: string[] = []
function newRunDir(): string {
  const dir = tempDir('deg-result-')
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function catchAppError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (err) {
    const candidate = (err as { appError?: AppError }).appError
    if (candidate) return candidate
    throw err
  }
  throw new Error('期望抛出异常，但没有抛出')
}

const HEADER = DE_COLUMNS.join(',')
const VALID_CSV = `${HEADER}
TP53,TP53,2.5,10.2,5.1,0.0001,0.001,3.2,up
EGFR,EGFR,-1.8,8.1,-3.2,0.01,0.04,1.1,down
MYC,MYC,0.2,7.0,0.5,0.6,0.7,0.1,ns
`

describe('ResultLoader — 正常加载', () => {
  it('读取 9 列并转成 DEResultRow（camelCase）', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', VALID_CSV)

    const payload = new ResultLoader().load(runDir)
    expect(payload.rows).toHaveLength(3)
    expect(payload.rows[0]).toEqual({
      geneId: 'TP53',
      geneName: 'TP53',
      logFC: 2.5,
      aveExpr: 10.2,
      t: 5.1,
      pValue: 0.0001,
      adjPValue: 0.001,
      b: 3.2,
      regulation: 'up'
    })
  })

  it('按阈值统计（与前端同一谓词：|logFC| >= 1 且 adjP < 0.05）', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', VALID_CSV)
    const payload = new ResultLoader().load(runDir, { filteredOutCount: 120 })
    expect(payload.stats).toEqual({
      totalGenesAfterFilter: 3,
      upCount: 1,
      downCount: 1,
      nsCount: 1,
      filteredOutCount: 120
    })
  })

  it('NA 的 pValue / adjPValue 允许存在（DESeq2 independent filtering），但不算显著', () => {
    const runDir = newRunDir()
    writeFile(
      runDir,
      'de.csv',
      `${HEADER}\nTP53,TP53,2.5,10.2,NA,NA,NA,,ns\n`
    )
    const payload = new ResultLoader().load(runDir)
    expect(payload.rows).toHaveLength(1)
    expect(Number.isNaN(payload.rows[0].pValue)).toBe(true)
    expect(payload.rows[0].b).toBeNull()
    expect(payload.stats.upCount).toBe(0)
    expect(payload.stats.nsCount).toBe(1)
  })

  it('gene_name 为 NA 时转成 null', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', `${HEADER}\nTP53,NA,2.5,10.2,5.1,0.001,0.01,NA,up\n`)
    const payload = new ResultLoader().load(runDir)
    expect(payload.rows[0].geneName).toBeNull()
    expect(payload.rows[0].b).toBeNull()
  })
})

describe('ResultLoader — 拒绝坏数据（E_RESULT_INVALID）', () => {
  it('文件不存在 → E_RESULT_INVALID', () => {
    const runDir = newRunDir()
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
    expect(error.message).toContain('de.csv')
  })

  it('列不符合约定（缺列/多列）→ E_RESULT_INVALID', () => {
    const runDir = newRunDir()
    writeFile(
      runDir,
      'de.csv',
      'gene_id,gene_name,logFC,aveExpr,t,pValue,adjPValue,regulation\nTP53,TP53,1,2,3,0.1,0.2,ns\n'
    )
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
    expect(error.message).toContain('b')
    expect(error.message).toContain('缺少')
  })

  it('logFC 是非数值 → 报错并指出行号', () => {
    const runDir = newRunDir()
    writeFile(
      runDir,
      'de.csv',
      `${HEADER}
TP53,TP53,2.5,10.2,5.1,0.001,0.01,1,up
EGFR,EGFR,abc,8.1,-3.2,0.01,0.04,1,down
`
    )
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
    // 表头 1 行 + 第 2 条数据 → 第 3 行
    expect(error.message).toContain('第 3 行')
    expect(error.message).toContain('logFC')
  })

  it('gene_id 为空 → 报错（不允许无名基因进入结果表）', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', `${HEADER}\n,TP53,2.5,10.2,5.1,0.001,0.01,1,up\n`)
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
    expect(error.message).toContain('gene_id')
  })

  it('regulation 取值非法 → 报错', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', `${HEADER}\nTP53,TP53,2.5,10.2,5.1,0.001,0.01,1,UP\n`)
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
    expect(error.message).toContain('regulation')
  })

  it('表头缺失（空文件）→ E_RESULT_INVALID', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', '')
    const error = catchAppError(() => new ResultLoader().load(runDir))
    expect(error.code).toBe('E_RESULT_INVALID')
  })
})

describe('ResultLoader — csv/json 一致性校验', () => {
  it('内容一致时 ok=true', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', VALID_CSV)
    const json = [
      { gene_id: 'TP53', logFC: 2.5 },
      { gene_id: 'EGFR', logFC: -1.8 },
      { gene_id: 'MYC', logFC: 0.2 }
    ]
    writeFile(runDir, 'de.json', JSON.stringify(json))
    const check = new ResultLoader().verifyJsonConsistency(runDir)
    expect(check).toEqual({ ok: true, csvRows: 3, jsonRows: 3 })
  })

  it('行数或数值不一致时 ok=false（防止有人只改了一处写盘逻辑）', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', VALID_CSV)
    writeFile(runDir, 'de.json', JSON.stringify([{ gene_id: 'TP53', logFC: 2.5 }]))
    const check = new ResultLoader().verifyJsonConsistency(runDir)
    expect(check.ok).toBe(false)
    expect(check.jsonRows).toBe(1)
  })

  it('de.json 缺失时 ok=false', () => {
    const runDir = newRunDir()
    writeFile(runDir, 'de.csv', VALID_CSV)
    expect(new ResultLoader().verifyJsonConsistency(runDir).ok).toBe(false)
  })
})

describe('ResultLoader — 阈值谓词（与前端同源）', () => {
  const row = {
    geneId: 'X',
    geneName: null,
    logFC: 1,
    aveExpr: 1,
    t: 1,
    pValue: 0.01,
    adjPValue: 0.04,
    b: null,
    regulation: 'up' as const
  }

  it('logFC 用 >=、FDR 用 <（PRD 原文：logFC ≥ 1.0、FDR < 0.05）', () => {
    expect(isSignificant(row, { logFC: 1, fdr: 0.05 })).toBe(true)
    // FDR 恰好等于阈值 → 不显著
    expect(isSignificant({ ...row, adjPValue: 0.05 }, { logFC: 1, fdr: 0.05 })).toBe(false)
    // logFC 恰好等于阈值 → 显著
    expect(isSignificant({ ...row, logFC: 1 }, { logFC: 1, fdr: 0.05 })).toBe(true)
  })

  it('pValue 非有限值（NA）一律不算显著', () => {
    expect(isSignificant({ ...row, pValue: Number.NaN }, { logFC: 1, fdr: 0.05 })).toBe(false)
    expect(isSignificant({ ...row, pValue: 1 }, { logFC: 1, fdr: 0.05 })).toBe(false)
  })

  it('computeStats 的 up/down/ns 之和等于总行数（火山图点数严格相等的数学基础）', () => {
    const rows = [
      { ...row, logFC: 2 },
      { ...row, logFC: -2, regulation: 'down' as const },
      { ...row, logFC: 0.1, regulation: 'ns' as const }
    ]
    const stats = computeStats(rows, { logFC: 1, fdr: 0.05 }, 7)
    expect(stats.upCount + stats.downCount + stats.nsCount).toBe(rows.length)
    expect(stats.upCount).toBe(1)
    expect(stats.downCount).toBe(1)
    expect(stats.filteredOutCount).toBe(7)
  })
})

describe('ResultLoader — 文件位置', () => {
  it('支持自定义文件名（富集结果复用同一 loader）', () => {
    const runDir = newRunDir()
    const file = path.join(runDir, 'custom.csv')
    fs.writeFileSync(file, VALID_CSV, 'utf8')
    const payload = new ResultLoader().load(runDir, { fileName: 'custom.csv' })
    expect(payload.rows).toHaveLength(3)
  })
})
