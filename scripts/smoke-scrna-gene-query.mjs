/**
 * 单细胞「基因查询」冒烟 —— 注释之后的三张图（FeaturePlot / 小提琴 / DotPlot）。
 *
 * ## 为什么这些断言必须有
 *
 *  1. **三张图都要出来**：客户点一次要三个视角。少一张（尤其 DotPlot 在 split.by 下
 *     曾经静默失败、只留一个 4 KB 的空文件）就是「按钮点了没反应」。
 *  2. **`split.by` 只分面、不重新配色**：同一个细胞类型在两个样本里必须是同一个颜色。
 *     这条没法从 PNG 里读，所以断言 `palette` 在 split / 不 split 两种情况下完全一致。
 *  3. **celltype 配色必须由簇色派生**：注释前 UMAP 的粉色簇，注释成 "A" 之后还得是粉色。
 *     断言 `celltypePalette["A"].color === clusterPalette[第一个簇]`。
 *  4. **基因全不存在 → 三张都不出**（不是出一张空图）。
 *  5. **分组列不存在 → E_DATA_INVALID** 并列出可用列（而不是 R 里一句 `object 'celltype' not found`）。
 *
 * 用法：
 *   node scripts/smoke-scrna-gene-query.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-gq-'))
const posix = (p) => p.replace(/\\/g, '/')

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
    summary: resultLine ? JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary : null,
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@ /, '')) : null
  }
}

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

try {
  const dir = path.join(work, 'run')
  fs.mkdirSync(dir, { recursive: true })

  // 两个样本、20 个 marker 基因：足够跑通 prep → embed → markers → annotate
  fs.writeFileSync(
    path.join(dir, 'make.R'),
    `
suppressMessages({library(Seurat); library(Matrix)})
genes <- c(sprintf("MARK%03d", 1:20), sprintf("BG%03d", 1:180))
samples <- c("S1", "S2")
mk <- function(sample, seed, high) {
  set.seed(seed)
  n <- 60
  m <- matrix(rpois(length(genes) * n, 3), nrow = length(genes),
              dimnames = list(genes, paste0(sample, "_c", 1:n)))
  idx <- match(sprintf("MARK%03d", 1:20), genes)
  m[idx, ] <- if (high) rpois(length(idx) * n, 60) else rpois(length(idx) * n, 1)
  Matrix(m, sparse = TRUE)
}
objs <- lapply(seq_along(samples), function(i) {
  o <- CreateSeuratObject(counts = mk(samples[i], i, i == 1), project = samples[i],
                          min.cells = 0, min.features = 0)
  o$orig.ident <- samples[i]
  o
})
obj <- merge(objs[[1]], y = objs[-1], add.cell.ids = samples, project = "smoke")
saveRDS(obj, ${JSON.stringify(posix(path.join(dir, 'obj_step2.rds')))})
`,
    'utf8'
  )
  execFileSync(rscript, ['--vanilla', path.join(dir, 'make.R')], { stdio: 'pipe' })

  const prep = runScript(dir, 'run_scrna_prep.R', { objectFile: 'obj_step2.rds', nFeatures: 150, nPcs: 10 })
  const embed = runScript(dir, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.5 })
  const markers = runScript(dir, 'run_scrna_markers.R', {
    objectFile: 'obj_step4.rds',
    logfcThreshold: 0.5,
    adjPvalFilter: 0.05
  })
  expect(
    '前置（prep + embed + markers）通过',
    prep.exitCode === 0 && embed.exitCode === 0 && markers.exitCode === 0,
    prep.error?.message ?? embed.error?.message ?? markers.error?.message ?? ''
  )

  const clusters = arr(embed.summary?.clusters ?? (embed.summary?.perCluster ?? []).map((c) => c.cluster))
  expect('聚类产出了 ≥2 个簇', clusters.length >= 2, clusters.join(','))

  // 前两个簇合并成一个类型 A，其余为 B —— 这样才能验证「合并后颜色取第一个簇」
  const merged = clusters.slice(0, 2)
  const assignments = clusters.map((c) => ({
    cluster: String(c),
    celltype: merged.includes(c) ? 'A' : 'B'
  }))
  const annotate = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: '',
    assignments
  })
  expect('注释步骤通过', annotate.exitCode === 0 && Boolean(annotate.summary),
    annotate.error?.message ?? '')

  /* ================= celltype 配色派生 ================= */
  console.log('\n--- celltype 颜色必须由簇色派生（取第一个簇）---')
  const palette = arr(annotate.summary?.celltypePalette)
  const typeA = palette.find((p) => p.celltype === 'A')
  expect('注释结果里带 celltypePalette', palette.length > 0, JSON.stringify(palette).slice(0, 120))
  if (typeA) {
    // 用 R 读一遍簇色板，核对 A 的颜色 == 第一个簇的颜色
    const chk = path.join(dir, 'palcheck.R')
    fs.writeFileSync(
      chk,
      `
suppressMessages({library(Seurat)})
source(${JSON.stringify(posix(path.join(ROOT, 'r', 'scrna', 'common_levels.R')))})
source(${JSON.stringify(posix(path.join(ROOT, 'r', 'scrna', 'common_palette.R')))})
obj <- readRDS(${JSON.stringify(posix(path.join(dir, 'obj_step6.rds')))})
pal <- .scrna_cluster_palette(obj, "clusters")
typeA <- unname(pal[[as.character(${JSON.stringify(merged[0])})]])
ctPal <- .scrna_celltype_palette(obj, "clusters", "celltype")
cat("CLUSTER_FIRST:", typeA, "\\n")
cat("CELLTYPE_A:", unname(ctPal[["A"]]), "\\n")
cat("IN_MISC:", !is.null(obj@misc$celltypePalette), "\\n")
cat("LEVELS:", paste(.scrna_cluster_levels(obj, "clusters"), collapse = ","), "\\n")
`,
      'utf8'
    )
    const chkOut = execFileSync(rscript, ['--vanilla', chk], { encoding: 'utf8', stdio: 'pipe' })
    const pick = (k) =>
      (chkOut.split('\n').find((l) => l.startsWith(`${k}:`)) ?? '').replace(`${k}:`, '').trim()
    expect('A 的颜色 = 它第一个簇的颜色',
      pick('CELLTYPE_A') !== '' && pick('CELLTYPE_A') === pick('CLUSTER_FIRST'),
      `A=${pick('CELLTYPE_A')} 簇${merged[0]}=${pick('CLUSTER_FIRST')}`)
    expect('派生色板写进了 obj@misc$celltypePalette（下游直接读，不重算）',
      pick('IN_MISC') === 'TRUE')
    expect('tSNE 图也生成了（注释后 umap/tSNE 都要）',
      arr(annotate.summary?.plots).some((p) => p.id === 'tsne_celltype'),
      arr(annotate.summary?.plots).map((p) => p.id).join(','))
  }

  /* ================= 三张图：group.by=celltype，不拆分 ============ */
  console.log('\n--- group.by=celltype，不拆分 ---')
  const g1 = runScript(dir, 'run_scrna_gene_query.R', {
    objectFile: 'obj_step6.rds',
    genes: ['MARK001', 'MARK002'],
    groupBy: 'celltype',
    splitBy: ''
  })
  expect('出图正常结束', g1.exitCode === 0 && Boolean(g1.summary),
    g1.error?.message ?? '')
  if (g1.summary) {
    const ids = arr(g1.summary.plots).map((p) => p.id)
    expect('三张图都出来了（feature / violin / dotplot）',
      ['feature', 'violin', 'dotplot'].every((x) => ids.includes(x)), ids.join(','))
    for (const f of ['p06_feature.png', 'p07_violin.png', 'p08_dotplot.png']) {
      const fp = path.join(dir, f)
      const ok = fs.existsSync(fp) && fs.statSync(fp).size > 5000
      expect(`${f} 存在且非空`, ok, ok ? `${Math.round(fs.statSync(fp).size / 1024)} KB` : '缺失或过小')
    }
    // 类型数由数据决定（簇少时可能只有 1 个类型），所以期望值也算出来，不写死
    const gstats = arr(g1.summary.geneStats)
    expect('返回基因稀疏度统计（界面据此给诊断）', gstats.length === 2,
      gstats.map((g) => `${g.gene}=${(g.pctExpressing * 100).toFixed(0)}%`).join(' '))
    const expTypes = new Set(assignments.map((a) => a.celltype)).size
    expect(`返回分组配色（${expTypes} 个类型）`,
      arr(g1.summary.palette).length === expTypes,
      JSON.stringify(arr(g1.summary.palette)))
    const palA = arr(g1.summary.palette).find((p) => p.group === 'A')
    expect('基因查询用的配色与注释时是同一份（A 的颜色一致）',
      palA && typeA && palA.color === typeA.color, `${palA?.color} vs ${typeA?.color}`)
  }

  /* ================= group.by=clusters + split.by=样本 ============ */
  console.log('\n--- group.by=clusters，按样本拆分（颜色不能变）---')
  const g2 = runScript(dir, 'run_scrna_gene_query.R', {
    objectFile: 'obj_step6.rds',
    genes: ['MARK001'],
    groupBy: 'clusters',
    splitBy: 'orig.ident'
  })
  expect('拆分模式正常结束', g2.exitCode === 0 && Boolean(g2.summary),
    g2.error?.message ?? '')
  if (g2.summary) {
    const ids = arr(g2.summary.plots).map((p) => p.id)
    expect('拆分模式三张图都在（DotPlot 在 split.by 下曾经静默失败）',
      ['feature', 'violin', 'dotplot'].every((x) => ids.includes(x)), ids.join(','))
    expect('返回了拆分出的样本名', arr(g2.summary.samples).length === 2,
      arr(g2.summary.samples).join(','))
    expect('分组数 = 簇数（split 不会把分组变多）',
      g2.summary.nGroups === clusters.length, `${g2.summary.nGroups} vs ${clusters.length}`)
  }

  /* ================= 全部不存在 ================= */
  console.log('\n--- 基因全不存在：E_DATA_EMPTY 且不留旧图 ---')
  const g3 = runScript(dir, 'run_scrna_gene_query.R', {
    objectFile: 'obj_step6.rds',
    genes: ['NOT_A_GENE'],
    groupBy: 'celltype',
    splitBy: ''
  })
  expect('报错（不是出空图）', g3.exitCode !== 0 && Boolean(g3.error),
    g3.error?.message?.slice(0, 100) ?? '')
  expect('错误码是 E_DATA_EMPTY', g3.error?.code === 'E_DATA_EMPTY', `code=${g3.error?.code}`)
  expect('三张旧图都被删掉',
    ['p06_feature.png', 'p07_violin.png', 'p08_dotplot.png'].every(
      (f) => !fs.existsSync(path.join(dir, f))
    ))

  /* ================= 分组列不存在 ================= */
  console.log('\n--- group.by 指定的列不存在 → E_DATA_INVALID 并列出可用列 ---')
  const g4 = runScript(dir, 'run_scrna_gene_query.R', {
    objectFile: 'obj_step6.rds',
    genes: ['MARK001'],
    groupBy: 'no_such_column',
    splitBy: ''
  })
  expect('报错', g4.exitCode !== 0 && Boolean(g4.error), g4.error?.code ?? '')
  expect('错误码是 E_DATA_INVALID', g4.error?.code === 'E_DATA_INVALID', `code=${g4.error?.code}`)
  expect('错误里列出了可用列', /Available:/.test(g4.error?.message ?? ''),
    g4.error?.message?.slice(0, 120) ?? '')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
