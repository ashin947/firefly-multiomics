/**
 * 单细胞第 5 步冒烟 —— Marker 基因的四条硬约束。
 *
 * ## 为什么这四条必须有
 *
 *  1. **`totalMarkers > 0`**：这是本轮真实踩到的坑 —— `FindAllMarkers` 内部用 future
 *     并行，会把 `data` 矩阵当 globals 导出；2.6 万细胞的数据矩阵约 5.4 GB，超过
 *     `future.globals.maxSize`（默认 500 MB）后**每个 future 都失败、函数静默返回 0 行**。
 *     界面上看起来就是「没有 marker」，实际一个基因都没算。这条断言把它钉死。
 *
 *  2. **二次筛选的行数与 summary 一致**：客户脚本有两层筛选（logfc.threshold 参与计算 +
 *     `abs(avg_log2FC) > logFC & p_val_adj < adjP`），任何一层漏了行数就对不上。
 *
 *  3. **每簇 top10 ≤ 10 且按 avg_log2FC 降序**：对应客户 `top_n(n = 10, wt = avg_log2FC)`。
 *
 *  4. **热图文件存在且非空**：这是「补 ScaleData 是否生效」的判据 —— 第 3 步只 scale 了
 *     高变基因，marker 基本不在其中，不补 scale 时 DoHeatmap 会报
 *     `No requested features found in the scale.data slot`，图就是空的。
 *
 * 用法：
 *   node scripts/smoke-scrna-markers.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-markers.mjs
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

// 造一个「两类细胞、基因表达明显不同」的小对象：这样才能稳定产出 marker
const N_MARKER = 20
const N_BG = 180
const N_CELLS = 40

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-markers-'))

function makeStep2(dir, samples) {
  fs.mkdirSync(dir, { recursive: true })
  const rCode = `
    suppressMessages({library(Seurat); library(Matrix)})
    markerGenes <- sprintf("MARK%03d", 1:${N_MARKER})
    bgGenes <- sprintf("BG%03d", 1:${N_BG})
    genes <- c(markerGenes, bgGenes)
    samples <- c(${samples.map((x) => JSON.stringify(x)).join(', ')})
    make <- function(sample, seed, high) {
      set.seed(seed)
      n <- ${N_CELLS}
      m <- matrix(rpois(length(genes) * n, 3), nrow = length(genes),
                  dimnames = list(genes, paste0(sample, "_c", 1:n)))
      # 让 marker 基因在 "high" 组里高表达、另一组几乎不表达 → 稳定产生 marker
      idx <- match(markerGenes, genes)
      m[idx, ] <- if (high) rpois(length(idx) * n, 60) else rpois(length(idx) * n, 1)
      Matrix(m, sparse = TRUE)
    }
    objs <- lapply(seq_along(samples), function(i) {
      o <- CreateSeuratObject(counts = make(samples[i], i, i == 1), project = samples[i],
                              min.cells = 0, min.features = 0)
      o$orig.ident <- samples[i]
      o
    })
    obj <- if (length(objs) == 1) objs[[1]] else
      merge(objs[[1]], y = objs[-1], add.cell.ids = samples, project = "smoke")
    saveRDS(obj, ${JSON.stringify(path.join(dir, 'obj_step2.rds').replace(/\\/g, '/'))})
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

/** 读 PNG 的宽高（IHDR：宽在偏移 16，高在 20，大端 uint32） */
function pngSize(file) {
  const buf = fs.readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function csvRows(file) {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const header = lines[0].split(',')
  return lines.slice(1).map((l) => {
    const cells = l.split(',')
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]))
  })
}

try {
  const dir = path.join(work, 'run')
  makeStep2(dir, ['S1', 'S2'])
  const prep = runScript(dir, 'run_scrna_prep.R', { objectFile: 'obj_step2.rds', nFeatures: 150, nPcs: 10 })
  const embed = runScript(dir, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.5 })
  expect('前置步骤（prep + embed）通过', prep.exitCode === 0 && embed.exitCode === 0,
    prep.error?.message ?? embed.error?.message ?? '')

  /* ================= 正常阈值 ================= */
  console.log('\n--- 正常阈值（logFC 0.5 / adjP 0.05）---')
  const r = runScript(dir, 'run_scrna_markers.R', {
    objectFile: 'obj_step4.rds',
    logfcThreshold: 0.5,
    adjPvalFilter: 0.05
  })
  expect('markers 正常结束', r.exitCode === 0 && Boolean(r.summary),
    r.error ? `错误: ${r.error.message}` : `exit=${r.exitCode}`)

  if (r.summary) {
    // ★ 这条钉的是 future.globals.maxSize 那个坑：0 行意味着根本没算
    expect('FindAllMarkers 真的算出了行（不是静默 0 行）', r.summary.totalMarkers > 0,
      `totalMarkers=${r.summary.totalMarkers}`)
    expect('二次筛选后仍有显著 marker', r.summary.sigMarkers > 0,
      `sigMarkers=${r.summary.sigMarkers} / total=${r.summary.totalMarkers}`)

    const sig = csvRows(path.join(dir, 'markers_sig.csv'))
    expect('markers_sig.csv 的行数与 summary.sigMarkers 一致',
      sig.length === r.summary.sigMarkers,
      `csv=${sig.length} summary=${r.summary.sigMarkers}`)

    // 二次筛选的两条阈值必须都生效
    const badRows = sig.filter(
      (row) =>
        Math.abs(Number(row.avg_log2FC)) <= r.summary.logfcThreshold ||
        Number(row.p_val_adj) >= r.summary.adjPvalFilter
    )
    expect('表里没有越界的行（|log2FC| 与 padj 都过筛）', badRows.length === 0,
      badRows.length ? `越界 ${badRows.length} 行` : '')

    const violatesTop10 = (r.summary.perCluster ?? []).filter((c) => (c.top10 ?? []).length > 10)
    expect('每簇 top10 不超过 10 个', violatesTop10.length === 0,
      `超出的簇：${violatesTop10.map((c) => c.cluster).join(',') || '无'}`)

    const notDesc = (r.summary.perCluster ?? []).filter((c) => {
      const v = (c.top10 ?? []).map((t) => t.avgLog2FC)
      return v.some((x, i) => i > 0 && x > v[i - 1] + 1e-9)
    })
    expect('top10 按 avg_log2FC 降序', notDesc.length === 0,
      `不降序的簇：${notDesc.map((c) => c.cluster).join(',') || '无'}`)

    const heat = path.join(dir, 'p01_top10_heatmap.png')
    const heatOk = fs.existsSync(heat) && fs.statSync(heat).size > 5000
    expect('热图存在且非空（说明补 ScaleData 生效）', heatOk,
      heatOk ? `${Math.round(fs.statSync(heat).size / 1024)} KB` : '缺失或过小')

    if (fs.existsSync(heat)) {
      const { width, height } = pngSize(heat)
      const pxPerGene = height / Math.max(1, r.summary.perCluster.length * 10)
      // ★ 每行不到 8px 时基因名会被压成一团（实测踩过：`Os01g0100100` 被裁成 `Os01g010…`）
      expect('热图每行基因留够像素（≥8px/行，基因名才读得出来）', pxPerGene >= 8,
        `${width}x${height}px / 约 ${r.summary.perCluster.length * 10} 行 = ${pxPerGene.toFixed(1)}px/行`)
      expect('热图宽度足够（≥1000px）', width >= 1000, `${width}px`)
    }

    expect('每簇 marker 数量图存在', fs.existsSync(path.join(dir, 'p03_marker_counts.png')), '')
    expect('markers_top10.csv 存在', fs.existsSync(path.join(dir, 'markers_top10.csv')), '')
    expect('obj_step5.rds 存在', fs.existsSync(path.join(dir, 'obj_step5.rds')), '')
  }

  /* ================= 簇序必须按数字，不是字典序 ================= */
  console.log('\n--- 簇序：0,1,2,10,11 应排成 0,1,2,10,11（不是 0,1,10,11,2）---')
  const orderDir = path.join(work, 'order')
  fs.mkdirSync(orderDir, { recursive: true })
  fs.writeFileSync(
    path.join(orderDir, 'check.R'),
    `Sys.unsetenv("LC_ALL")
suppressMessages({library(Seurat); library(Matrix)})
source(${JSON.stringify(path.join(ROOT, 'r', 'scrna', 'common_levels.R').replace(/\\/g, '/'))})
# 造一个 m levels 是字典序的假对象
cells <- c("c1","c2","c3","c4","c5")
obj <- CreateSeuratObject(counts = Matrix(matrix(1, nrow = 2, ncol = 5,
                            dimnames = list(c("g1","g2"), cells)), sparse = TRUE))
obj$clusters <- factor(c("0","11","2","10","1"))   # 故意乱序 + 触发字典序问题
cat("BEFORE:", paste(levels(obj$clusters), collapse = ","), "\n")
obj <- .scrna_order_clusters(obj, "clusters")
cat("AFTER:", paste(levels(obj$clusters), collapse = ","), "\n")
# 非纯数字的名字要退回字符串排序，不能崩
obj2 <- obj
obj2$clusters <- factor(c("B","A","C","A","B"))
obj2 <- .scrna_order_clusters(obj2, "clusters")
cat("TEXT:", paste(levels(obj2$clusters), collapse = ","), "\n")
`,
    'utf8'
  )
  const orderOut = execFileSync(rscript, ['--vanilla', path.join(orderDir, 'check.R')], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  const after = (orderOut.split('\n').find((l) => l.startsWith('AFTER:')) ?? '').replace('AFTER:', '').trim()
  const text = (orderOut.split('\n').find((l) => l.startsWith('TEXT:')) ?? '').replace('TEXT:', '').trim()
  expect('数字簇名按数值排（10/11 在 2 之后）', after === '0,1,2,10,11', `实际=${after}`)
  expect('非数字簇名退回字符串排序且不报错', text === 'A,B,C', `实际=${text}`)

  /* ========= 自选基因图已搬到独立脚本（run_scrna_custom_plots.R）========= */
  // 这里只钉一件事：markers 不再因为 dotGenes 参数而出 DotPlot（避免两张图各画一次）
  const withDot = runScript(dir, 'run_scrna_markers.R', {
    objectFile: 'obj_step4.rds',
    logfcThreshold: 0.5,
    adjPvalFilter: 0.05,
    dotGenes: ['MARK001']
  })
  expect(
    'markers 不再产出 dotplot_custom（自选基因图有独立脚本）',
    !(withDot.summary?.plots ?? []).some((p) => p.id === 'dotplot_custom'),
    (withDot.summary?.plots ?? []).map((p) => p.id).join(',')
  )

  /* ================= 极严阈值 → 0 行但不报错 ================= */
  console.log('\n--- 极严阈值（logFC 10 / adjP 1e-300）应 0 行且不报错 ---')
  const strict = runScript(dir, 'run_scrna_markers.R', {
    objectFile: 'obj_step4.rds',
    logfcThreshold: 10,
    adjPvalFilter: 1e-300
  })
  expect('极严阈值不报错', strict.exitCode === 0 && Boolean(strict.summary),
    strict.error ? `错误: ${strict.error.message}` : '')
  if (strict.summary) {
    expect('显著 marker 为 0', strict.summary.sigMarkers === 0, `sigMarkers=${strict.summary.sigMarkers}`)
    // 0 行也要能出「每簇 0 个」的柱状图，且不能因为没有热图而失败
    expect('0 行时仍产出 marker 数量图',
      fs.existsSync(path.join(dir, 'p03_marker_counts.png')), '')
    expect('0 行时不生成热图', !(strict.summary.plots ?? []).some((p) => p.id === 'heatmap'), '')
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
