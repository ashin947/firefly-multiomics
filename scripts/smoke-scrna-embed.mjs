/**
 * 单细胞第 4 步冒烟 —— 聚类 / 降维的三条硬约束。
 *
 * ## 为什么这三条要有测试
 *
 *  1. **单样本必须走 `pca`**：第 3 步单样本没有 harmony，第 4 步若仍去读 `"harmony"`
 *     会直接报 `reduction not found`。而这里的判定必须来自**对象自己**（`misc$activeReduction`），
 *     不能各自判断样本数。
 *
 *  2. **聚类列名必须是 `clusters`，不能是 `harmony_clusters`**：客户脚本用的是后者
 *     （因为他的场景一定有 harmony），但我们的单样本场景没有。列名带 harmony 会让
 *     后续 Marker / 注释 / 下游全都建立在错误前提上 —— 而且**不会报错**，
 *     只是 `obj$harmony_clusters` 在单样本对象里是 NULL。
 *
 *  3. **reduction 名固定 `umap` / `tsne`**：不带 `.harmony` 后缀，两种模式共用。
 *     若哪天有人给它加上后缀，第 5 步及以后的 `reduction = "umap"` 全部会失效。
 *
 * 断言方式上，不只看 summary 字段，还**读回 rds 核对**：reductions 列表里真的有
 * umap/tsne、meta.data 里真的有 clusters 列、且**没有** harmony_clusters。
 *
 * 用法：
 *   node scripts/smoke-scrna-embed.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-embed.mjs
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
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/Rscript.exe']
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

// 细胞数不能太少：irlba 的 PCA / UMAP / tSNE 都需要「细胞数 > 维数」
const N_GENES = 200
const N_CELLS = 60

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-embed-'))

/** 造 obj_step2.rds（samples 给几个就造几个样本） */
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

function runScript(dir, scriptRel, params) {
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
      ['--vanilla', path.join(ROOT, 'r', 'scrna', scriptRel), '--config', 'run_config.json'],
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
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@ /, '')) : null
  }
}

/** 读回 obj_step4.rds，核对 reductions 与 meta.data 列名 */
function inspectObject(dir) {
  const p = path.join(dir, 'check.R')
  fs.writeFileSync(
    p,
    `Sys.unsetenv("LC_ALL")
suppressMessages(library(Seurat))
obj <- readRDS(${JSON.stringify(path.join(dir, 'obj_step4.rds').replace(/\\/g, '/'))})
cat("REDUCTIONS:", paste(names(obj@reductions), collapse = ","), "\\n")
cat("META:", paste(colnames(obj@meta.data), collapse = ","), "\\n")
cat("IDENTS:", paste(levels(Seurat::Idents(obj)), collapse = ","), "\\n")
cat("MISC_ACTIVE:", as.character(obj@misc$activeReduction), "\\n")
`,
    'utf8'
  )
  const text = execFileSync(rscript, ['--vanilla', p], { encoding: 'utf8', stdio: 'pipe' })
  const get = (prefix) =>
    (text.split('\n').find((l) => l.startsWith(prefix)) ?? '').replace(prefix, '').trim()
  return {
    reductions: get('REDUCTIONS:').split(',').filter(Boolean),
    meta: get('META:').split(',').filter(Boolean),
    idents: get('IDENTS:').split(',').filter(Boolean),
    miscActive: get('MISC_ACTIVE:')
  }
}

try {
  /* ================= 用例 1：单样本（走 pca） ================= */
  console.log('\n--- 用例 1：单样本（应使用 pca，reduction 名固定 umap/tsne）---')
  const one = path.join(work, 'one')
  makeStep2(one, ['S1'])
  const prep1 = runScript(one, 'run_scrna_prep.R', { objectFile: 'obj_step2.rds', nFeatures: 150, nPcs: 10 })
  expect('第 3 步（单样本）正常结束', prep1.exitCode === 0 && Boolean(prep1.summary), '')

  const e1 = runScript(one, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.25 })
  expect('第 4 步正常结束', e1.exitCode === 0 && Boolean(e1.summary),
    e1.error ? `错误: ${e1.error.message}` : `exit=${e1.exitCode}`)
  if (e1.summary) {
    expect('activeReduction = "pca"（单样本没有 harmony）', e1.summary.activeReduction === 'pca',
      `activeReduction=${e1.summary.activeReduction}`)
    expect('cluster 列名是 clusters', e1.summary.clusterColumn === 'clusters',
      `clusterColumn=${e1.summary.clusterColumn}`)
    expect('nClusters > 0', e1.summary.nClusters > 0, `nClusters=${e1.summary.nClusters}`)
    expect('生成了 6 张图', (e1.summary.plots ?? []).length === 6,
      `plots=${JSON.stringify((e1.summary.plots ?? []).map((p) => p.id))}`)

    const obj = inspectObject(one)
    expect('对象里有 umap 与 tsne（名字不带后缀）',
      obj.reductions.includes('umap') && obj.reductions.includes('tsne'),
      `reductions=${JSON.stringify(obj.reductions)}`)
    expect('单样本对象里**没有** harmony', !obj.reductions.includes('harmony'),
      `reductions=${JSON.stringify(obj.reductions)}`)
    expect('meta.data 里有 clusters 列', obj.meta.includes('clusters'), '')
    expect('meta.data 里**没有** harmony_clusters',
      !obj.meta.some((c) => c.includes('harmony_clusters')),
      `meta=${JSON.stringify(obj.meta.filter((c) => c.includes('cluster')))}`)
    expect('Idents 是 cluster 的 level',
      obj.idents.length === e1.summary.nClusters, `idents=${JSON.stringify(obj.idents)}`)
  }

  /* ================= 用例 2：两个样本（走 harmony） ================= */
  console.log('\n--- 用例 2：两个样本（应使用 harmony）---')
  const two = path.join(work, 'two')
  makeStep2(two, ['S1', 'S2'])
  const prep2 = runScript(two, 'run_scrna_prep.R', { objectFile: 'obj_step2.rds', nFeatures: 150, nPcs: 10 })
  expect('第 3 步（两样本）正常结束', prep2.exitCode === 0 && Boolean(prep2.summary), '')

  const e2 = runScript(two, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.25 })
  expect('第 4 步正常结束', e2.exitCode === 0 && Boolean(e2.summary),
    e2.error ? `错误: ${e2.error.message}` : `exit=${e2.exitCode}`)
  if (e2.summary) {
    expect('activeReduction = "harmony"', e2.summary.activeReduction === 'harmony',
      `activeReduction=${e2.summary.activeReduction}`)
    expect('reduction 名仍是 umap / tsne（不带 .harmony 后缀）',
      e2.summary.reductions.includes('umap') && e2.summary.reductions.includes('tsne'),
      `reductions=${JSON.stringify(e2.summary.reductions)}`)
    expect('每个 cluster 都有 perSample 拆分',
      (e2.summary.perCluster ?? []).every((c) => (c.perSample ?? []).length > 0),
      `perCluster[0]=${JSON.stringify((e2.summary.perCluster ?? [])[0])}`)

    const obj = inspectObject(two)
    expect('meta.data 里仍**没有** harmony_clusters',
      !obj.meta.some((c) => c.includes('harmony_clusters')), '')
  }

  /* ================= 用例 3：resolution 生效 ================= */
  console.log('\n--- 用例 3：不同 resolution 应给出不同结果 ---')
  const coarse = runScript(two, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.02 })
  if (coarse.summary && e2.summary) {
    expect('resolution 0.02 的 cluster 数不多于 0.25',
      coarse.summary.nClusters <= e2.summary.nClusters,
      `0.02 -> ${coarse.summary.nClusters} 个；0.25 -> ${e2.summary.nClusters} 个`)
  } else {
    expect('resolution 0.02 跑通', false, coarse.error?.message ?? '')
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
