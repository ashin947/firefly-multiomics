/**
 * 客户数据基线（L4）—— 七个必须精确复现的数字。
 *
 * ## 为什么这组数字值得单开一套
 *
 * 单测和冒烟用的都是合成数据，它们能证明「逻辑没写反」，但证明不了
 * 「在客户那份 5 万行 × 40 列的真实矩阵上，结果还是原来那个数」。
 * 而客户验收时看的正是这几个数字：
 *
 * | 数据 | 模式 | 基线 |
 * | --- | --- | --- |
 * | `fpkm109.txt` | 单序列 SAM | 1,242（561↑ / 681↓） |
 * | `fpkm109dt.txt` | 单序列 SAM | 2,835（2,472↑ / 363↓） |
 * | `fpkm109dtck.txt` | 两组 moanin | 18,740 基因；df=5 → q<0.05 6,844 / q<0.01 4,328 |
 * | `fpkm.txt` | 四组 moanin | 20,114 基因；6 个对比各自 q<0.05 / q<0.01 的基因数 |
 *
 * 任何一次改动（MAD 过滤顺序、log2 偏移量、df 校验、Fisher 合并）都会让其中某个数字动，
 * 而**界面不会报错**——所以只能靠这套基线。
 *
 * ## 参数从哪来
 *
 * 样本元信息不是这里自己解析的：直接调 `TimeSeriesService.inspectMatrix`，
 * 用的是界面上那套命名规则。否则「脚本说 3 个时间点、界面说 7 个」这种分叉迟早发生。
 *
 * 用法：`npm run regress:baseline`（缺数据目录时整组 skip，不算失败）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TimeSeriesService } from '../../src/main/timeseries/TimeSeriesService'
import type { TsParseRule, TsSampleMeta } from '../../src/shared/types/timeseries'

const DATA_DIR = process.env.DEG_DATA_DIR || 'D:/ai/data'
const ROOT = path.resolve(__dirname, '..', '..')

/**
 * 基线数据的指纹。
 *
 * ## 为什么必须钉住输入
 *
 * 2026-11-15 真踩过：`fpkm.txt` 在两次比对之间被换成了另一份（78 样本含 A 期 → 72 样本
 * 从 B 期起），于是「20,402」变成「20,114」。当时第一反应是去查解析器 ——
 * 因为基线失败只会告诉你「数字不对」，不会告诉你「输入变了」。
 *
 * 数字变了有两种原因，处理方式完全不同：
 *   · 代码改坏了 → 得改代码；
 *   · 输入文件换了 → 得重新校准基线，代码没问题。
 * 光看断言失败分不出这两种，所以把输入本身也钉进断言：
 * **文件一变就先报「基线数据已变更」**，让人去看文件，而不是去读 R 脚本。
 *
 * 换数据后怎么重新校准：`DEG_BASELINE_REPRINT=1 npm run regress:baseline`
 * 会把当前指纹与最新数字打印出来，替换这里的常量与断言即可。
 */
const FINGERPRINTS: Record<string, { bytes: number; sha256: string }> = {
  'fpkm109.txt': { bytes: 9971660, sha256: '9eccc477aebc69f1' },
  'fpkm109dt.txt': { bytes: 9952608, sha256: 'f7a8113b4a4f37b4' },
  'fpkm109dtck.txt': { bytes: 16954922, sha256: '3ce41407180728da' },
  'fpkm.txt': { bytes: 14803319, sha256: '8069e0a15b62a905' }
}

function fingerprintOf(file: string): { bytes: number; sha256: string } {
  const buf = fs.readFileSync(path.join(DATA_DIR, file))
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) }
}

function findRscript(): string {
  if (process.env.DEG_RSCRIPT) return process.env.DEG_RSCRIPT
  const bundled = path.join(ROOT, 'resources', 'runtime', 'R', 'bin', 'Rscript.exe')
  if (fs.existsSync(bundled)) return bundled
  const candidates =
    process.platform === 'win32'
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/Rscript.exe']
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript']
  return candidates.find((c) => fs.existsSync(c)) ?? ''
}

const rscript = findRscript()
const missing = (name: string): boolean => !fs.existsSync(path.join(DATA_DIR, name))
const hasAll = !missing('fpkm109.txt') && !missing('fpkm109dt.txt') && !missing('fpkm109dtck.txt')
const skipReason = !rscript
  ? '找不到 Rscript（设 DEG_RSCRIPT）'
  : !hasAll
    ? `缺少客户数据（${DATA_DIR}）`
    : ''

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-baseline-'))
/** 复用真实解析：样本元信息必须与界面一致 */
const svc = new TimeSeriesService({} as never)

function samplesOf(file: string, rule: TsParseRule): TsSampleMeta[] {
  const ins = svc.inspectMatrix({ path: path.join(DATA_DIR, file), rule })
  const bad = ins.unparsed
  if (bad.length > 0) throw new Error(`${file} 用规则 ${rule} 有 ${bad.length} 个样本解析不出来：${bad.join(',')}`)
  return ins.samples
}

interface RRun {
  ok: boolean
  summary: Record<string, unknown> | null
  stderr: string
}

function runR(scriptRel: string, params: Record<string, unknown>, tag: string): RRun {
  const dir = path.join(work, tag)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'run_config.json'),
    JSON.stringify(
      { runId: tag, runDir: dir, projectRoot: path.dirname(dir), params: { skipFonts: true, ...params } },
      null,
      2
    ),
    'utf8'
  )
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    stdout = execFileSync(rscript, ['--vanilla', path.join(ROOT, 'r', scriptRel), '--config', 'run_config.json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        DEG_R_ROOT: path.join(ROOT, 'r'),
        DEG_RESOURCES_ROOT: path.join(ROOT, 'resources')
      }
    })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
    exitCode = e.status ?? 1
  }
  const resultLine = stdout.split('\n').find((l) => l.includes('"type":"result"'))
  // 失败时把 @@DEG@@ error 行原样带出来 —— 否则只剩 locale 警告，看不出真正原因
  const errorLine = stdout.split('\n').find((l) => l.includes('"type":"error"'))
  const errDetail = errorLine ? errorLine.replace(/^@@DEG@@ /, '') : ''
  return {
    ok: exitCode === 0 && Boolean(resultLine),
    summary: resultLine ? (JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary as Record<string, unknown>) : null,
    stderr: [errDetail, stderr, stdout.slice(-1500)].filter(Boolean).join('\n')
  }
}

/** 与界面同序：组名排序后两两组合（`combn(groups, 2)` 的 `a-b` 方向） */
function contrastsOf(groups: string[]): string[] {
  const sorted = [...groups].sort()
  const out: string[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) out.push(`${sorted[i]}-${sorted[j]}`)
  }
  return out
}

const num = (v: unknown): number => Number(v ?? NaN)

afterAll(() => {
  // 只清理本次临时目录；客户数据不动
  fs.rmSync(work, { recursive: true, force: true })
})

/**
 * 先校验输入指纹，再谈数字。
 *
 * 放在 `beforeAll` 而不是某个 `it` 里：指纹不匹配时**整组**都不该跑真 R
 * （几分钟白跑，且失败的断言会指向算法而不是文件）。
 * `DEG_BASELINE_REPRINT=1` 时只打印当前指纹不拦截，方便换数据后重新校准。
 */
beforeAll(() => {
  const reprint = process.env.DEG_BASELINE_REPRINT === '1'
  const changed: string[] = []
  for (const [file, want] of Object.entries(FINGERPRINTS)) {
    if (!fs.existsSync(path.join(DATA_DIR, file))) continue
    const got = fingerprintOf(file)
    if (got.bytes === want.bytes && got.sha256 === want.sha256) continue
    changed.push(
      `  ${file}\n    期望 ${want.bytes} 字节 / ${want.sha256}\n    实际 ${got.bytes} 字节 / ${got.sha256}`
    )
  }
  if (reprint) {
    for (const file of Object.keys(FINGERPRINTS)) {
      if (!fs.existsSync(path.join(DATA_DIR, file))) continue
      const got = fingerprintOf(file)
      console.log(`[指纹] ${file} → { bytes: ${got.bytes}, sha256: '${got.sha256}' }`)
    }
    return
  }
  if (changed.length > 0) {
    throw new Error(
      [
        '基线数据已变更 —— 先看文件，别去查 R 脚本。',
        '',
        ...changed,
        '',
        '数字随输入变化是正常的（2026-11-15 就发生过：fpkm.txt 从 78 样本含 A 期换成 72 样本从 B 期起，',
        '20,402 → 20,114）。确认新文件没问题后，用下面这条重新校准：',
        '  DEG_BASELINE_REPRINT=1 npm run regress:baseline   # 打印当前指纹',
        '然后把上面的指纹与断言里的数字一起更新。'
      ].join('\n')
    )
  }
})

describe.skipIf(Boolean(skipReason))(`客户数据基线（${DATA_DIR}）`, () => {
  describe('单序列 SAM', () => {
    it('fpkm109.txt → 1,242（561↑ / 681↓）', () => {
      const samples = samplesOf('fpkm109.txt', 'group-time-rep')
      const r = runR(
        'timeseries/run_sam_timecourse.R',
        {
          matrixFile: path.join(DATA_DIR, 'fpkm109.txt'),
          samples,
          log2: true,
          minSamplesExpr: 3,
          nperm: 200,
          fdr: 0.05,
          absD: 2,
          seed: 1
        },
        'sam-109'
      )
      expect(r.ok, r.stderr).toBe(true)
      const s = r.summary ?? {}
      console.log(`[fpkm109] nGenes=${s.nGenes} nSig=${s.nSig} up=${s.nUp} down=${s.nDown} times=${s.times}`)
      expect(num(s.nSig)).toBe(1242)
      expect(num(s.nUp)).toBe(561)
      expect(num(s.nDown)).toBe(681)
    })

    it('fpkm109dt.txt → 2,835（2,472↑ / 363↓）', () => {
      const samples = samplesOf('fpkm109dt.txt', 'group-time-rep')
      const r = runR(
        'timeseries/run_sam_timecourse.R',
        {
          matrixFile: path.join(DATA_DIR, 'fpkm109dt.txt'),
          samples,
          log2: true,
          minSamplesExpr: 3,
          nperm: 200,
          fdr: 0.05,
          absD: 2,
          seed: 1
        },
        'sam-109dt'
      )
      expect(r.ok, r.stderr).toBe(true)
      const s = r.summary ?? {}
      console.log(`[fpkm109dt] nGenes=${s.nGenes} nSig=${s.nSig} up=${s.nUp} down=${s.nDown} times=${s.times}`)
      expect(num(s.nSig)).toBe(2835)
      expect(num(s.nUp)).toBe(2472)
      expect(num(s.nDown)).toBe(363)
    })
  })

  describe('两组 × 时间（moanin）', () => {
    it('fpkm109dtck.txt → 18,740 基因；df=5 → 6,844 / 4,328；Fisher+lfc_max>2 → 1,877', () => {
      const samples = samplesOf('fpkm109dtck.txt', 'genotype-treatment')
      const groups = Array.from(new Set(samples.map((s) => s.group))).filter(Boolean)
      const contrasts = contrastsOf(groups)
      const r = runR(
        'timeseries/run_moanin_timecourse.R',
        {
          matrixFile: path.join(DATA_DIR, 'fpkm109dtck.txt'),
          samples,
          degreesOfFreedom: 5,
          varianceCutoff: 0.5,
          contrasts,
          nClusters: 8,
          fdr: 0.05,
          lfcCutoff: 2
        },
        'moanin-dtck'
      )
      expect(r.ok, r.stderr).toBe(true)
      const s = r.summary ?? {}
      console.log(
        `[fpkm109dtck] nGenesFiltered=${s.nGenesFiltered} qCounts=${JSON.stringify(s.qCounts)} ` +
          `nSelected=${s.nSelected} clusterSizes=${JSON.stringify(s.clusterSizes)}`
      )
      expect(num(s.nGenesFiltered)).toBe(18740)
      const q05 = (s.qCounts as { q05: number }[] | undefined)?.map((q) => num(q.q05)) ?? []
      expect(q05).toEqual([6844])
      const q01 = (s.qCounts as { q01: number }[] | undefined)?.map((q) => num(q.q01)) ?? []
      expect(q01).toEqual([4328])
      expect(num(s.nSelected)).toBe(1877)
      expect((s.clusterSizes as number[] | undefined)?.map(num)).toEqual([250, 203, 121, 476, 312, 162, 225, 128])
    })
  })

  describe('四组 × 时间（moanin + 多对比 Fisher 合并）', () => {
    it('fpkm.txt（72 样本 / 6 时间点 / 4 组）→ 20,114 基因；6 个对比的 q 计数不变', () => {
      if (missing('fpkm.txt')) {
        console.log('[skip] 没有 fpkm.txt')
        return
      }
      const samples = samplesOf('fpkm.txt', 'genotype-treatment')
      const groups = Array.from(new Set(samples.map((s) => s.group))).filter(Boolean)
      const contrasts = contrastsOf(groups)
      const r = runR(
        'timeseries/run_moanin_timecourse.R',
        {
          matrixFile: path.join(DATA_DIR, 'fpkm.txt'),
          samples,
          // ★ fpkm.txt 只有 6 个时间点 → df 上限是 nTime-2 = 4；
          //   传 5 会被 R 侧硬校验拦下（这正是 df 校验那节要防的）
          degreesOfFreedom: 4,
          varianceCutoff: 0.5,
          contrasts,
          nClusters: 8,
          fdr: 0.05,
          lfcCutoff: 2
        },
        'moanin-4g'
      )
      expect(r.ok, r.stderr).toBe(true)
      const s = r.summary ?? {}
      console.log(
        `[fpkm] groups=${JSON.stringify(s.groups)} nGenesFiltered=${s.nGenesFiltered} qCounts=${JSON.stringify(s.qCounts)}`
      )
      expect(num(s.nGenesFiltered)).toBe(20114)
      // 6 个对比（4 组合取 2），顺序 = contrastsOf() 的字典序组合
      const q05 = (s.qCounts as { q05: number }[] | undefined)?.map((q) => num(q.q05)) ?? []
      expect(q05).toEqual([8066, 10405, 15683, 15304, 13019, 11986])
      const q01 = (s.qCounts as { q01: number }[] | undefined)?.map((q) => num(q.q01)) ?? []
      expect(q01).toEqual([5648, 8476, 14006, 13438, 10636, 10172])
    })
  })
})
