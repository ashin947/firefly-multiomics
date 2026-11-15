/**
 * 绘图模块源文件读取的单元测试。
 *
 * ## 为什么这个文件的测试值得写
 *
 * `detectDelimiter` / `looksLikeHeader` / `suggestRoles` 都是**猜**的，
 * 而猜错的后果是静默的：分隔符判成逗号、实际是制表符 → 每行只解析出 1 列 →
 * 界面显示「只有 1 列」，用户以为自己的文件坏了；表头判成数据 → 第一行样本名
 * 变成数值 → 列名退化成 V1/V2；角色猜错 → 下拉框预选到一个错误列 →
 * 画出来的图完全不对但没有任何报错。
 *
 * 这几种情况都不会抛异常，所以只能靠断言钉住。
 *
 * 数据用**真实形状**（临床表、表达矩阵各一份），不手写「理想格式」——
 * 理想格式的测试永远绿，真实文件才会暴露问题。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectDelimiter, inspectTable, splitLine } from '../VizSourceReader'

let dir = ''

function writeFile(name: string, content: string): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-reader-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('detectDelimiter', () => {
  it('制表符分隔优先于逗号（表里恰好含逗号时不能判错）', () => {
    expect(detectDelimiter('gene\tsample\tvalue\tnote')).toBe('\t')
    // 列名里带逗号、但整体是 tab 分隔：按出现次数 tap 最多
    expect(detectDelimiter('gene\tsample\tvalue\tnote,note2,note3')).toBe('\t')
  })

  it('逗号与分号', () => {
    expect(detectDelimiter('gene,sample,value')).toBe(',')
    expect(detectDelimiter('gene;sample;value')).toBe(';')
  })

  it('没有分隔符时退回逗号而不是抛错', () => {
    expect(detectDelimiter('singlecolumn')).toBe(',')
  })
})

describe('splitLine', () => {
  it('处理引号包裹与逗号分隔', () => {
    expect(splitLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd'])
  })

  it('处理双引号转义', () => {
    expect(splitLine('a,"he said ""hi""",c', ',')).toEqual(['a', 'he said "hi"', 'c'])
  })

  it('去掉首尾空白', () => {
    expect(splitLine(' a , b ,c ', ',')).toEqual(['a', 'b', 'c'])
  })

  it('保留空字段（列错位比丢字段更难查）', () => {
    expect(splitLine('a,,c', ',')).toEqual(['a', '', 'c'])
  })
})

describe('inspectTable', () => {
  it('临床表：识别出样本 / 时间 / 状态 / 分组四列', () => {
    const file = writeFile(
      'clinical.csv',
      ['sample,time,status,group', 'S001,12.5,Dead,High', 'S002,30.1,Alive,Low'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.delimiter).toBe(',')
    expect(info.columns).toEqual(['sample', 'time', 'status', 'group'])
    expect(info.suggested.sampleColumn).toBe('sample')
    expect(info.suggested.timeColumn).toBe('time')
    expect(info.suggested.statusColumn).toBe('status')
    expect(info.suggested.groupColumn).toBe('group')
    expect(info.totalRows).toBe(2)
  })

  it('分组列取值被取出去重（界面用来填「参照组」下拉）', () => {
    const file = writeFile(
      'groups.csv',
      ['sample,group', 'S1,High', 'S2,Low', 'S3,High', 'S4,Mid'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.roleValues.group).toEqual(['High', 'Low', 'Mid'])
  })

  it('表达矩阵：第一列作为基因候选，去重且保留出现顺序', () => {
    const file = writeFile(
      'matrix.csv',
      ['gene,N1,N2', 'TP53,10.1,11.2', 'EGFR,8.5,9.1', 'TP53,10.0,11.0'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.suggested.geneColumn).toBe('gene')
    expect(info.rowKeys).toEqual(['TP53', 'EGFR'])
    // 去重了，但真实行数是 3 —— 界面要能显示「选了 2 个基因，文件里有 3 行」
    expect(info.rowKeyTotal).toBe(2)
    expect(info.totalRows).toBe(3)
    expect(info.totalColumns).toBe(3)
  })

  it('中文列名也能认', () => {
    const file = writeFile(
      'cn.csv',
      ['样本,生存时间,状态,分组', 'A,10,死亡,高危', 'B,20,存活,低危'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.suggested.sampleColumn).toBe('样本')
    expect(info.suggested.timeColumn).toBe('生存时间')
    expect(info.suggested.statusColumn).toBe('状态')
    expect(info.suggested.groupColumn).toBe('分组')
  })

  it('制表符分隔的 .tsv 同样能读', () => {
    const file = writeFile(
      'matrix.tsv',
      ['gene\tN1\tN2', 'TP53\t1.1\t2.2'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.columns).toEqual(['gene', 'N1', 'N2'])
    expect(info.suggested.geneColumn).toBe('gene')
  })

  it('重名列加序号区分，不静默丢列', () => {
    const file = writeFile('dup.csv', ['sample,value,value', 'A,1,2'].join('\n'))
    const info = inspectTable(file)
    expect(info.columns).toEqual(['sample', 'value', 'value_3'])
  })

  it('列名正则必须锚定：group_size / subgroup 不能被认成分组列', () => {
    // 宽松写法 `/group/i` 会把这些都认成分组列，界面就会把预选下拉框
    // 指到一个错误的列上 —— 用户不改的话，画出来的是「按 group_size 分组」的图，
    // 而且不会有任何报错。锚定（^...$）是这里唯一有效的防线。
    const file = writeFile(
      'loose.csv',
      ['sample,group_size,subgroup,condition', 'S1,3,A,ctrl'].join('\n')
    )
    const info = inspectTable(file)
    expect(info.suggested.groupColumn).toBe('condition')
  })

  it('文件不存在时抛出可读错误（而不是 undefined 崩在别处）', () => {
    expect(() => inspectTable(path.join(dir, 'not-exist.csv'))).toThrow(/不存在|not/i)
  })

  it('空文件报空数据错误', () => {
    const file = writeFile('empty.csv', '')
    expect(() => inspectTable(file)).toThrow()
  })
})
