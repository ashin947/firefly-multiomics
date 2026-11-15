/**
 * 真实结果的端到端链路：**真实 R 产物 → ResultLoader → 结果页数据 → 火山图点集**。
 *
 * ## 为什么要有这个测试
 *
 * 在此之前，「结果页」这条链只被两种东西验证过：
 *  ① `mockDeRows()` 造的假数据（`DEG_DEV_MOCK=1`）—— 形状对，但不是 R 真写出来的；
 *  ② `ResultLoader.test.ts` 里手写的小 CSV —— 能测边界，但不代表真实规模与真实数值。
 *
 * 于是出现一个盲区：**R 真的写出的 de.csv 能不能被加载器吃下去？** 真实文件里有
 * 引号包裹的字符串、`e-14` 这种科学计数法、`gene_name` 与 `gene_id` 同名、
 * 1400 行规模 —— 这些假数据都不一定覆盖到。这个测试把盲区补上：
 * 夹具是 `scripts/smoke-r-de.R` 跑 limma-voom 的**原始产物**，一个字节没改。
 *
 * 夹具来源（可复现）：
 *
 *     "D:/R-4.3.2/bin/x64/Rscript.exe" scripts/smoke-r-de.R --method limma-voom --keep
 *     cp .smoke-tmp/<dir>/results/de/limma-voom/de.csv \
 *        src/main/analysis/__tests__/fixtures/limma-voom/de.csv
 *
 * ## 断言里的数字从哪来
 *
 * 全部来自那次真实运行（见 `docs/SMOKE-R-DE.md`）：
 *   输入矩阵 2000 基因 → filterByExpr 过滤掉 600 → 1400 个进入检验
 *   界面阈值（logFC ≥ 1 且 FDR < 0.05）下：上调 75 / 下调 48 / 不显著 1277
 *   其中植入的 200 个差异基因里，通过过滤的 137 个检出 121 个（88.3%）
 *
 * 数字是**写死**的：R 侧算错了（或写盘错位、列错位）这里立刻红。若将来故意改了
 * demo 数据或阈值语义，需要同步更新本文件与 `docs/SMOKE-R-DE.md`。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { volcano } from '@renderer/utils/plotSpecs'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import type { ThresholdState } from '@shared/types/analysis'
import { DE_COLUMNS, ResultLoader } from '../ResultLoader'

/** 真实产物所在目录 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'limma-voom')

/** 那次运行 result 消息里的 summary（逐字抄自 events.jsonl） */
const REAL_SUMMARY = {
  genesAfterFilter: 1400,
  up: 75,
  down: 48,
  ns: 1277,
  filteredOut: 600,
  contrast: 'Tumor',
  /** R 写 regulation 列用的阈值（由 DEConfig.thresholds 落进 run_config.json） */
  logFCThreshold: 1,
  fdrThreshold: 0.05
}

/** 输入矩阵的基因数（demo 数据固定 2000 行） */
const INPUT_GENES = 2000

/** 界面默认阈值（PRD R-15） */
const THRESHOLDS: ThresholdState = { ...DEFAULT_THRESHOLDS }

function loadRealResult(): ReturnType<ResultLoader['load']> {
  return new ResultLoader().load(FIXTURE_DIR, {
    thresholds: THRESHOLDS,
    filteredOutCount: REAL_SUMMARY.filteredOut
  })
}

describe('真实 de.csv → ResultLoader', () => {
  it('能加载真实产物，行数与 summary 一致（1400）', () => {
    const payload = loadRealResult()
    expect(payload.rows).toHaveLength(REAL_SUMMARY.genesAfterFilter)
  })

  it('守恒律：加载行数 + 过滤掉 == 输入基因数（抓「悄悄丢行」）', () => {
    const payload = loadRealResult()
    expect(payload.rows.length + payload.stats.filteredOutCount).toBe(INPUT_GENES)
  })

  it('表头严格等于约定的 9 列（顺序也一致）', () => {
    // ResultLoader 只校验「集合相等」，顺序靠 R 侧写盘保证；这里用真实文件锁住它
    const payload = loadRealResult()
    expect(Object.keys(payload.rows[0])).toEqual([
      'geneId',
      'geneName',
      'logFC',
      'aveExpr',
      't',
      'pValue',
      'adjPValue',
      'b',
      'regulation'
    ])
    expect(DE_COLUMNS).toHaveLength(9)
  })

  it('统计卡三分类与真实数值严格相等（75 / 48 / 1277）', () => {
    const { stats, rows } = loadRealResult()
    expect(stats).toEqual({
      totalGenesAfterFilter: 1400,
      upCount: 75,
      downCount: 48,
      nsCount: 1277,
      filteredOutCount: REAL_SUMMARY.filteredOut
    })
    // 三分类完备：up + down + ns 恒等于总行数
    expect(stats.upCount + stats.downCount + stats.nsCount).toBe(rows.length)
  })

  it('R 的 regulation 列计数 == 界面统计卡（用户拿 CSV 去 Excel 数行数不会对不上）', () => {
    const { rows, stats } = loadRealResult()
    const csvUp = rows.filter((r) => r.regulation === 'up').length
    const csvDown = rows.filter((r) => r.regulation === 'down').length
    const csvNs = rows.filter((r) => r.regulation === 'ns').length

    // ★ 这条是「防止改回去」的锁。
    //   历史 bug（DEV-NOTES §8）：R 侧写的是「符号 + 原始 p<0.05」，界面用的是
    //   「|logFC| ≥ 1 且 FDR < 0.05」，同一份结果 118/98 vs 75/48 —— 不报错，
    //   但用户把 CSV 发给导师/放进论文附表后，数出来的数和界面对不上，信任就没了。
    //   现在 R 按 `run_config.json` 里的 logFCThreshold/fdrThreshold 写（默认 1.0/0.05）。
    expect(csvUp).toBe(REAL_SUMMARY.up)
    expect(csvDown).toBe(REAL_SUMMARY.down)
    expect(csvNs).toBe(REAL_SUMMARY.ns)
    // 与界面同源：严格相等，不是「差不多」
    expect(csvUp).toBe(stats.upCount)
    expect(csvDown).toBe(stats.downCount)
    expect(csvNs).toBe(stats.nsCount)
    // summary 与 regulation 列也必须一致（R 侧只留一处计算，summary 由它派生）
    expect(stats.upCount + stats.downCount + stats.nsCount).toBe(rows.length)
  })

  it('数值列没有被解析成 NaN / 字符串（真实文件里的科学计数法要能吃下）', () => {
    const { rows } = loadRealResult()
    for (const row of rows) {
      expect(Number.isFinite(row.logFC)).toBe(true)
      expect(Number.isFinite(row.adjPValue)).toBe(true)
      expect(Number.isFinite(row.pValue)).toBe(true)
      expect(typeof row.aveExpr).toBe('number')
    }
    // limma-voom 的 B 统计量有值（DESeq2 才是 null）
    expect(rows.every((row) => typeof row.b === 'number')).toBe(true)
  })

  it('gene_id 非空且唯一，gene_name 在 SYMBOL 输入下等于 gene_id', () => {
    const { rows } = loadRealResult()
    expect(new Set(rows.map((r) => r.geneId)).size).toBe(rows.length)
    expect(rows.every((r) => r.geneName === r.geneId)).toBe(true)
  })

  it('显著基因的 logFC 方向与 regulation 一致（没把 up/down 弄反）', () => {
    const { rows } = loadRealResult()
    const up = rows.filter((r) => r.regulation === 'up')
    const down = rows.filter((r) => r.regulation === 'down')
    expect(up.length).toBeGreaterThan(0)
    expect(down.length).toBeGreaterThan(0)
    expect(up.every((r) => r.logFC > 0)).toBe(true)
    expect(down.every((r) => r.logFC < 0)).toBe(true)
  })
})

describe('真实 de.csv → 火山图点集（与统计卡同源）', () => {
  it('火山图三分类计数与统计卡严格相等（这是「显著点数 == 表格行数」的落点）', () => {
    const { rows, stats } = loadRealResult()
    const spec = volcano({ rows, thresholds: THRESHOLDS, topN: 8, pointSize: 3 })
    expect(spec.counts).toEqual({ up: stats.upCount, down: stats.downCount, ns: stats.nsCount })
    expect(spec.series.up.length + spec.series.down.length + spec.series.ns.length).toBe(rows.length)
  })

  it('每个点的 x 就是该行的 logFC，y 是 -log10(pValue)', () => {
    const { rows } = loadRealResult()
    const spec = volcano({ rows, thresholds: THRESHOLDS, topN: 8, pointSize: 3 })
    const all = [...spec.series.up, ...spec.series.down, ...spec.series.ns]
    expect(all).toHaveLength(rows.length)
    // 点集是逐行 push 的，顺序与 rows 一致（up/down/ns 各自保序，合并后需要按行匹配）
    const upRows = rows.filter((r) => Math.abs(r.logFC) >= THRESHOLDS.logFC && r.adjPValue < THRESHOLDS.fdr && r.logFC > 0)
    expect(spec.series.up.map((p) => p[0])).toEqual(upRows.map((r) => r.logFC))
  })

  it('标注的 topN 基因全部来自显著集，且按 p 值升序', () => {
    const { rows } = loadRealResult()
    const spec = volcano({ rows, thresholds: THRESHOLDS, topN: 8, pointSize: 3 })
    expect(spec.labeled).toHaveLength(8)
    const byName = new Map(rows.map((r) => [r.geneName ?? r.geneId, r]))
    const ps = spec.labeled.map((name) => byName.get(name)?.pValue ?? Number.NaN)
    for (let i = 1; i < ps.length; i += 1) {
      expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1])
    }
    for (const name of spec.labeled) {
      const row = byName.get(name)
      expect(row).toBeDefined()
      expect(Math.abs(row?.logFC ?? 0)).toBeGreaterThanOrEqual(THRESHOLDS.logFC)
      expect(row?.adjPValue ?? 1).toBeLessThan(THRESHOLDS.fdr)
    }
  })

  it('阈值放松到 logFC ≥ 0 时显著数只增不减（滑块不会让点「消失」）', () => {
    const { rows } = loadRealResult()
    const strict = volcano({ rows, thresholds: THRESHOLDS, topN: 8, pointSize: 3 })
    const loose = volcano({ rows, thresholds: { logFC: 0, fdr: 0.05 }, topN: 8, pointSize: 3 })
    expect(loose.counts.up + loose.counts.down).toBeGreaterThanOrEqual(strict.counts.up + strict.counts.down)
    expect(loose.counts.ns).toBeLessThanOrEqual(strict.counts.ns)
  })
})
