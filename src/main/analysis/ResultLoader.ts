/**
 * 结果加载器（ARCHITECTURE §9 T09 / PRD R-13）。
 *
 * 三件事：
 *  1. 读 R 产出的 `de.csv`（逗号分隔、9 列固定顺序）→ `DEResultRow[]`；
 *  2. **逐行 zod 校验**：坏行必须报明确错误码（E_RESULT_INVALID）并指出行号，
 *     绝不静默跳过 —— 静默跳过会让「结果表 5000 行」变成 4998 行而无人察觉；
 *  3. 统一 `aveExpr`（DESeq2 用 baseMean）、`b = null`、`regulation` 三态，
 *     让前端只面对一种形状的数据。
 *
 * 阈值统计（DEStats）在这里按 §6.7 的谓词计算，与前端 `useThresholdFilter`
 * 完全同源 —— 这是「火山图显著点数 == 结果表行数」严格相等的数学保证。
 */
import fs from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import { z } from 'zod'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import { toAppError, type AppError } from '@shared/errors'
import type { DEResultPayload, DEResultRow, DEStats, ThresholdState } from '@shared/types/analysis'

/** 携带结构化错误的结果加载异常 */
export class ResultLoadError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'ResultLoadError'
  }
}

/** 9 列固定顺序（PRD R-13） */
export const DE_COLUMNS = [
  'gene_id',
  'gene_name',
  'logFC',
  'aveExpr',
  't',
  'pValue',
  'adjPValue',
  'b',
  'regulation'
] as const

/** 允许 NaN：R 侧 pValue 为 NA 的行必须保留（前端过滤，而不是丢弃） */
const numOrNaN = z.union([z.number(), z.nan()])

const deRowSchema = z.object({
  gene_id: z.string().min(1),
  gene_name: z.string().nullable(),
  // logFC 必须是有限数：它是结果表的核心列，NaN 说明写盘环节出了问题。
  // pValue / adjPValue 允许 NaN —— DESeq2 的 independent filtering 会产生 NA padj，
  // 这些行必须保留（前端按阈值过滤），不能因为「有 NA」就整表加载失败。
  logFC: z.number(),
  aveExpr: numOrNaN,
  t: numOrNaN,
  pValue: numOrNaN,
  adjPValue: numOrNaN,
  b: z.number().nullable(),
  regulation: z.enum(['up', 'down', 'ns'])
})

export interface LoadOptions {
  /** 默认 'de.csv' */
  fileName?: string
  /** 统计用的阈值；默认 PRD 默认值（logFC ≥ 1.0，FDR < 0.05） */
  thresholds?: ThresholdState
  /** 过滤掉的基因数（来自 result.summary，用于 DEStats.filteredOutCount） */
  filteredOutCount?: number
}

export class ResultLoader {
  /** 读 de.csv → { rows, stats } */
  load(runDir: string, options: LoadOptions = {}): DEResultPayload {
    const fileName = options.fileName ?? 'de.csv'
    const file = path.join(runDir, fileName)

    if (!fs.existsSync(file)) {
      throw new ResultLoadError(
        toAppError('E_RESULT_INVALID', {
          message: `结果文件不存在：${fileName}`,
          suggestion: 'R 进程可能未正常写出结果，请重新运行分析。'
        })
      )
    }

    let text: string
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    } catch (err) {
      throw new ResultLoadError(
        toAppError('E_RESULT_INVALID', {
          message: `无法读取结果文件：${fileName}`,
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false
    })

    const fields = parsed.meta.fields ?? []
    if (fields.length === 0) {
      throw new ResultLoadError(
        toAppError('E_RESULT_INVALID', { message: `${fileName} 没有表头，文件可能为空或已损坏。` })
      )
    }

    const missing = DE_COLUMNS.filter((c) => !fields.includes(c))
    const extra = fields.filter((f) => !(DE_COLUMNS as readonly string[]).includes(f))
    if (missing.length > 0 || extra.length > 0) {
      throw new ResultLoadError(
        toAppError('E_RESULT_INVALID', {
          message:
            `${fileName} 的列不符合约定（应为 ${DE_COLUMNS.join(', ')}）。` +
            (missing.length ? ` 缺少：${missing.join('、')}。` : '') +
            (extra.length ? ` 多出：${extra.join('、')}。` : ''),
          suggestion: '结果文件可能被外部程序修改过，请重新运行分析。'
        })
      )
    }

    const rows: DEResultRow[] = []
    for (let i = 0; i < parsed.data.length; i += 1) {
      const raw = parsed.data[i]
      // 跳过完全空白的行（papaparse 的 skipEmptyLines 对只有逗号的行不生效）
      if (Object.values(raw).every((v) => v === undefined || v === null || String(v).trim() === '')) {
        continue
      }
      const candidate = {
        gene_id: String(raw.gene_id ?? '').trim(),
        gene_name: toNullableString(raw.gene_name),
        logFC: toNumber(raw.logFC),
        aveExpr: toNumber(raw.aveExpr),
        t: toNumber(raw.t),
        pValue: toNumber(raw.pValue),
        adjPValue: toNumber(raw.adjPValue),
        b: toNullableNumber(raw.b),
        regulation: String(raw.regulation ?? '').trim()
      }
      const checked = deRowSchema.safeParse(candidate)
      if (!checked.success) {
        const detail = checked.error.issues
          .map((issue) => `${issue.path.join('.') || '(行)'}：${issue.message}`)
          .join('；')
        throw new ResultLoadError(
          toAppError('E_RESULT_INVALID', {
            // 行号 = 表头 1 行 + 数据第 i 行
            message: `${fileName} 第 ${i + 2} 行格式不正确 —— ${detail}`,
            detail: JSON.stringify(raw)
          })
        )
      }
      const value = checked.data
      rows.push({
        geneId: value.gene_id,
        geneName: value.gene_name,
        logFC: value.logFC,
        aveExpr: value.aveExpr,
        t: value.t,
        pValue: value.pValue,
        adjPValue: value.adjPValue,
        b: value.b,
        regulation: value.regulation
      })
    }

    const thresholds = options.thresholds ?? { ...DEFAULT_THRESHOLDS }
    const stats = computeStats(rows, thresholds, options.filteredOutCount ?? 0)
    return { rows, stats }
  }

  /**
   * 校验 `de.csv` 与 `de.json` 内容一致（T10 完成标准之一）。
   * R 侧两个文件由同一份 data.frame 写出，理论上必然一致；
   * 这个方法是「防御性验收」：万一有人改了写盘逻辑，测试会立刻失败。
   */
  verifyJsonConsistency(runDir: string, fileName = 'de.csv'): { ok: boolean; csvRows: number; jsonRows: number } {
    const csv = this.load(runDir, { fileName })
    const jsonFile = path.join(runDir, fileName.replace(/\.csv$/i, '.json'))
    if (!fs.existsSync(jsonFile)) {
      return { ok: false, csvRows: csv.rows.length, jsonRows: 0 }
    }
    const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as unknown
    const list = Array.isArray(raw) ? raw : []
    const ok =
      list.length === csv.rows.length &&
      list.every((item, index) => {
        const row = item as Record<string, unknown>
        const expected = csv.rows[index]
        return (
          String(row.gene_id) === expected.geneId &&
          Math.abs(Number(row.logFC) - expected.logFC) < 1e-9
        )
      })
    return { ok, csvRows: csv.rows.length, jsonRows: list.length }
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

/**
 * 阈值统计。谓词与前端 `useThresholdFilter` 严格一致（§6.7）：
 *   pValue 有限且 < 1 且 |logFC| >= t.logFC 且 adjPValue < t.fdr
 * 注意 logFC 用 `>=`、FDR 用 `<` —— 与 PRD「logFC ≥ 1.0」「FDR < 0.05」逐字对应。
 */
export function computeStats(
  rows: DEResultRow[],
  thresholds: ThresholdState,
  filteredOutCount = 0
): DEStats {
  let up = 0
  let down = 0
  for (const row of rows) {
    if (!isSignificant(row, thresholds)) continue
    if (row.logFC > 0) up += 1
    else down += 1
  }
  return {
    totalGenesAfterFilter: rows.length,
    upCount: up,
    downCount: down,
    nsCount: rows.length - up - down,
    filteredOutCount
  }
}

/** 单行是否显著（与前端同源，见 §6.7 的实现片段） */
export function isSignificant(row: DEResultRow, thresholds: ThresholdState): boolean {
  return (
    Number.isFinite(row.pValue) &&
    row.pValue < 1 &&
    Math.abs(row.logFC) >= thresholds.logFC &&
    row.adjPValue < thresholds.fdr
  )
}

/** 'NA' / '' → null；其余去空白 */
function toNullableString(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (text === '' || text.toUpperCase() === 'NA') return null
  return text
}

/** 'NA' / '' / 'NaN' → NaN（保留行，前端过滤） */
function toNumber(value: unknown): number {
  const text = String(value ?? '').trim()
  if (text === '' || text.toUpperCase() === 'NA' || text === 'NaN' || text === 'null') return Number.NaN
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** 'NA' / '' → null（b 列在 DESeq2 下无值） */
function toNullableNumber(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (text === '' || text.toUpperCase() === 'NA' || text === 'NaN' || text === 'null') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}
