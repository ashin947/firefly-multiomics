#!/usr/bin/env node
/**
 * 回归总入口 —— 一条命令回答「我这次改动有没有把别的模块带坏」。
 *
 * ## 为什么需要它（而不是记住 20 个 npm script）
 *
 * 项目里本来就有二十来个验证入口，分层很清楚：
 *
 *   L0 静态    typecheck / lint
 *   L1 单测    vitest（不碰 R，20 秒）
 *   L2 R 冒烟  直接驱动 Rscript，验「算得对不对」（不经过 Electron）
 *   L3 轻走查  真起 Electron、真点按钮，但只跑单细胞第 5/6 步与状态栏（几分钟）
 *   L4 基线    客户真实矩阵上的那七个数字（需 D:/ai/data，最慢）
 *   L5 重走查  差异分析 / 绘图 / GSEA / WGCNA 的完整 UI 流程（10 分钟以上）
 *
 * 问题在于**没有人记得全**：改完 `r/common/save_plot.R` 该跑哪些？
 * 于是每次靠「想起来再跑」，而忘了的那次就是把客户环境搞坏的那次。
 *
 * 这个脚本只做三件事：按层串起来、失败就停并说清**期望什么**、最后给一张汇总表。
 * 不重新实现任何断言 —— 每条都是既有的入口，一个字符都不改。
 *
 * ## 用法
 *
 *   node scripts/regress.mjs               # L0+L1+L2+L3（默认，约 6 分钟）
 *   node scripts/regress.mjs --fast        # L0+L1（约 1 分钟，改前端时够用）
 *   node scripts/regress.mjs --ui          # L5（完整 UI 流程，10 分钟以上）
 *   node scripts/regress.mjs --baseline    # L4（客户数据，需 D:/ai/data）
 *   node scripts/regress.mjs --all         # 全部
 *   node scripts/regress.mjs --layer=2     # 只跑某几层（可逗号分隔）
 *   node scripts/regress.mjs --only=sam    # 只跑名字含 sam 的步骤
 *   node scripts/regress.mjs --list        # 只列出步骤，不执行
 *   node scripts/regress.mjs --keep-going  # 失败也继续（默认失败即停：先修第一个错）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPORT = path.join(ROOT, '.tmp', 'regress-report.json')

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}

/* ------------------------------------------------------------------ *
 * 环境探测：缺 R / 缺客户数据时**跳过而不是失败**（且要说清原因）
 * ------------------------------------------------------------------ */
function findRscript() {
  if (process.env.DEG_RSCRIPT) return process.env.DEG_RSCRIPT
  const bundled = path.join(ROOT, 'resources', 'runtime', 'R', 'bin', 'Rscript.exe')
  if (fs.existsSync(bundled)) return bundled
  const candidates =
    process.platform === 'win32'
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/Rscript.exe']
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript']
  return candidates.find((c) => fs.existsSync(c)) ?? ''
}
const RSCRIPT = findRscript()
const DATA_DIR = process.env.DEG_DATA_DIR || 'D:/ai/data'

const npm = (script) => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', script] })
const node = (file, args = []) => ({ cmd: process.execPath, args: [path.join(ROOT, file), ...args] })

/**
 * 步骤清单。
 *
 * `expect` 是给人看的**预期数字/口径**：失败时原样打印，
 * 让人一眼知道「是这个数字变了」而不是「有个命令挂了」。
 */
const STEPS = [
  // ---------------- L0 静态 ----------------
  {
    id: 'typecheck',
    layer: 0,
    name: 'TypeScript 类型检查（node + web 两套）',
    ...npm('typecheck'),
    expect: '退出码 0，无输出错行'
  },
  {
    id: 'lint',
    layer: 0,
    name: 'ESLint（含 no-restricted-syntax 的架构约束）',
    ...npm('lint'),
    expect: '退出码 0'
  },

  // ---------------- L1 单测 ----------------
  {
    id: 'unit',
    layer: 1,
    name: 'vitest 全量单测（不碰 R）',
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vitest', 'run'],
    expect: '44 文件 / 411 条全绿（新增用例后数字只会增）'
  },

  // ---------------- L2 R 冒烟 ----------------
  {
    id: 'r-de',
    layer: 2,
    needsR: true,
    name: 'R 差异分析 5 条方法（limma-voom / limma-lm / limma-lm-log2 / DESeq2 / edgeR）',
    cmd: RSCRIPT || 'Rscript',
    args: [path.join(ROOT, 'scripts', 'smoke-r-de.R')],
    expect: '脚本自报「全部通过 ✅」；A3 = 通过过滤的植入基因 ≥85% 显著'
  },
  {
    id: 'r-failures',
    layer: 2,
    needsR: true,
    name: 'R 失败路径契约（退出码 10/11/12/13/14 → 错误码）',
    ...node('scripts/smoke-r-failures.mjs'),
    expect: '退出码精确等于期望值，且 @@DEG@@ error 行能被解析'
  },
  {
    id: 'scrna-import',
    layer: 2,
    needsR: true,
    name: '单细胞第 1 步：10x 导入（v2 genes.tsv / v3 features.tsv 都要认）',
    ...node('scripts/smoke-scrna-import.mjs'),
    expect: '两种目录都能建对象；缺文件时报具体缺哪个'
  },
  {
    id: 'scrna-qc',
    layer: 2,
    needsR: true,
    name: '单细胞第 2 步：质控/过滤（无线粒体基因、三阈值全空）',
    ...node('scripts/smoke-scrna-qc.mjs'),
    expect: 'mtGeneCount=0 时不筛细胞；阈值全 null 不是错误'
  },
  {
    id: 'scrna-prep',
    layer: 2,
    needsR: true,
    name: '单细胞第 3 步：标准化/PCA/harmony（单样本跳过 harmony）',
    ...node('scripts/smoke-scrna-prep.mjs'),
    expect: 'activeReduction 与对象里真实存在的 reduction 一致'
  },
  {
    id: 'scrna-embed',
    layer: 2,
    needsR: true,
    name: '单细胞第 4 步：聚类/UMAP/tSNE（列名必须是 clusters）',
    ...node('scripts/smoke-scrna-embed.mjs'),
    expect: '单样本走 pca；clusters 列存在；簇数是数字序'
  },
  {
    id: 'scrna-markers',
    layer: 2,
    needsR: true,
    name: '单细胞第 5 步：Marker（future.globals.maxSize 静默 0 行那类坑）',
    ...node('scripts/smoke-scrna-markers.mjs'),
    expect: 'totalMarkers > 0；二次筛选行数与 summary 一致；每簇 top10 ≤ 10'
  },
  {
    id: 'scrna-annotate',
    layer: 2,
    needsR: true,
    name: '单细胞第 6 步：细胞注释（clusters 列必须留下）',
    ...node('scripts/smoke-scrna-annotate.mjs'),
    expect: '34/34；客户 clusterAnn 两列无表头格式可直读'
  },
  {
    id: 'scrna-custom-plots',
    layer: 2,
    needsR: true,
    name: '单细胞自选基因两图（DotPlot + 小提琴）',
    ...node('scripts/smoke-scrna-custom-plots.mjs'),
    expect: '22/22；两张图都 > 5 KB 且各有一份矢量 PDF'
  },
  {
    id: 'scrna-gene-query',
    layer: 2,
    needsR: true,
    name: '单细胞基因查询三图（FeaturePlot / 小提琴 / DotPlot）',
    ...node('scripts/smoke-scrna-gene-query.mjs'),
    expect: '25/25；split 下 palette 不变；celltype 色派生自簇色'
  },
  {
    id: 'scrna-import-object',
    layer: 2,
    needsR: true,
    name: '「从 rds 继续」的四类判定',
    ...node('scripts/smoke-scrna-import-object.mjs'),
    expect: '有降维无聚类 / 无降维 / 非 Seurat / 损坏文件各自不同的错误码'
  },
  {
    id: 'timeseries-sam',
    layer: 2,
    needsR: true,
    name: '时序单序列 SAM（UTF-16LE/UTF-8 一致、阈值单调、LOC_ 容错）',
    ...node('scripts/smoke-timeseries-sam.mjs'),
    expect: '22/22'
  },
  {
    id: 'timeseries-moanin',
    layer: 2,
    needsR: true,
    name: '时序两组 moanin（df 校验、五条 lfc、Fisher 合并、seed 固定）',
    ...node('scripts/smoke-timeseries-moanin.mjs'),
    expect: '23/23'
  },

  // ---------------- L3 轻走查（真 Electron，几分钟） ----------------
  {
    id: 'statusbar',
    layer: 3,
    name: '状态栏 R 文案（探针未回来时不许说「未检测到」）',
    ...node('scripts/walkthrough-statusbar.mjs'),
    expect: '5/5；采样序列里从未出现「未检测到」「环境待完善」'
  },
  {
    id: 'export',
    layer: 3,
    name: '单细胞图导出按钮（PDF/PNG 落盘 + 导出的一定是那张图）',
    ...node('scripts/walkthrough-scrna-export.mjs'),
    expect: '16/16；导出文件与 runDir 里同名 pdf 字节一致'
  },

  // ---------------- L4 客户数据基线 ----------------
  {
    id: 'baseline',
    layer: 4,
    needsR: true,
    needsData: true,
    name: '客户数据基线（1242 / 2835 / 18740+6844+4328+1877 / 四组 20114）',
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vitest', 'run', '--config', 'vitest.baseline.config.ts'],
    expect:
      'fpkm109=1,242(561/681)；fpkm109dt=2,835(2472/363)；dtck=18,740→6,844/4,328→1,877；fpkm(4 组,df=4)=20,114 + 6 个对比的 q 计数'
  },

  // ---------------- L5 重走查（完整 UI 流程） ----------------
  {
    id: 'ui-de',
    layer: 5,
    name: '差异分析完整 UI（进度 / 结果 / 中途取消要杀掉 R 进程）',
    ...node('scripts/walkthrough-ui.mjs'),
    expect: '脚本自报全过；取消后无残留 Rscript'
  },
  {
    id: 'ui-viz',
    layer: 5,
    name: '绘图模块（Venn / 火山 / 热图，png+pdf 各导一次）',
    ...node('scripts/walkthrough-viz.mjs'),
    expect: '脚本自报全过；导出文件头正确'
  },
  {
    id: 'ui-gsea',
    layer: 5,
    name: 'GSEA（带 logFC 排序列 + GMT 资源 + fgsea）',
    ...node('scripts/walkthrough-gsea.mjs'),
    expect: '脚本自报全过；png/pdf 各自校验文件头'
  },
  {
    id: 'ui-wgcna',
    layer: 5,
    name: 'WGCNA（两段式 + TOM 缓存命中）',
    ...node('scripts/walkthrough-wgcna.mjs'),
    expect: '脚本自报全过；第二次重跑命中缓存且更快'
  },
  {
    id: 'ui-restore',
    layer: 5,
    name: '重启后自动恢复上次项目（真实两次启动）',
    ...node('scripts/verify-restore-project.mjs'),
    expect: '7 条全过；重启后状态栏有物种、横幅不再出现'
  }
]

/* ------------------------------------------------------------------ *
 * 选层
 * ------------------------------------------------------------------ */
function selectLayers() {
  const layerArg = flagValue('layer')
  if (layerArg) return new Set(layerArg.split(',').map((s) => Number(s.trim())))
  if (hasFlag('all')) return new Set([0, 1, 2, 3, 4, 5])
  if (hasFlag('fast')) return new Set([0, 1])
  if (hasFlag('ui')) return new Set([5])
  if (hasFlag('baseline')) return new Set([4])
  return new Set([0, 1, 2, 3])
}

const layers = selectLayers()
const only = flagValue('only')
const picked = STEPS.filter(
  (s) => layers.has(s.layer) && (!only || s.id.includes(only) || s.name.includes(only))
)

if (hasFlag('list') || picked.length === 0) {
  console.log('可用步骤：')
  for (const s of STEPS) console.log(`  L${s.layer}  ${s.id.padEnd(20)} ${s.name}`)
  console.log('\n层：L0 静态 / L1 单测 / L2 R 冒烟 / L3 轻走查 / L4 客户数据 / L5 重走查')
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */
const results = []
const t0 = Date.now()

function skipReasonOf(step) {
  if (step.needsR && !RSCRIPT) return '找不到 Rscript（设 DEG_RSCRIPT 或装 R 4.2+）'
  if (step.needsData) {
    const need = ['fpkm109.txt', 'fpkm109dt.txt', 'fpkm109dtck.txt']
    const lack = need.filter((f) => !fs.existsSync(path.join(DATA_DIR, f)))
    if (lack.length > 0) return `缺客户数据 ${lack.join(', ')}（设 DEG_DATA_DIR）`
  }
  return ''
}

console.log(`\n=== 回归：${picked.length} 个步骤，层 ${[...layers].sort().join(',')} ===\n`)

for (const step of picked) {
  const skip = skipReasonOf(step)
  if (skip) {
    console.log(`[SKIP] ${step.id}  ${step.name}\n        原因：${skip}`)
    results.push({ id: step.id, name: step.name, status: 'skip', reason: skip, ms: 0 })
    continue
  }
  console.log(`\n[RUN ] ${step.id}  ${step.name}`)
  console.log(`        预期：${step.expect}`)
  const started = Date.now()
  // ★ Windows 上 `npm.cmd` / `npx.cmd` 必须走 shell（Node 20+ 起直接 spawn .cmd 会 EINVAL）；
  //   shell 模式下 Node 只是把参数用空格拼起来，所以带空格的路径要自己加引号。
  const needsShell = /\.(cmd|bat)$/i.test(step.cmd)
  const args = needsShell ? step.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : step.args
  const r = spawnSync(step.cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: needsShell,
    env: { ...process.env, DEG_RSCRIPT: RSCRIPT || process.env.DEG_RSCRIPT || '', DEG_DATA_DIR: DATA_DIR }
  })
  const ms = Date.now() - started
  const ok = r.status === 0
  results.push({ id: step.id, name: step.name, status: ok ? 'pass' : 'fail', ms, expect: step.expect })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step.id}  ${(ms / 1000).toFixed(1)} s`)
  if (!ok) {
    console.log(`        ↑ 期望：${step.expect}`)
    if (!hasFlag('keep-going')) {
      console.log('\n失败即停（加 --keep-going 可继续跑完，看是不是只有这一处）')
      break
    }
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const pass = results.filter((r) => r.status === 'pass')
const fail = results.filter((r) => r.status === 'fail')
const skip = results.filter((r) => r.status === 'skip')
const notRun = picked.filter((s) => !results.some((r) => r.id === s.id))

console.log('\n================ 汇总 ================')
for (const r of results) {
  const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭'
  const secs = r.ms > 0 ? ` ${(r.ms / 1000).toFixed(1)}s` : ''
  console.log(`${mark} L${STEPS.find((s) => s.id === r.id)?.layer ?? '?'} ${r.id.padEnd(20)}${secs}${r.reason ? `  (${r.reason})` : ''}`)
}
if (notRun.length > 0) console.log(`⚪ 未执行：${notRun.map((s) => s.id).join(', ')}`)
console.log(
  `\n通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skip.length} / 未执行 ${notRun.length}` +
    ` · 总耗时 ${((Date.now() - t0) / 1000).toFixed(0)} s`
)

fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(
  REPORT,
  JSON.stringify(
    { at: new Date().toISOString(), platform: `${process.platform}-${os.release()}`, rscript: RSCRIPT, layers: [...layers], results },
    null,
    2
  ),
  'utf8'
)
console.log(`报告：${REPORT}`)

process.exit(fail.length === 0 ? 0 : 1)
