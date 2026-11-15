/**
 * 「从已有 rds 继续」冒烟 —— 检查/落盘这一步的四类判定。
 *
 * ## 为什么这四条必须分开测
 *
 * 用户手里的 rds 什么都有：别人的对象、旧版 Seurat 存的、根本不是 Seurat 对象、
 * 甚至半截下载的损坏文件。如果一律报「读取失败」，用户无法判断是自己选错了文件
 * 还是软件坏了。这里把四种情况各自钉住：
 *
 *   · 有降维、无聚类      → 第 4 步可用，第 5/6 步不行（缺 clusters）
 *   · 无降维              → 第 4 步不行，提示「从第 3 步开始」
 *   · 不是 Seurat 对象    → 明确说 class
 *   · 文件损坏 / 路径不存在 → 两种不同的错误码
 *
 * 另外钉住「降维名推断」：misc 优先，其次 harmony → pca —— 第 4 步直接读它，
 * 不在下游再判一次样本数。
 *
 * 用法：
 *   node scripts/smoke-scrna-import-object.mjs
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
  for (const c of ['D:/R-4.3.2/bin/x64/Rscript.exe', '/usr/bin/Rscript']) {
    if (fs.existsSync(c)) return c
  }
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-importobj-'))
const inspectDir = path.join(work, 'inspect')
fs.mkdirSync(inspectDir, { recursive: true })

/** 造三个对象：只有 counts / 有降维 / 有降维+聚类；另加一个损坏文件与一个非 Seurat 对象 */
function makeFixtures() {
  const script = path.join(work, 'make.R')
  const p = (name) => JSON.stringify(path.join(work, name).replace(/\\/g, '/'))
  fs.writeFileSync(
    script,
    `Sys.unsetenv("LC_ALL")
suppressMessages({library(Seurat); library(Matrix)})
set.seed(1)
genes <- sprintf("Os01g%07d", 1:120)
cells <- paste0("c", 1:60)
m <- Matrix(matrix(rpois(length(genes) * length(cells), 20), nrow = length(genes),
                   dimnames = list(genes, cells)), sparse = TRUE)

base <- CreateSeuratObject(counts = m, project = "x", min.cells = 0, min.features = 0)
base$orig.ident <- "S1"
saveRDS(base, ${p('only_counts.rds')})

withred <- NormalizeData(base, verbose = FALSE)
withred <- FindVariableFeatures(withred, nfeatures = 100, verbose = FALSE)
withred <- ScaleData(withred, features = VariableFeatures(withred), verbose = FALSE)
withred <- RunPCA(withred, npcs = 10, features = VariableFeatures(withred), verbose = FALSE)
# 造一个 misc$activeReduction 缺失但有 pca 的对象，验证推断
saveRDS(withred, ${p('with_reduction.rds')})

clustered <- FindNeighbors(withred, dims = 1:10, verbose = FALSE)
clustered <- FindClusters(clustered, resolution = 0.5, verbose = FALSE)
saveRDS(clustered, ${p('with_clusters.rds')})

# 非 Seurat 对象
saveRDS(list(a = 1, b = 2), ${p('not_seurat.rds')})
cat("fixtures ok\\n")
`,
    'utf8'
  )
  execFileSync(rscript, ['--vanilla', script], { encoding: 'utf8', stdio: 'pipe' })
  // 损坏文件：写一段不是 rds 的字节
  fs.writeFileSync(path.join(work, 'corrupt.rds'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))
}

function inspect(file, targetStep) {
  const config = {
    runId: 'inspect',
    runDir: inspectDir,
    projectRoot: work,
    params: { path: file, targetStep, skipFonts: true }
  }
  fs.writeFileSync(path.join(inspectDir, 'c.json'), JSON.stringify(config, null, 2), 'utf8')
  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync(
      rscript,
      ['--vanilla', path.join(ROOT, 'r', 'scrna', 'run_scrna_inspect.R'), '--config', 'c.json'],
      {
        cwd: inspectDir,
        encoding: 'utf8',
        env: { ...process.env, DEG_R_ROOT: path.join(ROOT, 'r'), DEG_RESOURCES_ROOT: path.join(ROOT, 'resources') }
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

try {
  makeFixtures()

  /* ---------- 有降维、无聚类：第 4 步可用，5/6 不行 ---------- */
  console.log('\n--- 有降维、无聚类（with_reduction.rds）---')
  const r4 = inspect(path.join(work, 'with_reduction.rds'), 4)
  expect('第 4 步：ok = true', r4.summary?.ok === true, `message=${r4.summary?.message}`)
  expect('降维名推断为 pca（对象没有 misc，只有 pca）',
    r4.summary?.suggestedReduction === 'pca', `suggestedReduction=${r4.summary?.suggestedReduction}`)
  expect('readyFor 里 4 为 true、5/6 为 false',
    r4.summary?.readyFor?.['4'] === true &&
      r4.summary?.readyFor?.['5'] === false &&
      r4.summary?.readyFor?.['6'] === false,
    JSON.stringify(r4.summary?.readyFor))
  expect('水稻基因名判为 other（不是人/鼠）', r4.summary?.strain === 'other',
    `strain=${r4.summary?.strain}`)

  const r5bad = inspect(path.join(work, 'with_reduction.rds'), 5)
  expect('第 5 步：ok = false 且指出缺 clusters',
    r5bad.summary?.ok === false && (r5bad.summary?.missing ?? []).includes('clusters column'),
    `missing=${JSON.stringify(r5bad.summary?.missing)}`)
  expect('第 5 步的提示要求「从第 4 步开始」',
    /step 4/i.test(r5bad.summary?.message ?? ''), r5bad.summary?.message)

  /* ---------- 有聚类的对象：第 5/6 步可用 ---------- */
  console.log('\n--- 有聚类的对象（with_clusters.rds）---')
  const r5 = inspect(path.join(work, 'with_clusters.rds'), 5)
  expect('第 5 步：ok = true', r5.summary?.ok === true, `message=${r5.summary?.message}`)
  const r6 = inspect(path.join(work, 'with_clusters.rds'), 6)
  expect('第 6 步：ok = true', r6.summary?.ok === true, `message=${r6.summary?.message}`)
  expect('第 6 步在没有 marker 表时只提示不阻断',
    /no marker table/i.test(r6.summary?.message ?? ''), r6.summary?.message)

  /* ---------- 没有降维的对象：第 4 步必须拒绝 ---------- */
  console.log('\n--- 只有 counts（only_counts.rds）---')
  const r4bad = inspect(path.join(work, 'only_counts.rds'), 4)
  expect('第 4 步：ok = false', r4bad.summary?.ok === false, '')
  expect('提示「没有降维，请从第 3 步开始」',
    /no dimension reduction/i.test(r4bad.summary?.message ?? ''), r4bad.summary?.message)

  /* ---------- 三种「读不了」必须分开 ---------- */
  console.log('\n--- 错误路径 ---')
  const notSeurat = inspect(path.join(work, 'not_seurat.rds'), 4)
  expect('不是 Seurat 对象 → 明确说 class',
    notSeurat.error?.code === 'E_DATA_INVALID' && /not a Seurat object/i.test(notSeurat.error?.message ?? ''),
    notSeurat.error?.message?.slice(0, 90))

  const corrupt = inspect(path.join(work, 'corrupt.rds'), 4)
  expect('损坏文件 → 明确说「无法读取」',
    corrupt.error?.code === 'E_DATA_INVALID' && /cannot read this/i.test(corrupt.error?.message ?? ''),
    corrupt.error?.message?.slice(0, 90))

  const missingFile = inspect(path.join(work, 'no-such-file.rds'), 4)
  expect('路径不存在 → E_DATA_MISSING',
    missingFile.error?.code === 'E_DATA_MISSING', missingFile.error?.message?.slice(0, 90))
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
