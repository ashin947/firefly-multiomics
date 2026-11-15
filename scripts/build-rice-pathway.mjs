#!/usr/bin/env node
/**
 * scripts/build-rice-pathway.mjs —— 把 KEGG `dosa` 通路注释转成 R 侧要的两份表
 *
 * ## 为什么不能直接调 enrichKEGG(organism = "dosa")
 *
 * 两个独立的原因，任一条都足以否掉它：
 *   1. **联网**。`enrichKEGG` 会去 rest.kegg.jp 现拉通路数据，实测 15.8 秒，
 *      而且客户机器没网就彻底不可用。本产品的定位是**离线**。
 *   2. **ID 体系不对**。`dosa` 只认 RAP-DB 号（`Os01g0100100`），而客户数据与
 *      我们内置的 GO 注释都是 MSU/LOC 号（`LOC_Os01g01010`）。直接喂 LOC_Os
 *      是 0 条命中，R 只会打印一句 `Expected input gene ID: Os07g0687900, ...`。
 *
 * 所以走「离线下好三份文件 + 本地做 ID 转换 + enricher(TERM2GENE)」这条路。
 *
 * ## 三份输入（`resources/annot/_source/`）
 *
 * | 文件 | 内容 | 行数 |
 * | --- | --- | --- |
 * | `rice_id_rapdb_msu.txt` | RAP-DB ↔ MSU 对照（客户 2026-11-12 提供，2014 版） | 138933 |
 * | `kegg_dosa_pathway_link.txt` | `dosa:Os01g0118000 <TAB> path:dosa00010` | 12950 |
 * | `kegg_dosa_pathway_list.txt` | `dosa01100 <TAB> Metabolic pathways - Oryza ...` | 164 |
 *
 * ## 两个必须处理的坑
 *
 * 1. **tigrId 带 isoform 后缀**（`LOC_Os01g01010.1`）。不去掉 `.\d+$` 就和客户的
 *    `LOC_Os01g01010` 对不上 —— 这类「差一个后缀」的映射失败**不会报错**，
 *    只会让命中率悄悄从 89% 掉到 0。
 * 2. **对照表有 30 多列**，`tigrId` 在哪一列不能硬编码（换一版导出就可能变序）。
 *    按表头找列索引，找不到就明确报错，而不是默默用错列。
 *
 * ## 产物
 *
 * - `rice_pathway.tsv`：宽表 `LOC_Os01g01010 <TAB> dosa00010 <TAB> dosa00260 ...`（无表头）
 * - `rice_pathway_names.tsv`：`dosa01100 <TAB> Metabolic pathways`（无表头）
 *
 *   名字里的 ` - Oryza sativa japonica (Japanese rice) (RAPDB)` 会被去掉：
 *   那是**物种标注**不是通路名，留着表格里又长又没用（另外它是 164 行里每行都有的赘余）。
 *
 * 用法：
 *   node scripts/build-rice-pathway.mjs
 *   node scripts/build-rice-pathway.mjs --check      # 只校验，不写盘（打包前 / CI）
 *   node scripts/build-rice-pathway.mjs --source <dir> --out <dir>
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
const SRC_DIR = path.resolve(ROOT, argOf('--source', 'resources/annot/_source'))
const OUT_DIR = path.resolve(ROOT, argOf('--out', 'resources/annot'))

const SRC_RAP = path.join(SRC_DIR, 'rice_id_rapdb_msu.txt')
const SRC_LINK = path.join(SRC_DIR, 'kegg_dosa_pathway_link.txt')
const SRC_LIST = path.join(SRC_DIR, 'kegg_dosa_pathway_list.txt')
const OUT_PATHWAY = path.join(OUT_DIR, 'rice_pathway.tsv')
const OUT_NAMES = path.join(OUT_DIR, 'rice_pathway_names.tsv')

/** KEGG list 文件里每行都带的物种后缀。去掉不掉的会单独报数（格式漂移的哨兵）。 */
const SPECIES_SUFFIX = /\s+-\s+Oryza sativa japonica \(Japanese rice\) \(RAPDB\)\s*$/
/** MSU isoform 后缀：LOC_Os01g01010.1 → LOC_Os01g01010 */
const ISOFORM_SUFFIX = /\.\d+$/

function fail(message) {
  console.error(`\n[错误] ${message}`)
  process.exit(1)
}

for (const file of [SRC_RAP, SRC_LINK, SRC_LIST]) {
  if (!fs.existsSync(file)) {
    fail(`缺少源文件：${path.relative(ROOT, file)}\n  三个文件都应放在 resources/annot/_source/ 下。`)
  }
}

const startedAt = Date.now()

// ---- 1. RAP-DB ↔ MSU 对照（按表头找列）------------------------------------
const rapLines = fs.readFileSync(SRC_RAP, 'utf8').split(/\r?\n/)
const header = rapLines[0].split('\t').map((c) => c.trim())
const idxRap = header.indexOf('rapLocus')
const idxTigr = header.indexOf('tigrId')
if (idxRap < 0 || idxTigr < 0) {
  fail(
    `对照表表头里找不到 rapLocus / tigrId（表头前 5 列：${header.slice(0, 5).join(' | ')}）。\n` +
      '  不要硬编码列号 —— 换一版导出就会变序，静默用错列会让整个映射变成 0。'
  )
}

/** @type {Map<string, Set<string>>} rapLocus → Set(MSU 去 isoform) */
const rap2msu = new Map()
let rapRows = 0
let rapBadRow = 0
for (let i = 1; i < rapLines.length; i += 1) {
  const line = rapLines[i]
  if (!line || !line.trim()) continue
  const cells = line.split('\t')
  const rap = (cells[idxRap] ?? '').trim()
  const tigr = (cells[idxTigr] ?? '').trim()
  if (!rap || !tigr) {
    rapBadRow += 1
    continue
  }
  rapRows += 1
  const msu = tigr.replace(ISOFORM_SUFFIX, '')
  let set = rap2msu.get(rap)
  if (!set) {
    set = new Set()
    rap2msu.set(rap, set)
  }
  set.add(msu)
}

// ★ 一个 rapLocus 对多个 **不同** MSU 基因时，**全部继承该 RAP 基因的通路注释**。
//
// 这不是 isoform —— `.1`/`.2` 在上面的 ISOFORM_SUFFIX 里已经合并了。
// 剩下这 426 个是 RAP-DB 与 MSU 的**基因模型拆分/合并差异**，例如
//   Os01g0116900 → LOC_Os01g02710 **和** LOC_Os01g02750
// 两边都是合法 MSU 号。
//
// ## 为什么展开，而不是「取第一个」
//
// 这是**数据语义**问题，不是偏好问题：
//
//   RAP-DB 认为「Os01g0116900 这个基因」参与某条通路；MSU 把它拆成了两个基因模型。
//   那么这两个 MSU 基因**都是那个 RAP 基因**，都该继承这条通路注释 ——
//   只取第一个等于让另一个基因凭空失去注释，而它在客户的表达矩阵里是真实存在的
//   （客户的数据是 MSU/LOC 体系，不是 RAP-DB）。
//
// 代价与量级：
//   - LOC 基因数 4554 → 4589（+35，+0.76%）
//   - 同一 RAP 基因会在同一条通路里贡献 2 个 LOC 基因，`BgRatio` 的分母略增；
//     这是**事实**（确实有两个 MSU 基因），不是重复计数。
//
// 「取第一个」曾作为基线（4554），已废弃。别再改回去。
function selectMsu(candidates) {
  return candidates
}
const multiMsuRap = [...rap2msu.values()].filter((s) => s.size > 1).length

// ---- 2. 通路名（去掉物种后缀）---------------------------------------------
/** @type {Map<string, string>} dosa01100 → Metabolic pathways */
const term2name = new Map()
let nameSuffixMissed = 0
for (const line of fs.readFileSync(SRC_LIST, 'utf8').split(/\r?\n/)) {
  if (!line || !line.trim()) continue
  const tab = line.indexOf('\t')
  if (tab < 0) continue
  const term = line.slice(0, tab).trim()
  const raw = line.slice(tab + 1).trim()
  if (!term) continue
  if (!SPECIES_SUFFIX.test(raw)) nameSuffixMissed += 1
  term2name.set(term, raw.replace(SPECIES_SUFFIX, '').trim())
}

// ---- 3. 通路 ↔ RAP 基因，转成 LOC ----------------------------------------
/** @type {Map<string, Set<string>>} LOC → Set(dosaXXXXX) */
const loc2terms = new Map()
let pairTotal = 0
let pairMapped = 0
const unmappedRap = []
const termsUsed = new Set()

for (const line of fs.readFileSync(SRC_LINK, 'utf8').split(/\r?\n/)) {
  if (!line || !line.trim()) continue
  const cells = line.split('\t')
  if (cells.length < 2) continue
  const rap = cells[0].trim().replace(/^dosa:/, '')
  const term = cells[1].trim().replace(/^path:/, '')
  if (!rap || !term) continue
  pairTotal += 1
  const msus = rap2msu.get(rap)
  if (!msus) {
    if (unmappedRap.length < 5) unmappedRap.push(rap)
    continue
  }
  pairMapped += 1
  termsUsed.add(term)
  // 展开：一个 RAP 基因对应的所有 MSU 基因都继承这条通路（见 selectMsu 的注释）
  for (const msu of selectMsu([...msus])) {
    let set = loc2terms.get(msu)
    if (!set) {
      set = new Set()
      loc2terms.set(msu, set)
    }
    set.add(term)
  }
}

if (loc2terms.size === 0) fail('一个 LOC 基因都没映射出来 —— 检查对照表的 tigrId 列。')

// ---- 4. 组装产物（排序保证幂等）------------------------------------------
const genes = [...loc2terms.keys()].sort()
const pathwayLines = []
const allTerms = new Set()
for (const gene of genes) {
  const terms = [...loc2terms.get(gene)].sort()
  for (const t of terms) allTerms.add(t)
  pathwayLines.push([gene, ...terms].join('\t'))
}
const pathwayContent = `${pathwayLines.join('\n')}\n`

// 名称只写「用得到的 term」还是全部 164 条？
// 写全部：以后换了 link 文件、多出几条通路时不用重新生成名称表，而且 --check 更稳。
const nameTerms = [...term2name.keys()].sort()
const nameLines = nameTerms.map((t) => `${t}\t${term2name.get(t)}`)
const namesContent = `${nameLines.join('\n')}\n`

const pathwayBytes = Buffer.byteLength(pathwayContent, 'utf8')
const namesBytes = Buffer.byteLength(namesContent, 'utf8')

// ---- 5. 写盘（内容相同就不动 mtime）--------------------------------------
function writeIfChanged(file, content) {
  const buf = Buffer.from(content, 'utf8')
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file).equals(buf)) return false
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return true
}

let changed = false
if (CHECK_ONLY) {
  for (const [file, content] of [
    [OUT_PATHWAY, pathwayContent],
    [OUT_NAMES, namesContent]
  ]) {
    const buf = Buffer.from(content, 'utf8')
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(buf)) {
      console.error(`\n[不通过] 产物不存在或已过期：${path.relative(ROOT, file)}`)
      console.error('  请执行：node scripts/build-rice-pathway.mjs')
      process.exit(1)
    }
  }
} else {
  changed = writeIfChanged(OUT_PATHWAY, pathwayContent) || changed
  changed = writeIfChanged(OUT_NAMES, namesContent) || changed
}

// ---- 6. 报告 --------------------------------------------------------------
const coverage = ((pairMapped / pairTotal) * 100).toFixed(2)
const termsWithoutName = [...allTerms].filter((t) => !term2name.has(t))

console.log(`源目录    : ${path.relative(ROOT, SRC_DIR)}`)
console.log(`对照表    : rapLocus=${idxRap} tigrId=${idxTigr}｜数据行 ${rapRows}｜唯一 rapLocus ${rap2msu.size}｜缺列行 ${rapBadRow}`)
console.log(`多 MSU 的 rapLocus: ${multiMsuRap} 个（RAP-DB 与 MSU 的基因模型拆分/合并差异，已全部展开继承通路注释）`)
console.log(`通路-基因 : 共 ${pairTotal} 对｜可映射 ${pairMapped}（${coverage}%）｜不可映射 ${pairTotal - pairMapped}`)
console.log(`LOC 基因  : ${loc2terms.size}`)
console.log(`通路      : list 文件 ${term2name.size} 条｜产物里用到 ${allTerms.size} 条` +
  (termsWithoutName.length ? `｜**缺名 ${termsWithoutName.length}**（${termsWithoutName.slice(0, 3).join(',')}）` : ''))
if (unmappedRap.length) {
  console.log(`不可映射样例: ${unmappedRap.join(', ')}（2014 年后新增的 RAP-DB 号，属正常，不要补）`)
}
if (nameSuffixMissed > 0) {
  console.log(`⚠ 有 ${nameSuffixMissed} 条名称没有匹配到物种后缀 —— list 文件格式可能变了，请检查`)
}
console.log(`产物 1    : ${path.relative(ROOT, OUT_PATHWAY)}｜${genes.length} 行｜${pathwayBytes} 字节`)
console.log(`产物 2    : ${path.relative(ROOT, OUT_NAMES)}｜${nameTerms.length} 行｜${namesBytes} 字节`)
console.log(`耗时      : ${((Date.now() - startedAt) / 1000).toFixed(2)}s`)
console.log(
  CHECK_ONLY ? '状态      : 校验通过（产物与源一致）' : changed ? '状态      : 已写入' : '状态      : 与现有产物一致，未改动'
)
