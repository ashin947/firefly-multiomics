#!/usr/bin/env node
/**
 * scripts/build-gmt.mjs —— 把 MSigDB 原始 GMT 规范化为随包格式
 *
 * ## 为什么要过一道
 *
 * MSigDB 的 GMT 第二列是**基因集主页 URL**：
 *
 *   HALLMARK_ADIPOGENESIS  https://www.gsea-msigdb.org/gsea/msigdb/human/geneset/HALLMARK_ADIPOGENESIS  ABCA1 ...
 *
 * 那一列在 fgsea / clusterProfiler 里从头到尾用不到（它们只读名称和基因），
 * 但能把文件撑大一倍（Reactome 那份 833 KB 里近一半是 URL）。规范成空描述后
 * 体积减半，且不改变任何计算结果。
 *
 * 同时做两件校验：
 *   ① 跳过表头/注释行（MSigDB 部分版本首行是 `!` 开头的说明）
 *   ② 基因去重（同一个基因在一条通路里出现两次会让 fgsea 的游走偏大）
 *
 * 用法：node scripts/build-gmt.mjs [--check]
 * 源：resources/gmt/_source/msigdb_<species>_<collection>.gmt
 * 产物：resources/gmt/<species>_<collection>.gmt
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'resources', 'gmt', '_source')
const OUT = path.join(ROOT, 'resources', 'gmt')
const CHECK = process.argv.includes('--check')

/** 物种 × 集合 —— 小鼠没有 KEGG 集合（MSigDB 里 m2.cp.kegg_legacy 不存在） */
const SETS = [
  ['human', 'hallmark'],
  ['human', 'kegg'],
  ['human', 'reactome'],
  ['mouse', 'hallmark'],
  ['mouse', 'reactome']
]

function build(species, collection) {
  const srcPath = path.join(SRC, `msigdb_${species}_${collection}.gmt`)
  const outPath = path.join(OUT, `${species}_${collection}.gmt`)
  if (!fs.existsSync(srcPath)) return null

  const lines = fs.readFileSync(srcPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('!'))
  const out = []
  let dupRemoved = 0

  for (const line of lines) {
    const cells = line.split('\t')
    if (cells.length < 3) continue
    const name = cells[0].trim()
    // cells[1] 是 URL，丢弃
    const genes = []
    const seen = new Set()
    for (let i = 2; i < cells.length; i += 1) {
      const g = cells[i].trim()
      if (!g) continue
      if (seen.has(g)) {
        dupRemoved += 1
        continue
      }
      seen.add(g)
      genes.push(g)
    }
    if (genes.length === 0) continue
    // GMT 规范要求第二列存在（可以是空），否则下游按位置取基因会把描述当基因
    out.push([name, '', ...genes].join('\t'))
  }

  if (CHECK) {
    if (!fs.existsSync(outPath)) {
      console.log(`${species}_${collection}: 缺少产物`)
      return false
    }
    const same = fs.readFileSync(outPath, 'utf8') === out.join('\n') + '\n'
    console.log(`${species}_${collection}: ${same ? '与产物一致' : '产物已过期'}（${out.length} 集）`)
    return same
  }

  fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8')
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0)
  const srcKb = (fs.statSync(srcPath).size / 1024).toFixed(0)
  console.log(
    `${species}_${collection}: ${out.length} 集｜${srcKb} KB → ${kb} KB` +
      (dupRemoved > 0 ? `｜去重基因 ${dupRemoved} 个` : '')
  )
  return true
}

let ok = true
for (const [s, c] of SETS) {
  const r = build(s, c)
  if (r === null) console.log(`${s}_${c}: 源文件缺失，跳过`)
  else if (r === false) ok = false
}
if (CHECK && !ok) process.exit(1)
