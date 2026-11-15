#!/usr/bin/env node
/**
 * gen-wgcna-demo.mjs —— 生成 WGCNA 模块的演示数据集
 *
 * 产物（默认写到 docs/demo/）：
 *   wgcna-demo-expression.tsv  2500 基因 × 24 样本的表达矩阵（行=基因，第一列 gene）
 *   wgcna-demo-trait.txt       24 行样本 × 2 列性状（sample / group / stage）
 *
 * 设计要点：
 *   - **必须能切出真模块**。WGCNA 最怕演示数据全是噪声，跑完只有 grey，
 *     界面上什么都看不到。这里埋 4 个模块（每个 150 个基因），组内共享一条
 *     「模块特征谱」+ 小噪声，dynamic tree cut 才能把它们识别成独立分支。
 *   - **模块 A 与 group 强相关**。模块 A 的特征谱直接由 group 向量驱动
 *     （病例组高、对照组低），这样模块-性状热图里一定有一格 |r| > 0.6，
 *     用户一眼就能看懂这张图在讲什么。
 *   - **必须有无标度拓扑**。只堆模块会让连接度分布变成「块 + 均匀」，软阈值
 *     拟合曲线永远爬不到 0.85，演示时界面会提示「没有合适的 β」。所以叠加
 *     一个全局 hub 因子，基因载荷服从帕累托（重尾）分布 —— 少数基因是 hub、
 *     多数基因连接度很低，这正是真实转录组连接度的幂律尾巴。
 *   - 数值量级模拟 log2(CPM+1)：0~12，保留 2 位小数。
 *     客户原始数据就是 count.gene.TMM.logCPM.tsv，量级对得上才能说明
 *     「auto 变换判断为已是 log 尺度」这条分支是真实场景。
 *   - 自实现 mulberry32 PRNG + 固定种子：不引第三方包，任何机器重跑
 *     得到逐字节相同的文件（演示数据要能进 git 并在文档里引用）。
 *
 * 用法：
 *   node scripts/gen-wgcna-demo.mjs
 *   node scripts/gen-wgcna-demo.mjs --seed 123 --out docs/demo
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const opts = { seed: 20250612, out: path.join(REPO_ROOT, 'docs', 'demo') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--seed') opts.seed = Number(argv[++i])
    else if (arg === '--out') opts.out = path.resolve(process.cwd(), argv[++i])
  }
  if (!Number.isFinite(opts.seed)) throw new Error('--seed must be a number')
  return opts
}

/* ------------------------------------------------------------------ *
 * 可复现随机数：mulberry32 + Box-Muller 正态
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeNormal(rand) {
  return function normal(mean = 0, sd = 1) {
    // Box-Muller；cache 只在一个闭包里复用，够用
    let u = 0
    let v = 0
    while (u === 0) u = rand()
    while (v === 0) v = rand()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return mean + sd * z
  }
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const round2 = (x) => Number(clamp(x, 0, 12).toFixed(2))

/* ------------------------------------------------------------------ *
 * 构造数据
 * ------------------------------------------------------------------ */
const N_GENES = 2500
const N_SAMPLES = 24
const MODULE_SIZE = 150
const MODULES = ['A', 'B', 'C', 'D']

function buildData(seed) {
  const rand = mulberry32(seed)
  const normal = makeNormal(rand)
  const sampleNames = Array.from({ length: N_SAMPLES }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)
  const geneNames = Array.from({ length: N_GENES }, (_, i) => `G${String(i + 1).padStart(4, '0')}`)

  // group：前 12 个样本为 1，后 12 个为 0。模块 A 由它驱动。
  const group = Array.from({ length: N_SAMPLES }, (_, i) => (i < 12 ? 1 : 0))
  // stage：按样本序号递增编码成 0/1/2（数值型，不是字符）
  const stage = Array.from({ length: N_SAMPLES }, (_, i) => (i < 8 ? 0 : i < 16 ? 1 : 2))

  // 4 条模块谱（24 维）。注意**故意不做正交化**：
  // 完全正交的块结构会让所有模块基因的连接度过于接近，连接度分布失去
  // 幂律尾巴，pickSoftThreshold 的 R² 反而爬不到 0.85。让三条随机谱
  // 保留轻微重叠（真实通路本来也共享基因），连接度才有层次。
  // 模块 A 仍由 group 驱动：先把 group 方向对三条随机谱张成的空间做投影剔除，
  // 保证「A 与 group 强相关」不是靠和别的模块混淆出来的。
  const rawSpectra = [
    sampleNames.map(() => normal(0, 1)),
    sampleNames.map(() => normal(0, 1)),
    sampleNames.map(() => normal(0, 1))
  ]
  const centeredGroup = standardize(group.map((x) => x - 0.5))
  const residual = projectOut(centeredGroup, rawSpectra)
  const spectra = [standardize(residual), ...rawSpectra.map(standardize)]

  // 全局 hub 因子：载荷重尾（帕累托），少数基因成为 hub。
  // 这是让 pickSoftThreshold 的 R² 能越过 0.85 的关键。
  const hub = sampleNames.map(() => normal(0, 1))
  const loadings = Array.from({ length: N_GENES }, () => {
    const u = rand()
    return Math.min(2.5, 0.18 * (1 - u) ** (-1 / 1.6))
  })

  const rows = []
  for (let g = 0; g < N_GENES; g += 1) {
    const idx = Math.floor(g / MODULE_SIZE)
    const inModule = idx < MODULES.length
    const baseline = 5.5 + normal(0, 0.7)
    // 每个基因自己的噪声 + hub 因子贡献
    const values = sampleNames.map((_, i) => normal(0, 0.4) + loadings[g] * hub[i])

    if (inModule) {
      // 模块基因：叠加模块谱（幅度 0.7 是实测出来的平衡点：
      // 再大块结构会破坏无标度拟合，再小模块切不出来）
      for (let i = 0; i < N_SAMPLES; i += 1) values[i] += 0.7 * spectra[idx][i]
    }

    rows.push({
      gene: geneNames[g],
      values: values.map((v) => round2(v + baseline))
    })
  }

  return { sampleNames, geneNames, group, stage, rows }
}

/* ------------------------------------------------------------------ *
 * 向量工具（24 维，够小，直接用朴素实现）
 * ------------------------------------------------------------------ */
function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

function mean(a) {
  return a.reduce((s, x) => s + x, 0) / a.length
}

function standardize(a) {
  const mu = mean(a)
  const centered = a.map((x) => x - mu)
  const sd = Math.sqrt(centered.reduce((s, x) => s + x * x, 0) / (a.length - 1))
  return centered.map((x) => x / sd)
}

/** 解小型线性方程组 A x = b（高斯-约当消元，k <= 3） */
function solveLinear(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let piv = col
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue
    const tmp = M[col]
    M[col] = M[piv]
    M[piv] = tmp
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

/** v 减去在 span(basis) 上的最小二乘投影，返回残差 */
function projectOut(v, basis) {
  const k = basis.length
  const gram = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => dot(basis[i], basis[j])))
  const rhs = basis.map((b) => dot(b, v))
  const coef = solveLinear(gram, rhs)
  const out = v.slice()
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < out.length; j += 1) out[j] -= coef[i] * basis[i][j]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 写文件
 * ------------------------------------------------------------------ */
function writeExpression(file, data) {
  const lines = []
  lines.push(['gene', ...data.sampleNames].join('\t'))
  for (const row of data.rows) {
    lines.push([row.gene, ...row.values.map((v) => v.toFixed(2))].join('\t'))
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function writeTraits(file, data) {
  const lines = []
  lines.push(['sample', 'group', 'stage'].join('\t'))
  data.sampleNames.forEach((s, i) => {
    lines.push([s, data.group[i], data.stage[i]].join('\t'))
  })
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 自检：模块 A 的特征向量与 group 的相关性
 * ------------------------------------------------------------------ */
function pearson(a, b) {
  const n = a.length
  const ma = a.reduce((s, x) => s + x, 0) / n
  const mb = b.reduce((s, x) => s + x, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  fs.mkdirSync(opts.out, { recursive: true })

  const data = buildData(opts.seed)
  const exprFile = path.join(opts.out, 'wgcna-demo-expression.tsv')
  const traitFile = path.join(opts.out, 'wgcna-demo-trait.txt')
  writeExpression(exprFile, data)
  writeTraits(traitFile, data)

  // 用模块 A 的「样本方向平均谱」与 group 求相关，作为相关性自检。
  // 注意是「对基因求平均、得到 24 维样本向量」，不是对样本求平均。
  const moduleA = data.rows.slice(0, MODULE_SIZE)
  const sampleProfile = Array.from({ length: N_SAMPLES }, (_, i) => {
    let sum = 0
    for (const row of moduleA) sum += row.values[i]
    return sum / moduleA.length
  })
  const r = pearson(sampleProfile, data.group)

  console.log(`[gen-wgcna-demo] expression -> ${exprFile}`)
  console.log(`[gen-wgcna-demo] trait      -> ${traitFile}`)
  console.log(`[gen-wgcna-demo] matrix     : ${data.rows.length} genes x ${data.sampleNames.length} samples`)
  console.log(`[gen-wgcna-demo] samples    : ${data.sampleNames.slice(0, 3).join(', ')} ... ${data.sampleNames.slice(-1)[0]}`)
  console.log(`[gen-wgcna-demo] traits     : ${data.sampleNames.length} rows, columns = sample, group, stage`)
  console.log(`[gen-wgcna-demo] module A mean profile vs group r = ${r.toFixed(3)}`)
  console.log(`[gen-wgcna-demo] bytes      : expr=${fs.statSync(exprFile).size}, trait=${fs.statSync(traitFile).size}`)
}

main()
