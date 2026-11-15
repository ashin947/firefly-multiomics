/**
 * 图片导出（复制 R 已生成的那份）的单元测试。
 *
 * ## 为什么这几条必须有
 *
 *  - **文件名白名单**：渲染进程传的是字符串，`../../secret.png` 这种必须被挡掉，
 *    否则等于给了一个任意文件读取口子。
 *  - **图没生成**要报「该图未生成」而不是复制出 0 字节文件 —— 单细胞/时序的图是
 *    按步骤分批生成的，用户很可能只跑了第 2 步就点第 4 步的导出。
 *  - **空 PDF（< 1 KB）**必须当失败：这正是「绘图闭包被 promise 缓存」那个坑的
 *    表现（文件生成了但空白），不拦的话用户拿到一张白图还以为是我们画错了。
 *  - **批量导出**要把没有 PDF 的图**列出来**，不能静默少几张。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyAllFigures, copyFigure } from '../util/figureExport'

let runDir = ''
let outDir = ''

const pdfBytes = (size = 6000): Buffer => {
  const head = Buffer.from('%PDF-1.5\n')
  return Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)])
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-fig-'))
  runDir = path.join(root, 'run')
  outDir = path.join(root, 'out')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'p01_volcano.png'), Buffer.alloc(3000, 1))
  fs.writeFileSync(path.join(runDir, 'p01_volcano.pdf'), pdfBytes())
  fs.writeFileSync(path.join(runDir, 'p02_old.png'), Buffer.alloc(3000, 1))
})

afterEach(() => {
  fs.rmSync(path.dirname(runDir), { recursive: true, force: true })
})

describe('copyFigure', () => {
  it('复制 PDF 到目标路径', () => {
    const out = path.join(outDir, 'a.pdf')
    const res = copyFigure({ runDir, file: 'p01_volcano.png', format: 'pdf', outPath: out })
    expect(res.bytes).toBeGreaterThan(5000)
    expect(fs.readFileSync(out).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('复制 PNG', () => {
    const out = path.join(outDir, 'a.png')
    const res = copyFigure({ runDir, file: 'p01_volcano.png', format: 'png', outPath: out })
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('拒绝带路径的文件名（白名单）', () => {
    expect(() =>
      copyFigure({ runDir, file: '../../etc/passwd.png', format: 'png', outPath: path.join(outDir, 'x.png') })
    ).toThrow()
    expect(fs.existsSync(path.join(outDir, 'x.png'))).toBe(false)
  })

  it('图没生成 → 明确报错且不落文件', () => {
    const out = path.join(outDir, 'nope.pdf')
    expect(() =>
      copyFigure({ runDir, file: 'p99_missing.png', format: 'pdf', outPath: out })
    ).toThrow(/未生成/)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('只有 PNG 没有 PDF（旧版本跑的图）→ 报「没有 PDF 版本」', () => {
    expect(() =>
      copyFigure({ runDir, file: 'p02_old.png', format: 'pdf', outPath: path.join(outDir, 'b.pdf') })
    ).toThrow(/PDF/)
  })

  it('空 PDF（< 1 KB）当失败处理', () => {
    fs.writeFileSync(path.join(runDir, 'p03_empty.png'), Buffer.alloc(3000, 1))
    fs.writeFileSync(path.join(runDir, 'p03_empty.pdf'), Buffer.from('%PDF-1.5\n'))
    expect(() =>
      copyFigure({ runDir, file: 'p03_empty.png', format: 'pdf', outPath: path.join(outDir, 'c.pdf') })
    ).toThrow(/异常/)
  })
})

describe('copyAllFigures', () => {
  it('批量导出：有 PDF 的复制，没有的列进 skipped', () => {
    const res = copyAllFigures({ runDir, outDir })
    expect(res.count).toBe(1)
    expect(res.skipped).toEqual(['p02_old.png'])
    expect(fs.existsSync(path.join(outDir, 'p01_volcano.pdf'))).toBe(true)
  })

  it('可以只导指定几张', () => {
    const res = copyAllFigures({ runDir, outDir, files: ['p01_volcano.png'] })
    expect(res.count).toBe(1)
    expect(res.skipped).toEqual([])
  })
})
