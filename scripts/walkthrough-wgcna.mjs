#!/usr/bin/env node
/**
 * scripts/walkthrough-wgcna.mjs —— WGCNA 模块的真实 UI 走查（Playwright + Electron + 真 R）
 *
 * 为什么要单独一份：WGCNA 是**两段式**链路（prepare → 用户挑 β → network），
 * 中间隔着一次人工决策。单测只到 service 边界（假 runner），R 冒烟不经过 IPC，
 * 两边都发现不了「zod schema 与前端字段对不上」「第二段没复用 runDir 导致缓存永远失效」
 * 「九张图的 file 名与界面按 id 取的路由不一致」这类问题。
 *
 * 走查内容（全部真跑，没有桩业务逻辑）：
 *   1. 侧栏「转录组」→ WGCNA 卡片已从「规划中」变成可点
 *   2. 选演示矩阵 + 性状表 → ① 计算软阈值 → 拟合表出现、推荐 β 被标出
 *   3. 用推荐 β 跑 ② 构建网络 → 九张诊断图、模块 chip、模块-性状相关表全部出现
 *   4. 第二次只改合并高度重跑 → 命中 TOM 缓存（界面出现「复用 TOM 缓存」）且明显更快
 *   5. 导出单张图 + 导出全部图 → 落盘的 png 文件头真是 PNG
 *
 * 原生文件对话框没法用 Playwright 点，所以在主进程里替换
 * `dialog.showOpenDialog` / `showSaveDialog` 的返回值 —— 替换的是**对话框**，
 * 不是业务逻辑：路径之后的读文件、zod 校验、起 R、写图全都是真的。
 *
 * 用法：
 *   npm run build && node scripts/walkthrough-wgcna.mjs
 *   node scripts/walkthrough-wgcna.mjs --keep-screenshots
 *
 * 退出码：0 全部通过 / 1 有断言失败 / 2 环境问题（没构建 / 没 R / 没演示数据）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './lib/tmpdir.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const KEEP = process.argv.includes('--keep-screenshots')

const MATRIX = path.join(ROOT, 'docs', 'demo', 'wgcna-demo-expression.tsv')
const TRAIT = path.join(ROOT, 'docs', 'demo', 'wgcna-demo-trait.txt')

const failures = []
function record(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
function note(title, detail) {
  console.log(`\nℹ️  ${title}\n   ${detail.replace(/\n/g, '\n   ')}`)
}

const WORK = makeTmpDir('wgcna-walkthrough-')
const SHOTS = path.join(WORK, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

async function shot(win, name) {
  const file = path.join(SHOTS, `${name}.png`)
  await win.screenshot({ path: file, fullPage: false })
  return file
}

/** 读 PNG 前 8 字节，确认不是 0 字节或别的格式 */
function isPng(file) {
  if (!fs.existsSync(file)) return false
  const buf = fs.readFileSync(file)
  return (
    buf.length > 1024 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
}

/** 读 PDF 头 5 字节，确认真是 PDF（而不是改了后缀的 png） */
function isPdf(file) {
  if (!fs.existsSync(file)) return false
  const buf = fs.readFileSync(file)
  return buf.length > 1024 && buf.subarray(0, 5).toString('ascii') === '%PDF-'
}

/**
 * 找到最近一次 WGCNA 运行落盘的 run_config.json。
 *
 * 为什么要绕到磁盘上看：界面上「推荐 β」是个 chip，真正送进 R 的是 select 的值。
 * 两者对不上（比如默认值没跟推荐值同步）在界面上看不出来，只能对齐 R 实际收到的参数。
 */
function newestRunConfig(userDataDir) {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 6 || !fs.existsSync(dir)) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'Cache') continue
        walk(full, depth + 1)
      } else if (e.name === 'run_config.json') {
        try {
          const raw = JSON.parse(fs.readFileSync(full, 'utf-8'))
          if (raw?.params?.softPower !== undefined) {
            hits.push({
              file: full,
              runDir: raw.runDir ?? path.dirname(full),
              params: raw.params,
              mtime: fs.statSync(full).mtimeMs
            })
          }
        } catch {
          /* 半截文件，跳过 */
        }
      }
    }
  }
  walk(userDataDir, 0)
  hits.sort((a, b) => b.mtime - a.mtime)
  return hits[0] ?? null
}

async function main() {
  if (!fs.existsSync(OUT_MAIN)) {
    console.error('没有构建产物，先跑 npm run build')
    process.exit(2)
  }
  if (!fs.existsSync(MATRIX) || !fs.existsSync(TRAIT)) {
    console.error(`找不到演示数据：${MATRIX} / ${TRAIT}`)
    process.exit(2)
  }

  console.log(`临时目录：${WORK}`)

  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']
  // 隔离 userData：否则 runtime-probe.json 会沿用上次探测到的 R，
  // 测出来的是缓存而不是真实链路（上一轮吃过这个亏）
  const userDataDir = path.join(WORK, 'userdata')

  console.log('启动 Electron…')
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env,
    timeout: 120_000
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  /** 把「打开文件」钉到指定路径 */
  const stubOpen = (filePath) =>
    app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, filePath)
  const stubOpenDir = (dir) =>
    app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, dir)
  const stubSave = (filePath) =>
    app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, filePath)

  try {
    // ---- ① 载入示例项目（WGCNA 要在项目里落 results/ 目录） ----
    await win.getByText('载入示例项目').first().waitFor({ timeout: 90_000 })
    await win
      .locator('div.MuiCard-root', { hasText: '载入示例项目' })
      .getByRole('button', { name: '载入', exact: true })
      .click()
    await win.getByText('差异表达分析').first().waitFor({ timeout: 90_000 })
    record('载入示例项目', true)

    // ---- ② 侧栏进转录组 → WGCNA 卡片可点 ----
    await win.getByText('转录组', { exact: true }).first().click()
    await win.waitForTimeout(800)
    const wgcnaCard = win.locator('div.MuiCard-root', { hasText: 'WGCNA 共表达网络' }).first()
    await wgcnaCard.waitFor({ timeout: 30_000 })
    const cardText = (await wgcnaCard.innerText()).replace(/\s+/g, ' ')
    // 卡片若还是「规划中」，点进去是空页 —— 先断言它确实变成可用
    record('WGCNA 卡片不再是「规划中」', !/规划中/.test(cardText), cardText.slice(0, 60))
    await wgcnaCard.click()
    // 「第一段：数据与质控」这个标题只在**第一段跑完之后**才出现，
    // 进页时该等的是空态提示和那个按钮
    await win.getByText('先定软阈值 β，再建网络').first().waitFor({ timeout: 30_000 })
    record('进入 WGCNA 页面', win.url().includes('/wgcna'), win.url().split('#')[1] ?? '')
    // 没选矩阵时按钮必须是禁用的（选了才知道该读哪个文件）
    const btnBefore = win.getByRole('button', { name: '① 计算软阈值' }).first()
    record('未选矩阵时「① 计算软阈值」禁用', await btnBefore.isDisabled())
    await shot(win, 'wgcna-empty')

    // ---- ③ 选矩阵 + 性状表 ----
    await stubOpen(MATRIX)
    await win.getByRole('button', { name: '表达矩阵', exact: true }).first().click()
    await win.getByText('wgcna-demo-expression.tsv').first().waitFor({ timeout: 30_000 })
    record('选择表达矩阵', true, path.basename(MATRIX))

    await stubOpen(TRAIT)
    await win.getByRole('button', { name: '性状表（可选）', exact: true }).first().click()
    await win.getByText('wgcna-demo-trait.txt').first().waitFor({ timeout: 30_000 })
    record('选择性状表', true, path.basename(TRAIT))

    // ---- ④ 第一段：计算软阈值 ----
    const prepareBtn = win.getByRole('button', { name: '① 计算软阈值' }).first()
    await prepareBtn.click()

    // 拟合表里会出现 signed R² 表头；软阈值计算在 1250 基因上约 10 秒
    await win.getByText('signed R²').first().waitFor({ timeout: 5 * 60_000 })
    record('第一段返回：软阈值拟合表出现', true)
    await shot(win, 'wgcna-prepare')

    // 统计卡：输入基因数 / 过滤后基因数 / 样本数
    const bodyAfterPrepare = await win.evaluate(() => document.body.innerText)
    record(
      '第一段：输入基因数 2500',
      /2500/.test(bodyAfterPrepare),
      (bodyAfterPrepare.match(/输入基因[^\n]*\n?[^\n]*/) ?? [''])[0]?.slice(0, 40)
    )
    // 推荐 β 在 select 的 option 文案里带「（推荐）」
    const hasRecommend = /（推荐）/.test(bodyAfterPrepare)
    record('第一段：标出了推荐 β', hasRecommend)
    // transformUsed 必须显式告诉用户动没动数据（客户原脚本会二次 log，这里不会）
    record(
      '第一段：显式说明有没有做 log 变换',
      /已做 log2|未变换/.test(bodyAfterPrepare),
      (bodyAfterPrepare.match(/已做 log2[^\n]*|未变换[^\n]*/) ?? [''])[0]
    )

    // 三张质控图必须真的渲染出来（不是空白占位）
    const prepareImgs = await win.locator('img[src^="data:image/png"]').count()
    record('第一段：三张质控图已渲染', prepareImgs >= 3, `${prepareImgs} 张`)

    // ---- ⑤ 第二段：用推荐 β 建网络 ----
    // 推荐 β 显示成一个 Chip（「推荐 β = 16」）；下面要验证真正送进 R 的就是它
    const recommendMatch = /推荐 β = (\d+)/.exec(bodyAfterPrepare)
    const recommendedPower = recommendMatch ? Number(recommendMatch[1]) : null
    record('第一段：推荐 β 的具体数值可读', recommendedPower != null, String(recommendedPower))

    const networkBtn = win.getByRole('button', { name: '② 构建网络' }).first()
    await networkBtn.waitFor({ timeout: 15_000 })

    const t0 = Date.now()
    await networkBtn.click()
    await win.getByText('第二段：网络构建结果').first().waitFor({ timeout: 20 * 60_000 })
    const coldMs = Date.now() - t0
    record('第二段返回：网络构建结果出现', true, `冷启动 ${(coldMs / 1000).toFixed(1)} s`)

    // 直接从落盘的 run_config.json 里核对「送进 R 的 β」＝「界面推荐的 β」
    const cfg = newestRunConfig(userDataDir)
    record(
      '送进 R 的 softPower 与推荐值一致',
      Boolean(cfg) && cfg.params?.softPower === recommendedPower,
      cfg ? `config.softPower=${cfg.params?.softPower}，推荐=${recommendedPower}` : '找不到 run_config.json'
    )
    record(
      '第二段复用了第一段的 runDir（有 stage1.rds）',
      Boolean(cfg) && fs.existsSync(path.join(cfg.runDir, 'stage1.rds')),
      cfg ? path.basename(cfg.runDir) : ''
    )
    await shot(win, 'wgcna-network')

    const bodyAfterNetwork = await win.evaluate(() => document.body.innerText)

    // 九张诊断图（含 p04~p12）
    const allImgs = await win.locator('img[src^="data:image/png"]').count()
    record('第二段：诊断图全部渲染（第一段 3 + 第二段 9）', allImgs >= 12, `共 ${allImgs} 张`)

    // 模块 chip（颜色名）
    const moduleChips = ['turquoise', 'blue', 'brown', 'yellow', 'green'].filter((m) =>
      bodyAfterNetwork.includes(m)
    )
    record('第二段：模块列表出现', moduleChips.length >= 3, moduleChips.join(' / '))

    // 模块-性状相关表：演示数据里 yellow 模块与 group 强相关
    record(
      '第二段：模块-性状相关表有强相关行',
      /0\.8[0-9]/.test(bodyAfterNetwork),
      (bodyAfterNetwork.match(/yellow[^\n]*group[^\n]*/) ?? [''])[0]?.slice(0, 50)
    )

    // ---- ⑤.5 模块基因：点色块看基因、导出列表 ----
    // 客户的实际诉求是「拿到某个模块的基因去做富集」，所以这条链路必须真跑，
    // 不能只断言 chip 上有个数字
    const firstModuleChip = win.getByRole('button', { name: /·\s*\d+$/ }).first()
    await firstModuleChip.waitFor({ timeout: 15_000 })
    const chipLabel = (await firstModuleChip.innerText()).replace(/\s+/g, ' ')
    // chip 文案是「turquoise · 644」：模块名与基因数分开取，后面要拿它们对账
    const chipMatch = /^(\S+)\s*·\s*(\d+)$/.exec(chipLabel)
    const chipModule = chipMatch?.[1] ?? ''
    const chipCount = Number(chipMatch?.[2] ?? 0)

    await firstModuleChip.click()
    // ★ 不能用 document.body 里第一个「N 个基因」—— 页面上方还有一个
    //   「1250 个基因」的总数 chip，第一次写就抓成了它（644 的模块被判成 1250）。
    //   必须锚定到「<模块名> 模块 … N 个基因」这一段，顺便验证面板真的换成了点中的那个模块。
    const panelRe = new RegExp(`${chipModule}\\s*模块\\s*(\\d+)\\s*个基因`)
    await win.waitForFunction(
      (re) => new RegExp(re).test(document.body.innerText),
      panelRe.source,
      { timeout: 20_000 }
    )
    const panelText = await win.evaluate(() => document.body.innerText)
    const panelGeneCount = Number(panelRe.exec(panelText)?.[1] ?? 0)
    record(
      '点模块色块能展开该模块的基因',
      panelGeneCount > 0 && panelGeneCount === chipCount,
      `${chipLabel} → 面板 ${panelGeneCount} 个基因${panelGeneCount === chipCount ? '' : '（与色块不符！）'}`
    )
    await win.screenshot({ path: path.join(SHOTS, 'wgcna-module-genes.png') })

    // 导出该模块的基因列表（txt，一行一个）
    const txtOut = path.join(WORK, 'module-genes.txt')
    await stubSave(txtOut)
    await win.getByRole('button', { name: '导出列表' }).first().click()
    await win.waitForTimeout(2500)
    const txtLines = fs.existsSync(txtOut)
      ? fs.readFileSync(txtOut, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : []
    record(
      '导出该模块基因列表（txt，行数=面板显示数）',
      txtLines.length === panelGeneCount && txtLines.length > 0,
      `${txtLines.length} 行`
    )

    // 导出全部模块（长表 module,gene）
    const allCsv = path.join(WORK, 'all-modules.csv')
    await stubSave(allCsv)
    await win.getByRole('button', { name: '导出模块基因' }).first().click()
    await win.locator('li[role="menuitem"]', { hasText: /全部模块 · CSV/ }).first().click()
    await win.waitForTimeout(2500)
    const allLines = fs.existsSync(allCsv)
      ? fs.readFileSync(allCsv, 'utf8').trim().split(/\r?\n/)
      : []
    record(
      '导出全部模块基因（长表 module,gene）',
      allLines[0] === 'module,gene' && allLines.length > panelGeneCount,
      `${allLines.length - 1} 个基因`
    )

    // ---- ⑥ 只改合并高度重跑 → 命中 TOM 缓存 ----
    // 注意提示文案是「本次复用了 TOM 缓存」，按 /TOM 缓存/ 匹配；
    // 一开始写成 '复用 TOM 缓存' 少了个「了」，选择器等满 20 分钟也等不到（踩过）
    console.log('\n… 调整合并高度，准备第二次构建')
    const slider = win.getByRole('slider').first()
    const mergeBefore = await slider.getAttribute('aria-valuenow')
    await slider.focus()
    for (let i = 0; i < 2; i += 1) await slider.press('ArrowRight')
    const mergeAfter = await slider.getAttribute('aria-valuenow')
    record('合并高度滑杆可调', mergeBefore !== mergeAfter, `${mergeBefore} → ${mergeAfter}`)
    await shot(win, 'wgcna-before-rerun')

    const t1 = Date.now()
    console.log('… 点击「② 构建网络」（第二次）')
    await win.getByRole('button', { name: '② 构建网络' }).first().click()
    await win.getByText(/本次复用了 TOM 缓存/).first().waitFor({ timeout: 10 * 60_000 })
    const warmMs = Date.now() - t1
    record(
      '第二次重跑命中 TOM 缓存',
      warmMs < coldMs,
      `冷 ${(coldMs / 1000).toFixed(1)} s → 热 ${(warmMs / 1000).toFixed(1)} s`
    )

    // ---- ⑦ 导出单张图：PNG 与 PDF 两条路都要真跑 ----
    const exportIcons = win.getByRole('button', { name: /^导出 / })
    const iconCount = await exportIcons.count()
    if (iconCount === 0) {
      record('导出单张诊断图落盘且是 PNG', false, '找不到导出按钮')
    } else {
      // 先 PNG
      const pngOut = path.join(WORK, 'export-one.png')
      await stubSave(pngOut)
      await exportIcons.first().click()
      await win.locator('li[role="menuitem"]', { hasText: /PNG/ }).first().click()
      await win.waitForTimeout(2500)
      record(
        '导出单张诊断图落盘且是 PNG',
        isPng(pngOut),
        `${fs.existsSync(pngOut) ? fs.statSync(pngOut).size : 0} 字节`
      )

      // 再 PDF —— 客户要的是投稿能放大的矢量图，不是「后缀叫 pdf 的位图」
      const pdfOut = path.join(WORK, 'export-one.pdf')
      await stubSave(pdfOut)
      await exportIcons.first().click()
      const pdfItem = win.locator('li[role="menuitem"]', { hasText: /PDF/ }).first()
      await pdfItem.waitFor({ timeout: 10_000 })
      const pdfEnabled = await pdfItem.isEnabled()
      record('导出菜单里 PDF 项可用（说明这次运行带矢量图）', pdfEnabled)
      if (pdfEnabled) {
        await pdfItem.click()
        await win.waitForTimeout(2500)
        const size = fs.existsSync(pdfOut) ? fs.statSync(pdfOut).size : 0
        record('导出单张诊断图为真实 PDF（%PDF- 文件头）', isPdf(pdfOut), `${size} 字节`)
      }
    }

    // ---- ⑧ 导出全部诊断图 ----
    const allDir = path.join(WORK, 'export-all')
    fs.mkdirSync(allDir, { recursive: true })
    await stubOpenDir(allDir)
    await win.getByRole('button', { name: '导出全部诊断图' }).first().click()
    await win.waitForTimeout(4000)
    const pngs = fs.readdirSync(allDir).filter((f) => f.toLowerCase().endsWith('.png'))
    const pdfs = fs.readdirSync(allDir).filter((f) => f.toLowerCase().endsWith('.pdf'))
    record(
      '导出全部诊断图：PNG 9~12 张且文件头正确',
      pngs.length >= 9 && pngs.every((f) => isPng(path.join(allDir, f))),
      `${pngs.length} 张 png`
    )
    record(
      '导出全部诊断图：同名 PDF 一并对齐落盘',
      pdfs.length >= 9 && pdfs.length === pngs.length && pdfs.every((f) => isPdf(path.join(allDir, f))),
      `${pdfs.length} 张 pdf`
    )
    note('导出的图', [...pngs.slice(0, 6), ...pdfs.slice(0, 6)].join('\n'))

    // ---- ⑨ 通用导出表（CSV） ----
    const csvOut = path.join(WORK, 'genes.csv')
    await stubSave(csvOut)
    await win.getByRole('button', { name: '导出结果表' }).first().click()
    await win.waitForTimeout(500)
    const menuItem = win.locator('li[role="menuitem"]', { hasText: /基因.*模块归属/ }).first()
    await menuItem.waitFor({ timeout: 10_000 })
    await menuItem.click()
    await win.waitForTimeout(2500)
    const csvOk = fs.existsSync(csvOut) && fs.readFileSync(csvOut, 'utf-8').split('\n').length > 100
    record('导出结果表（基因模块归属 CSV）', csvOk, csvOk ? `${fs.statSync(csvOut).size} 字节` : '未生成')

    await shot(win, 'wgcna-final')
  } catch (err) {
    record('走查过程未抛异常', false, err instanceof Error ? err.message : String(err))
    try {
      await shot(win, 'wgcna-error')
      const text = await win.evaluate(() => document.body.innerText)
      note('出错时页面文字（末尾 1200 字）', text.slice(-1200))
    } catch {
      /* 窗口可能已经没了 */
    }
  } finally {
    await app.close().catch(() => {})
  }

  console.log('\n' + '─'.repeat(60))
  if (failures.length === 0) {
    console.log('全部通过')
    if (!KEEP) console.log(`截图与导出物留在这里，方便肉眼复核：${SHOTS}`)
    process.exit(0)
  }
  console.log(`失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  console.log(`截图：${SHOTS}`)
  process.exit(1)
}

void main()
