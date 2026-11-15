#!/usr/bin/env node
/**
 * scripts/walkthrough-gsea.mjs —— GSEA 模块的真实 UI 走查（Playwright + Electron + 真 R）
 *
 * 为什么单独一份：GSEA 是唯一一条「必须带 logFC 排序」的链路，输入不是基因集合
 * 而是一张带排序列的表。它自己一个 IPC 通道、自己的 R 脚本、自己的基因集资源
 * （resources/gmt/*.gmt）。任何一处对不上（列名识别、GMT 资源根、fgsea 的并行后端）
 * 单测都发现不了 —— 单测不碰 R，R 冒烟不经过 IPC。
 *
 * 本次重点是**导出格式**：png 与 pdf 在 R 侧是两个独立文件，必须各导一次、
 * 各自校验文件头。之前只导 png，pdf 是这次补的。
 *
 * 原生对话框没法点，所以在主进程里替换 dialog 的返回值 —— 换的是对话框，
 * 不是业务逻辑：路径之后的读文件、zod 校验、起 R、写图全都是真的。
 *
 * 用法：
 *   npm run build && node scripts/walkthrough-gsea.mjs
 *
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境问题
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './lib/tmpdir.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const DEG_FILE = path.join(ROOT, 'docs', 'demo', 'gsea-demo-human.txt')

const failures = []
function record(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const WORK = makeTmpDir('gsea-walkthrough-')
const SHOTS = path.join(WORK, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

function isPng(file) {
  if (!fs.existsSync(file)) return false
  const b = fs.readFileSync(file)
  return b.length > 512 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}
function isPdf(file) {
  if (!fs.existsSync(file)) return false
  const b = fs.readFileSync(file)
  return b.length > 1024 && b.subarray(0, 5).toString('ascii') === '%PDF-'
}

async function main() {
  if (!fs.existsSync(OUT_MAIN)) {
    console.error('没有构建产物，先跑 npm run build')
    process.exit(2)
  }
  if (!fs.existsSync(DEG_FILE)) {
    console.error(`找不到演示差异表：${DEG_FILE}`)
    process.exit(2)
  }

  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']

  console.log(`临时目录：${WORK}\n启动 Electron…`)
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(WORK, 'userdata')}`],
    cwd: ROOT,
    env,
    timeout: 120_000
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const stubOpen = (p) =>
    app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, p)
  const stubSave = (p) =>
    app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, p)

  try {
    // ---- ① 进入模块 ----
    await win.getByText('载入示例项目').first().waitFor({ timeout: 90_000 })
    await win
      .locator('div.MuiCard-root', { hasText: '载入示例项目' })
      .getByRole('button', { name: '载入', exact: true })
      .click()
    await win.getByText('差异表达分析').first().waitFor({ timeout: 90_000 })

    await win.getByText('转录组', { exact: true }).first().click()
    await win.waitForTimeout(700)
    await win.locator('div.MuiCard-root', { hasText: 'GSEA' }).first().click()
    await win.getByText('选择差异结果文件后点「开始 GSEA」').first().waitFor({ timeout: 30_000 })
    record('进入 GSEA 页面', win.url().includes('/gsea'), win.url().split('#')[1] ?? '')

    // ---- ② 选差异表 ----
    await stubOpen(DEG_FILE)
    await win.getByRole('button', { name: '差异结果文件' }).first().click()
    await win.getByText('gsea-demo-human.txt').first().waitFor({ timeout: 30_000 })
    record('选择差异结果文件', true, path.basename(DEG_FILE))

    // ---- ③ 跑 GSEA ----
    const runBtn = win.getByRole('button', { name: '开始 GSEA' })
    const disabledBefore = await runBtn.isDisabled()
    record('选完文件后「开始 GSEA」可用', !disabledBefore)

    const t0 = Date.now()
    await runBtn.click()
    await win.getByText('GSEA 结果').first().waitFor({ timeout: 10 * 60_000 })
    record('GSEA 跑通并出结果', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`)
    await win.screenshot({ path: path.join(SHOTS, 'gsea-result.png') })

    const body = await win.evaluate(() => document.body.innerText)
    record('结果摘要显示基因集数', /\d+ 个基因集/.test(body), (body.match(/\d+ 个基因集/) ?? [''])[0])
    record('top-N 图已渲染', (await win.locator('img[src^="data:image/png"]').count()) >= 1)

    // ---- ④ 导出 PNG 与 PDF（两种格式两条路都要真跑） ----
    const pngOut = path.join(WORK, 'gsea-top.png')
    await stubSave(pngOut)
    await win.getByRole('button', { name: '导出 PNG' }).first().click()
    await win.waitForTimeout(2500)
    record('导出 PNG 落盘且文件头正确', isPng(pngOut), `${fs.existsSync(pngOut) ? fs.statSync(pngOut).size : 0} 字节`)

    const pdfOut = path.join(WORK, 'gsea-top.pdf')
    await stubSave(pdfOut)
    await win.getByRole('button', { name: '导出 PDF' }).first().click()
    await win.waitForTimeout(2500)
    // 关键断言：不是「有个 .pdf 文件」，而是「文件头真是 PDF」。
    // 若 R 侧那段 pdf 设备代码写错（比如 promise 缓存导致第二次不重画），
    // 这里会拿到一个空文件或者干脆没有文件。
    record(
      '导出 PDF 是真正的矢量 PDF（%PDF- 文件头）',
      isPdf(pdfOut),
      `${fs.existsSync(pdfOut) ? fs.statSync(pdfOut).size : 0} 字节`
    )

    // ---- ⑤ 显著性口径 + 完整结果表导出 ----
    const html = await win.evaluate(() => document.body.innerText)
    // 客户要求按 p 值判断显著；同时必须并列给出 FDR，否则读图的人会以为没做多重检验
    const pChip = /p < 0\.05：(\d+)/.exec(html)
    const fdrChip = /FDR < 0\.05：(\d+)/.exec(html)
    record('摘要里同时给出 p 与 FDR 两档显著数', Boolean(pChip) && Boolean(fdrChip),
      `p=${pChip?.[1] ?? '?'}, FDR=${fdrChip?.[1] ?? '?'}`)

    const csvOut = path.join(WORK, 'gsea-result.csv')
    await stubSave(csvOut)
    await win.getByRole('button', { name: '导出完整 CSV' }).first().click()
    await win.waitForTimeout(2500)
    const csvLines = fs.existsSync(csvOut)
      ? fs.readFileSync(csvOut, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : []
    // 表头 1 行 + 46 个基因集：导出的必须是**全量**，不是界面上滚动的那些
    record(
      '导出完整结果表（行数=基因集数，不是界面可见行）',
      csvLines.length === 47 && /^pathway,/.test(csvLines[0] ?? ''),
      `${csvLines.length - 1} 个基因集`
    )
  } catch (err) {
    record('走查过程未抛异常', false, err instanceof Error ? err.message : String(err))
    try {
      await win.screenshot({ path: path.join(SHOTS, 'gsea-error.png') })
      const text = await win.evaluate(() => document.body.innerText)
      console.log('\n出错时页面文字（末尾 900 字）：\n' + text.slice(-900))
    } catch {
      /* 窗口可能已经没了 */
    }
  } finally {
    await app.close().catch(() => {})
  }

  console.log('\n' + '─'.repeat(60))
  if (failures.length === 0) {
    console.log(`全部通过（截图：${SHOTS}）`)
    process.exit(0)
  }
  console.log(`失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}\n截图：${SHOTS}`)
  process.exit(1)
}

void main()
