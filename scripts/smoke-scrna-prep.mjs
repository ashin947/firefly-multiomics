/**
 * 单细胞第 3 步冒烟 —— 标准化 / PCA / 批次校正的两条关键行为。
 *
 * ## 为什么这两条必须有
 *
 *  1. **单样本必须跳过 harmony**：`IntegrateLayers` 是按 merge 产生的**层**分组的，
 *     只有一层时既没有可校正对象、也会直接抛错。跳过不是错误路径，而是正确结果 ——
 *     但必须同时把 `activeReduction` 设成 `"pca"`，否则下游第 4 步会去读一个
 *     不存在的 `"harmony"` reduction，表现是「图空白」或「reduction not found」。
 *
 *  2. **`activeReduction` 必须与真实存在的 reduction 一致**：这是第 4 步及以后
 *     唯一的降维入口。如果 R 说 `"harmony"` 而对象里只有 `"pca"`（或反过来），
 *     错误会在几步之后才以「找不到对象」的形式爆出来，极难回溯。
 *     所以这里不只断言字段值，还要**读回 rds 核对 reductions 列表**。
 *
 * 另外顺带钉住：单样本时不生成 p04（harmony 前后对比）那张图。
 *
 * ## 为什么造两个小对象而不是跑真实数据
 *
 * 真实数据跑一次 88 s，而且依赖 `D:/ai/data/...` 是否存在。这里用 Seurat 现场造
 * 「2 样本 / 1 样本」各一个 120 基因 × 8 细胞的对象，跑完整 prep 流程，几秒出结果，
 * 且能在任何机器上复现。（真实数据的数字在 DEV-NOTES §24 里。）
 *
 * 用法：
 *   node scripts/smoke-scrna-prep.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-prep.mjs
 * 退出码：全过 0 / 有断言失败 1 / 找不到 Rscript 4
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
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/x64/Rscript.exe']
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript']
  for (const c of candidates) if (fs.existsSync(c)) return c
  return ''
}

const out = []
function expect(name, ok, detail) {
  out.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

const rscript = findRscript()
if (!rscript) {
  console.error('找不到 Rscript：请设 DEG_RSCRIPT，或确认 resources/runtime/R 存在')
  process.exit(4)
}

// 细胞数不能太少：irlba 的 PCA 要求 npcs < min(基因数, 细胞数)，
// 而 harmony 的 kmeans 也需要足够细胞才能分簇。60 细胞/样本是最小的稳妥值。
const N_GENES = 200
const N_CELLS = 60

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-prep-'))

/**
 * 造一个 obj_step2.rds。`samples` 给几个就造几个样本。
 *
 * 基因数取 120（> min.features 的门槛，也够 FindVariableFeatures 选 HVG）；
 * 每列用不同的随机种子，保证有方差可供 vst 挑选。
 */
function makeStep2(dir, samples) {
  fs.mkdirSync(dir, { recursive: true })
  const rCode = `
    suppressMessages({library(Seurat); library(Matrix)})
    genes <- sprintf("GENE%03d", 1:${N_GENES})
    make <- function(sample, seed) {
      set.seed(seed)
      m <- Matrix(matrix(rpois(length(genes) * ${N_CELLS}, 40), nrow = length(genes),
                         dimnames = list(genes, paste0(sample, "_c", 1:${N_CELLS}))), sparse = TRUE)
      o <- CreateSeuratObject(counts = m, project = sample, min.cells = 0, min.features = 0)
      o$orig.ident <- sample
      o
    }
    samples <- c(${samples.map((x) => JSON.stringify(x)).join(', ')})
    objs <- lapply(seq_along(samples), function(i) make(samples[i], i))
    obj <- if (length(objs) == 1) objs[[1]] else
      merge(objs[[1]], y = objs[-1], add.cell.ids = samples, project = "smoke")
    saveRDS(obj, ${JSON.stringify(path.join(dir, 'obj_step2.rds').replace(/\\/g, '/'))})
    cat("object:", nrow(obj), "x", ncol(obj), "\\n")
  `
  const p = path.join(dir, 'make.R')
  fs.writeFileSync(p, rCode, 'utf8')
  execFileSync(rscript, ['--vanilla', p], { encoding: 'utf8', stdio: 'pipe' })
}

function runPrep(dir, nFeatures = 150, nPcs = 10) {
  const config = {
    runId: path.basename(dir),
    runDir: dir,
    projectRoot: path.dirname(dir),
    params: { objectFile: 'obj_step2.rds', nFeatures, nPcs, skipFonts: true }
  }
  fs.writeFileSync(path.join(dir, 'run_config.json'), JSON.stringify(config, null, 2), 'utf8')

  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync(
      rscript,
      ['--vanilla', path.join(ROOT, 'r', 'scrna', 'run_scrna_prep.R'), '--config', 'run_config.json'],
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
    stdout,
    summary: resultLine ? JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary : null,
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@"? /, '')) : null
  }
}

/** 读回 rds，拿到真实的 reductions 列表与被写进 activeReduction 的对照 */
function readReductions(dir) {
  const p = path.join(dir, 'check.R')
  fs.writeFileSync(
    p,
    `Sys.unsetenv("LC_ALL")
suppressMessages(library(Seurat))
obj <- readRDS(${JSON.stringify(path.join(dir, 'obj_step3.rds').replace(/\\/g, '/'))})
cat("REDUCTIONS:", paste(names(obj@reductions), collapse = ","), "\\n")
`,
    'utf8'
  )
  const text = execFileSync(rscript, ['--vanilla', p], { encoding: 'utf8', stdio: 'pipe' })
  const line = text.split('\n').find((l) => l.startsWith('REDUCTIONS:')) ?? ''
  return line.replace('REDUCTIONS:', '').trim().split(',').filter(Boolean)
}

try {
  /* ================= 用例 1：单样本 → 跳过 harmony ================= */
  console.log('\n--- 用例 1：单样本（应跳过 harmony，activeReduction = pca）---')
  const one = path.join(work, 'one-sample')
  makeStep2(one, ['S1'])
  const r1 = runPrep(one)
  expect('prep 正常结束（单样本不是错误）', r1.exitCode === 0 && Boolean(r1.summary),
    r1.error ? `错误: ${r1.error.message}` : `exit=${r1.exitCode}`)
  if (r1.summary) {
    expect('harmonyApplied = false', r1.summary.harmonyApplied === false, '')
    expect('activeReduction = "pca"', r1.summary.activeReduction === 'pca',
      `activeReduction=${r1.summary.activeReduction}`)
    expect('没有生成 p04（harmony 前后对比）图',
      !fs.existsSync(path.join(one, 'p04_harmony_before_after.png')) &&
        !(r1.summary.plots ?? []).some((p) => p.id === 'harmony'),
      `plots=${JSON.stringify((r1.summary.plots ?? []).map((p) => p.id))}`)
    expect('仍然生成了 pca 图', (r1.summary.plots ?? []).some((p) => p.id === 'pca'), '')
    expect('nHVG > 0', r1.summary.nHVG > 0, `nHVG=${r1.summary.nHVG}`)

    const reds = readReductions(one)
    expect('对象里只有 pca 这一个 reduction', reds.length === 1 && reds[0] === 'pca',
      `reductions=${JSON.stringify(reds)}`)
    // ★ 这条最关键：下游只认 activeReduction，必须与对象里真实存在的名字一致
    expect('activeReduction 与对象里的 reduction 一致',
      reds.includes(r1.summary.activeReduction),
      `activeReduction=${r1.summary.activeReduction} 实际=${JSON.stringify(reds)}`)
  }

  /* ================= 用例 2：两个样本 → harmony ================= */
  console.log('\n--- 用例 2：两个样本（应做 harmony，activeReduction = harmony）---')
  const two = path.join(work, 'two-samples')
  makeStep2(two, ['S1', 'S2'])
  const r2 = runPrep(two)
  expect('prep 正常结束', r2.exitCode === 0 && Boolean(r2.summary),
    r2.error ? `错误: ${r2.error.message}` : `exit=${r2.exitCode}`)
  if (r2.summary) {
    expect('harmonyApplied = true', r2.summary.harmonyApplied === true, '')
    expect('activeReduction = "harmony"', r2.summary.activeReduction === 'harmony',
      `activeReduction=${r2.summary.activeReduction}`)
    expect('生成了 p04（harmony 前后对比）图',
      fs.existsSync(path.join(two, 'p04_harmony_before_after.png')), '')

    const reds = readReductions(two)
    expect('对象里同时有 pca 与 harmony',
      reds.includes('pca') && reds.includes('harmony'), `reductions=${JSON.stringify(reds)}`)
    expect('activeReduction 与对象里的 reduction 一致',
      reds.includes(r2.summary.activeReduction),
      `activeReduction=${r2.summary.activeReduction} 实际=${JSON.stringify(reds)}`)
  }

  /* ================= 用例 3：没有 obj_step2.rds → 明确报错 ================= */
  console.log('\n--- 用例 3：缺少第 2 步对象时应明确报 E_DATA_MISSING ---')
  const empty = path.join(work, 'no-step2')
  fs.mkdirSync(empty, { recursive: true })
  const r3 = runPrep(empty)
  expect('报 E_DATA_MISSING 且提示先跑过滤',
    r3.error?.code === 'E_DATA_MISSING' && /run the QC filter first/i.test(r3.error.message),
    r3.error ? `${r3.error.code}: ${r3.error.message}` : '没有错误行')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
