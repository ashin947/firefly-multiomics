/**
 * `GseaService.exportPlot` 的格式分派。
 *
 * ## 钉的是什么
 *
 * png 与 pdf 在 R 侧是**两个文件**（两个图形设备各画一遍），不是同一张图换后缀。
 * 所以这里要保证两件事：
 *   1. `format='pdf'` 时读的是 `.pdf` 那份，不是把 `.png` 复制过去改个名；
 *   2. pdf 不存在时（加这个功能之前跑的旧结果）**明确报错**，绝不静默退回 png ——
 *      用户点的是「导出 PDF」，拿到一个后缀是 .pdf 的位图，等投稿放大才发现就晚了。
 *
 * 用假 runner / 假 projectStore，不启动 R：这条链路上真正有分支的就是文件名与
 * 存在性判断，R 那边的产物由 `scripts/walkthrough-wgcna.mjs` 一类的真跑脚本覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GseaService } from '../GseaService'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-gsea-pdf-'))
const RUN_ID = 'gsea-test'
const RUN_DIR = path.join(ROOT, 'results', 'gsea', RUN_ID)

function service(): GseaService {
  return new GseaService({
    // exportPlot 不碰 runner，但要满足构造签名
    runner: {} as never,
    projectStore: { getRoot: () => ROOT }
  })
}

/** 造一份「跑过 GSEA」的产物目录；pdf 是否生成由调用方决定 */
function seedRun(opts: { png: boolean; pdf: boolean }): void {
  fs.rmSync(RUN_DIR, { recursive: true, force: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })
  if (opts.png) fs.writeFileSync(path.join(RUN_DIR, 'gsea_top.png'), 'PNGDATA')
  if (opts.pdf) fs.writeFileSync(path.join(RUN_DIR, 'gsea_top.pdf'), 'PDFDATA')
}

beforeEach(() => {
  seedRun({ png: true, pdf: true })
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('GseaService.exportPlot — png / pdf 分派', () => {
  it('format=pdf 复制的是 .pdf 那份，内容不对调', () => {
    const outPath = path.join(ROOT, 'out.pdf')
    const res = service().exportPlot({ gseaId: RUN_ID, which: 'top', outPath, format: 'pdf' })
    expect(res.bytes).toBe('PDFDATA'.length)
    expect(fs.readFileSync(outPath, 'utf8')).toBe('PDFDATA')
  })

  it('不传 format 时按 png（老调用方不用改）', () => {
    const outPath = path.join(ROOT, 'out-default.png')
    service().exportPlot({ gseaId: RUN_ID, which: 'top', outPath })
    expect(fs.readFileSync(outPath, 'utf8')).toBe('PNGDATA')
  })

  it('旧结果只有 png 时，导出 PDF 报错且不留下假文件', () => {
    seedRun({ png: true, pdf: false })
    const outPath = path.join(ROOT, 'legacy.pdf')

    expect(() =>
      service().exportPlot({ gseaId: RUN_ID, which: 'top', outPath, format: 'pdf' })
    ).toThrow(/没有矢量 PDF/)

    // 关键：报错就必须什么都不写。留下一个 .pdf 文件比不报错更糟 ——
    // 用户会以为导出成功了。
    expect(fs.existsSync(outPath)).toBe(false)
  })

  it('连 png 都没有时提示「还没有生成」，而不是「没有矢量 PDF」', () => {
    seedRun({ png: false, pdf: false })
    expect(() =>
      service().exportPlot({
        gseaId: RUN_ID,
        which: 'detail',
        outPath: path.join(ROOT, 'none.png'),
        format: 'png'
      })
    ).toThrow(/还没有生成详情图/)
  })
})

describe('GseaService.exportTable — 完整结果表', () => {
  it('csv 直拷 R 写的原文件（行数、精度都不变）', async () => {
    const csv = 'pathway,description,size,es,nes,pvalue,p_adjust,leading_edge\n' +
      'HALLMARK_E2F_TARGETS,,200,0.82,4.27,0.001998,0.012,TP53/ MYC\n'
    fs.writeFileSync(path.join(RUN_DIR, 'gsea_result.csv'), csv, 'utf8')

    const outPath = path.join(ROOT, 'gsea-out.csv')
    const res = await service().exportTable({
      gseaId: RUN_ID,
      outPath,
      format: 'csv'
    })

    // 一个数据行（不含表头），内容逐字节相同 —— 用户拿去当投稿附件的，
    // 必须和软件里看到的是同一份东西
    expect(res.rows).toBe(1)
    expect(fs.readFileSync(outPath, 'utf8')).toBe(csv)
  })

  it('xlsx 也能导，且不是把 csv 改个后缀', async () => {
    fs.writeFileSync(
      path.join(RUN_DIR, 'gsea_result.csv'),
      'pathway,pvalue\nHALLMARK_A,0.01\nHALLMARK_B,0.2\n',
      'utf8'
    )
    const outPath = path.join(ROOT, 'gsea-out.xlsx')
    const res = await service().exportTable({ gseaId: RUN_ID, outPath, format: 'xlsx' })
    expect(res.rows).toBe(2)
    // xlsx 是 zip 容器，头两字节是 PK
    const head = fs.readFileSync(outPath).subarray(0, 2).toString('ascii')
    expect(head).toBe('PK')
  })

  it('结果文件不存在时明确报错，而不是导出一个空表', async () => {
    fs.rmSync(path.join(RUN_DIR, 'gsea_result.csv'), { force: true })
    await expect(
      service().exportTable({ gseaId: RUN_ID, outPath: path.join(ROOT, 'x.csv'), format: 'csv' })
    ).rejects.toThrow(/找不到 GSEA 结果文件/)
  })
})
