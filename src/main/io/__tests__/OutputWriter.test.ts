/**
 * 导出文件的写入（CSV / PNG）。
 *
 * ## 这些断言在防什么
 *
 * 导出是最典型的「不报错但结果错」的地方：
 *  - CSV 少转义一个逗号 → 整张表在 Excel 里错列，但文件打得开、没有报错；
 *  - 少写 UTF-8 BOM → 中文基因名在 Windows Excel 里变乱码，用户会以为数据坏了；
 *  - 列顺序与 `de.csv` 不一致 → 用户拿两份表对不上，却不知道哪份是对的。
 *
 * 这三件事用肉眼看文件都得不出结论（尤其 BOM，编辑器里根本看不见），
 * 只能靠断言。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCsv, csvCell, DE_COLUMNS, writeImageDataUrl, writeTableCsv } from '../OutputWriter'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-out-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('csvCell 转义', () => {
  it('普通值原样输出', () => {
    expect(csvCell('TP53')).toBe('TP53')
    expect(csvCell(1.25)).toBe('1.25')
    expect(csvCell(0)).toBe('0')
  })

  it('null / undefined 输出空串（不是 "null" / "undefined" 字符串）', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('含逗号的值必须加引号', () => {
    // 多基因别名里出现逗号是真实存在的
    expect(csvCell('A1BG,AS1')).toBe('"A1BG,AS1"')
  })

  it('含双引号的值：加引号并把内部引号翻倍', () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""')
  })

  it('含换行的值必须加引号（否则一行变两行，整表错位）', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"')
  })
})

describe('buildCsv', () => {
  const row = {
    geneId: 'ENSG00000141510',
    geneName: 'TP53',
    logFC: 3.2,
    aveExpr: 8.7,
    t: 12.4,
    pValue: 1e-9,
    adjPValue: 2e-8,
    b: 15.1,
    regulation: 'up'
  }

  it('表头固定为 9 列，顺序与 R 写出的 de.csv 逐字一致', () => {
    const header = buildCsv([]).split('\r\n')[0]
    expect(header).toBe('gene_id,gene_name,logFC,aveExpr,t,pValue,adjPValue,b,regulation')
    expect(DE_COLUMNS.length).toBe(9)
  })

  it('行数 == 输入行数 + 1（表头）', () => {
    const csv = buildCsv([row, row, row])
    expect(csv.split('\r\n').length).toBe(4)
  })

  it('camelCase 字段名正确映射到 snake_case 表头', () => {
    const line = buildCsv([row]).split('\r\n')[1]
    const cells = line.split(',')
    expect(cells[0]).toBe('ENSG00000141510')
    expect(cells[1]).toBe('TP53')
    expect(cells[8]).toBe('up')
  })

  it('字段缺失时该列留空，而不是整行错位', () => {
    const line = buildCsv([{ geneId: 'G1' }]).split('\r\n')[1]
    expect(line).toBe('G1,,,,,,,,')
  })

  it('b 为 null（DESeq2 / edgeR 没有 B 列）时输出空串', () => {
    const line = buildCsv([{ ...row, b: null }]).split('\r\n')[1]
    expect(line.split(',')[7]).toBe('')
  })
})

describe('writeTableCsv 落盘', () => {
  it('文件以 UTF-8 BOM 开头（否则 Windows Excel 中文乱码）', () => {
    const file = path.join(tempDir(), 'out.csv')
    writeTableCsv(file, [{ geneId: 'G1', geneName: '肿瘤蛋白' }])
    const bytes = fs.readFileSync(file)
    expect(bytes[0]).toBe(0xef)
    expect(bytes[1]).toBe(0xbb)
    expect(bytes[2]).toBe(0xbf)
  })

  it('去掉 BOM 后是合法 CSV，中文按 UTF-8 解码正确', () => {
    const file = path.join(tempDir(), 'out.csv')
    writeTableCsv(file, [{ geneId: 'G1', geneName: '肿瘤蛋白' }])
    const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
    expect(text).toContain('肿瘤蛋白')
  })

  it('父目录不存在时自动创建（用户可能选一个还没建的子目录）', () => {
    const file = path.join(tempDir(), 'a', 'b', 'out.csv')
    writeTableCsv(file, [{ geneId: 'G1' }])
    expect(fs.existsSync(file)).toBe(true)
  })
})

describe('writeImageDataUrl 落盘', () => {
  it('写出与 base64 解码后完全一致的字节', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    const file = path.join(tempDir(), 'volcano.png')
    const result = writeImageDataUrl(file, dataUrl)
    expect(result.bytes).toBe(8)
    expect(fs.readFileSync(file).equals(png)).toBe(true)
  })

  it('缺失 base64 前缀时抛 E_VALIDATION（不要写出空文件当成功）', () => {
    const file = path.join(tempDir(), 'bad.png')
    expect(() => writeImageDataUrl(file, 'not-a-data-url')).toThrowError(/格式不正确/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('base64 段为空时抛错，且不产生 0 字节文件', () => {
    const file = path.join(tempDir(), 'empty.png')
    expect(() => writeImageDataUrl(file, 'data:image/png;base64,')).toThrowError(/为空/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('PDF 的 dataURL（带 ;filename= 参数）也能正确落盘', () => {
    // jsPDF 的 output('datauristring') 真实格式：中间夹着 ;filename=generated.pdf
    const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf-8')
    const dataUrl = `data:application/pdf;filename=generated.pdf;base64,${pdfBytes.toString('base64')}`
    const file = path.join(tempDir(), 'volcano.pdf')
    const result = writeImageDataUrl(file, dataUrl)
    expect(result.bytes).toBe(pdfBytes.length)
    // 落盘内容必须以 PDF 魔数开头，否则是坏文件
    const written = fs.readFileSync(file)
    expect(written.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
    expect(written.equals(pdfBytes)).toBe(true)
  })
})
