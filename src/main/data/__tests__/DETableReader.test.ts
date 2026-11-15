/**
 * 外部差异结果表的列猜测与解析。
 *
 * ## 这些断言在防什么
 *
 * 外部表的列名没有任何标准，猜错一列的后果**不会报错**：
 *  - 把 `adj.P.Val` 猜成「原始 P 值」→ 用户看到的 FDR 其实是 p，显著基因翻几倍；
 *  - 把 `log2FoldChange` 漏掉 → 图根本画不出来（这条还算幸运）；
 *  - 表头前有标题行没跳过 → 所有列名变成数据值，映射全乱。
 *
 * 前两条都只能靠断言抓，肉眼看图看不出来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DETableReader } from '../DETableReader'

const dirs: string[] = []

function write(content: string, ext = '.csv'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-det-'))
  dirs.push(dir)
  const file = path.join(dir, `table${ext}`)
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const reader = new DETableReader()

describe('列名猜测', () => {
  it('DESeq2 风格的表头全部猜对', () => {
    const file = write('gene_id,gene_name,log2FoldChange,pvalue,padj\nG1,TP53,2.1,0.001,0.01\n')
    const result = reader.inspect(file)
    const roles = Object.fromEntries(result.columns.map((c) => [c.name, c.guessedRole]))
    expect(roles).toEqual({
      gene_id: 'geneId',
      gene_name: 'geneName',
      log2FoldChange: 'logFC',
      pvalue: 'pValue',
      padj: 'adjPValue'
    })
  })

  it('limma 风格的表头全部猜对', () => {
    const file = write('ID,Symbol,logFC,AveExpr,t,P.Value,adj.P.Val,B\nG1,TP53,2.1,8.3,4.2,0.001,0.01,2.0\n')
    const roles = Object.fromEntries(reader.inspect(file).columns.map((c) => [c.name, c.guessedRole]))
    expect(roles).toMatchObject({
      ID: 'geneId',
      Symbol: 'geneName',
      logFC: 'logFC',
      AveExpr: 'aveExpr',
      t: 't',
      'P.Value': 'pValue',
      'adj.P.Val': 'adjPValue'
    })
  })

  it('Seurat 风格的表头全部猜对', () => {
    const file = write('gene,avg_log2FC,p_val,p_val_adj\nCD3E,1.8,1e-8,1e-5\n')
    const roles = Object.fromEntries(reader.inspect(file).columns.map((c) => [c.name, c.guessedRole]))
    expect(roles).toMatchObject({
      gene: 'geneId',
      avg_log2FC: 'logFC',
      p_val: 'pValue',
      p_val_adj: 'adjPValue'
    })
  })

  it('★ 校正 P 值必须优先于原始 P 值（否则 FDR 会被当成 p，显著数翻倍）', () => {
    const file = write('gene,logFC,adj.P.Val\nG1,2,0.01\n')
    const col = reader.inspect(file).columns.find((c) => c.name === 'adj.P.Val')
    expect(col?.guessedRole).toBe('adjPValue')
  })

  it('常见的 FDR 别名都能认出来', () => {
    for (const name of ['FDR', 'padj', 'qvalue', 'q.value', 'p.adjust', 'adj_p', 'p_val_adj']) {
      const file = write(`gene,logFC,${name}\nG1,2,0.01\n`)
      const col = reader.inspect(file).columns.find((c) => c.name === name)
      expect(col?.guessedRole, `${name} 应识别为 adjPValue`).toBe('adjPValue')
    }
  })

  it('认不出的列标为 ignore，不会乱猜', () => {
    const file = write('gene,logFC,pvalue,描述\nG1,2,0.01,随便写点\n')
    const col = reader.inspect(file).columns.find((c) => c.name === '描述')
    expect(col?.guessedRole).toBe('ignore')
  })

  it('★ GEO2R 表只有 Gene.symbol 一列基因标识时，自动提升为「基因 ID」', () => {
    // 真实场景：GEO2R 导出的表就是 Gene.symbol + log2FoldChange + P.Value + adj.P.Val，
    // 没有独立的 gene_id 列。若不提升，导入按钮会因为"缺少基因 ID 列"直接变灰，
    // 而界面上明明有一列基因名 —— 用户会认为软件坏了。
    const file = write('Gene.symbol,log2FoldChange,P.Value,adj.P.Val\nTP53,3.25,1e-10,5e-8\n')
    const result = reader.inspect(file)
    const geneCol = result.columns.find((c) => c.name === 'Gene.symbol')
    expect(geneCol?.guessedRole).toBe('geneId')

    // 而且真的能导进来
    const mapping = Object.fromEntries(result.columns.map((c) => [c.name, c.guessedRole]))
    const imported = reader.importRows({ filePath: file, mapping })
    expect(imported.rows[0].geneId).toBe('TP53')
    expect(imported.rows[0].logFC).toBe(3.25)
  })

  it('已有 gene_id 时不会把 gene_name 抢走（DESeq2 那种双列共存）', () => {
    const file = write('gene_id,gene_name,logFC,pvalue\nENSG1,TP53,2,0.01\n')
    const result = reader.inspect(file)
    expect(result.columns.find((c) => c.name === 'gene_id')?.guessedRole).toBe('geneId')
    expect(result.columns.find((c) => c.name === 'gene_name')?.guessedRole).toBe('geneName')
  })
})

describe('表头定位与结构', () => {
  it('表头前有标题行和空行时能跳过', () => {
    const file = write('差异基因列表（2026-01-01 导出）\n\n\ngene,logFC,pvalue\nG1,2,0.01\nG2,-1.5,0.02\n')
    const result = reader.inspect(file)
    expect(result.headerRow).toBe(4)
    expect(result.columns.map((c) => c.name)).toEqual(['gene', 'logFC', 'pvalue'])
    expect(result.rowCount).toBe(2)
  })

  it('每列返回可读的样例值', () => {
    const file = write('gene,logFC\nTP53,2.1\nEGFR,-1.4\nMYC,0.9\nBRCA1,3.3\n')
    const col = reader.inspect(file).columns.find((c) => c.name === 'gene')
    expect(col?.samples).toEqual(['TP53', 'EGFR', 'MYC'])
  })

  it('空列名补成「第 N 列」，避免下拉里出现一堆空选项', () => {
    const file = write('gene,logFC,,pvalue\nG1,2,x,0.01\n')
    const names = reader.inspect(file).columns.map((c) => c.name)
    expect(names).toContain('第 3 列')
  })

  it('只有表头没有数据时明确报错', () => {
    const file = write('gene,logFC,pvalue\n')
    expect(() => reader.inspect(file)).toThrowError(/没有数据行/)
  })
})

describe('按映射解析', () => {
  const base = 'gene,logFC,pvalue,padj\nTP53,2.5,0.0001,0.001\nEGFR,-1.8,0.002,0.01\n'

  it('正常解析成 9 字段的结果行', () => {
    const file = write(base)
    const result = reader.importRows({ filePath: file, mapping: {} })
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      geneId: 'TP53',
      logFC: 2.5,
      pValue: 0.0001,
      adjPValue: 0.001,
      b: null,
      regulation: 'ns'
    })
  })

  it('★ 缺 FDR 列时用 P 值代替，并给出明确警告', () => {
    const file = write('gene,logFC,pvalue\nTP53,2.5,0.0001\n')
    const result = reader.importRows({ filePath: file, mapping: {} })
    expect(result.rows[0].adjPValue).toBe(result.rows[0].pValue)
    expect(result.warnings.join()).toMatch(/没有校正 P 值/)
  })

  it('注释行与汇总行被跳过并计数（不整表失败）', () => {
    const file = write(
      'gene,logFC,pvalue,padj\nTP53,2.5,0.0001,0.001\n# 备注：阈值 1.0\nTotal,,,\nEGFR,-1.8,0.002,0.01\n'
    )
    const result = reader.importRows({ filePath: file, mapping: {} })
    expect(result.rows.map((r) => r.geneId)).toEqual(['TP53', 'EGFR'])
    expect(result.skippedRows).toBe(2)
    expect(result.warnings.join()).toMatch(/跳过/)
  })

  it('NA / 空 / - 这类占位符转成 NaN 而不是 0', () => {
    const file = write('gene,logFC,pvalue,padj\nTP53,2.5,NA,-\n')
    const result = reader.importRows({ filePath: file, mapping: {} })
    expect(Number.isNaN(result.rows[0].pValue)).toBe(true)
    expect(Number.isNaN(result.rows[0].adjPValue)).toBe(true)
  })

  it('用户改过的映射生效（把 Gene Symbol 指定为基因 ID）', () => {
    const file = write('Symbol,log2FoldChange,padj\nTP53,2.5,0.001\n')
    const result = reader.importRows({
      filePath: file,
      mapping: { Symbol: 'geneId', log2FoldChange: 'logFC', padj: 'adjPValue' }
    })
    expect(result.rows[0].geneId).toBe('TP53')
    expect(result.rows[0].adjPValue).toBe(0.001)
  })

  it('没有基因 ID 列时明确报错（不猜一个凑合）', () => {
    const file = write('foo,logFC,pvalue\nx,2,0.01\n')
    expect(() => reader.importRows({ filePath: file, mapping: { foo: 'ignore' } })).toThrowError(/基因 ID/)
  })

  it('既没有 P 值也没有 FDR 时报错（画不了火山图）', () => {
    const file = write('gene,logFC\nTP53,2.5\n')
    expect(() => reader.importRows({ filePath: file, mapping: {} })).toThrowError(/P 值/)
  })

  it('全部行都解析失败时报错，而不是返回空表让界面显示空白', () => {
    const file = write('gene,logFC,pvalue\n,abc,0.01\n,bad,0.02\n')
    expect(() => reader.importRows({ filePath: file, mapping: {} })).toThrowError(/没有一行能解析/)
  })

  it('行数太少时提醒（防止导错文件却以为成功了）', () => {
    const file = write('gene,logFC,pvalue\nG1,2,0.01\nG2,-1,0.02\n')
    const result = reader.importRows({ filePath: file, mapping: {} })
    expect(result.warnings.join()).toMatch(/只解析出 2 行/)
  })
})

describe('★ 只读承诺', () => {
  it('inspect 与 importRows 都不修改源文件（一个字节都不写）', () => {
    const file = write('gene,logFC,pvalue,padj\nTP53,2.5,0.0001,0.001\nEGFR,-1.8,0.002,0.01\n')
    const before = fs.statSync(file)
    const beforeContent = fs.readFileSync(file)

    reader.inspect(file)
    reader.importRows({ filePath: file, mapping: {} })

    const after = fs.statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(fs.readFileSync(file).equals(beforeContent)).toBe(true)
  })

  it('不会在源文件旁边生成任何附属文件', () => {
    const file = write('gene,logFC,pvalue\nTP53,2.5,0.0001\n')
    const dir = path.dirname(file)
    const before = fs.readdirSync(dir)
    reader.importRows({ filePath: file, mapping: {} })
    expect(fs.readdirSync(dir)).toEqual(before)
  })
})
