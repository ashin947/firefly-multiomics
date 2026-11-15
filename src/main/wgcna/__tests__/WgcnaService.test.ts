/**
 * `WgcnaService.prepare` 的 auto_unbox 回归测试。
 *
 * ## 为什么要单独钉这两条
 *
 * `jsonlite::toJSON(auto_unbox = TRUE)` 会把**长度为 1 的数组塌成标量**。这个坑
 * 本项目踩过：前端拿到 `traits: "group"` 之后调 `.join('、')` 直接崩页；拿到
 * `plots` 是单个对象时 `.map` 也不是函数。R 侧已经用 `as.list` 规避了大部分，
 * 但主进程是最后一道关 —— 这里验证「无论 R 返回数组还是标量，服务层出来的
 * 一定是数组」。
 *
 * 第二条同时钉住「缺图不阻断分析」：R 侧是逐图 tryCatch 的，某张图渲染失败时
 * summary 里仍会列出它，但文件并不存在。此时 dataUrl 必须是 null，且 `prepare`
 * 不能抛错 —— 一张诊断图缺失不该让整次分析白跑。
 *
 * 测试用假 runner，不启动 R。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunRResult } from '../../process/RProcessRunner'
import { WgcnaService } from '../WgcnaService'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-wgcna-'))
const MATRIX = path.join(ROOT, 'matrix.tsv')

// prepare 会校验矩阵文件存在；内容无所谓，这里根本不真的读它（假 runner 直接返回）
fs.writeFileSync(MATRIX, 'gene\ts1\ts2\nG1\t1\t2\nG2\t2\t3\n', 'utf8')

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

function makeService(summary: Record<string, unknown>): WgcnaService {
  const runner = {
    run: async (): Promise<RunRResult> => ({
      ok: true,
      exitCode: 0,
      artifacts: [],
      stderr: '',
      durationMs: 1,
      cancelled: false,
      usedFallback: false,
      summary
    })
  }
  return new WgcnaService({
    runner,
    projectStore: { getRoot: () => ROOT },
    emit: () => {}
  })
}

describe('WgcnaService.prepare — auto_unbox 回归', () => {
  it('traits 是字符串（长度为 1 的数组被塌成标量）时归一成数组', async () => {
    const res = await makeService({ traits: 'group', powers: [], plots: [] }).prepare({
      matrixPath: MATRIX,
      varianceFilter: 'top50',
      transform: 'auto'
    })

    expect(Array.isArray(res.traits)).toBe(true)
    expect(res.traits).toEqual(['group'])
  })

  it('plots 里的 file 不存在时 dataUrl 为 null，且 prepare 不抛错', async () => {
    const res = await makeService({
      traits: [],
      powers: [],
      plots: [{ id: 'sampleTree', title: 'T', caption: 'C', file: 'p01_sample_tree.png' }]
    }).prepare({
      matrixPath: MATRIX,
      varianceFilter: 'top50',
      transform: 'auto'
    })

    expect(res.plots).toHaveLength(1)
    expect(res.plots[0].id).toBe('sampleTree')
    expect(res.plots[0].dataUrl).toBeNull()
  })
})

/**
 * PDF 导出的两条硬规则。
 *
 * 这里的两个断言都在挡同一类事故：**给用户一个 .pdf 后缀、内容却是位图的东西**。
 * 用户在软件里看到「已导出」，投稿时才发现放大是马赛克 —— 那时已经离交稿不远了。
 * 所以宁可报错让他重跑一次（有 TOM 缓存，十几秒），也不要静默降级。
 */
describe('WgcnaService — PDF 导出', () => {
  it('快照里有 pdf 名但文件不存在时，hasPdf 为 false（不骗界面）', async () => {
    const res = await makeService({
      traits: [],
      powers: [],
      plots: [
        {
          id: 'sampleTree',
          title: 'T',
          caption: 'C',
          file: 'p01_sample_tree.png',
          pdf: 'p01_sample_tree.pdf'
        }
      ]
    }).prepare({ matrixPath: MATRIX, varianceFilter: 'top50', transform: 'auto' })

    // 判定以「文件真的在」为准，不信 R 报的字段
    expect(res.plots[0].hasPdf).toBe(false)
  })

  it('对老运行（只有 png）导出 PDF 时明确报错，不悄悄退回 png', () => {
    const service = makeService({})
    const runDir = path.join(ROOT, 'results', 'wgcna', 'legacy')
    fs.mkdirSync(runDir, { recursive: true })
    // 一份「加 PDF 之前」留下的快照：只有 file，没有 pdf
    fs.writeFileSync(
      path.join(runDir, 'prepare.json'),
      JSON.stringify({
        plots: [{ id: 'sampleTree', title: 'T', caption: 'C', file: 'p01_sample_tree.png' }]
      }),
      'utf8'
    )

    expect(() =>
      service.exportPlot({
        wgcnaId: 'legacy',
        plotId: 'sampleTree',
        outPath: path.join(ROOT, 'out.pdf'),
        format: 'pdf'
      })
    ).toThrow(/没有生成矢量 PDF/)
    // 关键：目标文件不能存在 —— 报错却留下一个假 pdf 比不报错更糟
    expect(fs.existsSync(path.join(ROOT, 'out.pdf'))).toBe(false)
  })
})

/**
 * 模块基因的读取与导出。
 *
 * 数据源是 R 写的 `wgcna_genes.csv`（每个基因一行，含 mergedColor）。
 * 这里钉三件事：
 *   1. 切出来的基因数与表里一致，且只含该模块；
 *   2. 模块名写错时给出「当前有哪些模块」——否则用户只看到一句「没有这个模块」；
 *   3. txt 导出**不带表头**（贴进 DAVID / clusterProfiler 时表头会被当成基因名）。
 */
describe('WgcnaService — 模块基因', () => {
  const RUN = path.join(ROOT, 'results', 'wgcna', 'mod-run')

  function seedGenes(): void {
    fs.mkdirSync(RUN, { recursive: true })
    fs.writeFileSync(
      path.join(RUN, 'wgcna_genes.csv'),
      ['gene,dynamicMods,dynamicColors,moduleLabels,mergedColor',
        '"G1",1,"turquoise",1,"turquoise"',
        '"G2",1,"turquoise",1,"turquoise"',
        '"G3",2,"yellow",2,"yellow"',
        '"G4",0,"grey",0,"grey"'].join('\n') + '\n',
      'utf8'
    )
  }

  it('按模块切基因，数量与表一致', () => {
    seedGenes()
    const res = makeService({}).moduleGenes({ wgcnaId: 'mod-run', module: 'turquoise' })
    expect(res.genes).toEqual(['G1', 'G2'])
    expect(res.total).toBe(2)
  })

  it('模块名写错时，suggestion 里列出当前有哪些模块', () => {
    seedGenes()
    // 模块清单在 AppError.suggestion 里（message 只放「没有这个模块」），
    // 所以要取 error 对象本身 —— toThrow(regex) 只匹配 message，会漏掉真正有用的那句
    // toAppError 在主进程里直接返回 AppError（code/message/suggestion 都在顶层），
    // 所以取 error 自身的 suggestion —— toThrow(regex) 只匹配 message，会漏掉真正有用的那句
    const caught = ((): { message?: string; suggestion?: string } | null => {
      try {
        makeService({}).moduleGenes({ wgcnaId: 'mod-run', module: 'purple' })
        return null
      } catch (err) {
        return err as { message?: string; suggestion?: string }
      }
    })()
    expect(caught?.message).toContain('purple')
    expect(caught?.suggestion).toContain('turquoise、yellow、grey')
  })

  it('txt 导出只有基因名，没有表头（贴富集工具不能带 header）', async () => {
    seedGenes()
    const outPath = path.join(ROOT, 'yellow.txt')
    const res = await makeService({}).exportModuleGenes({
      wgcnaId: 'mod-run',
      module: 'yellow',
      outPath,
      format: 'txt'
    })
    expect(res.genes).toBe(1)
    expect(fs.readFileSync(outPath, 'utf8')).toBe('G3\n')
  })

  it('不指定模块时导出全部（长表带 module 列）', async () => {
    seedGenes()
    const outPath = path.join(ROOT, 'all.csv')
    const res = await makeService({}).exportModuleGenes({
      wgcnaId: 'mod-run',
      outPath,
      format: 'csv'
    })
    expect(res.genes).toBe(4)
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('module,gene')
    expect(lines).toContain('yellow,G3')
  })
})
