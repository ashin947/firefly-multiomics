/**
 * `scanSamples` 的布局识别测试。
 *
 * ## 为什么这个函数值得单独测
 *
 * 它要认的是**文件系统布局**，而不是数据内容 —— 布局认错的后果是「扫不到样本」
 * 或「同一份数据被算成两个样本」，两种都不会抛异常，只会让用户在界面上看到
 * 一个空列表或一个多出来的样本。这类问题在真实数据上很难复现（客户目录结构各不同），
 * 所以用临时目录把三种已知布局都钉住：
 *
 *   1. `root/MD/{barcodes,genes,matrix}`            —— CellRanger **v2 平铺**（本批 GSE313726）
 *   2. `root/{sample}/outs/filtered_feature_bc_matrix/{...}` —— v3 标准输出
 *   3. `root/{sample}/filtered_gene_bc_matrices/GRCh38/{...}` —— v2 带基因组层
 *
 * 另外两条容易忽略的规则也一并钉住：
 *   - `raw_feature_bc_matrix` 与 `filtered_` 并存时**只收 filtered**（raw 含空液滴）
 *   - 同一个目录名出现两次时**追加 -2**，不能互相覆盖
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detect10xDir, sampleNameOf, scanSamples } from '../scanSamples'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-scan-'))

/** 造一个最小可用的 10x 目录（文件内容是占位符：扫描只看文件名） */
function makeMatrixDir(
  dir: string,
  kind: 'v2' | 'v3',
  matrixExt: '' | '.gz' = '.gz'
): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `matrix.mtx${matrixExt}`), '%%MatrixMarket\n')
  fs.writeFileSync(path.join(dir, `barcodes.tsv${matrixExt}`), 'AAAC\n')
  fs.writeFileSync(path.join(dir, `${kind === 'v3' ? 'features' : 'genes'}.tsv${matrixExt}`), 'g1\n')
}

beforeAll(() => {
  // 布局 1：v2 平铺（两个样本 + 无压缩后缀，顺带覆盖 .mtx / .tsv 的兜底）
  makeMatrixDir(path.join(ROOT, 'v2-flat', 'MD'), 'v2')
  makeMatrixDir(path.join(ROOT, 'v2-flat', 'WW'), 'v2')

  // 布局 2：v3 标准 CellRanger 输出（嵌套两层）
  makeMatrixDir(path.join(ROOT, 'v3-outs', 's1', 'outs', 'filtered_feature_bc_matrix'), 'v3')
  makeMatrixDir(path.join(ROOT, 'v3-outs', 's2', 'outs', 'filtered_feature_bc_matrix'), 'v3')

  // 布局 3：v2 带基因组层（DeepTools 时代的老结构）
  makeMatrixDir(path.join(ROOT, 'v2-genome', 'p1', 'filtered_gene_bc_matrices', 'GRCh38'), 'v2')

  // raw + filtered 并存：只应保留 filtered
  makeMatrixDir(path.join(ROOT, 'raw-and-filtered', 'x1', 'outs', 'filtered_feature_bc_matrix'), 'v3')
  makeMatrixDir(path.join(ROOT, 'raw-and-filtered', 'x1', 'outs', 'raw_feature_bc_matrix'), 'v3')

  // 同名样本：两个都叫 MD，必须追加后缀
  makeMatrixDir(path.join(ROOT, 'dup', 'a', 'MD'), 'v2')
  makeMatrixDir(path.join(ROOT, 'dup', 'b', 'MD'), 'v2')

  // 干扰项：普通目录，不该被当成样本
  fs.mkdirSync(path.join(ROOT, 'v2-flat', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'v2-flat', 'notes', 'readme.txt'), 'x')
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('detect10xDir', () => {
  it('v2 认 genes.tsv，v3 认 features.tsv', () => {
    const v2 = detect10xDir(path.join(ROOT, 'v2-flat', 'MD'))
    expect(v2?.layout).toBe('v2')
    expect(v2?.files.features).toBe('genes.tsv.gz')

    const v3 = detect10xDir(path.join(ROOT, 'v3-outs', 's1', 'outs', 'filtered_feature_bc_matrix'))
    expect(v3?.layout).toBe('v3')
    expect(v3?.files.features).toBe('features.tsv.gz')
  })

  it('缺任一件就返回 null（notes 目录不是样本）', () => {
    expect(detect10xDir(path.join(ROOT, 'v2-flat', 'notes'))).toBeNull()
    // 有 matrix 没有 barcodes
    const broken = path.join(ROOT, 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'matrix.mtx.gz'), 'x')
    expect(detect10xDir(broken)).toBeNull()
  })
})

describe('sampleNameOf', () => {
  it('从 outs/filtered_feature_bc_matrix 往上找到样本名', () => {
    const dir = path.join(ROOT, 'v3-outs', 's1', 'outs', 'filtered_feature_bc_matrix')
    expect(sampleNameOf(path.join(ROOT, 'v3-outs'), dir)).toBe('s1')
  })

  it('从 filtered_gene_bc_matrices/GRCh38 往上找，跳过容器名与基因组名', () => {
    const dir = path.join(ROOT, 'v2-genome', 'p1', 'filtered_gene_bc_matrices', 'GRCh38')
    expect(sampleNameOf(path.join(ROOT, 'v2-genome'), dir)).toBe('p1')
  })
})

describe('scanSamples', () => {
  it('v2 平铺：两个样本都扫到，且忽略普通目录', () => {
    const { samples } = scanSamples(path.join(ROOT, 'v2-flat'))
    expect(samples.map((s) => s.name)).toEqual(['MD', 'WW'])
    expect(samples.every((s) => s.layout === 'v2')).toBe(true)
  })

  it('v3 嵌套 outs/filtered_feature_bc_matrix：样本名取外层目录', () => {
    const { samples } = scanSamples(path.join(ROOT, 'v3-outs'))
    expect(samples.map((s) => s.name)).toEqual(['s1', 's2'])
    expect(samples.every((s) => s.layout === 'v3')).toBe(true)
    expect(samples[0].dir).toContain(path.join('s1', 'outs', 'filtered_feature_bc_matrix'))
  })

  it('v2 带基因组层：样本名是 p1 而不是 GRCh38', () => {
    const { samples } = scanSamples(path.join(ROOT, 'v2-genome'))
    expect(samples.map((s) => s.name)).toEqual(['p1'])
  })

  it('raw 与 filtered 并存时只收 filtered', () => {
    const { samples } = scanSamples(path.join(ROOT, 'raw-and-filtered'))
    expect(samples).toHaveLength(1)
    expect(samples[0].dir).toContain('filtered_feature_bc_matrix')
    expect(samples[0].dir).not.toContain('raw_feature_bc_matrix')
  })

  it('同名样本追加后缀，不互相覆盖', () => {
    const { samples } = scanSamples(path.join(ROOT, 'dup'))
    expect(samples.map((s) => s.name)).toEqual(['MD', 'MD-2'])
  })

  it('根目录本身就是矩阵目录时也能扫到', () => {
    const { samples } = scanSamples(path.join(ROOT, 'v2-flat', 'MD'))
    expect(samples).toHaveLength(1)
    expect(samples[0].name).toBe('MD')
  })

  it('空目录返回空列表而不是抛错', () => {
    const empty = path.join(ROOT, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    expect(scanSamples(empty).samples).toEqual([])
  })
})
