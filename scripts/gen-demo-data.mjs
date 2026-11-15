#!/usr/bin/env node
/**
 * gen-demo-data.mjs —— 生成可复现的示例数据集（T06 第 5 条）
 *
 * 产物：
 *   resources/demo/expression.csv  24 样本 × 2000 基因的负二项 counts（行=基因，列=样本）
 *   resources/demo/groups.csv      sample,group（12 Tumor / 12 Normal）
 *
 * 设计要点：
 *   - **固定随机种子**（默认 20250612），任何机器上重跑得到逐字节相同的数据；
 *   - 前 200 个基因植入真实差异（100 上调 / 100 下调，倍数 2~5），
 *     保证 DESeq2 / limma 跑完能拿到「显著基因」，用于 S3 自测与人工核对；
 *   - 前 20 个基因用真实基因符号（TP53/EGFR/MYC...），方便用户直接搜索做箱线图；
 *   - 负二项分布 = Gamma-Poisson 混合（与真实 RNA-seq counts 的过离散特性一致）。
 *
 * 用法：
 *   node scripts/gen-demo-data.mjs
 *   node scripts/gen-demo-data.mjs --seed 42 --genes 2000 --samples 24 --out resources/demo
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
  const opts = {
    seed: 20250612,
    genes: 2000,
    samples: 24,
    deGenes: 200,
    out: path.join(REPO_ROOT, 'resources', 'demo')
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--seed') opts.seed = Number(argv[++i])
    else if (arg === '--genes') opts.genes = Number(argv[++i])
    else if (arg === '--samples') opts.samples = Number(argv[++i])
    else if (arg === '--de') opts.deGenes = Number(argv[++i])
    else if (arg === '--out') opts.out = path.resolve(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: node scripts/gen-demo-data.mjs [--seed N] [--genes N] [--samples N] [--de N] [--out DIR]'
      )
      process.exit(0)
    }
  }
  if (!Number.isFinite(opts.seed)) throw new Error('--seed 必须是数字')
  if (!Number.isInteger(opts.genes) || opts.genes < 10) throw new Error('--genes 必须 ≥ 10')
  if (!Number.isInteger(opts.samples) || opts.samples < 4 || opts.samples % 2 !== 0) {
    throw new Error('--samples 必须是 ≥ 4 的偶数（一半 Tumor 一半 Normal）')
  }
  return opts
}

/* ------------------------------------------------------------------ *
 * 可复现随机数（mulberry32 + Box-Muller）
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const uniform = mulberry32(seed)
  let spare = null

  const rng = {
    uniform,
    /** 标准正态（Box-Muller，缓存第二个值） */
    normal() {
      if (spare !== null) {
        const v = spare
        spare = null
        return v
      }
      let u = 0
      let v = 0
      while (u === 0) u = uniform()
      while (v === 0) v = uniform()
      const mag = Math.sqrt(-2 * Math.log(u))
      spare = mag * Math.sin(2 * Math.PI * v)
      return mag * Math.cos(2 * Math.PI * v)
    },
    /** Poisson：λ 小时用 Knuth，λ 大时用正态近似（demo 数据无需极致精确） */
    poisson(lambda) {
      if (lambda <= 0) return 0
      if (lambda < 30) {
        const L = Math.exp(-lambda)
        let k = 0
        let p = 1
        do {
          k += 1
          p *= uniform()
        } while (p > L && k < 1000)
        return k - 1
      }
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()))
    },
    /** Gamma(shape, scale)，Marsaglia-Tsang */
    gamma(shape, scale) {
      if (shape < 1) {
        // 提升：Gamma(a) = Gamma(a+1) * U^(1/a)
        return rng.gamma(shape + 1, scale) * Math.pow(uniform(), 1 / shape)
      }
      const d = shape - 1 / 3
      const c = 1 / Math.sqrt(9 * d)
      for (;;) {
        let x
        let v
        do {
          x = rng.normal()
          v = 1 + c * x
        } while (v <= 0)
        v = v * v * v
        const u = uniform()
        if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
      }
    },
    /** 负二项：Gamma-Poisson 混合（mu = 均值，size = 离散度参数，越小越过离散） */
    negBinomial(mu, size) {
      if (mu <= 0) return 0
      const lambda = rng.gamma(size, mu / size)
      return rng.poisson(lambda)
    }
  }
  return rng
}

/* ------------------------------------------------------------------ *
 * 基因符号
 * ------------------------------------------------------------------ */
const REAL_SYMBOLS = [
  'TP53', 'EGFR', 'MYC', 'KRAS', 'BRCA1', 'BRCA2', 'PTEN', 'RB1', 'CDKN2A', 'ALK',
  'MET', 'ERBB2', 'PIK3CA', 'APC', 'VHL', 'NF1', 'SMAD4', 'CTNNB1', 'JAK2', 'STAT3',
  'GAPDH', 'ACTB', 'TUBB', 'HPRT1', 'B2M', 'TBP', 'RPLP0', 'PPIA', 'GUSB', 'TFRC'
]

function buildGeneIds(count) {
  const ids = []
  for (let i = 0; i < count; i += 1) {
    if (i < REAL_SYMBOLS.length) {
      ids.push(REAL_SYMBOLS[i])
    } else {
      ids.push(`GENE${String(i + 1).padStart(4, '0')}`)
    }
  }
  return ids
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  const opts = parseArgs(process.argv.slice(2))
  const rng = makeRng(opts.seed)

  const half = opts.samples / 2
  const samples = []
  const groups = []
  for (let i = 0; i < opts.samples; i += 1) {
    const name = `S${String(i + 1).padStart(2, '0')}`
    samples.push(name)
    groups.push(i < half ? 'Tumor' : 'Normal')
  }

  const geneIds = buildGeneIds(opts.genes)

  // 每个样本的文库大小因子（lognormal，sd=0.18 模拟建库差异）
  const sizeFactors = samples.map(() => Math.exp(rng.normal() * 0.18))

  // 每个基因的基线表达（lognormal，多数基因低表达、少数高表达）
  const baseMeans = []
  for (let g = 0; g < opts.genes; g += 1) {
    const mu = Math.exp(rng.normal() * 1.25 + 3.0)
    baseMeans.push(Math.min(20000, Math.max(1, mu)))
  }

  // 植入真实差异：前 deGenes 个基因，前一半上调、后一半下调
  const deCount = Math.min(opts.deGenes, opts.genes)
  const foldChanges = new Array(opts.genes).fill(1)
  for (let g = 0; g < deCount; g += 1) {
    const up = g < deCount / 2
    // 倍数 2~5 之间随机
    const fc = 2 + rng.uniform() * 3
    foldChanges[g] = up ? fc : 1 / fc
  }

  // 离散度：越小越过离散；真实 RNA-seq 常见 0.02~0.3
  const dispersions = []
  for (let g = 0; g < opts.genes; g += 1) {
    dispersions.push(0.02 + rng.uniform() * 0.28)
  }

  // 逐基因逐样本抽 counts
  const rows = []
  for (let g = 0; g < opts.genes; g += 1) {
    const values = []
    for (let s = 0; s < opts.samples; s += 1) {
      const isTumor = groups[s] === 'Tumor'
      const mu = baseMeans[g] * sizeFactors[s] * (isTumor ? foldChanges[g] : 1)
      values.push(rng.negBinomial(mu, 1 / dispersions[g]))
    }
    rows.push(values)
  }

  // ---- 写出 expression.csv ----
  fs.mkdirSync(opts.out, { recursive: true })
  const expressionPath = path.join(opts.out, 'expression.csv')
  const lines = [`gene_id,${samples.join(',')}`]
  for (let g = 0; g < opts.genes; g += 1) {
    lines.push(`${geneIds[g]},${rows[g].join(',')}`)
  }
  fs.writeFileSync(expressionPath, `${lines.join('\n')}\n`, 'utf8')

  // ---- 写出 groups.csv ----
  const groupsPath = path.join(opts.out, 'groups.csv')
  const groupLines = ['sample,group']
  for (let s = 0; s < opts.samples; s += 1) {
    groupLines.push(`${samples[s]},${groups[s]}`)
  }
  fs.writeFileSync(groupsPath, `${groupLines.join('\n')}\n`, 'utf8')

  // ---- 自检统计（打印出来便于人工确认数据合理性）----
  let total = 0
  let zeros = 0
  let allZeroGenes = 0
  for (let g = 0; g < opts.genes; g += 1) {
    let rowSum = 0
    for (let s = 0; s < opts.samples; s += 1) {
      const v = rows[g][s]
      total += v
      rowSum += v
      if (v === 0) zeros += 1
    }
    if (rowSum === 0) allZeroGenes += 1
  }
  const cells = opts.genes * opts.samples

  const exprSize = fs.statSync(expressionPath).size
  console.log('示例数据生成完成')
  console.log(`  种子        : ${opts.seed}`)
  console.log(`  矩阵        : ${opts.genes} 基因 × ${opts.samples} 样本（${half} Tumor / ${half} Normal）`)
  console.log(`  植入差异基因: ${deCount} 个（${deCount / 2} 上调 / ${deCount / 2} 下调，倍数 2~5）`)
  console.log(`  平均 count  : ${(total / cells).toFixed(1)}`)
  console.log(`  零值比例    : ${((zeros / cells) * 100).toFixed(1)}%`)
  console.log(`  全零基因    : ${allZeroGenes}`)
  console.log(`  expression  : ${expressionPath} (${(exprSize / 1024).toFixed(1)} KB)`)
  console.log(`  groups      : ${groupsPath}`)
}

try {
  main()
} catch (err) {
  console.error(`生成示例数据失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
