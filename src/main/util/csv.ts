/**
 * CSV → 内存 / CSV → XLSX 的公共工具。
 *
 * 这些函数原本是 `EnrichService` 私有的。WGCNA 的「导出结果表」需要**完全相同**的
 * 语义（csv 直拷、xlsx 由 exceljs 生成、行数分块统计），如果复制一份，两个模块的
 * 转义规则、数值列处理迟早会分叉 —— 用户会看到「富集导出的 P 值是数字、WGCNA
 * 导出的却是文本」这种无来由的差异。抽到这里，两边共用同一份实现。
 */
import fs from 'node:fs'
import { toAppError } from '@shared/errors'

/**
 * 极简 CSV 解析（带引号、双引号转义），够读我们自己产出的表。
 *
 * 不引第三方 CSV 库：R 的 `data.table::fwrite` 只产出 RFC4180 的最小子集，
 * 几百行手写解析比多一个依赖更容易审计。
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return []
  const header = rows[0]
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

/**
 * 分块数一个 CSV 的**数据行**数（不含表头），不整读文件。
 *
 * 结果表动辄几万行、几十 MB，只为在 UI 上显示「共 N 行」就整读一遍纯属浪费；
 * 按 1 MB 一块流式扫 `\n` 即可。末行没有换行符时也要算一行。
 */
export function countCsvDataRows(file: string): number {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let newlines = 0
    let bytes = 0
    let lastByte = 0
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      bytes += read
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 0x0a) newlines += 1
      }
      lastByte = buf[read - 1]
    }
    if (bytes === 0) return 0
    // 末行没有换行符时也要算一行
    const totalLines = lastByte === 0x0a ? newlines : newlines + 1
    return Math.max(0, totalLines - 1) // 去掉表头
  } finally {
    fs.closeSync(fd)
  }
}

/** 哪些列按数字写进 Excel（否则 Excel 会把 P 值当文本，排序/条件格式全废） */
const NUMERIC_COLUMNS = new Set(['gene_ratio', 'pvalue', 'p_adjust', 'qvalue', 'count'])

/**
 * 用 exceljs 把一份 CSV 转成 xlsx。
 *
 * 表头加粗 + 冻结首行 + 列宽自适应 —— 后两条是「能不能用」而不是「好不好看」：
 * 结果表动辄几十行 × 十几列，不冻结表头一滚就不知道哪列是什么；
 * 不自适应列宽，description 列会被压成 `Metab…`。
 *
 * `sheetName` 默认 `enrich` 以保持既有行为；WGCNA 传入自己的名字，避免用户
 * 打开 xlsx 看到一个叫「enrich」的工作表。
 */
export async function writeXlsx(
  csvPath: string,
  outPath: string,
  sheetName = 'enrich'
): Promise<void> {
  const mod = await import('exceljs')
  const ExcelJS = ((mod as unknown as { default?: typeof import('exceljs') }).default ??
    mod) as typeof import('exceljs')

  // 这里必须整读：exceljs 要一行一行 addRow，没有流式入口。
  // 结果表几万行、几 MB，可以接受；对比之下 CSV 那条路径是不读内存的。
  const text = fs.readFileSync(csvPath, 'utf-8')
  const records = parseCsvWithHeader(text)
  if (records.header.length === 0) {
    throw toAppError('E_RESULT_INVALID', { message: '结果文件是空的，无法导出。' })
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'DEG Studio'
  wb.created = new Date()
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }] // 冻结首行
  })

  const headerRow = ws.addRow(records.header)
  headerRow.font = { bold: true }

  for (const row of records.rows) {
    ws.addRow(
      records.header.map((name, i) => {
        const raw = row[i] ?? ''
        if (!NUMERIC_COLUMNS.has(name)) return raw
        const n = Number(raw)
        return Number.isFinite(n) ? n : raw
      })
    )
  }

  // 列宽自适应：按每列最长文本算，夹在 [10, 60]
  records.header.forEach((name, i) => {
    let width = name.length
    for (const row of records.rows) {
      const len = (row[i] ?? '').length
      if (len > width) width = len
    }
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, width + 2))
  })

  await wb.xlsx.writeFile(outPath)
}

/** 与 parseCsv 同一套解析，但保留表头顺序（写 xlsx 需要列序） */
function parseCsvWithHeader(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return { header: [], rows: [] }
  return {
    header: rows[0],
    rows: rows.slice(1).filter((r) => r.some((c) => c.trim() !== ''))
  }
}
