/**
 * 单细胞导入冒烟 —— **读入 + 建对象**这一步的契约。
 *
 * ## 为什么要有这个脚本（踩过的坑）
 *
 * `src/main/scrna/__tests__/scanSamples.test.ts` 只测「目录能扫到」，
 * 完全没碰「读完能不能建对象」。结果 2026-11 真实数据一跑就崩：
 *
 *     Read10X failed for MD: Gene name or features file missing. Expecting features.tsv.gz
 *
 * Seurat 5 的 `Read10X(data.dir=)` **只认 v3 的 features.tsv.gz**，不认 CellRanger v2 的
 * genes.tsv.gz（那是 Seurat 4 的行为）。扫描测试全绿也拦不住 —— 因为它测的是另一半。
 *
 * 所以这里造两个**最小但合法**的 10x 目录（v2 + v3），真的起 R 跑完整流程，断言四件事：
 *
 *   a) `nCells > 0 && nGenes > 0`（能读、能建对象）
 *   b) 行名是 **symbol**（`GENE001`）而不是 Ensembl 号也不是 `"1","2","3"`
 *      —— 这条专门钉 `feature.column`：取错列不会报错，只会让下游注释全废
 *   c) 多列 feature 文件按第 2 列取（v3 三列 / v2 两列都对）
 *   d) 对象文件真的写出来了，且不是空文件
 *
 * 用法：
 *   node scripts/smoke-scrna-import.mjs
 *   node scripts/smoke-scrna-import.mjs --keep     # 保留临时目录
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-scrna-import.mjs
 *
 * 退出码：全部通过 0 / 有断言失败 1 / 找不到 Rscript 4
 */
import fs from 'node:fs'
import { safeRemove } from './lib/tmpdir.mjs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const KEEP = process.argv.includes('--keep')

/** 造矩阵用：基因数必须 ≥ min.features(100)，否则每个细胞都会被过滤掉 */
const N_GENES = 120
const N_CELLS = 5

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

/**
 * 写一个最小 10x 目录。
 *
 * `layout='v2'` 写 `genes.tsv`（2 列：基因号 + symbol），`'v3'` 写 `features.tsv`（3 列）。
 * 两列**故意不同**（`ENSG*` vs `GENE*`），这样 `feature.column` 取错列会被断言抓住。
 */
function writeMatrixDir(dir, layout, cellPrefix) {
  fs.mkdirSync(dir, { recursive: true })

  // 每个基因出现在每个细胞里 → 每个细胞 nFeature=120（>100 不被过滤），
  // 每个基因出现在 5 个细胞里（>3 不被 min.cells 过滤）
  const lines = []
  let nz = 0
  for (let c = 1; c <= N_CELLS; c += 1) {
    for (let g = 1; g <= N_GENES; g += 1) {
      lines.push(`${g} ${c} ${(g % 7) + 1}`)
      nz += 1
    }
  }
  fs.writeFileSync(
    path.join(dir, 'matrix.mtx'),
    `%%MatrixMarket matrix coordinate integer general\n%\n${N_GENES} ${N_CELLS} ${nz}\n${lines.join('\n')}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(dir, 'barcodes.tsv'),
    Array.from({ length: N_CELLS }, (_, i) => `${cellPrefix}CELL${i + 1}`).join('\n') + '\n',
    'utf8'
  )

  const geneRows = Array.from({ length: N_GENES }, (_, i) => {
    const n = String(i + 1).padStart(3, '0')
    // ★ 两个样本用**同一套基因名**，否则 merge 的并集会把基因数翻倍，
    //   断言就变成在测「我的测试数据写错了」而不是在测产品代码。
    // ★ 名字里不放 `_`：Seurat 会把 `_` 改写成 `-`，那样断言会先撞上改名的坑。
    const symbol = `GENE${n}`
    const id = `ENSG${n}`
    return layout === 'v3' ? `${id}\t${symbol}\tGene Expression` : `${id}\t${symbol}`
  })
  fs.writeFileSync(
    path.join(dir, layout === 'v3' ? 'features.tsv' : 'genes.tsv'),
    `${geneRows.join('\n')}\n`,
    'utf8'
  )
}

const out = []
function expect(name, ok, detail) {
  out.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

const rscript = findRscript()
if (!rscript) {
  console.error('找不到 Rscript：请设 DEG_RSCRIPT 或确认 resources/runtime/R 存在')
  process.exit(4)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-scrna-smoke-'))
const runDir = path.join(work, 'run')
fs.mkdirSync(runDir, { recursive: true })

try {
  const v2Dir = path.join(work, 'v2sample')
  const v3Dir = path.join(work, 'v3sample')
  writeMatrixDir(v2Dir, 'v2', 'V2')
  writeMatrixDir(v3Dir, 'v3', 'V3')

  const config = {
    runId: 'scrna-smoke',
    runDir,
    projectRoot: work,
    params: {
      dataDir: work,
      samples: [
        { name: v2Dir.split(path.sep).pop(), dir: v2Dir },
        { name: v3Dir.split(path.sep).pop(), dir: v3Dir }
      ],
      skipFonts: true
    }
  }
  fs.writeFileSync(path.join(runDir, 'run_config.json'), JSON.stringify(config, null, 2), 'utf8')

  console.log(`Rscript: ${rscript}`)
  console.log(`临时目录: ${work}\n`)

  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync(
      rscript,
      ['--vanilla', path.join(ROOT, 'r', 'scrna', 'run_scrna_import.R'), '--config', 'run_config.json'],
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

  const resultLine = stdout
    .split('\n')
    .find((l) => l.includes('"type":"result"'))
  const errorLine = stdout.split('\n').find((l) => l.includes('"type":"error"'))
  const summary = resultLine
    ? JSON.parse(resultLine.replace(/^@@DEG@@ /, '')).summary
    : null

  expect('R 进程正常结束', exitCode === 0, errorLine ? `错误: ${errorLine.slice(0, 240)}` : `exit=${exitCode}`)
  expect('拿到 result 行', Boolean(summary), '')
  if (!summary) throw new Error('没有 result 行，后续断言无意义')

  expect('两个样本都读进来了', summary.nSamples === 2, `nSamples=${summary.nSamples}`)
  expect('细胞数 > 0', summary.nCells > 0, `nCells=${summary.nCells}（期望 ${N_CELLS * 2}）`)
  expect('基因数 > 0', summary.nGenes > 0, `nGenes=${summary.nGenes}（期望 ${N_GENES}）`)
  expect(
    '细胞数与构造一致',
    summary.nCells === N_CELLS * 2,
    `nCells=${summary.nCells}，期望 ${N_CELLS * 2}`
  )
  expect(
    '基因数与构造一致',
    summary.nGenes === N_GENES,
    `nGenes=${summary.nGenes}，期望 ${N_GENES}`
  )

  // ★ 这条钉的是 feature.column：取错列会拿到 ENS*（基因号），取成数字列会拿到 "1","2","3"
  const first = Array.isArray(summary.firstGenes) ? summary.firstGenes : [summary.firstGenes]
  const allSymbols = first.every((g) => /^GENE\d+$/.test(String(g)))
  expect(
    '行名是 symbol 而不是基因号/序号',
    allSymbols,
    `firstGenes=${JSON.stringify(first)}`
  )

  const objPath = path.join(runDir, 'obj_step1.rds')
  const objOk = fs.existsSync(objPath) && fs.statSync(objPath).size > 1000
  expect('obj_step1.rds 已写出且非空', objOk, objOk ? `${fs.statSync(objPath).size} 字节` : '缺失或过小')

  const png = path.join(runDir, 'p01_cells_per_sample.png')
  expect(
    '没有触发基因名改写（本测试数据不含下划线）',
    (summary.featureNamesRewritten ?? 0) === 0,
    `featureNamesRewritten=${summary.featureNamesRewritten}`
  )

  expect('柱状图已生成', fs.existsSync(png), fs.existsSync(png) ? `${fs.statSync(png).size} 字节` : '缺失')

  const csv = path.join(runDir, 'sample_stats.csv')
  expect('sample_stats.csv 已生成', fs.existsSync(csv), fs.existsSync(csv) ? '' : '缺失')
} catch (err) {
  expect('冒烟未抛异常', false, err instanceof Error ? err.message : String(err))
} finally {
  if (KEEP) console.log(`\n已保留临时目录：${work}`)
  else safeRemove(work)
}

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
