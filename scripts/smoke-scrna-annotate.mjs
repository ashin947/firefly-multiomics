/**
 * 单细胞第 6 步冒烟 —— 细胞注释（人工注释那条路）。
 *
 * ## 为什么这几条必须有
 *
 *  1. **`clusters` 列必须留下**：第 8 步（细胞类型富集）与第 9 步（pseudobulk）都要
 *     按原始簇回溯。应用注释时把 `clusters` 删掉，这两步就再也拿不回来了 ——
 *     而删掉是最「自然」的写法（`obj$clusters <- NULL`），所以必须用断言钉死。
 *
 *  2. **客户的 `07.clusterAnn.txt` 格式必须直接吃进去**：两列、制表符、**无表头**。
 *     这是客户真实文件的样子，多认一行表头、或要求逗号分隔，他就要先手工改文件。
 *
 *  3. **对不上要报错并列出差异**：注释表里写了对象里不存在的簇时，静默忽略是最坏的
 *     结果 —— 用户以为注释成功了，其实是 `cluster_7`。
 *
 *  4. **全留空不报错**：用户可能只想先看张图，用 `cluster_N` 占位并提示。
 *
 *  5. **同名合并要报出来**：两个簇填同一个类型是「合并」，是有效操作，但必须
 *     告诉用户合了哪几个（否则 UMAP 上图例少一块，会以为是 bug）。
 *
 * 用法：
 *   node scripts/smoke-scrna-annotate.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-annotate.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-annotate-'))
const posix = (p) => p.replace(/\\/g, '/')

function makeStep2(dir, samples) {
  fs.mkdirSync(dir, { recursive: true })
  const rCode = `
    suppressMessages({library(Seurat); library(Matrix)})
    markerGenes <- sprintf("MARK%03d", 1:${N_MARKER})
    bgGenes <- sprintf("BG%03d", 1:${N_BG})
    genes <- c(markerGenes, bgGenes)
    samples <- c(${samples.map((x) => `"${x}"`).join(', ')})
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
    obj <- if (length(objs) == 1) objs[[1]] else
      merge(objs[[1]], y = objs[-1], add.cell.ids = samples, project = "smoke")
    saveRDS(obj, ${JSON.stringify(posix(path.join(dir, 'obj_step2.rds')))})
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

/** 用 R 读回对象，回答「clusters 还在不在 / celltype 是什么水平 / Idents 是谁」 */
function inspectObject(dir, file = 'obj_step6.rds') {
  const script = path.join(dir, 'inspect.R')
  fs.writeFileSync(
    script,
    `suppressMessages({library(Seurat)})
obj <- readRDS(${JSON.stringify(posix(path.join(dir, file)))})
md <- obj@meta.data
cat("COLS:", paste(colnames(md), collapse = ","), "\\n")
cat("CELLTYPES:", paste(levels(factor(as.character(md$celltype))), collapse = ","), "\\n")
cat("CLUSTERS:", paste(levels(factor(as.character(md$clusters))), collapse = ","), "\\n")
cat("IDENTS:", paste(levels(Seurat::Idents(obj)), collapse = ","), "\\n")
cat("NCELL:", ncol(obj), "\\n")
`,
    'utf8'
  )
  let text = ''
  try {
    text = execFileSync(rscript, ['--vanilla', script], { encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    // 对象不存在时不要把整轮冒烟炸掉：后面那几条断言会各自报 FAIL，原因更清楚
    text = `${err.stdout ?? ''}`
  }
  const pick = (key) =>
    (text.split('\n').find((l) => l.startsWith(`${key}:`)) ?? '').replace(`${key}:`, '').trim()
  return {
    cols: pick('COLS'),
    celltypes: pick('CELLTYPES'),
    clusters: pick('CLUSTERS'),
    idents: pick('IDENTS'),
    nCells: Number(pick('NCELL'))
  }
}

try {
  const dir = path.join(work, 'run')
  makeStep2(dir, ['S1', 'S2'])
  const prep = runScript(dir, 'run_scrna_prep.R', {
    objectFile: 'obj_step2.rds',
    nFeatures: 150,
    nPcs: 10
  })
  const embed = runScript(dir, 'run_scrna_embed.R', { objectFile: 'obj_step3.rds', resolution: 0.8 })
  expect(
    '前置步骤（prep + embed）通过',
    prep.exitCode === 0 && embed.exitCode === 0,
    prep.error?.message ?? embed.error?.message ?? ''
  )

  // 注释的输入是 obj_step5.rds（第 5 步的产物），所以这里必须先把 marker 跑出来
  const markers = runScript(dir, 'run_scrna_markers.R', {
    objectFile: 'obj_step4.rds',
    logfcThreshold: 0.5,
    adjPvalFilter: 0.05
  })
  expect('前置步骤（markers）通过', markers.exitCode === 0 && Boolean(markers.summary),
    markers.error?.message ?? '')

  const clusters = (embed.summary?.perCluster ?? []).map((c) => String(c.cluster))
  expect('聚类产出了簇', clusters.length >= 2, `clusters=${clusters.join(',')}`)

  /* ============ 1. 表格映射 + 两个簇合并 ============ */
  // 前两个簇都填 T cell（= 合并），其余填 B cell。簇数由数据决定（小对象可能只分出 2 个），
  // 所以期望值也是算出来的，不写死 —— 写死会让冒烟在数据稍变时就红，那种红没人会看。
  console.log('\n--- 表格映射：两个簇 → T cell（合并），其余 → B cell ---')
  const mergedClusters = clusters.slice(0, 2)
  const assignments = clusters.map((c) => ({
    cluster: c,
    celltype: mergedClusters.includes(c) ? 'T cell' : 'B cell'
  }))
  const expTypes = clusters.length >= 3 ? 2 : 1
  const r = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: '',
    assignments
  })
  expect('人工注释正常结束', r.exitCode === 0 && Boolean(r.summary),
    r.error ? `错误: ${r.error.message}` : `exit=${r.exitCode}`)

  if (r.summary) {
    expect(`细胞类型数 = ${expTypes}`, r.summary.nCelltypes === expTypes,
      `nCelltypes=${r.summary.nCelltypes}`)
    expect('报出合并（T cell ← 0 + 1）', r.summary.renamed === 1,
      `renamed=${r.summary.renamed} merged=${JSON.stringify(r.summary.merged)}`)
    const mergedOk =
      (r.summary.merged ?? []).length === 1 &&
      r.summary.merged[0].celltype === 'T cell' &&
      (r.summary.merged[0].clusters ?? []).length === 2
    expect('合并的具体内容正确（一个类型 / 两个簇）', mergedOk,
      JSON.stringify(r.summary.merged))
    expect('没有簇被漏掉（unnamed = 0）', r.summary.unnamed === 0, `unnamed=${r.summary.unnamed}`)
    expect('注释表落盘（celltype_annotation.csv）',
      fs.existsSync(path.join(dir, 'celltype_annotation.csv')), '')
    expect('对象落盘（obj_step6.rds）', fs.existsSync(path.join(dir, 'obj_step6.rds')), '')

    const csv = csvRows(path.join(dir, 'celltype_annotation.csv'))
    expect('注释表行数 = 簇数', csv.length === clusters.length,
      `csv=${csv.length} clusters=${clusters.length}`)
    // 簇的顺序必须是数字序：0,1,2,…,10（不是 0,1,10,2）
    const csvOrder = csv.map((x) => String(x.cluster))
    const sorted = [...csvOrder].sort((a, b) => Number(a) - Number(b))
    expect('注释表按簇号数字序排列', JSON.stringify(csvOrder) === JSON.stringify(sorted),
      csvOrder.join(','))

    const plots = (r.summary.plots ?? []).map((p) => p.id)
    // 注释后要给 umap **和** tSNE 两套（客户第 4 步就要求两种降维都要）
    expect(
      '五张图都生成了（umap 类型 / umap 对比 / 占比 / tSNE 类型 / tSNE 对比）',
      ['umap_celltype', 'cluster_vs_celltype', 'ratio', 'tsne_celltype', 'tsne_cluster_vs_celltype']
        .every((x) => plots.includes(x)),
      plots.join(',')
    )

    // 配色派生：一个类型取它第一个簇的颜色（注释前后颜色才对得上）
    const pal = r.summary.celltypePalette ?? []
    expect('返回了 celltypePalette（派生配色）', pal.length >= 1,
      JSON.stringify(pal).slice(0, 160))
    const mergedType = pal.find((p) => p.celltype === 'T cell')
    expect('合并出来的类型颜色 = 它第一个簇（0）的颜色来源标注正确',
      mergedType && (mergedType.fromClusters ?? []).includes('0'),
      JSON.stringify(mergedType))
  }

  /* ============ 标签必须每个类型都画出来（客户报的 tSNE 漏标） ============ */
  console.log('\n--- 质心标签：2 个类型必须出 2 个标签（repel 会丢）---')
  const labelCheck = path.join(dir, 'label_check.R')
  fs.writeFileSync(
    labelCheck,
    `suppressMessages({library(Seurat); library(ggplot2); library(Matrix)})
source(${JSON.stringify(posix(path.join(ROOT, 'r', 'scrna', 'common_plot.R')))})
# 造一个两“类型”的对象，各自成团（质心分开，才能验证标签数 == 类型数）
set.seed(7)
emb <- rbind(
  matrix(rnorm(40 * 2, mean = -5), ncol = 2),
  matrix(rnorm(40 * 2, mean = 5), ncol = 2)
)
colnames(emb) <- c("tSNE_1", "tSNE_2")
rownames(emb) <- paste0("c", 1:80)
obj <- CreateSeuratObject(counts = Matrix(matrix(1, nrow = 2, ncol = 80,
                         dimnames = list(c("g1","g2"), rownames(emb))), sparse = TRUE))
obj[["tsne"]] <- CreateDimReducObject(embeddings = emb, key = "tSNE_", assay = "RNA")
obj$celltype <- factor(c(rep("A", 40), rep("B", 40)))
p <- DimPlot(obj, reduction = "tsne", group.by = "celltype", label = FALSE)
p2 <- .scrna_centroid_labels(p, obj, "tsne", "celltype")
# 数一下新加的 geom_text 里的标签行数
# 标签用的是 geom_label（白底半透明，深色堆里也读得清），所以两种都要认
texts <- Filter(function(l) {
  cls <- class(l$geom)[1]
  cls %in% c("GeomText", "GeomLabel")
}, p2$layers)
n <- if (length(texts) > 0) nrow(texts[[length(texts)]]$data) else 0
cat("LAYERS_TEXT:", length(texts), "\\n")
cat("LABEL_ROWS:", n, "\\n")
cat("LABELS:", paste(sort(as.character(texts[[length(texts)]]$data$label)), collapse = ","), "\\n")
`,
    'utf8'
  )
  const lc = execFileSync(rscript, ['--vanilla', labelCheck], { encoding: 'utf8', stdio: 'pipe' })
  const lpick = (k) =>
    (lc.split('\n').find((l) => l.startsWith(`${k}:`)) ?? '').replace(`${k}:`, '').trim()
  expect('加了 1 层文本/标签图层', lpick('LAYERS_TEXT') === '1', lpick('LAYERS_TEXT'))
  expect('两个类型 → 两个标签（repel 版本只剩一个）',
    Number(lpick('LABEL_ROWS')) === 2, lpick('LABEL_ROWS'))
  expect('标签内容就是类型名', lpick('LABELS') === 'A,B', lpick('LABELS'))

  const objInfo = inspectObject(dir)
  expect('★ clusters 列仍然保留（第 8/9 步要回溯）', objInfo.cols.split(',').includes('clusters'),
    `cols=${objInfo.cols}`)
  expect('celltype 列已写入', objInfo.cols.split(',').includes('celltype'), `cols=${objInfo.cols}`)
  expect('细胞类型写在对象里（T cell 在前，因为目录里的顺序就是簇序）',
    expTypes === 2 ? objInfo.celltypes === 'T cell,B cell' : objInfo.celltypes === 'T cell',
    `celltypes=${objInfo.celltypes}`)
  expect('Idents 切到 celltype（后面画图按类型着色）', objInfo.idents === objInfo.celltypes,
    `idents=${objInfo.idents}`)
  expect('细胞数没变（注释不该动细胞）', objInfo.nCells === N_CELLS * 2, `nCells=${objInfo.nCells}`)

  /* ============ 2. 客户格式的注释表（两列 / 制表符 / 无表头）============ */
  console.log('\n--- 客户格式 07.clusterAnn.txt（两列、制表符、无表头）---')
  const annFile = path.join(dir, '07.clusterAnn.txt')
  fs.writeFileSync(
    annFile,
    clusters.map((c, i) => `${c}\t${i % 2 === 0 ? 'Xylem' : 'Phloem'}`).join('\n') + '\n',
    'utf8'
  )
  const r2 = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: posix(annFile),
    // 故意同时给 assignments：R 侧以文件优先，这条断言钉的是「优先级」
    assignments: clusters.map((c) => ({ cluster: c, celltype: 'SHOULD_NOT_WIN' }))
  })
  expect('客户格式的注释表能直接读', r2.exitCode === 0 && Boolean(r2.summary),
    r2.error ? `错误: ${r2.error.message}` : '')
  if (r2.summary) {
    const types = (r2.summary.celltypes ?? []).map((x) => x.celltype)
    expect('文件名优先于 assignments', !types.includes('SHOULD_NOT_WIN'), types.join(','))
    expect('两列注释表解析出 Xylem / Phloem',
      types.every((t) => t === 'Xylem' || t === 'Phloem'), types.join(','))
  }

  /* ============ 3. 对不上的注释表 → 明确报错 ============ */
  console.log('\n--- 注释表里有对象不存在的簇 → 应报错并列出差异 ---')
  const badFile = path.join(dir, 'bad_ann.txt')
  fs.writeFileSync(
    badFile,
    `${clusters.map((c) => `${c}\tCell`).join('\n')}\n999\tGhost\n`,
    'utf8'
  )
  const r3 = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: posix(badFile),
    assignments: []
  })
  expect('对不上时报错（不是静默放过）', r3.exitCode !== 0 && Boolean(r3.error),
    r3.error?.message ?? `exit=${r3.exitCode}`)
  expect('错误码是 E_DATA_INVALID', r3.error?.code === 'E_DATA_INVALID', `code=${r3.error?.code}`)
  expect('错误里点名了多出来的簇 999', /999/.test(r3.error?.message ?? ''),
    r3.error?.message ?? '')

  /* ============ 4. 全留空 → cluster_N 占位，不报错 ============ */
  console.log('\n--- 全部留空 → 用 cluster_N 占位，不报错 ---')
  const r4 = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: '',
    assignments: clusters.map((c) => ({ cluster: c, celltype: '' }))
  })
  expect('全留空不报错', r4.exitCode === 0 && Boolean(r4.summary),
    r4.error ? `错误: ${r4.error.message}` : '')
  if (r4.summary) {
    expect('所有簇都被记为未命名', r4.summary.unnamed === clusters.length,
      `unnamed=${r4.summary.unnamed} / ${clusters.length}`)
    const types = (r4.summary.celltypes ?? []).map((x) => x.celltype)
    expect('占位名是 cluster_<簇号>', types.every((t) => /^cluster_/.test(t)), types.join(','))
  }

  /* ============ 5. 两条输入都不给 → E_VALIDATION ============ */
  console.log('\n--- 既没有文件也没有 assignments → E_VALIDATION ---')
  const r5 = runScript(dir, 'run_scrna_annotate.R', {
    objectFile: 'obj_step5.rds',
    mode: 'manual',
    annotationFile: '',
    assignments: null
  })
  expect('缺输入时报错', r5.exitCode !== 0 && Boolean(r5.error), r5.error?.code ?? '')
  expect('错误码是 E_VALIDATION', r5.error?.code === 'E_VALIDATION', `code=${r5.error?.code}`)
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log(`\n保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
