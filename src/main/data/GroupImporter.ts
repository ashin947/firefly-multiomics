/**
 * 分组表导入器（ARCHITECTURE §9 T07 / PRD §8.2、R-05）。
 *
 * 约定：
 *  - 必需两列：样本列（默认识别 sample/Sample/样本）+ 分组列（group/Group/分组）；
 *  - 支持用户手工指定列名（前端下拉框传 sampleColumn/groupColumn）；
 *  - 样本名 `trim()` 后**严格匹配**（大小写敏感）——匹配与否由 DataValidator 判定，
 *    这里只负责解析，避免「解析层也做校验、校验层也做校验」两套逻辑打架。
 */
import fs from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import { PROJECT_FILES } from '@shared/constants'
import { toAppError } from '@shared/errors'
import type { GroupImportResult, Issue } from '@shared/types/dataset'
import { DataImportError } from './MatrixImporter'
import { FileSniffer } from './FileSniffer'

/** 样本列的默认识别名（按优先级） */
const SAMPLE_COLUMN_CANDIDATES = ['sample', 'Sample', 'SAMPLE', '样本', '样本名', 'samples', 'Samples']
/** 分组列的默认识别名 */
const GROUP_COLUMN_CANDIDATES = ['group', 'Group', 'GROUP', '分组', '分组名', 'condition', 'Condition']

export interface GroupImportOptions {
  filePath: string
  sampleColumn?: string
  groupColumn?: string
}

export class GroupImporter {
  private readonly sniffer = new FileSniffer()

  importGroups(options: GroupImportOptions): GroupImportResult {
    const sniff = this.sniffer.sniff(options.filePath)

    const rows: string[][] = []
    if (sniff.kind === 'excel') {
      for (const row of sniff.rows ?? []) rows.push(row)
    } else {
      Papa.parse<string[]>(sniff.text ?? '', {
        delimiter: sniff.delimiter,
        skipEmptyLines: 'greedy',
        header: false,
        step: (result) => {
          rows.push(Array.isArray(result.data) ? result.data.map((c) => String(c ?? '')) : [])
        }
      })
    }

    if (rows.length === 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', { message: '分组表是空的。' })
      )
    }

    const header = rows[0].map((c) => c.trim())
    const dataRows = sniff.hasHeader ? rows.slice(1) : rows
    if (!sniff.hasHeader) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '分组表第一行必须是表头（例如 sample,group）。',
          suggestion: '请检查文件是否缺少表头行。'
        })
      )
    }

    const sampleColumn = options.sampleColumn?.trim() || this.pickColumn(header, SAMPLE_COLUMN_CANDIDATES)
    const groupColumn = options.groupColumn?.trim() || this.pickColumn(header, GROUP_COLUMN_CANDIDATES)

    if (!sampleColumn || !groupColumn) {
      throw new DataImportError(
        toAppError('E_VALIDATION', {
          message:
            `分组表必须包含「样本列」和「分组列」，当前表头：${header.join('、')}。` +
            (sampleColumn ? '' : ' 未识别到样本列（可命名为 sample / 样本）。') +
            (groupColumn ? '' : ' 未识别到分组列（可命名为 group / 分组）。'),
          suggestion: '请手动指定哪一列是样本、哪一列是分组。'
        })
      )
    }

    const sampleIndex = header.indexOf(sampleColumn)
    const groupIndex = header.indexOf(groupColumn)
    if (sampleIndex < 0 || groupIndex < 0) {
      throw new DataImportError(
        toAppError('E_VALIDATION', {
          message: `指定的列在表头中不存在（样本列=${sampleColumn}，分组列=${groupColumn}）。`,
          suggestion: `可用列名：${header.join('、')}`
        })
      )
    }

    const groups: Record<string, string[]> = {}
    const seen = new Map<string, string>()
    const issues: Issue[] = []
    const duplicateRows: string[] = []
    const emptyGroupRows: number[] = []

    for (let i = 0; i < dataRows.length; i += 1) {
      const row = dataRows[i] ?? []
      const sample = (row[sampleIndex] ?? '').trim()
      const group = (row[groupIndex] ?? '').trim()
      if (!sample) continue
      if (!group) {
        emptyGroupRows.push(i + 2)
        continue
      }
      const previous = seen.get(sample)
      if (previous !== undefined) {
        // 同一样本出现多次：保留第一次，记 warning（不阻断，用户可能只是多写了一行）
        if (previous !== group) duplicateRows.push(`${sample}（${previous} / ${group}）`)
        continue
      }
      seen.set(sample, group)
      if (!groups[group]) groups[group] = []
      groups[group].push(sample)
    }

    if (Object.keys(groups).length === 0) {
      throw new DataImportError(
        toAppError('E_DATA_EMPTY', {
          message: '分组表里没有任何有效的「样本-分组」数据行。',
          suggestion: '请确认样本列与分组列选对了。'
        })
      )
    }

    if (duplicateRows.length > 0) {
      issues.push({
        code: 'E_DATA_DUP_SAMPLE',
        rule: 'dup-sample',
        level: 'warning',
        message: `分组表中有 ${duplicateRows.length} 个样本重复出现且分组不一致（${duplicateRows
          .slice(0, 10)
          .join('、')}），已保留第一次出现的分组`,
        suggestion: '请检查分组表是否有重复行。',
        count: duplicateRows.length
      })
    }
    if (emptyGroupRows.length > 0) {
      issues.push({
        code: 'E_VALIDATION',
        level: 'warning',
        message: `分组表第 ${emptyGroupRows.slice(0, 10).join('、')} 行的分组为空，已跳过`,
        count: emptyGroupRows.length
      })
    }

    return {
      groups,
      issues,
      preview: {
        columns: ['sample', 'group'],
        rows: dataRows
          .filter((row) => (row[sampleIndex] ?? '').trim().length > 0)
          .slice(0, 20)
          .map((row) => [(row[sampleIndex] ?? '').trim(), (row[groupIndex] ?? '').trim()])
      },
      sampleColumn,
      groupColumn
    }
  }

  /**
   * 把分组写成项目内的 `data/groups.csv`（UTF-8 无 BOM，sample,group 两列）。
   *
   * 为什么要落盘而不是只在内存里传：R 脚本需要读它，而且「重开项目后校验」
   * 也必须有真源。落盘后 validate 直接读文件，不依赖任何内存态。
   */
  writeNormalized(groups: Record<string, string[]>, projectRoot: string): string {
    const outPath = path.join(projectRoot, PROJECT_FILES.groups)
    const lines: string[] = ['sample,group']
    for (const [group, samples] of Object.entries(groups)) {
      for (const sample of samples) {
        const s = /[",\n\r]/.test(sample) ? `"${sample.replace(/"/g, '""')}"` : sample
        const g = /[",\n\r]/.test(group) ? `"${group.replace(/"/g, '""')}"` : group
        lines.push(`${s},${g}`)
      }
    }
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
    } catch (err) {
      throw new DataImportError(
        toAppError('E_IO_PERMISSION', {
          message: '写入 data/groups.csv 失败。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
    return outPath
  }

  /** 读项目内的 data/groups.csv（不存在返回 null） */
  readNormalized(projectRoot: string): Record<string, string[]> | null {
    const file = path.join(projectRoot, PROJECT_FILES.groups)
    if (!fs.existsSync(file)) return null
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = Papa.parse<{ sample?: string; group?: string }>(text, {
        header: true,
        skipEmptyLines: 'greedy'
      })
      const groups: Record<string, string[]> = {}
      for (const row of parsed.data) {
        const sample = String(row.sample ?? '').trim()
        const group = String(row.group ?? '').trim()
        if (!sample || !group) continue
        if (!groups[group]) groups[group] = []
        groups[group].push(sample)
      }
      return Object.keys(groups).length > 0 ? groups : null
    } catch {
      return null
    }
  }

  /** 在表头里找候选列（大小写敏感，先精确后忽略大小写） */
  private pickColumn(header: string[], candidates: string[]): string | null {
    for (const name of candidates) {
      if (header.includes(name)) return name
    }
    const lower = header.map((h) => h.toLowerCase())
    for (const name of candidates) {
      const idx = lower.indexOf(name.toLowerCase())
      if (idx >= 0) return header[idx]
    }
    return null
  }
}

/** 便于测试与诊断：暴露分组表是否可读（不做完整导入） */
export function isGroupsFileReadable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    return path.extname(filePath).toLowerCase() !== '.bin'
  } catch {
    return false
  }
}
