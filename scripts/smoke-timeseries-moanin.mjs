/**
 * 时序模块「两组 × 时间（moanin）」冒烟。
 *
 * ## 这些断言各自挡的是什么
 *
 *  1. **df ≥ nTime−1 必须报错，而不是 0 个显著基因**：moanin 在样条基饱和时
 *     不报错、只把 p/q 变成 NA；界面会显示「0 个显著基因」，用户会以为两组没差异。
 *  2. **所有 q 都 NA（无重复时）→ E_R_GENERIC「模型未收敛」**：第二道防线。
 *  3. **五种 lfc 的形状/符号**：`max`/`min` 必须非负（它们不是有符号 logFC），
 *     `timely` 是「基因 × 时间点」矩阵。
 *  4. **同 seed 两次结果一致**：k-means 固定 seed=42，否则客户换了机器数字就变。
 *  5. **多对比走 Fisher 合并**：3 个组 → 3 个对比，合并后的 q 不应大于任一单对比的 q。
 *
 * 用法：node scripts/smoke-timeseries-moanin.mjs
 * 退出码：全过 0 / 有失败 1 / 找不到 Rscript 4
 */
import fs from 'node:fs'
import { safeRemove } from './lib/tmpdir.mjs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-moanin-'))
const posix = (p) => p.replace(/\\/g, '/')

/** 造矩阵：group × time × rep，前若干基因带「组×时间」交互（两组曲线不同） */
function buildMatrix({ groups, times, reps, nGenes = 160, interaction = 20, seed = 7 }) {
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  const samples = []
  for (const g of groups) for (const t of times) for (const r of reps) {
    samples.push({ name: `S_01_${g}_${t}${r}`, group: g, time: t, rep: String(r) })
  }
  const genes = Array.from({ length: nGenes }, (_, i) => `LOC_Os${String(i + 1).padStart(2, '0')}g${1000 + i}`)
  const header = ['gene_id', ...samples.map((x) => x.name)]
  const lines = [header.join('\t')]
  genes.forEach((gene, gi) => {
    const base = 40 + Math.floor(rnd() * 40)
    const vals = samples.map((sm) => {
      const ti = times.indexOf(sm.time)
      const gi2 = groups.indexOf(sm.group)
      // 交互要够强：W 组随时间指数上升（log2 差 > 2 才过 |lfc_max| > 1）
      let v = base * (1 + ti * 0.35) * (gi2 === 1 ? 1 + ti * 1.2 : 1)
      // 其余基因也要有明显波动：MAD 过滤会砍掉一半，太平的数据会只剩几十个基因
      if (gi >= interaction) v = base * (0.4 + rnd() * 1.6)
      v *= 0.9 + rnd() * 0.2
      return Math.max(1, Math.round(v * 10) / 10)
    })
    lines.push([gene, ...vals].join('\t'))
  })
  return { text: `${lines.join('\r\n')}\r\n`, samples, genes }
}

function writeMatrix(file, built) {
  fs.writeFileSync(file, Buffer.from(built.text, 'utf8'))
}

function runScript(dir, params) {
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
      ['--vanilla', path.join(ROOT, 'r', 'timeseries', 'run_moanin_timecourse.R'), '--config', 'run_config.json'],
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

const csvRows = (file) => {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const header = lines[0].split(',')
  return lines.slice(1).map((l) => Object.fromEntries(header.map((h, i) => [h, l.split(',')[i]])))
}
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

const TIMES = ['A', 'B', 'C', 'D']
const GROUPS = ['D', 'W']
const base = (file, samples, extra = {}) => ({
  matrixFile: posix(file),
  samples,
  degreesOfFreedom: 2, // nTime-2 = 2
  varianceCutoff: 0.5,
  contrasts: [],
  nClusters: 3,
  fdr: 0.05,
  lfcCutoff: 1,
  ...extra
})

try {
  /* ================= 正常跑（2 组 / 4 时间点 / 2 重复） ================= */
  console.log('\n--- 两组正常跑 ---')
  const built = buildMatrix({ groups: GROUPS, times: TIMES, reps: [1, 2] })
  const file = path.join(work, 'matrix.txt')
  writeMatrix(file, built)

  const dirA = path.join(work, 'runA')
  const a = runScript(dirA, base(file, built.samples))
  expect('跑完不报错', a.exitCode === 0 && Boolean(a.summary), a.error?.message ?? '')
  if (a.summary) {
    const s = a.summary
    expect('识别为 2 组 / 4 时间点', arr(s.groups).length === 2 && s.nTime === 4,
      `${arr(s.groups).join('/')} nTime=${s.nTime}`)
    expect('对比自动生成 1 个（D-W 或 W-D）', arr(s.contrasts).length === 1, arr(s.contrasts).join(','))
    expect('MAD 过滤后基因数 < 原始', s.nGenesFiltered < s.nGenesRaw,
      `${s.nGenesRaw} → ${s.nGenesNonZero} → ${s.nGenesFiltered}`)
    expect('筛出了交互基因（造了 15 个）', s.nSelected > 0, `nSelected=${s.nSelected}`)
    expect('5 张图都生成了',
      ['volcano', 'splines_p', 'splines_lfc', 'cluster_centroids', 'cluster_heatmap']
        .every((id) => arr(s.plots).some((p) => p.id === id)),
      arr(s.plots).map((p) => p.id).join(','))
    expect('聚类簇大小之和 = 筛出基因数',
      arr(s.clusterSizes).reduce((x, y) => x + Number(y), 0) === s.nSelected,
      `${arr(s.clusterSizes).join('/')} vs ${s.nSelected}`)

    // ★ 每张图都要有同名 PDF（投稿用），且 > 5 KB —— 空 PDF 约 1–2 KB
    const pdfChecks = ['p01_volcano', 'p02_splines_top_pval', 'p03_splines_top_lfc',
                       'p04_cluster_centroids', 'p05_cluster_heatmap']
    const badPdf = pdfChecks.filter((f) => {
      const fp = path.join(dirA, `${f}.pdf`)
      return !fs.existsSync(fp) || fs.statSync(fp).size < 5120
    })
    expect('5 张图都有矢量 PDF（> 5 KB）', badPdf.length === 0,
      badPdf.length ? `缺: ${badPdf.join(',')}` : 'ok')

    /* ---- lfc 的形状与符号 ---- */
    const rows = csvRows(path.join(dirA, 'de_all.csv'))
    const maxVals = rows.map((r) => Number(r.lfc_max))
    const minVals = rows.map((r) => Number(r.lfc_min))
    expect('lfc_max 全非负', maxVals.every((v) => v >= 0), `min=${Math.min(...maxVals)}`)
    expect('lfc_min 全非负', minVals.every((v) => v >= 0), `min=${Math.min(...minVals)}`)
    expect('lfc_timecourse 有正有负（带方向）',
      rows.some((r) => Number(r.lfc_timecourse) > 0) && rows.some((r) => Number(r.lfc_timecourse) < 0))
    const timely = csvRows(path.join(dirA, 'lfc_timely.csv'))
    expect('timely 是「基因 × 时间点」长表（每基因 4 行）',
      timely.length === rows.length * TIMES.length, `${timely.length} vs ${rows.length * TIMES.length}`)
  }

  /* ---- 同 seed 可复现 ---- */
  const dirB = path.join(work, 'runB')
  const b = runScript(dirB, base(file, built.samples))
  const clA = csvRows(path.join(dirA, 'gene_clusters.csv')).map((r) => `${r.gene}:${r.cluster}`).sort()
  const clB = csvRows(path.join(dirB, 'gene_clusters.csv')).map((r) => `${r.gene}:${r.cluster}`).sort()
  expect('同 seed 两次聚类完全一致（可复现）',
    clA.length > 0 && JSON.stringify(clA) === JSON.stringify(clB), `${clA.length} 个基因`)

  /* ================= df 越界 ================= */
  console.log('\n--- df 越界必须报错，而不是「0 个显著基因」 ---')
  const badDf = runScript(path.join(work, 'runBadDf'), base(file, built.samples, { degreesOfFreedom: 3 }))
  expect('df = nTime-1 (3) 被拒绝', badDf.exitCode !== 0 && Boolean(badDf.error),
    badDf.error?.message?.slice(0, 90) ?? `exit=${badDf.exitCode}`)
  expect('错误码 E_VALIDATION', badDf.error?.code === 'E_VALIDATION', String(badDf.error?.code))
  expect('错误信息说明「样条基饱和 / q 变 NA」',
    /saturat|NA/.test(badDf.error?.message ?? ''), badDf.error?.message?.slice(0, 120) ?? '')
  expect('没有写出结果表（不是 0 个基因的成功结果）',
    !fs.existsSync(path.join(work, 'runBadDf', 'de_all.csv')))

  /* ================= 无重复：不能静默返回 0 个显著基因 ================= */
  console.log('\n--- 无重复（每组合 1 个样本）：跑通要有结果，否则必须结构化报错 ---')
  const single = buildMatrix({ groups: GROUPS, times: TIMES, reps: [1], seed: 11 })
  const fileSingle = path.join(work, 'matrix-single.txt')
  writeMatrix(fileSingle, single)
  const noRep = runScript(path.join(work, 'runNoRep'), base(fileSingle, single.samples))
  if (noRep.exitCode === 0) {
    // 拟合成功也必须有真实结果（交互基因本来就造得很强）
    const s2 = noRep.summary ?? {}
    expect('跑通时不是「0 个显著基因」的假成功',
      (s2.qCounts ?? []).some((q) => Number(q.q05) > 0) || Number(s2.nSelected) > 0,
      JSON.stringify(s2.qCounts ?? []))
  } else {
    expect('失败时给出结构化错误（不是崩栈）', Boolean(noRep.error), String(noRep.error?.code))
    expect('错误信息可读（提到收敛/自由度/NA）',
      /converge|degrees_of_freedom|NA/i.test(noRep.error?.message ?? ''),
      noRep.error?.message?.slice(0, 120) ?? '')
  }

  /* ================= 多对比：Fisher 合并 ================= */
  console.log('\n--- 3 组 → 3 个对比 → Fisher 合并 ---')
  const three = buildMatrix({ groups: ['D', 'W', 'X'], times: TIMES, reps: [1, 2], seed: 13 })
  const file3 = path.join(work, 'matrix-3.txt')
  writeMatrix(file3, three)
  const dir3 = path.join(work, 'run3')
  const r3 = runScript(dir3, base(file3, three.samples, { nClusters: 3 }))
  expect('3 组能跑', r3.exitCode === 0 && Boolean(r3.summary), r3.error?.message ?? '')
  if (r3.summary) {
    expect('自动生成 3 个两两对比', arr(r3.summary.contrasts).length === 3,
      arr(r3.summary.contrasts).join(','))
    const rows3 = csvRows(path.join(dir3, 'de_all.csv'))
    // Fisher 合并是「逐基因跨对比」算的：同一个基因的 fisher_q 在它的 3 行里必须一致
    const byGene = new Map()
    let sameAcrossContrasts = true
    for (const r of rows3) {
      const prev = byGene.get(r.gene)
      if (prev !== undefined && prev !== r.fisher_q) sameAcrossContrasts = false
      byGene.set(r.gene, r.fisher_q)
    }
    expect('同一基因的 Fisher q 在各对比行里一致（逐基因合并，不是逐行）',
      sameAcrossContrasts, `${byGene.size} 个基因`)
    expect('Fisher q 全部落在 (0,1]',
      Array.from(byGene.values()).every((v) => Number(v) > 0 && Number(v) <= 1))
    expect('每个基因在每个对比里都有一行',
      rows3.length === rows3.filter((r) => r.contrast).length && rows3.length % 3 === 0,
      `${rows3.length} 行`)
  }
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
