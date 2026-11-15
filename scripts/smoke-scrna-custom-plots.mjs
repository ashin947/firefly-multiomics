/**
 * 单细胞「自选基因出图」冒烟 —— 一次调用出 DotPlot + 小提琴。
 *
 * ## 为什么这些断言必须有
 *
 *  1. **两张图一起出**：客户要的是「按一下出两张」。只出一张（比如小球没画出来）
 *     而接口仍返回 ok，用户会以为另一半坏了 —— 所以两张文件都要存在且不是空文件。
 *  2. **一个基因都不存在时两张都不出**：这是最容易做错的分支（画半张更糟）。
 *     同时必须报 E_DATA_EMPTY 并点名缺失基因，而不是「图未生成」了事。
 *  3. **部分存在**：画存在的、缺的单独返回，不阻断。
 *  4. **簇序是数字序**：x 轴 / 图例必须是 0,1,2,…,10 而不是 0,1,10,2。
 *     第一版用的 `levels(factor(as.character(...)))` 就是字典序，实测踩过。
 *  5. **配色与 UMAP 同源**：`obj@misc$clusterPalette` 存在时必须被沿用（不改写）。
 *
 * 用法：
 *   node scripts/smoke-scrna-custom-plots.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-custom-plots.mjs
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

const N_MARKER = 20
const N_BG = 180
const N_CELLS = 40
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-custom-'))
const posix = (p) => p.replace(/\\/g, '/')

function makeStep2(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'make.R'),
    `
suppressMessages({library(Seurat); library(Matrix)})
markerGenes <- sprintf("MARK%03d", 1:${N_MARKER})
bgGenes <- sprintf("BG%03d", 1:${N_BG})
genes <- c(markerGenes, bgGenes)
samples <- c("S1", "S2")
make <- function(sample, seed, high) {
  set.seed(seed)
  n <- ${N_CELLS}
  m <- matrix(rpois(length(genes) * n, 3), nrow = length(genes),
              dimnames = list(genes, paste0(sample, "_c", 1:n)))
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
obj <- merge(objs[[1]], y = objs[-1], add.cell.ids = samples, project = "smoke")
saveRDS(obj, ${JSON.stringify(posix(path.join(dir, 'obj_step2.rds')))})
`,
    'utf8'
  )
  execFileSync(rscript, ['--vanilla', path.join(dir, 'make.R')], { stdio: 'pipe' })
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
    summary: resultLine ? JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary : null,
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@ /, '')) : null
  }
}

try {
  const dir = path.join(work, 'run')
  makeStep2(dir)
  const prep = runScript(dir, 'run_scrna_prep.R', {
    objectFile: 'obj_step2.rds',
    nFeatures: 150,
    nPcs: 10
  })
  const embed = runScript(dir, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.5 })
  expect('前置步骤（prep + embed）通过', prep.exitCode === 0 && embed.exitCode === 0,
    prep.error?.message ?? embed.error?.message ?? '')

  /* ================= 正常：3 个基因 ================= */
  console.log('\n--- 3 个基因（2 个存在 + 1 个不存在）---')
  const r = runScript(dir, 'run_scrna_custom_plots.R', {
    objectFile: 'obj_step4.rds',
    genes: ['MARK001', 'MARK002', 'NO_SUCH_GENE']
  })
  expect('出图正常结束', r.exitCode === 0 && Boolean(r.summary),
    r.error ? `错误: ${r.error.message}` : '')

  if (r.summary) {
    const drawn = [].concat(r.summary.genes ?? [])
    const missing = [].concat(r.summary.missingGenes ?? [])
    expect('实际画的基因 = 存在的那些（按输入顺序）',
      JSON.stringify(drawn) === JSON.stringify(['MARK001', 'MARK002']), JSON.stringify(drawn))
    expect('不存在的基因单独返回（不阻断）',
      JSON.stringify(missing) === JSON.stringify(['NO_SUCH_GENE']), JSON.stringify(missing))

    // 稀疏度统计：界面靠它解释「为什么是竖线」，也算「不存在 vs 几乎不表达」的分界
    const stats = (r.summary.geneStats ?? []).map((g) => g)
    expect('返回每个已画基因的稀疏度统计', stats.length === drawn.length,
      JSON.stringify(stats))
    expect('pctExpressing 在 0~1 之间',
      stats.every((g) => g.pctExpressing >= 0 && g.pctExpressing <= 1),
      stats.map((g) => `${g.gene}=${(g.pctExpressing * 100).toFixed(1)}%`).join(' '))

    const ids = (r.summary.plots ?? []).map((p) => p.id)
    expect('一次出两张：dotplot_custom + violin_custom',
      ids.includes('dotplot_custom') && ids.includes('violin_custom'), ids.join(','))

    const dotFile = path.join(dir, 'p04_dotplot_custom.png')
    const vlnFile = path.join(dir, 'p05_violin_custom.png')
    const dotOk = fs.existsSync(dotFile) && fs.statSync(dotFile).size > 5000
    const vlnOk = fs.existsSync(vlnFile) && fs.statSync(vlnFile).size > 5000
    expect('DotPlot 文件存在且非空', dotOk,
      dotOk ? `${Math.round(fs.statSync(dotFile).size / 1024)} KB` : '缺失或过小')
    expect('小提琴文件存在且非空', vlnOk,
      vlnOk ? `${Math.round(fs.statSync(vlnFile).size / 1024)} KB` : '缺失或过小')

    // ★ 矢量 PDF：空 PDF 约 1–2 KB，这条能拦住「绘图闭包被 promise 缓存」那个坑
    for (const f of ['p04_dotplot_custom.pdf', 'p05_violin_custom.pdf']) {
      const fp = path.join(dir, f)
      const ok = fs.existsSync(fp) && fs.statSync(fp).size > 5000
      expect(`矢量图 ${f} 存在且 > 5 KB`, ok,
        fs.existsSync(fp) ? `${(fs.statSync(fp).size / 1024).toFixed(1)} KB` : '缺失')
    }

    // 小提琴必须比 DotPlot 高（有 legend + caption），否则说明只画了一个基因
    if (dotOk && vlnOk) {
      const w = (f) => fs.readFileSync(f).readUInt32BE(16)
      const h = (f) => fs.readFileSync(f).readUInt32BE(20)
      expect('小提琴宽度随基因数增长（≥3 列）', w(vlnFile) >= 900, `${w(vlnFile)}px`)
      expect('DotPlot 尺寸合理（宽 ≥ 700 高 ≥ 500）', w(dotFile) >= 700 && h(dotFile) >= 500,
        `${w(dotFile)}x${h(dotFile)}`)
    }
  }

  /* ================= 一个都不存在 → 两张都不出 ================= */
  console.log('\n--- 全部不存在：报 E_DATA_EMPTY，且**两张都不留** ---')
  const none = runScript(dir, 'run_scrna_custom_plots.R', {
    objectFile: 'obj_step4.rds',
    genes: ['NO_SUCH_1', 'NO_SUCH_2']
  })
  expect('报错（不是静默出空图）', none.exitCode !== 0 && Boolean(none.error),
    none.error?.message?.slice(0, 90) ?? `exit=${none.exitCode}`)
  expect('错误码是 E_DATA_EMPTY', none.error?.code === 'E_DATA_EMPTY', `code=${none.error?.code}`)
  expect('错误里点名了第一批缺失基因', /NO_SUCH_1/.test(none.error?.message ?? ''),
    none.error?.message?.slice(0, 120) ?? '')
  expect('DotPlot 旧图已被删除（不留上一次的结果）',
    !fs.existsSync(path.join(dir, 'p04_dotplot_custom.png')))
  expect('小提琴旧图已被删除', !fs.existsSync(path.join(dir, 'p05_violin_custom.png')))

  /* ================= 簇序：数字序 ================= */
  console.log('\n--- 簇序与配色（数字序 + 沿用 misc 里的 palette）---')
  const check = path.join(dir, 'check.R')
  // 造一个「簇号会踩字典序坑」的小对象：0,1,2,10,11 —— 字典序会排成 0,1,10,11,2
  fs.writeFileSync(
    check,
    `
suppressMessages({library(Seurat); library(Matrix)})
source(${JSON.stringify(posix(path.join(ROOT, 'r', 'scrna', 'common_levels.R')))})
source(${JSON.stringify(posix(path.join(ROOT, 'r', 'scrna', 'common_palette.R')))})
cells <- paste0("c", 1:5)
obj <- CreateSeuratObject(counts = Matrix(matrix(1, nrow = 2, ncol = 5,
                         dimnames = list(c("g1", "g2"), cells)), sparse = TRUE))
obj$clusters <- factor(c("0", "11", "2", "10", "1"))   # 故意乱序，且含两位数
cat("RAW_LEVELS:", paste(levels(factor(as.character(obj$clusters))), collapse = ","), "\\n")
obj <- .scrna_order_clusters(obj, "clusters")
cat("LEVELS:", paste(.scrna_cluster_levels(obj, "clusters"), collapse = ","), "\\n")
pal <- .scrna_cluster_palette(obj, "clusters")
cat("PAL_NAMES:", paste(names(pal), collapse = ","), "\\n")
cat("PAL_N:", length(pal), "\\n")
pal2 <- .scrna_cluster_palette(obj, "clusters")
cat("STABLE:", identical(pal, pal2), "\\n")
`,
    'utf8'
  )
  const chk = execFileSync(rscript, ['--vanilla', check], { encoding: 'utf8', stdio: 'pipe' })
  const pick = (k) =>
    (chk.split('\n').find((l) => l.startsWith(`${k}:`)) ?? '').replace(`${k}:`, '').trim()
  const levels = pick('LEVELS')
  expect('字典序原始顺序确实是坑（0,1,10,11,2）',
    pick('RAW_LEVELS') === '0,1,10,11,2', pick('RAW_LEVELS'))
  expect('簇 levels 是数字序（0,1,2,10,11）', levels === '0,1,2,10,11', levels)
  expect('palette 的键与 levels 一致', pick('PAL_NAMES') === levels, pick('PAL_NAMES'))
  expect('同一对象两次取色一致（缓存生效）', pick('STABLE') === 'TRUE')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

if (out.length === 0 || out.some((r) => !r.ok)) {
  console.log(`\n${out.filter((r) => r.ok).length}/${out.length} 通过`)
  process.exit(1)
}
console.log(`\n${out.length}/${out.length} 通过`)
