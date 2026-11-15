/**
 * 测试夹具工厂（不是测试文件，不会被 vitest 收集）。
 *
 * 为什么手搓 CleanedMatrix 而不是每次都走真实文件导入：
 *  - 校验规则的测试要精确控制「只有一个变量不同」，走文件解析会引入编码/分隔符噪音；
 *  - 真实导入链路的正确性由 MatrixImporter.test.ts 与集成测试覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CleanedMatrix } from '../MatrixImporter'
import { countDuplicates, detectGeneIdType, findDuplicates } from '../MatrixImporter'

export interface MatrixSpec {
  geneIds: string[]
  samples: string[]
  /** rows × cols，NaN 表示缺失 */
  values: number[][]
  nonNumericCount?: number
  nonNumericDetails?: { row: number; column: string; raw: string }[]
}

/** 由「行 × 列」二维数组构造 CleanedMatrix（自动算 naMask / naRatio / 全零数） */
export function makeMatrix(spec: MatrixSpec): CleanedMatrix {
  const { geneIds, samples, values } = spec
  const sampleCount = samples.length
  const flat: number[] = []
  const mask: number[] = []
  let naCount = 0
  let allZeroGeneCount = 0

  for (let g = 0; g < geneIds.length; g += 1) {
    const row = values[g] ?? []
    let allZero = true
    for (let s = 0; s < sampleCount; s += 1) {
      const v = row[s] ?? Number.NaN
      flat.push(v)
      const isNa = !Number.isFinite(v)
      mask.push(isNa ? 1 : 0)
      if (isNa) naCount += 1
      if (isNa || v !== 0) allZero = false
    }
    if (allZero && sampleCount > 0) allZeroGeneCount += 1
  }

  const cells = geneIds.length * sampleCount
  return {
    geneIds,
    samples,
    values: Float64Array.from(flat),
    naMask: Uint8Array.from(mask),
    geneCount: geneIds.length,
    sampleCount,
    naRatio: cells === 0 ? 0 : naCount / cells,
    allZeroGeneCount,
    nonNumericCount: spec.nonNumericCount ?? 0,
    nonNumericDetails: spec.nonNumericDetails ?? [],
    duplicateGenes: countDuplicates(geneIds),
    duplicateSamples: findDuplicates(samples),
    geneIdType: detectGeneIdType(geneIds),
    rowNumbers: geneIds.map((_, i) => i + 2)
  }
}

/** 建一个临时目录（测试结束由调用方或系统清理） */
export function tempDir(prefix = 'deg-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 写一个文本文件（默认 UTF-8） */
export function writeFile(dir: string, name: string, content: string, encoding: BufferEncoding = 'utf8'): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content, encoding)
  return file
}

/** 读 CSV 为二维数组（测试断言用，不依赖 papaparse） */
export function readCsv(file: string): string[][] {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(','))
}
