#!/usr/bin/env node
/**
 * scripts/build-rice-annot.mjs —— 把客户提供的「长表」GO 注释聚合成 R 侧要的「宽表」
 *
 * ## 为什么需要这一步（两个格式之间不是换个分隔符那么简单）
 *
 * 客户给的 `resources/annot/_source/rice_go_matched.txt` 是**一行一个 (GO, 基因)**：
 *
 *     GO_ID           gene_            Description           Category
 *     GO:0030234      LOC_Os01g01010   enzyme regulator ...  MF
 *     GO:0007165      LOC_Os01g01010   signal transduction   BP
 *
 * 25443 个基因 × 平均 7 个 term 摊成 176966 行。而 `r/enrich/run_ora.R` 的
 * `.read_term2gene()` 读的是**一行一个基因、后面跟它所有的 term**：
 *
 *     LOC_Os01g01010\tGO:0030234\tGO:0007165\t...
 *
 * 两个方向差一次转置。可以直接让 R 读长表再 reshape，但 R 侧那个解析器是**按行
 * 拉平**实现的（为了避开 `c()` 循环追加的 O(n²) 性能坑，见 run_ora.R 的注释），
 * 在 Node 里先把转置做掉，R 侧一行代码都不用改，也少一次 25443×7 的内存峰值。
 *
 * ## 为什么 Description / Category 两列不写进产物
 *
 * - `Description`：R 侧用 `GO.db` 离线补（`.attach_go_info()`）。注释文件里的描述
 *   是英文原文，而 GO.db 是同一份数据，两处来源会在「GO 条目改名」时打架。
 *   只留一个来源，才不会出现「同一个 GO 在两张表里名字不同」。
 * - `Category`（BP/CC/MF）：它是 **GO 号自身的属性**，不是注释文件的属性。
 *   写进宽表就得给每个基因的每个 term 重复一遍，而 R 侧已经能按 `ontology`
 *   用 GO.db 现查（`run_ora.R` 的 `.filter_term2gene_by_ontology()`）。
 *   重复存一份的代价是**漂移**：客户重新导出一份 Category 略有不同的文件时，
 *   过滤结果会跟着变，而 GO.db 不会。
 *
 * ## 幂等
 *
 * 同样的输入永远产生同样的字节（基因与 term 都排序）。重复执行是安全的，
 * 第二次会打印「与现有产物一致」而不是让人怀疑是不是又改了内容。
 *
 * 用法：
 *   node scripts/build-rice-annot.mjs
 *   node scripts/build-rice-annot.mjs --check     # 只校验，不写盘（CI / 打包前用）
 *   node scripts/build-rice-annot.mjs --source <path> --out <path>
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)

function argOf(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const CHECK_ONLY = argv.includes('--check')
const SRC = path.resolve(ROOT, argOf('--source', 'resources/annot/_source/rice_go_matched.txt'))
const OUT = path.resolve(ROOT, argOf('--out', 'resources/annot/rice_go.tsv'))

/** GO 号形态：GO:0000001（7 位数字）。形态不对的行不静默丢，最后统一报数。 */
const GO_RE = /^GO:\d{7}$/

function fail(message) {
  console.error(`\n[错误] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(SRC)) {
  fail(`找不到源文件：${path.relative(ROOT, SRC)}\n  客户的原始注释应放在 resources/annot/_source/ 下。`)
}

const startedAt = Date.now()
const raw = fs.readFileSync(SRC, 'utf8')
// 文件是 UTF-8 且带表头；先按行切，再按 \t 切列
const allLines = raw.split(/\r?\n/)

// ---- 1. 定位列（不硬编码列序）-------------------------------------------
// 客户文件当前是 GO_ID / gene_ / Description / Category，但换一版导出就可能变序。
// 表头认不出来时退回「第 1 列 GO、第 2 列基因」并在输出里说明，而不是直接崩掉。
const headerCells = allLines[0].split('\t').map((cell) => cell.trim())
const idxGo = headerCells.findIndex((cell) => /^GO[_\s-]?ID$/i.test(cell))
const idxGene = headerCells.findIndex((cell) => /^gene/i.test(cell))
const idxCategory = headerCells.findIndex((cell) => /^categor/i.test(cell))

const hasHeader = idxGo >= 0 && idxGene >= 0
const goCol = hasHeader ? idxGo : 0
const geneCol = hasHeader ? idxGene : 1
const categoryCol = idxCategory

if (!hasHeader) {
  console.warn(
    `[警告] 表头未识别（首行：${headerCells.join(' | ')}），退回「第 1 列=GO / 第 2 列=基因」`
  )
}

// ---- 2. 聚合 --------------------------------------------------------------
/** @type {Map<string, Set<string>>} gene → Set(term) */
const byGene = new Map()
/** @type {Map<string, number>} 用于报告的 Category 分布 */
const byCategory = new Map()
let dataRows = 0
let skippedBadGo = 0
let skippedEmptyGene = 0
const firstLine = hasHeader ? 1 : 0

for (let i = firstLine; i < allLines.length; i += 1) {
  const line = allLines[i]
  if (!line || !line.trim()) continue
  const cells = line.split('\t')
  const go = (cells[goCol] ?? '').trim()
  const gene = (cells[geneCol] ?? '').trim()
  if (!gene) {
    skippedEmptyGene += 1
    continue
  }
  if (!GO_RE.test(go)) {
    skippedBadGo += 1
    continue
  }
  dataRows += 1
  let terms = byGene.get(gene)
  if (!terms) {
    terms = new Set()
    byGene.set(gene, terms)
  }
  terms.add(go)
  if (categoryCol >= 0) {
    const category = (cells[categoryCol] ?? '').trim()
    if (category) byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
  }
}

if (byGene.size === 0) fail('一行都没解析出来 —— 检查分隔符是否为 Tab。')

// ---- 3. 组装宽表（基因与 term 都排序，保证同样输入 → 同样字节）----------
const genes = [...byGene.keys()].sort()
const allTerms = new Set()
const lines = []
let pairCount = 0
for (const gene of genes) {
  const terms = [...byGene.get(gene)].sort()
  for (const term of terms) allTerms.add(term)
  pairCount += terms.length
  lines.push([gene, ...terms].join('\t'))
}
const content = `${lines.join('\n')}\n`
const bytes = Buffer.byteLength(content, 'utf8')

// ---- 4. 写盘（幂等：内容相同就不动 mtime，方便判断「有没有变」）----------
let changed = true
if (fs.existsSync(OUT)) {
  const previous = fs.readFileSync(OUT)
  changed = !previous.equals(Buffer.from(content, 'utf8'))
}

if (CHECK_ONLY) {
  if (changed) {
    console.error(`\n[不通过] 产物不存在或已过期：${path.relative(ROOT, OUT)}`)
    console.error(`  请执行：node scripts/build-rice-annot.mjs`)
    process.exit(1)
  }
} else if (changed) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, content, 'utf8')
}

// ---- 5. 报告 --------------------------------------------------------------
const categoryText = [...byCategory.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([name, count]) => `${name}=${count}`)
  .join(' / ')

console.log(`源文件    : ${path.relative(ROOT, SRC)}`)
console.log(`产物      : ${path.relative(ROOT, OUT)}`)
console.log(`列定位    : GO=${goCol}  gene=${geneCol}  category=${categoryCol >= 0 ? categoryCol : '（无）'}`)
console.log(`数据行    : ${dataRows}（表头 ${hasHeader ? '已跳过' : '无'}）`)
console.log(`基因数    : ${byGene.size}`)
console.log(`term 数   : ${allTerms.size}（唯一 GO 号）`)
console.log(`基因-term : ${pairCount} 对`)
if (categoryText) console.log(`Category  : ${categoryText}（仅用于核对，不写进产物）`)
if (skippedBadGo) console.log(`丢弃      : ${skippedBadGo} 行 GO 号格式不符`)
if (skippedEmptyGene) console.log(`丢弃      : ${skippedEmptyGene} 行基因列为空`)
console.log(`产物大小  : ${bytes} 字节（${(bytes / 1024 / 1024).toFixed(2)} MB）`)
console.log(`耗时      : ${((Date.now() - startedAt) / 1000).toFixed(2)}s`)
console.log(
  CHECK_ONLY
    ? `状态      : 校验通过（产物与源一致）`
    : changed
      ? `状态      : 已写入`
      : `状态      : 与现有产物一致，未改动`
)
