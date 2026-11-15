/**
 * MatrixImporter 单测（T07 完成标准的可自动化部分）。
 *
 * 覆盖：
 *  - 正常导入：摘要、预览、geneIdType、clean.csv 表头与无 BOM（R fread 友好）；
 *  - **4 种重复基因聚合策略**逐个验证（PRD §8.1 要求绝不静默处理）；
 *  - 重复基因未选策略时 requiresChoice=true 且**不写 clean.csv**；
 *  - 重复样本名 → 阻断；非数值 → 定位到行列；全零行 → 过滤并计数；
 *  - GB18030 编码回退；空文件/单列 → E_DATA_EMPTY；
 *  - setGeneIdColumn / aggregateDuplicates 的「改主意」链路。
 */
import fs from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { afterAll, describe, expect, it } from 'vitest'
import { PROJECT_FILES } from '@shared/constants'
import type { AppError } from '@shared/errors'
import type { ImportMatrixResult } from '@shared/types/dataset'
import { MatrixImporter, detectGeneIdType, formatNumber, parseCell } from '../MatrixImporter'
import { readCsv, tempDir, writeFile } from './fixtures'

const dirs: string[] = []
function newProject(): string {
  const dir = tempDir('deg-matrix-')
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

/** 捕获抛出的 appError（断言错误码比断言文案稳） */
function catchAppError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (err) {
    const candidate = (err as { appError?: AppError }).appError
    if (candidate) return candidate
    throw err
  }
  throw new Error('期望抛出异常，但没有抛出')
}

const BASIC = `gene_id,S01,S02,S03
TP53,10,20,30
EGFR,4,5,6
MYC,7,8,9
`

describe('MatrixImporter — 正常导入', () => {
  it('解析出摘要、预览、基因 ID 类型，并写出 raw/clean 两份 CSV', () => {
    const project = newProject()
    const file = writeFile(project, 'expr.csv', BASIC)
    const importer = new MatrixImporter()

    const result = importer.importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })

    expect(result.summary.geneCount).toBe(3)
    expect(result.summary.sampleCount).toBe(3)
    expect(result.summary.samples).toEqual(['S01', 'S02', 'S03'])
    expect(result.summary.encoding).toBe('utf-8')
    expect(result.summary.delimiter).toBe(',')
    expect(result.summary.geneIdColumn).toBe('gene_id')
    expect(result.summary.matrixPath).toBe('data/expression.clean.csv')
    expect(result.summary.hasBlockingIssue).toBe(false)
    expect(result.requiresChoice).toBe(false)
    expect(result.detectedGeneIdType).toBe('SYMBOL')
    expect(result.geneIdSample).toEqual(['TP53', 'EGFR', 'MYC'])
    expect(result.preview.columns).toEqual(['gene_id', 'S01', 'S02', 'S03'])
    expect(result.preview.rows).toHaveLength(3)
    expect(result.preview.rows[0]).toEqual(['TP53', 10, 20, 30])

    // raw 与 clean 都落盘
    expect(fs.existsSync(path.join(project, 'data/expression.raw.csv'))).toBe(true)
    const cleanFile = path.join(project, 'data/expression.clean.csv')
    expect(fs.existsSync(cleanFile)).toBe(true)

    // ★ clean.csv 必须能被 R 的 data.table::fread 直接读：
    //   首列固定 gene_id、逗号分隔、UTF-8 无 BOM
    const buffer = fs.readFileSync(cleanFile)
    expect(buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    const rows = readCsv(cleanFile)
    expect(rows[0]).toEqual(['gene_id', 'S01', 'S02', 'S03'])
    expect(rows[1]).toEqual(['TP53', '10', '20', '30'])
  })

  it('ExpressionPayload 随导入下发（供箱线图兜底渲染）', () => {
    const project = newProject()
    const file = writeFile(project, 'expr.csv', BASIC)
    const result = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })
    expect(result.expression).toBeDefined()
    expect(result.expression?.geneIds).toEqual(['TP53', 'EGFR', 'MYC'])
    expect(result.expression?.samples).toEqual(['S01', 'S02', 'S03'])
    expect(Array.from(result.expression?.values ?? [])).toEqual([10, 20, 30, 4, 5, 6, 7, 8, 9])
  })
})

describe('MatrixImporter — 重复基因的 4 种聚合策略', () => {
  // TP53 两行：均值 (10+30)/2=20, (20+40)/2=30 / 求和 40,60 / 最大 30,40 / 第一条 10,20
  const DUP = `gene_id,S01,S02
TP53,10,20
TP53,30,40
EGFR,5,6
`

  const cases: { strategy: 'mean' | 'sum' | 'max' | 'first'; expected: string[] }[] = [
    { strategy: 'mean', expected: ['20', '30'] },
    { strategy: 'sum', expected: ['40', '60'] },
    { strategy: 'max', expected: ['30', '40'] },
    { strategy: 'first', expected: ['10', '20'] }
  ]

  for (const testCase of cases) {
    it(`策略 ${testCase.strategy} 的聚合结果正确`, () => {
      const project = newProject()
      const file = writeFile(project, 'dup.csv', DUP)
      const importer = new MatrixImporter()

      // 先不带策略：必须要求用户选择，且不写 clean.csv
      const first = importer.importMatrix({
        filePath: file,
        dataType: 'counts',
        species: 'human',
        projectRoot: project
      })
      expect(first.requiresChoice).toBe(true)
      expect(first.duplicateChoice?.totalDuplicateGenes).toBe(1)
      expect(first.duplicateChoice?.affectedRows).toBe(2)
      expect(first.duplicateChoice?.names[0]).toEqual({ name: 'TP53', count: 2 })
      expect(first.duplicateChoice?.strategies.map((s) => s.value)).toEqual([
        'mean',
        'sum',
        'max',
        'first'
      ])
      expect(fs.existsSync(path.join(project, 'data/expression.clean.csv'))).toBe(false)
      expect(first.summary.hasBlockingIssue).toBe(true)
      expect(first.summary.issues.some((i) => i.rule === 'dup-gene' && i.level === 'error')).toBe(true)

      // 选择策略后重跑
      const second = importer.aggregateDuplicates(testCase.strategy)
      expect(second.requiresChoice).toBe(false)
      expect(second.summary.geneCount).toBe(2)
      expect(second.summary.duplicateStrategy).toBe(testCase.strategy)

      const rows = readCsv(path.join(project, 'data/expression.clean.csv'))
      expect(rows[1]).toEqual(['TP53', ...testCase.expected])
      expect(rows[2]).toEqual(['EGFR', '5', '6'])
    })
  }

  it('聚合时忽略 NA（全 NA 才输出 NA）', () => {
    const project = newProject()
    const file = writeFile(project, 'dup-na.csv', 'gene_id,S01\nTP53,10\nTP53,NA\n')
    const importer = new MatrixImporter()
    importer.importMatrix({ filePath: file, dataType: 'counts', species: 'human', projectRoot: project })
    const result = importer.aggregateDuplicates('mean')
    expect(result.summary.geneCount).toBe(1)
    const rows = readCsv(path.join(project, 'data/expression.clean.csv'))
    expect(rows[1]).toEqual(['TP53', '10'])
  })
})

describe('MatrixImporter — 阻断与告警', () => {
  it('重复样本名直接阻断（E_DATA_DUP_SAMPLE）', () => {
    const project = newProject()
    const file = writeFile(project, 'dup-sample.csv', 'gene_id,S01,S01,S03\nTP53,1,2,3\n')
    const error = catchAppError(() =>
      new MatrixImporter().importMatrix({
        filePath: file,
        dataType: 'counts',
        species: 'human',
        projectRoot: project
      })
    )
    expect(error.code).toBe('E_DATA_DUP_SAMPLE')
    expect(error.message).toContain('S01')
  })

  it('非数值单元格按缺失处理，并定位到具体行列', () => {
    const project = newProject()
    const file = writeFile(
      project,
      'dirty.csv',
      'gene_id,S01,S02,S03\nTP53,1,2,3\nEGFR,4,NA_1,6\n'
    )
    const result = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })
    const issue = result.summary.issues.find((i) => i.rule === 'non-numeric')
    expect(issue?.level).toBe('warning')
    // 表头是第 1 行，EGFR 是第 3 行
    expect(issue?.locator).toEqual({ row: 3, column: 'S02' })
    expect(issue?.message).toContain('NA_1')
    expect(result.summary.naRatio).toBeCloseTo(1 / 6, 5)
  })

  it('全零行自动过滤并回传数量', () => {
    const project = newProject()
    const file = writeFile(
      project,
      'zero.csv',
      'gene_id,S01,S02\nTP53,1,2\nZERO,0,0\nEGFR,3,4\n'
    )
    const result = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })
    expect(result.summary.allZeroGeneCount).toBe(1)
    expect(result.summary.geneCount).toBe(2)
    const issue = result.summary.issues.find((i) => i.rule === 'all-zero-gene')
    expect(issue?.message).toContain('1 个基因在所有样本中为 0')
    const rows = readCsv(path.join(project, 'data/expression.clean.csv'))
    expect(rows.map((r) => r[0])).toEqual(['gene_id', 'TP53', 'EGFR'])
  })

  it('空文件 → E_DATA_EMPTY', () => {
    const project = newProject()
    const file = writeFile(project, 'empty.csv', '')
    const error = catchAppError(() =>
      new MatrixImporter().importMatrix({
        filePath: file,
        dataType: 'counts',
        species: 'human',
        projectRoot: project
      })
    )
    expect(error.code).toBe('E_DATA_EMPTY')
  })

  it('只有 1 列 → E_DATA_EMPTY（提示第一列为基因 ID）', () => {
    const project = newProject()
    const file = writeFile(project, 'onecol.csv', 'gene_id\nTP53\nEGFR\n')
    const error = catchAppError(() =>
      new MatrixImporter().importMatrix({
        filePath: file,
        dataType: 'counts',
        species: 'human',
        projectRoot: project
      })
    )
    expect(error.code).toBe('E_DATA_EMPTY')
    expect(error.message).toContain('第一列为基因 ID')
  })

  it('指定的基因 ID 列不存在 → 可读错误', () => {
    const project = newProject()
    const file = writeFile(project, 'expr.csv', BASIC)
    const error = catchAppError(() =>
      new MatrixImporter().importMatrix({
        filePath: file,
        dataType: 'counts',
        species: 'human',
        geneIdColumn: 'NOT_THERE',
        projectRoot: project
      })
    )
    expect(error.code).toBe('E_DATA_EMPTY')
    expect(error.message).toContain('NOT_THERE')
  })
})

describe('MatrixImporter — 编码与分隔符', () => {
  it('GB18030 文件自动回退解码（中文样本名不乱码）', () => {
    const project = newProject()
    const text = 'gene_id,样本1,样本2\nTP53,10,20\nEGFR,30,40\n'
    const file = path.join(project, 'gbk.csv')
    fs.writeFileSync(file, iconv.encode(text, 'gb18030'))

    const result = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })
    expect(result.summary.encoding).toBe('gb18030')
    expect(result.summary.samples).toEqual(['样本1', '样本2'])
  })

  it('制表符分隔的 TSV 自动嗅探', () => {
    const project = newProject()
    const file = writeFile(project, 'expr.tsv', 'gene_id\tS01\tS02\nTP53\t1\t2\nEGFR\t3\t4\n')
    const result = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: project
    })
    expect(result.summary.delimiter).toBe('\t')
    expect(result.summary.sampleCount).toBe(2)
    // clean.csv 统一用逗号，便于 R 侧 fread 固定参数
    const rows = readCsv(path.join(project, 'data/expression.clean.csv'))
    expect(rows[0]).toEqual(['gene_id', 'S01', 'S02'])
  })
})

describe('MatrixImporter — 改主意（复用已解析缓存）', () => {
  it('setGeneIdColumn 切换到另一列后样本列随之变化', () => {
    const project = newProject()
    const file = writeFile(
      project,
      'expr.csv',
      'gene_id,probe,S01,S02\nTP53,p1,10,20\nEGFR,p2,30,40\n'
    )
    const importer = new MatrixImporter()
    importer.importMatrix({ filePath: file, dataType: 'counts', species: 'human', projectRoot: project })

    const result = importer.setGeneIdColumn('S01')
    expect(result.summary.geneIdColumn).toBe('S01')
    // 原 gene_id 列变成样本列；与 clean.csv 的固定首列同名，故自动改名为 gene_id.sample
    expect(result.summary.samples).toEqual(['gene_id.sample', 'probe', 'S02'])
    expect(result.geneIdSample).toEqual(['10', '30'])
  })

  it('未导入时调用 setGeneIdColumn / aggregateDuplicates → E_VALIDATION', () => {
    const importer = new MatrixImporter()
    expect(catchAppError(() => importer.setGeneIdColumn('x')).code).toBe('E_VALIDATION')
    expect(catchAppError(() => importer.aggregateDuplicates('mean')).code).toBe('E_VALIDATION')
  })
})

describe('MatrixImporter — 纯函数', () => {
  it('parseCell 识别 NA 标记、千分位与脏值', () => {
    expect(parseCell('')).toEqual({ kind: 'na' })
    expect(parseCell('NA')).toEqual({ kind: 'na' })
    expect(parseCell('nan')).toEqual({ kind: 'na' })
    expect(parseCell('-')).toEqual({ kind: 'na' })
    expect(parseCell('1,234')).toEqual({ kind: 'number', value: 1234 })
    expect(parseCell('12.5')).toEqual({ kind: 'number', value: 12.5 })
    expect(parseCell('NA_1')).toEqual({ kind: 'invalid' })
    expect(parseCell('abc')).toEqual({ kind: 'invalid' })
  })

  it('detectGeneIdType 识别 ENSEMBL / ENTREZ / SYMBOL', () => {
    expect(detectGeneIdType(['ENSG00000141510', 'ENSG00000012048'])).toBe('ENSEMBL')
    expect(detectGeneIdType(['7157', '1956', '4609'])).toBe('ENTREZ')
    expect(detectGeneIdType(['TP53', 'EGFR', 'MYC'])).toBe('SYMBOL')
    expect(detectGeneIdType(['---', '???', '###'])).toBe('UNKNOWN')
    expect(detectGeneIdType([])).toBe('UNKNOWN')
  })

  it('formatNumber 输出 fread 友好的数字文本', () => {
    expect(formatNumber(12)).toBe('12')
    expect(formatNumber(12.3456789)).toBe('12.345679')
    expect(formatNumber(Number.NaN)).toBe('NA')
  })
})

/**
 * 重启后只读恢复（restoreFromProject）。
 *
 * 这组用例的核心不是「能读回来」，而是「读回来的时候**什么都没写**」——
 * 恢复场景传入的是 clean.csv，一旦走 importMatrix() 就会把清洗结果回写成
 * raw.csv，用户的原始矩阵不可逆地消失。所以这里用 mtime + 内容双重断言。
 */
describe('MatrixImporter — 重启后只读恢复', () => {
  /** 造一个「已经导入过」的项目（真实落盘 raw.csv / clean.csv） */
  function importedProject(): { root: string; first: ImportMatrixResult } {
    const root = newProject()
    const file = writeFile(root, 'expr.csv', BASIC)
    const first = new MatrixImporter().importMatrix({
      filePath: file,
      dataType: 'counts',
      species: 'human',
      projectRoot: root
    })
    return { root, first }
  }

  it('恢复出与导入时一致的矩阵（基因、样本、数值）', () => {
    const { root, first } = importedProject()
    const importer = new MatrixImporter()
    expect(importer.hasData()).toBe(false)

    const restored = importer.restoreFromProject(
      root,
      path.join(root, PROJECT_FILES.cleanMatrix),
      first.summary
    )

    expect(restored).not.toBeNull()
    expect(importer.hasData()).toBe(true)
    expect(restored?.summary.geneCount).toBe(3)
    expect(restored?.summary.sampleCount).toBe(3)
    expect(restored?.summary.samples).toEqual(['S01', 'S02', 'S03'])

    const cleaned = importer.getCleaned()
    expect(cleaned?.geneIds).toEqual(['TP53', 'EGFR', 'MYC'])
    expect(cleaned?.samples).toEqual(['S01', 'S02', 'S03'])
    expect(Array.from(cleaned?.values ?? [])).toEqual([10, 20, 30, 4, 5, 6, 7, 8, 9])
    expect(cleaned?.naRatio).toBe(0)
  })

  it('★ 不改写 raw.csv / clean.csv（mtime 与内容都必须不变）', () => {
    const { root, first } = importedProject()
    const rawPath = path.join(root, PROJECT_FILES.rawMatrix)
    const cleanPath = path.join(root, PROJECT_FILES.cleanMatrix)

    const rawBefore = fs.readFileSync(rawPath, 'utf8')
    const cleanBefore = fs.readFileSync(cleanPath, 'utf8')

    // 把两个文件的 mtime 拨到很久以前：只要恢复过程写了其中一个字节，mtime 就会变「现在」，
    // 断言立刻失败。这样即使写入内容碰巧相同（回写成同样的字节）也逃不掉。
    const stamp = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(rawPath, stamp, stamp)
    fs.utimesSync(cleanPath, stamp, stamp)
    const rawStamp = fs.statSync(rawPath).mtimeMs
    const cleanStamp = fs.statSync(cleanPath).mtimeMs

    new MatrixImporter().restoreFromProject(root, cleanPath, first.summary)

    expect(fs.readFileSync(rawPath, 'utf8')).toBe(rawBefore)
    expect(fs.readFileSync(cleanPath, 'utf8')).toBe(cleanBefore)
    expect(fs.statSync(rawPath).mtimeMs).toBe(rawStamp)
    expect(fs.statSync(cleanPath).mtimeMs).toBe(cleanStamp)
  })

  it('反推不出来的摘要字段由落盘摘要补；源文件信息置空而不是拿 clean.csv 冒充', () => {
    const { root, first } = importedProject()
    const importer = new MatrixImporter()
    const persisted = {
      ...first.summary,
      matrixSourceFile: 'GSE12345_raw_counts.csv',
      duplicateStrategy: 'mean' as const
    }

    const restored = importer.restoreFromProject(
      root,
      path.join(root, PROJECT_FILES.cleanMatrix),
      persisted
    )

    // 来源文件名 / 聚合策略只存在于 project.json，clean.csv 里没有 → 必须从落盘摘要带过来，
    // 否则下一次 validate 会把 project.json 的 dataset 覆盖成丢了来源名的版本
    expect(restored?.summary.matrixSourceFile).toBe('GSE12345_raw_counts.csv')
    expect(restored?.summary.duplicateStrategy).toBe('mean')
    expect(restored?.summary.matrixPath).toBe(PROJECT_FILES.cleanMatrix)
    // 第 11、12 条规则依赖的「原始文件字节数 / 表头列数」恢复不出来 → null（跳过，不假绿）
    expect(importer.getSourceInfo()).toBeNull()
  })

  it('clean.csv 不存在时返回 null 且不抛错（恢复失败不该盖掉原来的错误文案）', () => {
    const root = newProject()
    const importer = new MatrixImporter()
    expect(importer.restoreFromProject(root, path.join(root, PROJECT_FILES.cleanMatrix), null)).toBeNull()
    expect(importer.hasData()).toBe(false)
    expect(importer.getCleaned()).toBeNull()
  })

  it('恢复后「换基因 ID 列」仍基于 raw.csv 重跑（缓存里存的是真实项目根）', () => {
    const { root, first } = importedProject()
    const importer = new MatrixImporter()
    importer.restoreFromProject(root, path.join(root, PROJECT_FILES.cleanMatrix), first.summary)

    const result = importer.setGeneIdColumn('S01')
    expect(result.summary.geneIdColumn).toBe('S01')
    // 原 gene_id 列变成样本列，与 clean.csv 固定首列同名 → 自动改名
    expect(result.summary.samples).toEqual(['gene_id.sample', 'S02', 'S03'])
    expect(result.geneIdSample).toEqual(['10', '4', '7'])
  })
})
