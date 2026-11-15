/**
 * 单细胞「图右上角 PDF / PNG 导出按钮」真机点按走查（walkthrough）。
 *
 * ## 为什么要单独一支
 *
 * `smoke-*` 验的是 R 端「图与 PDF 都产出了」，`__tests__/figureExport` 验的是
 * 「复制的白名单/报错分支」，两边都碰不到**界面接线**：
 * 按钮绑的是哪张图的文件名、点了走哪条 IPC、失败会不会显示出来。
 * 实测就踩过一次——`plots.map` 里错用了 `current.file`，
 * 结果是「按钮在、导出的是别张图」，两边测试都不会响。
 *
 * ## 断言的关键：字节比对
 *
 * 只断言「导出的是个合法 PDF」抓不到导错图（热图 PDF 也合法）。
 * 所以导出后必须与 `runDir` 里**按钮所属那张**的 pdf 逐字节比对。
 *
 * ## 阶段
 *
 *  A. 第 5 步「自选基因一键两张图」（用 `obj_step4.rds` 跳过 1–4 步）
 *     · 两张图各有按钮；导出 PDF 与 `p04_dotplot_custom.pdf` 字节一致；
 *     · 删掉 pdf 再点 → 提示「没有 PDF 版本」且**不留空文件**；导出 PNG 正常。
 *  B. 第 6 步「基因查询出一张三张图」（用 `obj_step5.rds` 跳过 1–5 步）
 *     · 三张图各有按钮；FeaturePlot 导出的 pdf 与 `p06_feature.pdf` 字节一致；
 *     · 26k 细胞的散点数据区仍是矢量（没有大位图）。
 *
 * ## 前置对象从哪来
 *
 *  · `obj_step4.rds`：用界面跑完第 4 步后，从 userData 下 `results/scrna/<id>/` 拷一份；
 *  · `obj_step5.rds`：同上，跑完第 5 步后拷。
 *  两个都没有时用 `DEG_OBJ_STEP4` / `DEG_OBJ_STEP5` 指定，缺失的阶段会 SKIP（不动退出码）。
 *
 * 用法：
 *   node scripts/walkthrough-scrna-export.mjs
 *   DEG_OBJ_STEP4=D:/path/obj_step4.rds DEG_OBJ_STEP5=D:/path/obj_step5.rds node scripts/walkthrough-scrna-export.mjs
 * 退出码：全过 0 / 有失败 1
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
const { _electron } = await import('playwright')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const USERDATA = path.join(ROOT, '.tmp', 'scrna-export-userdata')
const SHOTS = path.join(ROOT, '.tmp', 'scrna-export-shots')
/**
 * ★ 每次运行用独立的输出子目录，而不是「清空固定目录」。
 *
 * 两个原因：
 *  1. 清空要删文件，而受限环境（工作台的删除护栏）会在一次调用里累计删
 *     超过 N 个文件时直接 throw —— 脚本会因为收尾动作而以退出码 1 结束；
 *  2. 更危险的是**残留文件让断言假通过**：上一轮导出的 `exported.pdf` 还在，
 *     `waitFile()` 立刻返回 true，「点按钮后落盘」这条断言就没意义了。
 */
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const OUT5 = path.join(ROOT, '.tmp', 'scrna-export-out', STAMP, 'step5')
const OUT6 = path.join(ROOT, '.tmp', 'scrna-export-out', STAMP, 'step6')
const STEP4 = process.env.DEG_OBJ_STEP4 || path.join(ROOT, '.tmp', 'embed-verify', 'obj_step4.rds')
const STEP5 = process.env.DEG_OBJ_STEP5 || path.join(ROOT, '.tmp', 'mk-verify', 'obj_step5.rds')

fs.mkdirSync(SHOTS, { recursive: true })
fs.mkdirSync(OUT5, { recursive: true })
fs.mkdirSync(OUT6, { recursive: true })

const results = []
const expect = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFile = async (p, ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return true
    await sleep(200)
  }
  return fs.existsSync(p)
}

/**
 * 找**本次**运行的 runDir。
 *
 * 复用 `--user-data-dir` 时「载入示例项目」会再生成一个 `… (2).degproj`，
 * 取「第一个 results/scrna」会拿到上一次运行的目录（实测导致假失败），
 * 所以收集全部 `<...>/results/scrna/<id>` 再按 mtime 取最新。
 */
function newestRunDir(root) {
  const hits = []
  const walk = (d) => {
    let ents = []
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const full = path.join(d, e.name)
      const norm = full.replace(/\\/g, '/')
      if (/\/results\/scrna\/[^/]+$/.test(norm) && !norm.endsWith('/_inspect')) hits.push(full)
      walk(full)
    }
  }
  walk(root)
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? ''
}

/** PDF 里所有位图对象的尺寸（colourbar 渐变条是小图，数据区被光栅化才是大图） */
function embeddedImages(buf) {
  return [...buf.toString('latin1').matchAll(/\/Subtype\s*\/Image\s*\/Width (\d+)\s*\/Height (\d+)/g)].map(
    (m) => [Number(m[1]), Number(m[2])]
  )
}

/** 起一个 Electron 实例 + 回到单细胞页，返回操作句柄 */
async function boot() {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${USERDATA}`],
    cwd: ROOT,
    env,
    timeout: 120000
  })
  const win = await app.firstWindow()
  const consoleErrs = []
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrs.push(m.text())
  })
  win.on('pageerror', (e) => consoleErrs.push('PAGEERROR: ' + e.message))
  await win.waitForLoadState('domcontentloaded')

  const vis = (sel, text) =>
    win.locator(`${sel}:visible`, text === undefined ? {} : { hasText: text }).first()
  const clickBtn = async (name, timeout = 180000) => {
    const b = vis('button', name)
    await b.waitFor({ timeout })
    await b.click()
  }
  const stubOpen = (p) =>
    app.evaluate(({ dialog }, t) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [t] })
    }, p)
  const stubSave = (p) =>
    app.evaluate(({ dialog }, t) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: t })
    }, p)

  await win.getByText('载入示例项目').first().waitFor({ timeout: 90000 })
  await win
    .locator('div.MuiCard-root', { hasText: '载入示例项目' })
    .getByRole('button', { name: '载入', exact: true })
    .click()
  await win.getByText('差异表达分析').first().waitFor({ timeout: 90000 })
  await win.getByText('单细胞', { exact: true }).first().click()
  await win.waitForTimeout(700)
  await win.locator('div.MuiCard-root', { hasText: '单细胞' }).first().click()
  await win.waitForTimeout(1200)
  const sidebar = win.locator('div.MuiCard-root', { hasText: '分析步骤' }).first()

  return {
    app,
    win,
    vis,
    clickBtn,
    stubOpen,
    stubSave,
    sidebar,
    consoleErrs,
    bodyText: () => win.evaluate(() => document.body.innerText)
  }
}

/* ==================== A. 第 5 步：自选基因两张图 ==================== */
async function phaseStep5() {
  if (!fs.existsSync(STEP4)) {
    console.log(`[SKIP] 第 5 步：找不到 ${STEP4}（用 DEG_OBJ_STEP4 指定）`)
    return
  }
  const t = await boot()
  try {
    await t.sidebar.getByText('Marker 基因', { exact: true }).click()
    await t.win.getByText('5. Marker 基因').first().waitFor({ state: 'visible', timeout: 20000 })
    await t.vis('p', '已有中间对象').click({ timeout: 20000 })
    await t.stubOpen(STEP4)
    await t.clickBtn('选择 .rds')
    await t.vis('button', '用这个对象继续').waitFor({ timeout: 180000 })
    await t.clickBtn('用这个对象继续')
    await t.win.getByText(/步未在本工具中运行/).first().waitFor({ timeout: 240000 })
    await t.win.waitForTimeout(800)

    await t.win.getByPlaceholder(/粘贴基因名/).first().fill('Os08g0427700 Os10g0413400')
    await t.win.waitForTimeout(300)
    await t.clickBtn('出图')
    await t.win.getByText(/自选基因小提琴/).first().waitFor({ timeout: 300000 })
    await t.win.waitForTimeout(1500)

    const pdfBtns = t.win.getByRole('button', { name: 'PDF', exact: true })
    const pngBtns = t.win.getByRole('button', { name: 'PNG', exact: true })
    const n = await pdfBtns.count()
    expect('[5] 两张图右上角各有 PDF/PNG 按钮', n >= 2 && (await pngBtns.count()) >= 2, `${n} 组`)

    const runDir = newestRunDir(USERDATA)
    const pdfsIn = fs.readdirSync(runDir).filter((f) => f.endsWith('.pdf'))
    const pngsIn = fs.readdirSync(runDir).filter((f) => f.endsWith('.png'))
    expect('[5] runDir 里 PNG+PDF 双份', pngsIn.length >= 2 && pdfsIn.length >= 2,
      `png ${pngsIn.length} / pdf ${pdfsIn.length}`)

    // ---- 正常导出 PDF ----
    const outPdf = path.join(OUT5, 'exported.pdf')
    await t.stubSave(outPdf)
    await pdfBtns.first().scrollIntoViewIfNeeded()
    await pdfBtns.first().click()
    const okPdf = await waitFile(outPdf)
    const pdfSize = okPdf ? fs.statSync(outPdf).size : 0
    expect('[5] 点 PDF 后落盘（> 5 KB）', okPdf && pdfSize > 5120, `${pdfSize} 字节`)
    const buf = okPdf ? fs.readFileSync(outPdf) : Buffer.alloc(0)
    expect('[5] 是 %PDF- 头', buf.subarray(0, 5).toString('latin1') === '%PDF-')
    const imgs = embeddedImages(buf)
    expect('[5] 数据区矢量（只允许 colourbar 小位图）',
      imgs.every(([w, h]) => w <= 400 && h <= 400) && buf.includes(Buffer.from('/Font')),
      `位图 ${JSON.stringify(imgs)}`)
    const srcFirst = path.join(runDir, 'p04_dotplot_custom.pdf')
    expect('[5] 导出的正是按钮所属的那张图',
      okPdf && fs.existsSync(srcFirst) && Buffer.compare(buf, fs.readFileSync(srcFirst)) === 0)

    // ---- 缺 PDF：明确报错、不留空文件 ----
    const backups = pdfsIn.map((f) => ({ f, bak: path.join(runDir, f + '.bak') }))
    for (const b of backups) fs.renameSync(path.join(runDir, b.f), b.bak)
    const outMissing = path.join(OUT5, 'should-not-exist.pdf')
    await t.stubSave(outMissing)
    await t.win.waitForTimeout(300)
    await pdfBtns.first().click()
    await sleep(900)
    const alerts = await t.win.locator('div.MuiAlert-root:visible').allTextContents().catch(() => [])
    const msg = alerts.map((s) => String(s).trim()).find((s) => /没有 PDF|未生成|异常/.test(s)) ?? ''
    expect('[5] 缺 PDF 时给一句人话（不静默）', msg.length > 0, msg.slice(0, 60))
    expect('[5] 缺 PDF 时不留空文件', !fs.existsSync(outMissing))
    await t.win.screenshot({ path: path.join(SHOTS, 'step5-missing-pdf.png') })
    for (const b of backups) fs.renameSync(b.bak, path.join(runDir, b.f))

    // ---- 正常导出 PNG ----
    const outPng = path.join(OUT5, 'exported.png')
    await t.stubSave(outPng)
    await t.win.waitForTimeout(400)
    await pngBtns.first().click()
    const okPng = await waitFile(outPng)
    const pngSize = okPng ? fs.statSync(outPng).size : 0
    const head = okPng ? fs.readFileSync(outPng).subarray(0, 8).toString('latin1') : ''
    expect('[5] 点 PNG 后落盘且是真 PNG', okPng && pngSize > 5120 && head.includes('PNG'), `${pngSize} 字节`)
    await t.win.screenshot({ path: path.join(SHOTS, 'step5-buttons.png') })
    expect('[5] 渲染进程无未预期报错', t.consoleErrs.length === 0, t.consoleErrs.slice(-3).join(' | '))
  } finally {
    await t.app.close()
  }
}

/* ==================== B. 第 6 步：基因查询三张图 ==================== */
async function phaseStep6() {
  if (!fs.existsSync(STEP5)) {
    console.log(`[SKIP] 第 6 步：找不到 ${STEP5}（用 DEG_OBJ_STEP5 指定）`)
    return
  }
  const t = await boot()
  try {
    await t.sidebar.getByText('细胞注释', { exact: true }).click()
    await t.win.getByText('6. 细胞注释').first().waitFor({ state: 'visible', timeout: 20000 })
    await t.vis('p', '已有中间对象').click({ timeout: 20000 })
    await t.stubOpen(STEP5)
    await t.clickBtn('选择 .rds')
    await t.vis('button', '用这个对象继续').waitFor({ timeout: 180000 })
    await t.clickBtn('用这个对象继续')
    await t.win.getByText(/步未在本工具中运行/).first().waitFor({ timeout: 240000 })
    await t.win.getByText(/共 14 个簇/).first().waitFor({ timeout: 60000 })

    for (const c of ['0', '1', '2', '5', '6', '7', '8', '9', '10', '11', '12']) {
      await t.win.getByPlaceholder(`cluster_${c}`).first().fill('Parenchyma')
    }
    for (const c of ['3', '4', '13']) {
      await t.win.getByPlaceholder(`cluster_${c}`).first().fill('Vascular')
    }
    const t0 = Date.now()
    await t.clickBtn('应用注释')
    await t.win.getByText('注释结果').first().waitFor({ timeout: 600000 })
    console.log(`[6] 注释耗时 ${((Date.now() - t0) / 1000).toFixed(0)} s`)

    await t.win
      .getByPlaceholder(/一行一个（空格 \/ 逗号分隔也行），例如/)
      .first()
      .fill('Os08g0427700 Os01g0239000')
    await t.win.waitForTimeout(200)
    await t.clickBtn('出图')
    await t.win.getByText(/FeaturePlot（2 个基因/).first().waitFor({ timeout: 300000 })
    await t.win.waitForTimeout(1500)

    const gqCard = t.win.locator('div.MuiCard-root:visible', { hasText: '基因查询' }).last()
    const gqPdfs = gqCard.getByRole('button', { name: 'PDF', exact: true })
    const n = await gqPdfs.count()
    expect('[6] 三张图各有 PDF 按钮', n >= 3, `${n} 个`)

    const runDir = newestRunDir(USERDATA)
    const srcFeature = path.join(runDir, 'p06_feature.pdf')
    expect('[6] 产出 p06_feature.pdf', fs.existsSync(srcFeature),
      fs.existsSync(srcFeature) ? `${fs.statSync(srcFeature).size} 字节` : runDir)

    const outPdf = path.join(OUT6, 'feature.pdf')
    await t.stubSave(outPdf)
    await gqPdfs.first().scrollIntoViewIfNeeded()
    await gqPdfs.first().click()
    const ok = await waitFile(outPdf)
    const buf = ok ? fs.readFileSync(outPdf) : Buffer.alloc(0)
    expect('[6] 点 FeaturePlot 的 PDF 落盘（> 5 KB）', ok && buf.length > 5120, `${buf.length} 字节`)
    expect('[6] 导出的正是 FeaturePlot（字节一致）',
      ok && fs.existsSync(srcFeature) && Buffer.compare(buf, fs.readFileSync(srcFeature)) === 0)
    const big = embeddedImages(buf).filter(([w, h]) => w > 400 || h > 400)
    expect('[6] 26k 细胞散点的数据区仍是矢量', big.length === 0, JSON.stringify(big))
    expect('[6] 渲染进程无报错', t.consoleErrs.length === 0, t.consoleErrs.slice(-3).join(' | '))
  } finally {
    await t.app.close()
  }
}

await phaseStep5()
await phaseStep6()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
