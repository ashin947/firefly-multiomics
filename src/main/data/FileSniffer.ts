/**
 * 文件嗅探器（ARCHITECTURE §9 T07 / PRD R-04）。
 *
 * 三件事：
 *  1. **编码**：UTF-8 优先，失败回退 GB18030（中文 Excel 导出的 CSV 默认就是 GBK）。
 *     判定顺序：BOM → 严格 UTF-8 解码（无 U+FFFD）→ chardet 提示 → GB18030 → 放弃。
 *  2. **分隔符**：`,` `\t` `;` 三选一，按「前 5 行切分出的列数是否一致」打分。
 *     为什么要看多行：单看首行时，`A;B,C` 这种数据里含逗号的样本名会误判。
 *  3. **表格类型**：csv/tsv/txt 走文本解析，xlsx/xls 走 SheetJS 转成行列数组。
 *
 * 失败一律抛 SnifferError（带 appError），由 IPC 层转成中文提示；
 * 绝不让编码问题以「乱码基因名」的形式悄悄流进分析。
 */
import fs from 'node:fs'
import path from 'node:path'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import * as XLSX from 'xlsx'
import { toAppError, type AppError } from '@shared/errors'
import type { SniffResult } from '@shared/types/dataset'

/** 携带结构化错误的嗅探异常 */
export class SnifferError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'SnifferError'
  }
}

export type SniffKind = 'text' | 'excel'

export interface SniffOutcome extends SniffResult {
  kind: SniffKind
  /** 文本文件：完整解码后的内容（已去 BOM）；Excel 为 null */
  text: string | null
  /** Excel：行 × 列 的字符串矩阵（含表头）；文本为 null */
  rows: string[][] | null
  fileSizeBytes: number
}

/** 分隔符候选（顺序即并列时的优先级：逗号最常见） */
const DELIMITER_CANDIDATES = [',', '\t', ';'] as const

/** 用来判断列数一致性的行数 */
const DELIMITER_SAMPLE_LINES = 5

/** 文本扩展名 */
const TEXT_EXTS = new Set(['.csv', '.tsv', '.txt', '.tab'])

/** Excel 扩展名 */
const EXCEL_EXTS = new Set(['.xlsx', '.xls', '.xlsm'])

export class FileSniffer {
  /** 嗅探文件：编码 + 分隔符 + 表头 + 内容 */
  sniff(filePath: string): SniffOutcome {
    if (!fs.existsSync(filePath)) {
      throw new SnifferError(
        toAppError('E_DATA_EMPTY', {
          message: `文件不存在：${filePath}`,
          suggestion: '请确认文件没有被移动或删除。'
        })
      )
    }

    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      throw new SnifferError(
        toAppError('E_DATA_EMPTY', { message: `不是一个文件：${filePath}` })
      )
    }
    if (stat.size === 0) {
      throw new SnifferError(
        toAppError('E_DATA_EMPTY', {
          message: '文件是空的（0 字节）。',
          suggestion: '请确认导出时没有中断。'
        })
      )
    }

    const ext = path.extname(filePath).toLowerCase()

    if (EXCEL_EXTS.has(ext)) {
      const rows = this.readExcel(filePath)
      return {
        kind: 'excel',
        encoding: 'utf-8',
        // Excel 没有「分隔符」概念，填逗号只是为了满足类型（不会用于解析）
        delimiter: ',',
        hasHeader: this.detectHasHeader(rows),
        headLines: rows.slice(0, DELIMITER_SAMPLE_LINES).map((r) => r.join('\t')),
        text: null,
        rows,
        fileSizeBytes: stat.size
      }
    }

    if (!TEXT_EXTS.has(ext)) {
      // 扩展名不认识时也尝试按文本解析：用户常把 csv 存成 .dat / 无扩展名
      // 但二进制文件必须早点拒绝，否则解码出来全是乱码
      if (!this.looksLikeText(filePath)) {
        throw new SnifferError(
          toAppError('E_DATA_ENCODING', {
            message: `不支持的文件类型：${ext || '(无扩展名)'}。`,
            suggestion: '请导入 CSV / TSV / TXT / XLSX / XLS 文件。'
          })
        )
      }
    }

    const buffer = fs.readFileSync(filePath)
    const { text, encoding } = this.decode(buffer)
    const lines = this.firstNonEmptyLines(text, DELIMITER_SAMPLE_LINES)
    const delimiter = this.detectDelimiter(lines)
    const headerCells = this.splitLine(lines[0] ?? '', delimiter)

    return {
      kind: 'text',
      encoding,
      delimiter,
      hasHeader: this.detectHasHeaderFromCells(headerCells, this.splitLine(lines[1] ?? '', delimiter)),
      headLines: lines,
      text,
      rows: null,
      fileSizeBytes: stat.size
    }
  }

  /* ---------------------------------------------------------------- *
   * 编码
   * ---------------------------------------------------------------- */

  /**
   * 解码为 UTF-8 字符串。
   *
   * 判定顺序（任何一步失败就继续往下，全部失败才报错）：
   *  1. UTF-8 BOM（EF BB BF）→ 直接按 UTF-8 解，并去掉 BOM；
   *  2. 严格 UTF-8：Node 的 toString('utf8') 遇到非法字节会替换成 U+FFFD，
   *     没有替换字符就说明是真 UTF-8（比 chardet 更可靠）；
   *  3. chardet 提示是 GB 系列 → 直接用 GB18030 解（GB18030 是 GBK/GB2312 的超集）；
   *  4. 盲试 GB18030，没有替换字符即采用；
   *  5. 全失败 → E_DATA_ENCODING（提示另存为 UTF-8）。
   */
  private decode(buffer: Buffer): { text: string; encoding: 'utf-8' | 'gb18030' } {
    // 1) BOM
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8' }
    }
    // UTF-16 BOM：明确不支持（Excel 另存为「Unicode 文本」会产出这种），给出可操作提示
    if (
      (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
    ) {
      throw new SnifferError(
        toAppError('E_DATA_ENCODING', {
          message: '文件是 UTF-16 编码（Excel 的「Unicode 文本」格式），本软件不支持。',
          suggestion: '请在 Excel 中另存为「CSV UTF-8（逗号分隔）」后重新导入。'
        })
      )
    }

    // 2) 严格 UTF-8
    const asUtf8 = buffer.toString('utf8')
    if (!asUtf8.includes('\uFFFD')) {
      return { text: asUtf8, encoding: 'utf-8' }
    }

    // 3) chardet 提示
    let hint = ''
    try {
      hint = (chardet.detect(buffer) ?? '').toString().toLowerCase()
    } catch {
      hint = ''
    }
    const gbHints = ['gb18030', 'gbk', 'gb2312', 'gb_2312', 'big5', 'windows-936', 'cp936']

    if (gbHints.some((h) => hint.includes(h)) || hint === '') {
      // 4) 盲试 GB18030
      try {
        const asGb = iconv.decode(buffer, 'gb18030')
        if (!asGb.includes('\uFFFD')) return { text: asGb, encoding: 'gb18030' }
      } catch {
        // 落到下面的统一报错
      }
    } else {
      // chardet 说是别的编码（如 windows-1252），也再试一次 GB18030 —— 中文场景下更可能对
      try {
        const asGb = iconv.decode(buffer, 'gb18030')
        if (!asGb.includes('\uFFFD')) return { text: asGb, encoding: 'gb18030' }
      } catch {
        /* ignore */
      }
    }

    // 5) 放弃
    throw new SnifferError(
      toAppError('E_DATA_ENCODING', {
        message: `文件编码无法识别（探测结果：${hint || '未知'}）。`,
        suggestion: '请在 Excel 中将文件另存为「CSV UTF-8」编码后重试。'
      })
    )
  }

  /** 粗判是否文本文件（前 8KB 里没有 NUL 字节即认为是文本） */
  private looksLikeText(filePath: string): boolean {
    try {
      const fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(8192)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 0) return false
      }
      return true
    } catch {
      return false
    }
  }

  /* ---------------------------------------------------------------- *
   * 分隔符
   * ---------------------------------------------------------------- */

  private firstNonEmptyLines(text: string, count: number): string[] {
    const out: string[] = []
    for (const raw of text.split(/\r\n|\n|\r/)) {
      if (raw.trim().length === 0) continue
      out.push(raw)
      if (out.length >= count) break
    }
    return out
  }

  /**
   * 分隔符打分：
   *   - 用每个候选分隔符切前 5 行，统计每行的字段数；
   *   - 只有当所有行字段数相同且 >= 2 时该分隔符才算「结构一致」；
   *   - 得分 = 字段数（列越多越可能是真分隔符），并列时按候选顺序取第一个。
   * 这样 `gene_id,S01,S02` 会选逗号，而 `gene_id\tS01\tS02` 会选制表符。
   */
  private detectDelimiter(lines: string[]): ',' | '\t' | ';' {
    if (lines.length === 0) return ','
    let best: { delimiter: ',' | '\t' | ';'; score: number } = { delimiter: ',', score: -1 }

    for (const delimiter of DELIMITER_CANDIDATES) {
      const counts = lines.map((line) => this.splitLine(line, delimiter).length)
      const first = counts[0] ?? 0
      const consistent = first >= 2 && counts.every((c) => c === first)
      const score = consistent ? first : 0
      if (score > best.score) best = { delimiter, score }
    }
    return best.delimiter
  }

  /**
   * 按分隔符切一行（支持双引号包裹与 "" 转义）。
   * 不用 papaparse 是为了在「嗅探阶段」保持零依赖、零副作用。
   */
  private splitLine(line: string, delimiter: string): string[] {
    const out: string[] = []
    let field = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"'
            i += 1
          } else {
            inQuotes = false
          }
        } else {
          field += ch
        }
      } else if (ch === '"' && field.length === 0) {
        inQuotes = true
      } else if (ch === delimiter) {
        out.push(field)
        field = ''
      } else {
        field += ch
      }
    }
    out.push(field)
    return out
  }

  /* ---------------------------------------------------------------- *
   * 表头
   * ---------------------------------------------------------------- */

  private detectHasHeader(rows: string[][]): boolean {
    if (rows.length === 0) return false
    return this.detectHasHeaderFromCells(rows[0] ?? [], rows[1] ?? [])
  }

  /**
   * 表头判定：首行「非数值占比」明显高于第二行 → 有表头。
   * 只有一行数据时按「有表头」处理（PRD §8.1 约定首行为表头）。
   */
  private detectHasHeaderFromCells(firstRow: string[], secondRow: string[]): boolean {
    if (firstRow.length === 0) return false
    if (secondRow.length === 0) return true
    const ratio = (cells: string[]): number => {
      const body = cells.slice(1) // 第一列通常是基因 ID，永远是非数值，不参与判断
      if (body.length === 0) return 1
      const numeric = body.filter((c) => c.trim() !== '' && Number.isFinite(Number(c))).length
      return 1 - numeric / body.length
    }
    return ratio(firstRow) >= 0.5 || ratio(secondRow) < 0.5
  }

  /* ---------------------------------------------------------------- *
   * Excel
   * ---------------------------------------------------------------- */

  /** 读取第一个工作表为字符串矩阵（空单元格 → 空串） */
  private readExcel(filePath: string): string[][] {
    let workbook: XLSX.WorkBook
    try {
      workbook = XLSX.readFile(filePath, { cellDates: false, raw: false })
    } catch (err) {
      throw new SnifferError(
        toAppError('E_DATA_ENCODING', {
          message: 'Excel 文件无法解析（可能已损坏或加了密码）。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) {
      throw new SnifferError(toAppError('E_DATA_EMPTY', { message: 'Excel 里没有任何工作表。' }))
    }
    const sheet = workbook.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false
    })
    const rows = matrix.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : []))
    if (rows.length === 0) {
      throw new SnifferError(
        toAppError('E_DATA_EMPTY', { message: 'Excel 工作表是空的。' })
      )
    }
    return rows
  }
}
