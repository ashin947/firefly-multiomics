/**
 * `EnrichService.run()` 对「Excel 注释文件」的处理。
 *
 * ## 为什么要测这个（而不是直接信任 `materializeBackground`）
 *
 * 内置 R **没有** readxl/openxlsx（装一次要再加几十 MB），所以 xlsx 必须在主进程
 * 转成 TSV 再交给 R。这条链路有三个容易悄悄坏掉的点，而且**坏了都不会报错**：
 *
 *  1. 转换后的路径没写进 config → R 收到的是 `.xlsx`，它读不了，报一个跟真实原因
 *     无关的「no usable term-gene pairs」；
 *  2. 表头被改写成别的列名 → R 侧的宽/长表识别靠表头词，改了就认不出来；
 *  3. 空单元格没对齐 → 长表里多出来的空列会被当成 name/category，或整行错位。
 *
 * 测试用**桩 runner**接住配置，因此不需要起 R 进程，也能断言「交给 R 的到底是什么」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { EnrichService } from '../EnrichService'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-enrich-xlsx-'))
const PROJECT = path.join(ROOT, 'proj')

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

/** 造一份「客户 KEGG.xlsx」形态的表：Pathway / gene_id / Description */
async function makeKeggXlsx(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.addRow(['Pathway', 'gene_id', 'Description'])
  ws.addRow(['dosa00010', 'LOC_Os01g01010', 'Glycolysis / Gluconeogenesis'])
  ws.addRow(['dosa00010', 'LOC_Os01g01020', 'Glycolysis / Gluconeogenesis'])
  // 故意留一个空单元格，验证列不会错位
  ws.addRow(['dosa00020', 'LOC_Os01g01030', ''])
  await wb.xlsx.writeFile(file)
}

function makeService(captured: { config?: unknown; runDir?: string }): EnrichService {
  const runner = {
    run: async (req: { config: unknown; runDir: string }) => {
      captured.config = req.config
      captured.runDir = req.runDir
      // R 侧产物是 run() 后续步骤依赖的，桩里补一份最小 CSV
      fs.writeFileSync(
        path.join(req.runDir, 'enrich_result.csv'),
        'database,ontology,term_id,description,gene_ratio,gene_ratio_text,bg_ratio,pvalue,p_adjust,qvalue,count,gene_ids,category\n' +
          'GO,BP,GO:0000001,mitochondrion inheritance,0.1,3/300,10/2000,0.01,0.02,0.02,3,g1/g2/g3,\n',
        'utf8'
      )
      return { ok: true, summary: { totalTerms: 1 }, durationMs: 1, stderr: '', exitCode: 0 }
    }
  }
  return new EnrichService({
    runner: runner as never,
    paths: { getTempDir: () => ROOT } as never,
    projectStore: {
      getRoot: () => {
        fs.mkdirSync(PROJECT, { recursive: true })
        return PROJECT
      }
    } as never
  })
}

const BASE_INPUT = {
  genes: ['g1', 'g2', 'g3'],
  geneIdType: 'SYMBOL',
  species: 'rice' as const,
  sources: ['go', 'kegg'] as ('go' | 'kegg')[],
  ontology: 'ALL' as const,
  pvalueCutoff: 0.05,
  qvalueCutoff: 0.05
}

describe('EnrichService.run — Excel 注释文件', () => {
  it('xlsx 被转成 TSV 落进 runDir，且路径交给 R', async () => {
    const xlsx = path.join(ROOT, 'KEGG.xlsx')
    await makeKeggXlsx(xlsx)
    const captured: { config?: { params?: Record<string, unknown> }; runDir?: string } = {}
    await makeService(captured as never).run({ ...BASE_INPUT, customPathwayPath: xlsx })

    const passed = String(captured.config?.params?.['customPathwayPath'] ?? '')
    expect(passed).not.toBe(xlsx) // 交给 R 的不是原 xlsx
    expect(passed).toMatch(/background_pathway\.tsv$/)
    expect(captured.runDir && passed.startsWith(captured.runDir)).toBe(true)

    // 注意：这里**不能**对整份内容 `.trim()` —— 它会连末行的尾随 tab 一起削掉，
    // 让你误判「空单元格没被补列」。
    const tsv = fs.readFileSync(passed, 'utf8').replace(/\n$/, '').split('\n')
    // 表头原样保留（R 靠它识别长表），3 行数据，空单元格也不错位
    expect(tsv[0]).toBe('Pathway\tgene_id\tDescription')
    expect(tsv).toHaveLength(4)
    // 第三行的 Description 在 Excel 里是空的 → 要补成 3 列（尾随 tab），
    // 否则 R 按位置取第 3 列时那一行会悄悄没有名称
    expect(tsv[3]).toBe('dosa00020\tLOC_Os01g01030\t')
  })

  it('非 Excel 文件原样传给 R（不做任何改写）', async () => {
    const txt = path.join(ROOT, 'go_long.txt')
    fs.writeFileSync(txt, 'GO_ID\tgene_ID\tDescription\tCategory\nGO:0000001\tg1\tmitochondrion inheritance\tBP\n', 'utf8')
    const captured: { config?: { params?: Record<string, unknown> } } = {}
    await makeService(captured as never).run({ ...BASE_INPUT, customGoPath: txt })

    expect(captured.config?.params?.['customGoPath']).toBe(txt)
  })
})
