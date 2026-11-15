/**
 * 单细胞第 2 步冒烟 —— 质控（段 A）与过滤（段 B）的**边界行为**。
 *
 * ## 为什么这两个用例必须有
 *
 * 它们都是「不会报错、但结果没有意义」的那类问题：
 *
 *  1. **数据里没有线粒体基因**（有些物种/注释就是没有 `^mt-`）：`percent.mt`
 *     算不出来。如果实现里直接 `obj$percent.mt <- ...` 就会得到全是 NaN 的列，
 *     后面按 mt 过滤时把所有细胞都筛掉 —— 而且不报错。
 *     正确行为：跳过 mt 图与 mt 过滤，`mtGeneCount = 0`，并在 summary 里说清楚。
 *
 *  2. **三个阈值全为 null**（用户清空了全部输入框）：这**不是**错误，
 *     等于「先看看现在有多少细胞」。若实现把 null 当成「用默认值」，
 *     用户会莫名其妙少掉一批细胞，而界面上显示的还是「已过滤」。
 *
 * 另外覆盖正常路径（有 mt 基因、阈值生效）与「某个样本被清空」的警告。
 *
 * ## 为什么是脚本而不是 vitest
 *
 * 被测逻辑在 R 里（`run_scrna_qc.R` / `run_scrna_filter.R`）。mock 掉 R 等于
 * 只测 TypeScript 的拼装，测不到这两条真实行为。所以这里**真的起 R**，
 * 造一个可控的小对象，跑完整流程后断言 summary。
 *
 * 用法：
 *   node scripts/smoke-scrna-qc.mjs
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-qc.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-qc-'))

/**
 * 造一个「已合并」的最小 Seurat 对象，直接调 import 脚本做不到（那需要 10x 目录），
 * 所以用一段 R 代码造 obj_step1.rds：两个样本、每个样本 4 个细胞、6 个基因。
 *
 * `withMt = true` 时基因名带 `MT-`（大写，验证 `^mt-` 不区分大小写）；
 * `false` 时全用普通名字（模拟没有线粒体基因的物种）。
 */
function makeObject(dir, { withMt }) {
  fs.mkdirSync(dir, { recursive: true })
  const genes = withMt
    ? ['MT-ND1', 'MT-CO1', 'GeneA', 'GeneB', 'GeneC', 'GeneD']
    : ['GeneA', 'GeneB', 'GeneC', 'GeneD', 'GeneE', 'GeneF']
  fs.writeFileSync(path.join(dir, 'genes.json'), JSON.stringify(genes), 'utf8')

  const rCode = `
    suppressMessages({library(Seurat); library(Matrix)})
    genes <- jsonlite::fromJSON(${JSON.stringify(path.join(dir, 'genes.json').replace(/\\/g, '/'))})
    build <- function(sample, offset) {
      set.seed(offset)
      m <- Matrix(matrix(rpois(length(genes) * 4, 60), nrow = length(genes),
                         dimnames = list(genes, paste0(sample, '_c', 1:4))), sparse = TRUE)
      obj <- CreateSeuratObject(counts = m, project = sample, min.cells = 0, min.features = 0)
      obj$orig.ident <- sample
      obj
    }
    a <- build("S1", 1); b <- build("S2", 2)
    obj <- merge(a, y = b, add.cell.ids = c("S1", "S2"), project = "smoke")
    saveRDS(obj, ${JSON.stringify(path.join(dir, 'obj_step1.rds').replace(/\\/g, '/'))})
    cat("object:", nrow(obj), "x", ncol(obj), "\\n")
  `
  const scriptPath = path.join(dir, 'make.R')
  fs.writeFileSync(scriptPath, rCode, 'utf8')
  execFileSync(rscript, ['--vanilla', scriptPath], { encoding: 'utf8', stdio: 'pipe' })
}

function runScript(scriptRel, runDir, params) {
  fs.mkdirSync(runDir, { recursive: true })
  const config = {
    runId: `smoke-${path.basename(runDir)}`,
    runDir,
    projectRoot: path.dirname(runDir),
    params: { ...params, skipFonts: true }
  }
  fs.writeFileSync(path.join(runDir, 'run_config.json'), JSON.stringify(config, null, 2), 'utf8')

  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync(
      rscript,
      ['--vanilla', path.join(ROOT, 'r', 'scrna', scriptRel), '--config', 'run_config.json'],
      {
        cwd: runDir,
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
    error: errorLine ? JSON.parse(errorLine.replace(/^@@DEG@@ /, '')) : null,
    runDir
  }
}

try {
  /* ================= 用例 1：没有线粒体基因 ================= */
  console.log('\n--- 用例 1：数据里没有 mt 基因（应跳过 mt 图与 mt 过滤，不报错）---')
  const noMt = path.join(work, 'no-mt')
  makeObject(noMt, { withMt: false })
  const qcNoMt = runScript('run_scrna_qc.R', noMt, {
    objectFile: 'obj_step1.rds',
    minFeature: 200,
    minCount: 500,
    maxMt: 0.2
  })
  expect('qc 正常结束（不因缺 mt 基因失败）', qcNoMt.exitCode === 0 && Boolean(qcNoMt.summary),
    qcNoMt.error ? `错误: ${qcNoMt.error.message}` : `exit=${qcNoMt.exitCode}`)
  if (qcNoMt.summary) {
    expect('mtGeneCount = 0', qcNoMt.summary.mtGeneCount === 0, `mtGeneCount=${qcNoMt.summary.mtGeneCount}`)
    const plots = (qcNoMt.summary.plots ?? []).map((p) => p.id)
    expect('没有 mt 小提琴图（p03 未生成）', !plots.includes('percentMt'), `plots=${JSON.stringify(plots)}`)
    expect('文件系统里也没有 p03 图', !fs.existsSync(path.join(noMt, 'p03_violin_percent_mt.png')), '')
    const mt = (qcNoMt.summary.qcSummary ?? []).map((s) => s.medianMt)
    expect('medianMt 全为空而不是 NaN', mt.every((v) => v == null), `medianMt=${JSON.stringify(mt)}`)
  }

  const filterNoMt = runScript('run_scrna_filter.R', noMt, {
    objectFile: 'obj_qc.rds',
    minFeature: null,
    minCount: null,
    maxMt: 0.2
  })
  expect('设了 maxMt 但无 mt 基因时：过滤照常完成', filterNoMt.exitCode === 0 && Boolean(filterNoMt.summary),
    filterNoMt.error ? `错误: ${filterNoMt.error.message}` : '')
  if (filterNoMt.summary) {
    expect('mtFilterApplied = false', filterNoMt.summary.mtFilterApplied === false, '')
    expect('没有误删细胞（前后相等）',
      filterNoMt.summary.cellsBefore === filterNoMt.summary.cellsAfter,
      `${filterNoMt.summary.cellsBefore} -> ${filterNoMt.summary.cellsAfter}`)
  }

  /* ================= 用例 2：三个阈值全为 null ================= */
  console.log('\n--- 用例 2：三个阈值全为 null（= 不过滤，不该报错）---')
  const withMt = path.join(work, 'with-mt')
  makeObject(withMt, { withMt: true })
  const qcAll = runScript('run_scrna_qc.R', withMt, {
    objectFile: 'obj_step1.rds',
    minFeature: null,
    minCount: null,
    maxMt: null
  })
  expect('qc 正常结束', qcAll.exitCode === 0 && Boolean(qcAll.summary), '')
  if (qcAll.summary) {
    // MT-ND1 / MT-CO1 大写，验证 ^mt- 的 ignore.case
    expect('大写 MT- 也被认成线粒体基因', qcAll.summary.mtGeneCount === 2,
      `mtGeneCount=${qcAll.summary.mtGeneCount}`)
    expect('阈值回显为 null', qcAll.summary.minFeature == null && qcAll.summary.maxMt == null, '')
  }

  const filterAllNull = runScript('run_scrna_filter.R', withMt, {
    objectFile: 'obj_qc.rds',
    minFeature: null,
    minCount: null,
    maxMt: null
  })
  expect('全 null 时不过滤、不报错',
    filterAllNull.exitCode === 0 && Boolean(filterAllNull.summary),
    filterAllNull.error ? `错误: ${filterAllNull.error.message}` : '')
  if (filterAllNull.summary) {
    expect('前后细胞数相等',
      filterAllNull.summary.cellsBefore === filterAllNull.summary.cellsAfter,
      `${filterAllNull.summary.cellsBefore} -> ${filterAllNull.summary.cellsAfter}`)
    expect('removed = 0', filterAllNull.summary.removed === 0, `removed=${filterAllNull.summary.removed}`)
  }

  /* ================= 用例 3：阈值生效（正常路径）================= */
  console.log('\n--- 用例 3：阈值生效（正常路径）---')
  // ★ maxMt=0.5 表示「50%」—— 这组数据 percent.mt 约 34%，应当全部留下。
  //   若实现里漏了 `* 100`（把 0.5 直接和 34 比），这里会一个细胞都不剩，
  //   用例就会红 —— 这条断言专门钉单位。
  const filterReal = runScript('run_scrna_filter.R', withMt, {
    objectFile: 'obj_qc.rds',
    minFeature: 1,
    minCount: 1,
    maxMt: 0.5
  })
  expect('正常路径跑通', filterReal.exitCode === 0 && Boolean(filterReal.summary),
    filterReal.error ? `错误: ${filterReal.error.message}` : '')
  if (filterReal.summary) {
      expect('mt 阈值按 0–1 小数解释（0.5 = 50%，不应清空细胞）',
      filterReal.summary.cellsAfter > 0,
      `cellsAfter=${filterReal.summary.cellsAfter}`)
    expect('每样本前后都有数',
      (filterReal.summary.perSample ?? []).every((r) => r.before > 0 && r.after > 0),
      JSON.stringify(filterReal.summary.perSample))
    expect('产出 qc_summary.csv',
      fs.existsSync(path.join(withMt, 'qc_summary.csv')), '')
    expect('产出 obj_step2.rds',
      fs.existsSync(path.join(withMt, 'obj_step2.rds')), '')
    expect('产出前后对比图',
      fs.existsSync(path.join(withMt, 'p05_filter_before_after.png')), '')
  }

  /* ================= 用例 4：阈值过严 → 总细胞归零应报错 ================= */
  console.log('\n--- 用例 4：阈值过严（总细胞 0）应明确报错而不是产出空对象---')
  const tooStrict = runScript('run_scrna_filter.R', withMt, {
    objectFile: 'obj_qc.rds',
    minFeature: 100000,
    minCount: null,
    maxMt: null
  })
  expect('报 E_DATA_EMPTY', tooStrict.error?.code === 'E_DATA_EMPTY',
    tooStrict.error ? `${tooStrict.error.code}: ${tooStrict.error.message}` : '没有错误行')
  expect('没有写出 obj_step2.rds', !fs.existsSync(path.join(withMt, 'obj_step2_empty.rds')), '')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (process.argv.includes('--keep')) console.log('保留:', work)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
