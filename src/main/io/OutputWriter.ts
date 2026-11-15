/**
 * 导出文件写入（CSV / PNG）—— 纯 node:fs，不依赖 electron。
 *
 * 为什么从 `ipc/outputHandlers.ts` 里抽出来：
 *  - handler 文件顶部要 import `ipcMain`，一旦在 vitest 里 import 就会去加载
 *    electron 运行时，测不了；
 *  - 而「CSV 该长什么样」恰恰是最需要测的部分：转义错一个字符，整张表在
 *    Excel 里就错列，并且**不会报错**。这类 bug 只能靠断言抓。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'

/** 确保父目录存在（用户可能选了一个还没建的子目录） */
function ensureParent(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * CSV 单元格转义（RFC 4180）。
 *
 * 必须处理的三类字符：逗号、双引号、换行。基因名里出现逗号是真实存在的
 * （多基因别名），漏掉这一条会让整张表在 Excel 里错列，而且**不会报错**。
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * 结果表的列定义：`[CSV 表头, DEResultRow 字段名]`。
 *
 * 表头与 R 写出的 `de.csv` **逐字一致**（gene_id / logFC / adjPValue ...）：
 * 用户在界面下载的表和 results/de 下那份是同一套列名，发给导师后不会出现
 * 「两份表对不上」的困惑。
 */
export const DE_COLUMNS: readonly [string, string][] = [
  ['gene_id', 'geneId'],
  ['gene_name', 'geneName'],
  ['logFC', 'logFC'],
  ['aveExpr', 'aveExpr'],
  ['t', 't'],
  ['pValue', 'pValue'],
  ['adjPValue', 'adjPValue'],
  ['b', 'b'],
  ['regulation', 'regulation']
]

export function buildCsv(rows: Record<string, unknown>[]): string {
  const header = DE_COLUMNS.map(([name]) => name).join(',')
  const lines = rows.map((row) => DE_COLUMNS.map(([, key]) => csvCell(row[key])).join(','))
  return [header, ...lines].join('\r\n')
}

/**
 * 把结果表写成 CSV（带 UTF-8 BOM）。
 *
 * ★ BOM 不是可选项：Windows 版 Excel 默认按系统代码页（GBK）解析无 BOM 的
 *   UTF-8 文件，中文基因名会变成乱码。这一个字节决定了表能不能直接用。
 */
export function writeTableCsv(outPath: string, rows: Record<string, unknown>[]): { outPath: string } {
  const csv = buildCsv(rows)
  ensureParent(outPath)
  fs.writeFileSync(outPath, `\uFEFF${csv}`, 'utf-8')
  return { outPath }
}

/**
 * 把 `data:image/png;base64,...` / `data:application/pdf;...;base64,...` 写成文件。
 *
 * 支持三种后缀：PNG（位图）、JPEG（位图）、PDF（矢量，来自 jsPDF）。
 * jsPDF 的 dataURL 会带 `;filename=generated.pdf` 参数，所以取的是**第一个逗号**
 * 之后的内容，而不是按 `;base64,` 切 —— 前者对两种格式都成立。
 */
export function writeImageDataUrl(outPath: string, dataUrl: string): { outPath: string; bytes: number } {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) {
    throw toAppError('E_VALIDATION', { message: '导出数据格式不正确（缺少 base64 前缀）。' })
  }
  const base64 = dataUrl.slice(comma + 1).replace(/\s/g, '')
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw toAppError('E_VALIDATION', { message: '导出数据为空，无法保存。' })
  }
  ensureParent(outPath)
  fs.writeFileSync(outPath, buffer)
  return { outPath, bytes: buffer.length }
}
