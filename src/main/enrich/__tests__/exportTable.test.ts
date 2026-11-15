/**
 * `EnrichService.exportTable` 的行为测试。
 *
 * ## 为什么这两条值得测
 *
 * 1. **CSV 必须是「拷贝」而不是「重写」**。结果表动辄上万行，实现里走
 *    `fs.copyFile`；但这条约束在代码里只体现为一行调用，谁把它改成
 *    「读进来 → 写出去」都不会有任何断言失败 —— 直到某天用户导出 20 万行时卡住。
 *    这里用**逐字节相等**（`Buffer.equals`）钉住：重写一遍很容易在换行符
 *    （`\n` vs `\r\n`）或 BOM 上产生差异。
 * 2. **xlsx 的行数/列名/数值类型**。表头必须是 CSV 的原样列名、数据行一条不少，
 *    且 P 值那些列必须落成**数字**（落成文本的话 Excel 里没法排序，用户会来问）。
 *
 * 这里不跑 R：`exportTable` 只读 R 已经写好的 `enrich_result.csv`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { EnrichService } from '../EnrichService'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-enrich-export-'))
const PROJECT = path.join(ROOT, 'proj')
const ENRICH_ID = 'enr-test-0001'
const RUN_DIR = path.join(PROJECT, 'results', 'enrich', ENRICH_ID)
const CSV_PATH = path.join(RUN_DIR, 'enrich_result.csv')

/** 故意带引号里的逗号，测 CSV 解析没被简单 split(',') 糊弄过去 */
const CSV_TEXT = [
  'database,ontology,term_id,description,gene_ratio,gene_ratio_text,bg_ratio,pvalue,p_adjust,qvalue,count,gene_ids,category',
  'GO,BP,GO:0009606,tropism,0.0401,12/299,85/23890,1.2e-09,9.6e-08,7.1e-08,12,LOC_Os01g01010/LOC_Os01g01020,',
  'GO,CC,GO:0005768,endosome,0.0167,5/299,96/23890,0.0031,0.024,0.018,5,LOC_Os02g01010,',
  'KEGG,,dosa04144,"Endocytosis, by receptor",0.0689,138/200,138/4589,1e-20,1e-18,1e-19,138,LOC_Os01g01689,',
  ''
].join('\n')

function service(): EnrichService {
  return new EnrichService({
    runner: {} as never,
    paths: { getTempDir: () => ROOT } as never,
    projectStore: { getRoot: () => PROJECT } as never
  })
}

beforeEach(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })
  fs.writeFileSync(CSV_PATH, CSV_TEXT, 'utf8')
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('EnrichService.exportTable', () => {
  it('csv：逐字节拷贝源文件，不是重新拼接', async () => {
    const out = path.join(ROOT, 'out', 'enrich.csv')
    const res = await service().exportTable({ enrichId: ENRICH_ID, outPath: out, format: 'csv' })

    // ★ 逐字节相等：重写一遍最容易在换行符 / BOM / 引号上产生差异
    expect(fs.readFileSync(out).equals(fs.readFileSync(CSV_PATH))).toBe(true)
    expect(res.rows).toBe(3) // 3 条数据行，不含表头
    expect(res.bytes).toBe(fs.statSync(out).size)
    expect(res.outPath).toBe(out)
  })

  it('xlsx：列名与数据行完整，数值列落成数字', async () => {
    const out = path.join(ROOT, 'out', 'enrich.xlsx')
    const res = await service().exportTable({ enrichId: ENRICH_ID, outPath: out, format: 'xlsx' })

    expect(fs.existsSync(out)).toBe(true)
    expect(res.rows).toBe(3)

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(out)
    const ws = wb.getWorksheet('enrich')
    expect(ws).toBeDefined()
    if (!ws) return

    // 表头与 CSV 原样一致（顺序也一致）
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    expect(header).toEqual(CSV_TEXT.split('\n')[0].split(','))

    // 冻结首行
    expect(ws.views?.[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    // 表头加粗
    expect(ws.getRow(1).font?.bold).toBe(true)

    // 数据行：3 行，且带引号逗号的描述解析正确
    expect(ws.rowCount).toBe(4)
    const descCol = header.indexOf('description') + 1
    expect(String(ws.getRow(4).getCell(descCol).value)).toBe('Endocytosis, by receptor')

    // ★ P 值 / count 必须是数字，否则 Excel 里无法排序
    const pCol = header.indexOf('p_adjust') + 1
    expect(typeof ws.getRow(2).getCell(pCol).value).toBe('number')
    const countCol = header.indexOf('count') + 1
    expect(ws.getRow(2).getCell(countCol).value).toBe(12)
  })

  it('结果文件不存在时报 E_RESULT_INVALID（而不是写出一个空文件）', async () => {
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    await expect(
      service().exportTable({ enrichId: ENRICH_ID, outPath: path.join(ROOT, 'x.csv'), format: 'csv' })
    ).rejects.toMatchObject({ code: 'E_RESULT_INVALID' })
    // 而且**没有**产生输出文件 —— 「报错但留下半个空文件」比不报错更糟
    expect(fs.existsSync(path.join(ROOT, 'x.csv'))).toBe(false)
  })
})
