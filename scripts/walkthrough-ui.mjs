#!/usr/bin/env node
/**
 * scripts/walkthrough-ui.mjs —— **真实 UI 走查**（Playwright + Electron，真跑 R）
 *
 * 为什么需要它：
 *   冒烟脚本验的是「R 算得对不对」，单测验的是「函数行为对不对」。
 *   两者都碰不到一个问题：**用户点下去之后，界面是什么样**。
 *   进度条会不会卡在某个阶段不动？取消能不能真的把 R 进程杀掉？
 *   跑完能不能看到结果？这些只有把应用真的启动起来点一遍才知道。
 *
 * 走查路径（全部走真实代码，没有任何桩）：
 *   工作台 → 载入示例项目 → 模块首页 → 差异表达分析 → 开始分析（真起 Rscript）
 *          → 采样进度 → 分析完成 → 查看结果 → 读统计卡
 *          → 再跑一次并在中途「取消运行」→ 确认 R 进程已被杀掉
 *
 * 用法：
 *   npm run build                      # 走查的是构建产物 out/，不是源码
 *   node scripts/walkthrough-ui.mjs
 *   node scripts/walkthrough-ui.mjs --relax-missing-packages
 *   node scripts/walkthrough-ui.mjs --keep-screenshots
 *
 * 关于 `--relax-missing-packages`（现在是**兜底开关**，正常不该用到）：
 *   `resources/r-libs-manifest.json` 把 DESeq2 / AnnotationDbi / clusterProfiler /
 *   DOSE / enrichplot 都标成 `required: true`，缺任意一个都会让 `RRuntimeInfo.ok=false`。
 *   曾经 `AnalysisRunner.run()` 按这个**全局**清单拦门，导致缺 DESeq2 时连 limma-voom
 *   都点不动（预检全绿、一点报 E_RT_PKG_MISSING）。现在门禁改成按**所选方法的
 *   requiredPackages**，所以本脚本在缺这些包时**也能跑通**，不再需要放宽。
 *   这个开关只把「运行时缺失的包」临时改成 required:false，用于在旧构建或回归排查时
 *   确认问题不是包门禁引起的；脚本结束（含异常）会把清单原样写回。**不是产品行为。**
 *
 * 退出码：0 全部通过 / 1 有断言失败 / 2 环境问题（没构建、没 R）
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const MANIFEST = path.join(ROOT, 'resources', 'r-libs-manifest.json')
const DOCS = path.join(ROOT, 'docs')
const SHOT_DIR = path.join(ROOT, 'test-results', 'walkthrough')

const argv = process.argv.slice(2)
const RELAX = argv.includes('--relax-missing-packages')
const KEEP_SHOTS = argv.includes('--keep-screenshots')
/**
 * `--stress`：改用压力测试数据（20000 基因 × 48 样本）走同一条链路。
 *
 * 为什么需要：默认示例 1 秒跑完，界面上只能采到两三个百分比台阶 ——
 * 「进度条会不会卡住」「阶段说明看不看得懂」这两个问题在 1 秒的任务里看不出来。
 * 压力数据跑几十秒，能真实观察阶段推进；报告写到单独文件，不覆盖默认走查结论。
 */
const STRESS = argv.includes('--stress')
const REPORT = path.join(DOCS, STRESS ? 'WALKTHROUGH-UI-STRESS.md' : 'WALKTHROUGH-UI.md')

/* ------------------------------------------------------------------ *
 * 0. 环境自检
 * ------------------------------------------------------------------ */

function findRscript() {
  const candidates = [
    process.env['DEG_RSCRIPT'],
    'D:/R-4.3.2/bin/x64/Rscript.exe',
    ...(process.env['PATH'] ?? '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'))
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // 继续找
    }
  }
  return null
}

function fail(message, code = 2) {
  console.error(`\n[环境问题] ${message}`)
  process.exit(code)
}

if (!fs.existsSync(OUT_MAIN)) {
  fail('未找到构建产物 out/main/index.js。请先执行：npm run build')
}
const RSCRIPT = findRscript()
if (!RSCRIPT) fail('未找到 Rscript。请设置 DEG_RSCRIPT 或把 R 加入 PATH。')

/* ------------------------------------------------------------------ *
 * 1. 可选：临时放宽 manifest 的 required 标记
 * ------------------------------------------------------------------ */

let manifestBackup = null

function installedMissingRequired() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const missing = []
  for (const pkg of manifest.packages) {
    if (!pkg.required || pkg.speciesScoped) continue
    const probe = `cat(requireNamespace("${pkg.name}", quietly = TRUE))`
    try {
      const out = execFileSync(RSCRIPT, ['--vanilla', '-e', probe], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: '' },
        timeout: 60_000
      })
      if (!/TRUE/.test(out)) missing.push(pkg.name)
    } catch {
      missing.push(pkg.name)
    }
  }
  return missing
}

function relaxManifest(missing) {
  if (missing.length === 0) return
  manifestBackup = fs.readFileSync(MANIFEST, 'utf8')
  const manifest = JSON.parse(manifestBackup)
  for (const pkg of manifest.packages) {
    if (missing.includes(pkg.name)) pkg.required = false
  }
  manifest.notes = `${manifest.notes ?? ''} [walkthrough-ui 临时放宽：${missing.join(',')}]`
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`临时放宽 required：${missing.join('、')}`)
}

function restoreManifest() {
  if (manifestBackup === null) return
  fs.writeFileSync(MANIFEST, manifestBackup, 'utf8')
  manifestBackup = null
  console.log('已还原 resources/r-libs-manifest.json')
}

/* ------------------------------------------------------------------ *
 * 2. 走查
 * ------------------------------------------------------------------ */

const results = []
/** 走查过程中发现的「不是断言失败、但需要人决策」的问题 */
const findings = []
/** 走查环境说明（缺哪些包、临时开关是否生效等），只做记录，不参与判定 */
const notes = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

function finding(title, detail) {
  findings.push({ title, detail })
  console.log(`[发现] ${title}`)
}

function note(title, detail) {
  notes.push({ title, detail })
  console.log(`[说明] ${title}`)
}

/** 从运行遮罩里读当前百分比；读不到返回 null */
async function readPct(win) {
  const text = await win.evaluate(() => document.body.innerText).catch(() => '')
  const match = /(\d{1,3})\s*%/.exec(text)
  return match ? Number(match[1]) : null
}

/** 采样进度：返回 [{ t, pct }]，直到 phase 结束或超时 */
async function sampleProgress(win, { timeoutMs, stopWhen }) {
  const samples = []
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const body = await win.evaluate(() => document.body.innerText).catch(() => '')
    if (await stopWhen(body)) break
    const match = /(\d{1,3})\s*%/.exec(body)
    if (match) {
      const pct = Number(match[1])
      if (samples.length === 0 || samples[samples.length - 1].pct !== pct) {
        samples.push({ t: Date.now() - startedAt, pct })
      }
    }
    await win.waitForTimeout(120)
  }
  return samples
}

/** 统计当前存活的分析用 R 进程数 */
function countRscript() {
  if (process.platform !== 'win32') {
    try {
      return execSync('pgrep -f "run_limma_voom|run_deseq2" | wc -l', { encoding: 'utf8' }).trim()
    } catch {
      return '0'
    }
  }
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Rscript.exe" /NH', { encoding: 'utf8' })
    return String(out.split(/\r?\n/).filter((line) => line.toLowerCase().includes('rscript.exe')).length)
  } catch {
    return '0'
  }
}

async function main() {
  const missing = installedMissingRequired()
  if (missing.length > 0) {
    console.log(`\n运行时缺失的必需包：${missing.join('、')}`)
    if (RELAX) relaxManifest(missing)
    note(
      '运行时缺包，但本方法不受影响',
      `缺失的必需包：${missing.join('、')}。\n` +
        '这些包按用途分三类：DESeq2 只被 deseq2 方法需要；clusterProfiler/DOSE/enrichplot 只被' +
        '富集分析需要；AnnotationDbi 只在 geneIdType≠SYMBOL 时用到。limma-voom 一个都不需要。\n' +
        '`AnalysisRunner.run()` 的门禁按**所选方法的 requiredPackages** 判（`RProcessRunner.' +
        'resolveRscript()` 同样接收这份清单），所以这些包缺失**不会**挡住 limma-voom；' +
        '全局清单 `RRuntimeInfo.ok` 只用于首页的三盏灯和预检提示。\n' +
        (RELAX
          ? '本次加了 `--relax-missing-packages`，清单里的 required 被临时改为 false，结束时已还原。'
          : '本次**没有**加 `--relax-missing-packages`，即上述门禁是在真实产品行为下被验证的。')
    )
  }

  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  // DEV-NOTES §1：这两个变量会让 Electron 以 Node 模式启动，窗口根本不出来
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']
  // 让应用走「系统 PATH」这一级找到 R（客户机器上 R 不在 PATH 时用设置页填路径）
  env['PATH'] = `${path.dirname(RSCRIPT)}${path.delimiter}${env['PATH'] ?? ''}`

  console.log(`\n启动 Electron（Rscript = ${RSCRIPT}）…`)
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 120_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  try {
    // ---- ① 工作台 → 载入示例项目 ----
    // 注意用 .first()：卡片标题与按钮的可访问名都含「载入示例项目」，strict 模式会报多元素
    await win.getByText('载入示例项目').first().waitFor({ timeout: 60_000 })
    record('工作台渲染', true, `标题「${await win.title()}」`)
    await shot(win, '01-workspace')

    // ---- ①b 核心分析包灯：点开应**逐方法**列出可用性 ----
    // 这是客户最容易被误导的地方：缺 DESeq2 不等于软件废了，limma-voom 还能用。
    // 断言「limma-voom 可用」+「DESeq2 缺 DESeq2」同时出现在展开详情里。
    await win.getByText('核心分析包').first().click()
    await win.waitForTimeout(300)
    // ★ 用**定位器**而不是整页 innerText：
    //   灯下面的黄框里也有「（缺 DESeq2）」这句话，拿整页文本判会「假通过」——
    //   断言必须落在展开区里那几行方法上。
    // 四个方法的行都要在（标签来自 registry，这里只做「存在性」判断，不硬编码可用性 ——
    // 包是会被装上的，断言写死「缺 DESeq2」在装好那天就变成假红）
    const labels = ['limma + voom', 'limma 线性模型', 'DESeq2', 'edgeR']
    const rows = []
    for (const label of labels) rows.push((await win.getByText(label).count()) > 0)
    const anyAvailable = (await win.getByText('可用', { exact: true }).count()) > 0
    // 只有真的缺 DESeq2 时才要求出现「缺 DESeq2」那一行
    const needsMissingRow = missing.includes('DESeq2')
    const showsMissing = !needsMissingRow || (await win.getByText('缺 DESeq2', { exact: true }).count()) > 0
    record(
      '核心分析包灯：展开后逐方法列出可用性',
      rows.every(Boolean) && anyAvailable && showsMissing,
      `方法行 ${rows.filter(Boolean).length}/${labels.length}` +
        (needsMissingRow ? '，DESeq2 标为缺包' : '，DESeq2 已就绪')
    )
    await shot(win, '02-runtime-lights')
    if (STRESS) {
      await win.getByRole('button', { name: /载入压力测试数据/ }).click()
    } else {
      await win
        .locator('div.MuiCard-root', { hasText: '载入示例项目' })
        .getByRole('button', { name: '载入', exact: true })
        .click()
    }

    // ---- ② 模块首页 ----
    await win.getByText('差异表达分析').first().waitFor({ timeout: 60_000 })
    record(STRESS ? '载入压力测试数据 → 模块首页' : '载入示例项目 → 模块首页', true, (await win.evaluate(() => location.hash)) || '')

    // ---- ③ 分析配置页 ----
    await win.getByText('差异表达分析').first().click()
    const startButton = win.getByRole('button', { name: '开始分析' })
    await startButton.waitFor({ timeout: 60_000 })
    await win.waitForTimeout(1500) // 等预检（300ms 防抖）出结论
    const preflightText = await win.evaluate(() => document.body.innerText)
    const preflightBlocked = /无法运行|不可运行|缺少/.test(preflightText) && (await startButton.isDisabled())
    record(
      '分析配置页 + 预检',
      !preflightBlocked,
      preflightBlocked ? '预检阻断：开始分析按钮不可用' : '预检通过，开始分析可点'
    )
    if (preflightBlocked) {
      await shot(win, '03-preflight-blocked')
      throw new Error('预检阻断，无法继续走查（通常是 R 包缺失导致）')
    }

    // ---- ④ 真跑一次 ----
    const rBefore = Number(countRscript())
    const t0 = Date.now()
    await startButton.click()
    // 阶段叙述只在「跑得够久」时采得到：默认示例 1.1s，采一次就可能已经结束了。
    // 压力数据要跑几秒，正好用来验证「正在××·细节」「已完成：A → B」这两行真的在。
    let midRunText = ''
    if (STRESS) {
      await win.waitForTimeout(900)
      midRunText = await win.evaluate(() => document.body.innerText)
      await shot(win, '03-running')
    }
    const samples = await sampleProgress(win, {
      timeoutMs: STRESS ? 600_000 : 180_000,
      stopWhen: async (body) => /分析完成|分析失败|已取消/.test(body)
    })
    const runText = await win.evaluate(() => document.body.innerText)
    const succeeded = /分析完成/.test(runText)
    const failed = /分析失败/.test(runText)
    record(
      '真实运行（limma-voom）',
      succeeded && !failed,
      succeeded
        ? `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，进度采样 ${samples.length} 个台阶`
        : `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，遮罩文字：${runText.replace(/\s+/g, ' ').slice(0, 260)}`
    )
    if (missing.length > 0) {
      // 曾经的坑：run() 按全局清单拦门，缺 DESeq2 时连 limma-voom 都起不来。
      // 这条断言把「按方法的包门禁」钉住 —— 全局缺包但本方法能跑，才算对。
      record(
        '全局缺包不阻断所选方法（按方法门禁）',
        succeeded,
        succeeded
          ? `全局缺 ${missing.join('、')}，limma-voom 仍跑通${RELAX ? '（本次放宽了 required，证据偏弱）' : '（未放宽清单）'}`
          : '缺包把本方法一起挡住了，检查 AnalysisRunner 是否又按全局 RRuntimeInfo.ok 拦门'
      )
    }
    if (STRESS) {
      // 只取「正在<阶段名>…」那一行：界面上还有个「正在运行差异分析」的标题，
      // 用 /正在[^\n]*/ 会先命中标题，报告里就变成一句没有信息量的废话。
      const stageLine =
        (midRunText.match(/正在(读取数据|低表达过滤|标准化|估计离散度|拟合模型|统计检验|富集计算|绘图|写出结果)[^\n]*/) ?? [''])[0]
      const completedLine = (midRunText.match(/已完成：[^\n]*/) ?? [''])[0]
      const midPct = Number((/(\d{1,3})\s*%/.exec(midRunText) ?? [])[1] ?? '0')
      // 跑到 28%（标准化）之后，「已完成」里必须出现「低表达过滤」——
      // 这一条正是防「进度事件被节流丢掉 → 某一阶段永远不亮」的回归。
      const completedOk = midPct >= 28 ? /低表达过滤/.test(completedLine) : true
      record(
        '运行中显示阶段名 + 已完成阶段清单',
        Boolean(stageLine) && /已完成：/.test(midRunText) && completedOk,
        `${stageLine || '（没采到阶段行）'} | ${completedLine || '（没采到已完成行）'}`
      )
    }
    record(
      '进度单调不减（没有回退/卡死）',
      isMonotonic(samples) && samples.length >= 3,
      samples.map((s) => s.pct).join('→') || '（没采到百分比）'
    )
    const stall = largestGap(samples)
    const stallLimitMs = STRESS ? 15_000 : 3000
    record(
      `最大进度停顿 < ${stallLimitMs / 1000}s`,
      stall.ms < stallLimitMs,
      `停在 ${stall.pct}% 约 ${(stall.ms / 1000).toFixed(1)}s`
    )
    await shot(win, '04-run-done')
    if (!succeeded) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      fs.writeFileSync(path.join(SHOT_DIR, 'failed-overlay.txt'), runText, 'utf8')
      throw new Error('运行未成功，后续步骤跳过')
    }

    // ---- ⑤ 查看结果 ----
    await win.getByRole('button', { name: '查看结果' }).click()
    await win.getByText('差异分析结果').waitFor({ timeout: 60_000 })
    const resultText = await win.evaluate(() => document.body.innerText)
    const up = cardValue(resultText, '上调基因')
    const down = cardValue(resultText, '下调基因')
    const total = /共\s*([\d,]+)\s*个基因通过过滤/.exec(resultText)?.[1] ?? '?'
    record('结果页渲染（真实结果）', Boolean(up && down), `上调 ${up} / 下调 ${down} / 通过过滤 ${total}`)
    record(
      '结果页不是演示数据',
      !resultText.includes('演示数据'),
      resultText.includes('演示数据') ? '出现了「演示数据」标记' : '无演示标记'
    )
    await shot(win, '05-result')

    // ---- ⑥ 取消能不能杀掉进程 ----
    // 先回到配置页（结果页上没有「开始分析」）。示例数据跑一次只要 ~1.1s，
    // 取消窗口很窄，所以最多试 3 次；每次都是「点开始 → 等遮罩 → 立刻取消」。
    let cancelled = false
    let rDuring = 0
    const cancelAttempts = STRESS ? 1 : 3
    for (let attempt = 1; attempt <= cancelAttempts && !cancelled; attempt += 1) {
      await win.evaluate(() => {
        location.hash = '#/module/transcriptome/analysis/de'
      })
      await win.waitForTimeout(800)
      // 回到配置页时，上一次「分析完成」的运行遮罩会自动重新打开（store 里 phase 还是
      // success）。MUI Dialog 会把页面其余部分标成 aria-hidden，于是「开始分析」在
      // Playwright 眼里「不可见」—— 必须先把它关掉。
      const closeBtn = win.getByRole('button', { name: '关闭' })
      if ((await closeBtn.count()) > 0) await closeBtn.last().click().catch(() => {})
      await win.waitForTimeout(300)
      const startAgain = win.getByRole('button', { name: '开始分析' })
      await startAgain.waitFor({ timeout: 60_000 })
      await win.waitForTimeout(300)
      await startAgain.click()
      await win.getByText('正在运行差异分析').waitFor({ timeout: 30_000 })
      // 等 runId 回来（IPC 是毫秒级），否则 cancel 找不到进程可杀
      await win.waitForTimeout(200)
      rDuring = Math.max(rDuring, Number(countRscript()))
      await win.getByRole('button', { name: '取消运行', exact: true }).first().click()
      // 二次确认对话框里的确认按钮（文案同「取消运行」，取最后一个）
      await win.getByRole('button', { name: '取消运行', exact: true }).last().click()
      cancelled = await waitForText(win, /已取消/, 20_000)
      if (!cancelled) {
        // 这一轮没赶上（跑完了），关掉遮罩重试
        await win.getByRole('button', { name: '关闭' }).last().click().catch(() => {})
        await win.waitForTimeout(500)
      }
    }
    // 给 kill 一点时间落地
    await win.waitForTimeout(2500)
    const rAfter = Number(countRscript())
    record('取消 → UI 进入「已取消」', cancelled, cancelled ? '遮罩显示已取消' : '3 次尝试都没赶上取消窗口')
    record(
      '取消 → R 进程已终止',
      cancelled && rAfter <= rBefore,
      `运行中 Rscript ${rDuring} 个 → 取消后 ${rAfter} 个（基线 ${rBefore}）`
    )
    await shot(win, '06-cancelled')
  } finally {
    await app.close().catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 * 3. 小工具
 * ------------------------------------------------------------------ */

function isMonotonic(samples) {
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].pct < samples[i - 1].pct) return false
  }
  return true
}

function largestGap(samples) {
  let best = { ms: 0, pct: samples[0]?.pct ?? 0 }
  for (let i = 1; i < samples.length; i += 1) {
    const ms = samples[i].t - samples[i - 1].t
    if (ms > best.ms) best = { ms, pct: samples[i - 1].pct }
  }
  return best
}

/** 从统计卡所在卡片里取数字（卡片里有 hint 文案，用它定位） */
function cardValue(bodyText, label) {
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim())
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(label)) continue
    // 标签下面几行里找纯数字（MUI 的行内布局在不同 innerText 版本下可能把数字和
    // 提示语放在同一行，所以不能用固定偏移）
    for (let j = i + 1; j <= i + 4 && j < lines.length; j += 1) {
      const direct = /^([\d,]+)$/.exec(lines[j])
      if (direct) return direct[1]
      const inline = /^([\d,]+)\s+(logFC|未达阈值)/.exec(lines[j])
      if (inline) return inline[1]
    }
  }
  return null
}

async function waitForText(win, regex, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const body = await win.evaluate(() => document.body.innerText).catch(() => '')
    if (regex.test(body)) return true
    await win.waitForTimeout(200)
  }
  return false
}

async function shot(win, name) {
  if (!KEEP_SHOTS) return
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await win.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  } catch {
    // 截图失败不影响走查结论
  }
}

/* ------------------------------------------------------------------ *
 * 4. 报告
 * ------------------------------------------------------------------ */

function writeReport() {
  const passed = results.filter((r) => r.ok).length
  const lines = []
  lines.push(STRESS ? '# 真实 UI 走查报告（压力测试数据 20,000 × 48）' : '# 真实 UI 走查报告（Playwright + Electron）')
  lines.push('')
  lines.push('> 本文件由 `scripts/walkthrough-ui.mjs` 自动生成，请勿手工编辑。')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- Rscript：${RSCRIPT}`)
  lines.push(`- 走查对象：构建产物 \`out/\`（源码改动后需先 \`npm run build\`）`)
  lines.push(`- 示例数据：${STRESS ? '压力测试 20,000 基因 × 48 样本' : '默认 2,000 基因 × 24 样本'}`)
  lines.push(`- 临时放宽 required：${RELAX ? '是（仅本次走查，结束已还原）' : '否'}`)
  lines.push(`- **结论：${passed === results.length ? '全部通过 ✅' : `存在失败 ❌（${results.length - passed} 项）`}**`)
  lines.push('')
  lines.push('| 步骤 | 结果 | 详情 |')
  lines.push('| --- | --- | --- |')
  for (const item of results) {
    lines.push(`| ${item.name} | ${item.ok ? '✅' : '❌'} | ${item.detail ?? ''} |`)
  }
  lines.push('')
  if (notes.length > 0) {
    lines.push('## 环境说明')
    lines.push('')
    notes.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${item.title}`)
      lines.push('')
      lines.push(item.detail)
      lines.push('')
    })
  }
  if (findings.length > 0) {
    lines.push('## 发现的问题（不是断言失败，需要决策）')
    lines.push('')
    findings.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${item.title}`)
      lines.push('')
      lines.push(item.detail)
      lines.push('')
    })
  }
  lines.push('## 走查路径')
  lines.push('')
  lines.push('```')
  lines.push('工作台 → 载入示例项目 → 模块首页 → 差异表达分析 → 开始分析（真起 Rscript）')
  lines.push('      → 采样进度 → 分析完成 → 查看结果 → 读统计卡')
  lines.push('      → 再跑一次并在中途取消 → 确认 R 进程已终止')
  lines.push('```')
  lines.push('')
  lines.push('## 说明')
  lines.push('')
  lines.push('- 进度采样每 120ms 读一次运行遮罩上的百分比，只记录**变化**（台阶）。')
  lines.push('- 「最大进度停顿」是相邻两个台阶之间的最大时间差 —— 它比总耗时更能反映')
  lines.push('  「进度条是不是卡住了」：总耗时里有 R 启动（约 0.3–0.5s）和进程回收。')
  lines.push('- 取消测试会真的杀掉 R 进程；用 `tasklist` 数 Rscript.exe 的数量来验证。')
  lines.push('- 示例数据一次 limma-voom 只要 ~1.1s，采样窗口很窄，界面上只能看到几个台阶；')
  lines.push('  R 侧 13 条进度消息是否全部发出、pct 是否单调，由 `docs/SMOKE-R-DE.md` 的 A5 覆盖。')
  if (KEEP_SHOTS) lines.push(`- 截图：\`${path.relative(ROOT, SHOT_DIR)}\``)
  fs.mkdirSync(DOCS, { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`\n报告已写入：${REPORT}`)
  console.log(`总体：${passed}/${results.length} 通过`)
  return passed === results.length
}

/* ------------------------------------------------------------------ *
 * 5. 入口
 * ------------------------------------------------------------------ */

let exitCode = 1
try {
  await main()
  exitCode = writeReport() ? 0 : 1
} catch (err) {
  console.error(`\n[走查中断] ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
  writeReport()
} finally {
  restoreManifest()
}
process.exit(exitCode)
