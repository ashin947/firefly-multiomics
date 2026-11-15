/**
 * 时序模块（单序列 SAM）冒烟。
 *
 * ## 为什么这些断言必须是这几条
 *
 *  1. **UTF-16LE 与 UTF-8 都要能读**：客户的 `.txt` 是 UTF-16LE + BOM，
 *     而 `fread()` 读到的是 `Embedded nul character` 这种看不懂的报错。
 *     同一份数据用两种编码各存一份，结果必须**完全一致**。
 *  2. **阈值单调**：q 放宽 / |Score(d)| 放宽，显著基因数只能不减。
 *     这条挡的是「过滤写反了」（`>=` 写成 `<=` 时数字看着也正常，只是方向反了）。
 *  3. **基因名容错**：数据里是 `LOC_Os03g54160`，用户写 `Os03g54160` 要能匹配。
 *  4. **两类「画不出来」分开**：名字不存在 vs 存在但没过阈值 —— 处理方式完全不同。
 *  5. **坏文件报 E_DATA_INVALID**：不能把 `read.table` 的原始报错丢给用户。
 *
 * 用法：
 *   node scripts/smoke-timeseries-sam.mjs
 * 退出码：全过 0 / 有失败 1 / 找不到 Rscript 4
 */
import fs from 'node:fs'
import { safeRemove } from './lib/tmpdir.mjs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function findRscript() {
  if (process.env.DEG_RSCRIPT) return process.env.DEG_RSCRIPT
  const bundled = path.join(ROOT, 'resources', 'runtime', 'R', 'bin', 'Rscript.exe')
  if (fs.existsSync(bundled)) return bundled
  const candidates =
    process.platform === 'win32'
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/Rscript.exe']
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript']
  for (const c of candidates) if (fs.existsSync(c)) return c
  return ''
}

const out = []
const expect = (name, ok, detail) => {
  out.push({ name, ok: Boolean(ok) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}
const rscript = findRscript()
if (!rscript) {
  console.error('找不到 Rscript：请设 DEG_RSCRIPT，或确认 resources/runtime/R 存在')
  process.exit(4)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-ts-'))
const posix = (p) => p.replace(/\\/g, '/')

/* ---------------- 造数据 ---------------- */
const N_TREND_UP = 8
const N_TREND_DOWN = 8
const N_NOISE = 24
const TIMES = ['A', 'B', 'C']
const REPS = ['1', '2', '3']

function buildMatrix() {
  const genes = []
  for (let i = 0; i < N_TREND_UP; i += 1) genes.push(`LOC_Os01g${String(1000 + i)}`)
  for (let i = 0; i < N_TREND_DOWN; i += 1) genes.push(`LOC_Os02g${String(1000 + i)}`)
  for (let i = 0; i < N_NOISE; i += 1) genes.push(`LOC_Os03g${String(1000 + i)}`)

  const cols = []
  for (const rep of REPS) for (const t of TIMES) cols.push({ name: `S_IR09_W_${t}${rep}`, t, rep })
  // 按「时间优先」排列列（客户的表是按时间分组的）
  cols.sort((a, b) => TIMES.indexOf(a.t) - TIMES.indexOf(b.t) || a.rep.localeCompare(b.rep))

  let seed = 42
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  const lines = [['gene_id', ...cols.map((c) => c.name)].join('\t')]
  genes.forEach((g, gi) => {
    const base = 20 + Math.floor(rnd() * 30)
    const vals = cols.map((c) => {
      const ti = TIMES.indexOf(c.t)
      const noise = 0.9 + rnd() * 0.2
      if (gi < N_TREND_UP) return Math.round(base * (1 + ti * 1.6) * noise)
      if (gi < N_TREND_UP + N_TREND_DOWN) return Math.round(base * (1 / (1 + ti * 0.8)) * noise)
      return Math.round(base * noise)
    })
    lines.push([g, ...vals].join('\t'))
  })
  return { text: `${lines.join('\r\n')}\r\n`, cols, genes }
}

const { text, cols } = buildMatrix()
const samples = cols.map((c) => ({ name: c.name, group: 'W', time: c.t, rep: c.rep }))

const fileUtf16 = path.join(work, 'matrix-utf16.txt')
const fileUtf8 = path.join(work, 'matrix-utf8.txt')
const fileBad = path.join(work, 'matrix-bad.txt')
fs.writeFileSync(fileUtf16, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16-le')]))
fs.writeFileSync(fileUtf8, Buffer.from(text, 'utf8'))
fs.writeFileSync(fileBad, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))

function runScript(dir, scriptRel, params) {
  fs.mkdirSync(dir, { recursive: true })
  const config = {
    runId: path.basename(dir),
    runDir: dir,
    projectRoot: path.dirname(dir),
    params: { ...params, skipFonts: true }
  }
  fs.writeFileSync(path.join(dir, 'run_config.json'), JSON.stringify(config, null, 2), 'utf8')
  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync(
      rscript,
      ['--vanilla', path.join(ROOT, 'r', scriptRel), '--config', 'run_config.json'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEG_R_ROOT: path.join(ROOT, 'r'),
          DEG_RESOURCES_ROOT: path.join(ROOT, 'resources')
        }
      }
    )
  } catch (err) {
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
    exitCode = err.status ?? 1
  }
  const resultLine = stdout.split('\n').find((l) => l.includes('"type":"result"'))
  const errorLine = stdout.split('\n').find((l) => l.includes('"type":"error"'))
  return {
    exitCode,
    summary: resultLine ? JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary : null,
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@ /, '')) : null
  }
}

function csvRows(file) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const header = lines[0].split(',')
  return lines.slice(1).map((l) => Object.fromEntries(header.map((h, i) => [h, l.split(',')[i]])))
}

const baseParams = (file) => ({
  matrixFile: file,
  samples,
  log2: true,
  minSamplesExpr: 3,
  nperm: 200,
  fdr: 0.05,
  absD: 2,
  seed: 1
})

try {
  /* ================= 1. 两种编码 ================= */
  console.log('\n--- UTF-16LE 与 UTF-8 必须得到同一份结果 ---')
  const dir16 = path.join(work, 'run16')
  const r16 = runScript(dir16, 'timeseries/run_sam_timecourse.R', baseParams(posix(fileUtf16)))
  expect('UTF-16LE 文件能读并跑完', r16.exitCode === 0 && Boolean(r16.summary),
    r16.error?.message ?? `exit=${r16.exitCode}`)
  expect('识别出 UTF-16LE 编码', r16.summary?.encoding === 'UTF-16LE', String(r16.summary?.encoding))

  const dir8 = path.join(work, 'run8')
  const r8 = runScript(dir8, 'timeseries/run_sam_timecourse.R', baseParams(posix(fileUtf8)))
  expect('UTF-8 文件能读并跑完', r8.exitCode === 0 && Boolean(r8.summary),
    r8.error?.message ?? `exit=${r8.exitCode}`)
  expect('识别出 UTF-8 编码', r8.summary?.encoding === 'UTF-8', String(r8.summary?.encoding))
  expect('两种编码的显著基因数一致',
    r16.summary?.nSig === r8.summary?.nSig,
    `utf16=${r16.summary?.nSig} utf8=${r8.summary?.nSig}`)

  const s = r16.summary ?? {}
  expect('设计识别为 3 个时间点 / 3 条重复序列',
    s.nSeries === 3 && (s.times ?? []).length === 3,
    `series=${s.nSeries} times=${(s.times ?? []).join(',')}`)
  expect('样本数 = 9', s.nSamples === 9, String(s.nSamples))
  expect('跑出了显著基因（造了 8 上 8 下）', s.nSig > 0, `nSig=${s.nSig} up=${s.nUp} down=${s.nDown}`)

  /* ================= 2. 阈值单调 ================= */
  console.log('\n--- 阈值放宽 → 基因数不减（过滤方向别写反）---')
  const all = csvRows(path.join(dir16, 'sam_all.csv'))
  const countAt = (fdr, d) =>
    all.filter((r) => Number(r.q_value) / 100 <= fdr && Math.abs(Number(r.score_d)) >= d).length
  const c1 = countAt(0.05, 2)
  const c2 = countAt(0.2, 2)
  const c3 = countAt(0.2, 1)
  const c4 = countAt(1, 0.001)
  expect('全基因表行数 = 参与检验的基因数', all.length === s.nGenes, `${all.length} vs ${s.nGenes}`)
  expect('放宽 q（0.05→0.2）基因数不减', c2 >= c1, `${c1} → ${c2}`)
  expect('放宽 |d|（2→1）基因数不减', c3 >= c2, `${c2} → ${c3}`)
  expect('两个都放到最宽时 = 全部基因', c4 === all.length, `${c4} vs ${all.length}`)
  expect('R 侧写的 sam_sig 行数与 summary.nSig 一致',
    csvRows(path.join(dir16, 'sam_sig.csv')).length === s.nSig,
    `${csvRows(path.join(dir16, 'sam_sig.csv')).length} vs ${s.nSig}`)

  /* ================= 3. 曲线：容错 + 两类提示 ================= */
  console.log('\n--- 曲线：LOC_ 容错 / 名字不存在 / 存在但未过阈值 ---')
  // 一个显著基因（上趋势）、一个噪声基因（应判为「没过阈值」）、一个拼写错的
  const sigGene = all
    .filter((r) => Number(r.q_value) / 100 <= 0.05 && Math.abs(Number(r.score_d)) >= 2)
    .map((r) => r.gene)[0]
  const noiseGene = all
    .filter((r) => Number(r.q_value) / 100 > 0.5)
    .map((r) => r.gene)[0]
  const shortName = sigGene ? sigGene.replace(/^LOC_/, '') : ''
  const curveDir = dir16
  const rc = runScript(curveDir, 'timeseries/run_timecourse_curves.R', {
    matrixFile: posix(fileUtf8),
    samples,
    genes: [shortName, noiseGene, 'NO_SUCH_GENE'],
    log2: true,
    minSamplesExpr: 3
  })
  expect('曲线跑完（不起第二个矩阵副本）', rc.exitCode === 0 && Boolean(rc.summary),
    rc.error?.message ?? '')
  if (rc.summary) {
    const found = [].concat(rc.summary.genes ?? [])
    const missing = [].concat(rc.summary.missingGenes ?? [])
    const notSig = [].concat(rc.summary.notSignificant ?? [])
    expect('去掉 LOC_ 前缀的名字能匹配上', found.includes(sigGene), `found=${found.join(',')}`)
    expect('拼错的名字进「找不到」', missing.includes('NO_SUCH_GENE'), missing.join(','))
    expect('存在但没过阈值的单独一类', notSig.includes(noiseGene), `notSig=${notSig.join(',')}`)
    const png = path.join(curveDir, 'curves_timecourse.png')
    expect('曲线图文件存在且非空',
      fs.existsSync(png) && fs.statSync(png).size > 5000,
      fs.existsSync(png) ? `${Math.round(fs.statSync(png).size / 1024)} KB` : '缺失')
  }

  /* ================= 4. 全是名字找不到 → E_DATA_EMPTY ================= */
  const rNone = runScript(dir16, 'timeseries/run_timecourse_curves.R', {
    matrixFile: posix(fileUtf8),
    samples,
    genes: ['NO_SUCH_1', 'NO_SUCH_2'],
    log2: true,
    minSamplesExpr: 3
  })
  expect('全找不到时报错（不是画空图）', rNone.exitCode !== 0 && Boolean(rNone.error),
    rNone.error?.message?.slice(0, 80) ?? '')
  expect('错误码 E_DATA_EMPTY', rNone.error?.code === 'E_DATA_EMPTY', String(rNone.error?.code))

  /* ================= 5. 坏文件 ================= */
  console.log('\n--- 读不了的文件要给人话 ---')
  const rBad = runScript(path.join(work, 'runbad'), 'timeseries/run_sam_timecourse.R', {
    ...baseParams(posix(fileBad)),
    samples
  })
  expect('坏文件不崩、给出结构化错误', rBad.exitCode !== 0 && Boolean(rBad.error),
    rBad.error?.code ?? '')
  expect('错误信息提到矩阵/编码（不是 read.table 原文）',
    /cannot read the matrix|encoding|matrix file/i.test(rBad.error?.message ?? ''),
    rBad.error?.message?.slice(0, 120) ?? '')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
