#!/usr/bin/env node
/**
 * scripts/verify-restore-project.mjs —— 验证「重启后自动恢复上次项目」
 *
 * 客户实测的 bug：
 *   关掉软件重新打开 → 点侧栏「转录组」→「数据导入与质控」→ 红色横幅
 *   「当前没有打开的项目」；底部状态栏「未打开项目」。
 *   根因：主进程 `ProjectStore` 是纯内存态，退出即丢；`project.json` 其实完好。
 *
 * 这个脚本走**两次真实启动**（同一个 userData，真实落盘），因此能验证到
 * 单测完全碰不到的东西：进程退出后状态还在不在。
 *
 * 覆盖的 7 条：
 *   ① 首次启动载入示例项目后状态栏有物种
 *   ② 完全退出
 *   ③ 重启后自动恢复上次项目（ProjectStore 内存态 → projectStore.restoreLast()）
 *   ④ 数据导入页有真实内容
 *   ⑤a validate 不再报「当前没有打开的项目」（ProjectStore 内存态 → restoreLast()）
 *   ⑤b validate 不再报「尚未导入表达矩阵」（MatrixImporter 内存态 → ensureMatrix()）
 *   ⑤c 关闭再打开项目后，预检路径也会懒恢复矩阵（AnalysisRunner 的矩阵注入点）
 *   ⑥ 恢复过程未改写 data/expression.raw.csv（内容 + mtime 不变）
 *
 * 用法：
 *   npm run build            # 走查的是构建产物 out/
 *   node scripts/verify-restore-project.mjs
 *   node scripts/verify-restore-project.mjs --keep-screenshots
 *
 * 退出码：0 全部通过 / 1 有断言失败 / 2 环境问题（没构建）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const SHOT_DIR = path.join(ROOT, 'test-results', 'restore-project')
const KEEP_SHOTS = process.argv.includes('--keep-screenshots')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

async function shot(win, name) {
  if (!KEEP_SHOTS) return
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await win.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  } catch {
    // 截图失败不影响结论
  }
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

function bodyText(win) {
  return win.evaluate(() => document.body.innerText)
}

/** 与 src/main/logger.ts 的 localDateStamp 保持一致（本地时间，不是 UTC） */
function dateStamp(d) {
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
}

/** 读主进程日志（appendFileSync 同步落盘，所以 IPC 返回后立刻能读到） */
function readLog(userData) {
  const file = path.join(userData, 'logs', `main-${dateStamp(new Date())}.log`)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function countOf(text, regexSource) {
  return (text.match(new RegExp(regexSource, 'g')) ?? []).length
}

/**
 * 成功恢复的那一行日志长这样：`… 恢复内存矩阵 2000×24（只读，未改写 raw.csv）`。
 * 失败的那一行是 `恢复内存矩阵失败：…` —— 两者都含「恢复内存矩阵」四个字，
 * 所以这里必须连行列数一起匹配，否则**恢复失败反而会让断言变绿**。
 */
const RESTORE_LOG = '恢复内存矩阵 \\d+×\\d+'

async function main() {
  if (!fs.existsSync(OUT_MAIN)) {
    console.error('缺少构建产物 out/main/index.js —— 请先 npm run build')
    process.exit(2)
  }

  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  // DEV-NOTES §1：这两个变量会让 Electron 以 Node 模式启动，窗口根本不出来
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']

  const launch = async () => {
    const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 120_000 })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  }

  /* ---- ① 第一次启动：载入示例项目（真实落盘到 userData/demo-projects） ---- */
  let { app, win } = await launch()
  await win.getByText('载入示例项目').first().waitFor({ timeout: 60_000 })
  await win
    .locator('div.MuiCard-root', { hasText: '载入示例项目' })
    .getByRole('button', { name: '载入', exact: true })
    .click()
  await win.getByText('差异表达分析').first().waitFor({ timeout: 60_000 })
  const firstRun = await bodyText(win)
  // 状态栏物种文案来自 SPECIES_LABELS：human → 「人 (Homo sapiens)」。
  // 断言用「有物种 + 不是未打开项目」两条一起，比硬编码某个中文词稳。
  const firstStatus = /Homo sapiens/.test(firstRun) && !firstRun.includes('未打开项目')
  record(
    '① 首次启动：载入示例项目后状态栏显示物种',
    firstStatus,
    /Homo sapiens/.test(firstRun) ? '人 (Homo sapiens)' : '状态栏没有物种'
  )
  await shot(win, '01-first-run')

  /**
   * 记下 data/expression.raw.csv 的「指纹」（内容 + mtime）。
   *
   * 用途见 ⑥：恢复内存矩阵时**绝不能**回写 raw.csv——恢复读的是 clean.csv，
   * 一旦走 importMatrix() 就会把清洗结果写成 raw.csv，用户的原始矩阵（NA 标记、
   * 非数值单元格、重复基因行）不可逆地消失。mtime 一起记，是为了让「写入内容碰巧
   * 相同」这种情况也逃不掉。
   */
  const recentResult = await win.evaluate(() => window.deg.project.recent())
  const projectDir = recentResult?.ok ? recentResult.data?.[0]?.dir ?? null : null
  const rawPath = projectDir ? path.join(projectDir, 'data', 'expression.raw.csv') : null
  const rawBefore =
    rawPath && fs.existsSync(rawPath)
      ? { text: fs.readFileSync(rawPath, 'utf8'), mtimeMs: fs.statSync(rawPath).mtimeMs }
      : null

  /* ---- 完全退出 ---- */
  await app.close()
  record('② 已完全退出（进程结束）', true, 'app.close() 返回')

  /* ---- ③ 第二次启动：应自动恢复上次项目 ---- */
  ;({ app, win } = await launch())
  await win.getByText('载入示例项目').first().waitFor({ timeout: 60_000 })
  // 恢复是异步的（recent → open 两次 IPC），最多等 15 秒
  const restored = await waitForText(win, /Homo sapiens/, 15_000)
  const statusText = (await bodyText(win))
    .split('\n')
    .filter((line) => line.includes('基因 ×') || line.includes('Homo sapiens') || line.includes('未打开项目'))
    .join(' | ')
  record(
    '③ 重启后自动恢复上次项目（状态栏不再是「未打开项目」）',
    restored,
    statusText || '（没读到状态栏）'
  )
  await shot(win, '02-after-restart')

  /* ---- ④ 点侧栏「转录组」→「数据导入与质控」，红色横幅不应出现 ---- */
  await win.getByText('转录组').first().click()
  await win.getByText('数据导入与质控').first().waitFor({ timeout: 30_000 })
  await win.getByText('数据导入与质控').first().click()
  await win.waitForTimeout(1500)
  const dataPage = await bodyText(win)
  // 顺带确认这一页真的能用（不是靠空白页骗过断言）
  const hasRealContent = /表达矩阵|导入|分组/.test(dataPage)
  record('④ 数据导入页有真实内容（不是空白页）', hasRealContent, hasRealContent ? '含导入向导文字' : '页面像是空的')

  /**
   * ★ 因果断言：直接调一个「必须有项目」的 IPC。
   *
   * 为什么不再只查「页面上有没有红条」：那是**下游症状**。没有项目时进入这一页
   * 并不会立刻报错（页面本身不调 IPC），红条要等用户点「下一步 → 校验」才出现。
   * 第一版脚本就是这么写的，反向对照时发现它**在没有修复的情况下也通过**——
   * 一条永远绿的断言等于没有断言。这里改成直接问后端「现在有项目吗」。
   */
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

  const validateResult = await win.evaluate(() => window.deg.data.validate())
  const errorMessage = String(validateResult?.error?.message ?? '')
  const detail = validateResult?.ok
    ? `data.validate → ok（${validateResult.data?.issues?.length ?? 0} 条 issue）`
    : `${validateResult?.error?.code ?? '?'}：${errorMessage || '（无错误信息）'}`

  /**
   * ⑤a 断言「项目门禁已通过」，而不是「这次调用一定成功」。
   * 修复前这里报的是 `E_VALIDATION：当前没有打开的项目`（ProjectStore 是纯内存态）。
   */
  record(
    '⑤a 项目门禁已通过（不再报「当前没有打开的项目」）',
    !errorMessage.includes('当前没有打开的项目'),
    detail
  )

  /**
   * ⑤b 断言「内存矩阵已恢复」。
   *
   * 这是上一轮报告里留下的缺口：`MatrixImporter` 只持有本进程导入过的矩阵，
   * 重启后即便项目恢复成功，`validate()` 仍报 `E_DATA_EMPTY：尚未导入表达矩阵`。
   * 修复方式是 handler 开头的 `ensureMatrix()`（只读恢复 data/expression.clean.csv）。
   *
   * 与 ⑤a 共用同一次 IPC 调用：两种失败模式的错误码不同（E_VALIDATION / E_DATA_EMPTY），
   * 一次响应就能分别判别，不必再发一次请求。
   */
  record(
    '⑤b 内存矩阵已恢复（不再报「尚未导入表达矩阵」）',
    !errorMessage.includes('尚未导入表达矩阵'),
    detail
  )

  /**
   * ⑤c 预检路径也会懒恢复矩阵。
   *
   * 为什么先 `project.close()` 再 `project.open()`：⑤b 的那次 validate 已经把矩阵读回内存了，
   * 此时直接调 preflight 无论如何都能拿到矩阵——断言就变成了「永远绿」。
   * close() 会调 `matrixImporter.reset()`，把内存态清干净，才能测到「重启后第一次
   * 需要矩阵的其实是预检」这个真实场景。
   *
   * 为什么用日志而不是界面文案做证据：`checkIntegerCounts()` 拿不到矩阵时返回
   * `{ok:true, detail:'当前没有可检查的内存矩阵…'}`，而预检界面把 ok 一律渲染成
   * 「已确认数据为整数」——ok 与 skip 两种情况文案**一模一样**，从 UI 上分辨不出来。
   * 主进程日志里那一行「恢复内存矩阵」是唯一可观测的因果证据
   * （appendFileSync 同步落盘，IPC 一返回就能读到）。
   */
  const reopened = await win.evaluate(async (dir) => {
    if (!dir) return { ok: false, error: { message: '没拿到项目目录' } }
    const closed = await window.deg.project.close()
    if (!closed?.ok) return closed
    return window.deg.project.open({ dir })
  }, projectDir)
  const restoresBefore = countOf(readLog(userData), RESTORE_LOG)
  const preflight = await win.evaluate(() =>
    window.deg.analysis.preflight({
      method: 'deseq2',
      config: {
        method: 'deseq2',
        dataType: 'counts',
        contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
        filter: { enabled: true, mode: 'filterByExpr' },
        fdrMethod: 'BH',
        outputGeneName: true,
        keepAllGenes: false
      }
    })
  )
  const restoresAfter = countOf(readLog(userData), RESTORE_LOG)
  record(
    '⑤c 预检路径也会懒恢复矩阵（counts 整数性不是假绿）',
    reopened?.ok === true && restoresAfter > restoresBefore,
    restoresAfter > restoresBefore
      ? `日志新增「恢复内存矩阵」（${restoresBefore} → ${restoresAfter}）`
      : `日志没有恢复记录（close/open ${reopened?.ok ? 'ok' : `err: ${reopened?.error?.message ?? '?'}`}，preflight ${
          preflight?.ok ? 'ok' : `err: ${preflight?.error?.message ?? '?'}`
        }）`
  )

  /**
   * ⑥ raw.csv 未被改写（恢复只读 clean.csv）。
   *
   * 与单测里的 mtime 断言同一个目的，但这里走真实应用 + 真实示例项目，
   * 覆盖的是「handler → ensureMatrix → restoreFromProject」这条真实链路。
   */
  const rawAfter =
    rawPath && fs.existsSync(rawPath)
      ? { text: fs.readFileSync(rawPath, 'utf8'), mtimeMs: fs.statSync(rawPath).mtimeMs }
      : null
  const rawIntact =
    rawBefore !== null &&
    rawAfter !== null &&
    rawBefore.text === rawAfter.text &&
    rawBefore.mtimeMs === rawAfter.mtimeMs
  record(
    '⑥ 恢复过程未改写 data/expression.raw.csv（内容 + mtime 不变）',
    rawIntact,
    rawBefore === null || rawAfter === null
      ? `没读到 raw.csv（projectDir=${projectDir ?? 'null'}）`
      : `${rawBefore.text.length} 字节 / mtime ${new Date(rawBefore.mtimeMs).toISOString()}`
  )

  await shot(win, '03-data-page')

  await app.close()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n总体：${passed}/${results.length} 通过`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error(`验证脚本异常：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
