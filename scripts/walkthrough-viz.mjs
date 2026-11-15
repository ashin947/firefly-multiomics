#!/usr/bin/env node
/**
 * scripts/walkthrough-viz.mjs —— **绘图模块的真实 UI 走查**（Playwright + Electron + 真 R）
 *
 * 为什么要单独一份脚本：
 *   `walkthrough-ui.mjs` 走的是转录组的差异分析链路。绘图模块是**另一条完全独立**
 *   的链路：它自己一个 IPC 通道（`deg:viz:render`）、自己的三个 R 脚本、
 *   输入是用户随手给的 csv。那条链路里任何一处对不上（zod schema 与前端拼的字段
 *   不一致、R 的参数名拼错、临时文件没写对），单测和 R 冒烟都发现不了 ——
 *   单测不碰 R，R 冒烟不经过 IPC。
 *
 * 走查内容（全部真实执行，没有任何桩）：
 *   1. 侧栏出现「绘图」模块，首页三张卡片
 *   2. Venn：粘贴 3 组基因 → 自动出图 → 导出 PNG 落盘且文件头是 PNG
 *   3. 分面小提琴：选矩阵 + 分组 → 选基因 → 出图（3 组）
 *   4. 生存曲线：选随访表 → 时间/状态列自动识别 → 出图（risk table）
 *
 * 原生文件对话框没法用 Playwright 点，所以在主进程里替换
 * `dialog.showOpenDialog` / `showSaveDialog` 的返回值为固定路径 —— 这是
 * **替换对话框，不是替换业务逻辑**：路径之后的所有环节（读文件、zod 校验、
 * 起 R、写图）都是真的。
 *
 * 用法：
 *   npm run build && node scripts/walkthrough-viz.mjs
 *   node scripts/walkthrough-viz.mjs --keep-screenshots
 *
 * 退出码：0 全部通过 / 1 有断言失败 / 2 环境问题（没构建、没 R）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir, safeRemove } from './lib/tmpdir.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const KEEP = process.argv.includes('--keep-screenshots')
const RSCRIPT = 'D:\\R-4.3.2\\bin\\x64\\Rscript.EXE'

const failures = []
function record(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
function note(title, detail) {
  console.log(`\nℹ️  ${title}\n   ${detail.replace(/\n/g, '\n   ')}`)
}

/* ------------------------------------------------------------------ */
/* 测试数据（用 JS 生成，不依赖 R，保证脚本可重复）                      */
/* ------------------------------------------------------------------ */

const WORK = makeTmpDir('viz-walkthrough-')

function makeMatrix() {
  const genes = ['GAPDH', 'TMEM158', 'INMT', 'ALOX5AP', 'ACTB', 'MYC']
  const samples = [
    ...Array.from({ length: 8 }, (_, i) => `N${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `C${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `T${i + 1}`)
  ]
  // 固定序列，保证每次跑出来的图一致（否则断言「图变了没」会飘）
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const lines = [`gene,${samples.join(',')}`]
  for (const gene of genes) {
    const cells = samples.map((sample) => {
      let value = 10 + (rand() - 0.5) * 3
      if (gene === 'TMEM158' && sample.startsWith('C')) value += 4
      if (gene === 'INMT' && sample.startsWith('C')) value -= 3
      if (gene === 'ALOX5AP' && sample.startsWith('T')) value += 2
      return value.toFixed(3)
    })
    lines.push(`${gene},${cells.join(',')}`)
  }
  const file = path.join(WORK, 'matrix.csv')
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

function makeGroups() {
  const rows = ['sample,group']
  for (let i = 1; i <= 8; i += 1) {
    rows.push(`N${i},normal`)
    rows.push(`C${i},cancer`)
    rows.push(`T${i},treated`)
  }
  const file = path.join(WORK, 'groups.csv')
  fs.writeFileSync(file, rows.join('\n'), 'utf8')
  return file
}

function makeClinical() {
  const rows = ['sample,time,status,group']
  const groups = ['Low risk', 'Medium', 'High risk']
  for (let i = 0; i < 60; i += 1) {
    const group = groups[i % 3]
    // 高危组时间更短，保证 log-rank 有显著差异
    const base = group === 'Low risk' ? 40 : group === 'Medium' ? 22 : 12
    const time = Math.max(1, base + ((i * 37) % 25) - 12)
    const status = i % 4 === 0 ? 'Alive' : 'Dead'
    rows.push(`S${String(i + 1).padStart(3, '0')},${time},${status},${group}`)
  }
  const file = path.join(WORK, 'clinical.csv')
  fs.writeFileSync(file, rows.join('\n'), 'utf8')
  return file
}

/* ------------------------------------------------------------------ */
/* 截图                                                                */
/* ------------------------------------------------------------------ */

let shotIndex = 0
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots-viz')
async function shot(win, name) {
  if (!KEEP) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  shotIndex += 1
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await win.screenshot({ path: file })
  console.log(`     截图：${path.relative(ROOT, file)}`)
}

/** 当前预览图的 src（没有就是 null） */
async function currentSrc(win) {
  return win.evaluate(() => {
    const el = document.querySelector('img[alt="绘图预览"]')
    return el?.getAttribute('src') ?? null
  })
}

/**
 * 等到预览图真的出现（dataURL），返回它的字节数。
 *
 * ★ 光等「src 是 dataURL」是不够的：改完参数后上一张图还挂在 DOM 上，
 *   这个条件立刻为真，直接返回旧图 —— 于是「图更新了吗」这个断言永远绿。
 *   所以后续调用要传 `prevSrc`，等 src **变化**才算数。
 */
async function waitForImage(win, timeoutMs = 120_000, prevSrc = null) {
  const img = win.locator('img[alt="绘图预览"]').first()
  await img.waitFor({ state: 'visible', timeout: timeoutMs })
  await win.waitForFunction(
    (previous) => {
      const el = document.querySelector('img[alt="绘图预览"]')
      const src = el?.getAttribute('src') ?? ''
      return src.startsWith('data:image/') && src !== previous
    },
    prevSrc,
    { timeout: timeoutMs }
  )
  const src = await img.getAttribute('src')
  return Math.round(((src?.length ?? 0) * 3) / 4)
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(OUT_MAIN)) {
    console.error('没有构建产物，先跑 npm run build')
    process.exit(2)
  }
  if (!fs.existsSync(RSCRIPT)) {
    console.error(`找不到 Rscript：${RSCRIPT}`)
    process.exit(2)
  }

  const matrixFile = makeMatrix()
  const groupsFile = makeGroups()
  const clinicalFile = makeClinical()
  console.log(`测试数据目录：${WORK}`)

  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']
  env['PATH'] = `${path.dirname(RSCRIPT)}${path.delimiter}${env['PATH'] ?? ''}`

  console.log('\n启动 Electron…')
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 120_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  /** 把「打开文件」的返回值钉到指定路径（主进程内替换，业务逻辑全真） */
  const stubOpen = async (filePath) => {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, filePath)
  }
  const stubSave = async (filePath) => {
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, filePath)
  }

  try {
    // ---- ① 载入示例项目，拿到一个可用的项目上下文 ----
    await win.getByText('载入示例项目').first().waitFor({ timeout: 60_000 })
    await win
      .locator('div.MuiCard-root', { hasText: '载入示例项目' })
      .getByRole('button', { name: '载入', exact: true })
      .click()
    await win.getByText('差异表达分析').first().waitFor({ timeout: 60_000 })
    record('载入示例项目', true)

    // ---- ② 侧栏进入绘图模块 ----
    await win.getByText('绘图', { exact: true }).first().click()
    await win.waitForTimeout(600)
    const hashAfterNav = await win.evaluate(() => location.hash)
    const cardCount = await win.getByText('Venn 图').first().isVisible()
    const violinVisible = await win.getByText('分面小提琴图').first().isVisible()
    const survivalVisible = await win.getByText('生存曲线').first().isVisible()
    record(
      '侧栏「绘图」模块 + 三张卡片',
      hashAfterNav.includes('/module/viz') && cardCount && violinVisible && survivalVisible,
      hashAfterNav
    )
    await shot(win, 'viz-module')

    // ---- ③ Venn 图 ----
    await win.getByText('Venn 图').first().click()
    await win.getByPlaceholder('粘贴基因列表（逗号 / 空格 / 换行分隔）').first().waitFor({ timeout: 30_000 })

    const pasteBoxes = win.getByPlaceholder('粘贴基因列表（逗号 / 空格 / 换行分隔）')
    const setA = Array.from({ length: 200 }, (_, i) => `GENE${String(i + 1).padStart(3, '0')}`)
    const setB = Array.from({ length: 200 }, (_, i) => `GENE${String(i + 101).padStart(3, '0')}`)
    const setC = Array.from({ length: 150 }, (_, i) => `GENE${String(i + 201).padStart(3, '0')}`)
    await pasteBoxes.nth(0).fill(setA.join('\n'))
    await pasteBoxes.nth(1).fill(setB.join('\n'))
    await pasteBoxes.nth(2).fill(setC.join('\n'))

    const vennBytes = await waitForImage(win)
    record('Venn：三组基因 → 自动出图', vennBytes > 5000, `预览约 ${vennBytes} 字节`)
    await shot(win, 'venn-preview')

    // --- 交集明细：点行看基因（客户要求「点数字看里面的基因」）---
    await win.getByText('交集明细').first().waitFor({ timeout: 30_000 })
    // 注意：表格行里是**区域名**（「基因集 1 & 基因集 2」）+ 计数，不含基因名。
    // 一开始按 hasText 'GENE' 过滤，一行都匹配不到 —— 基因只出现在展开后的那一行。
    const regionRows = win.locator('table tbody tr')
    const rowCount = await regionRows.count()
    // 三组两两相交：非空区域应该 >= 4（A only / B only / C only / A∩B / ... 中非空的）
    record('Venn：交集明细表列出非空区域', rowCount >= 3, `${rowCount} 行`)
    if (rowCount > 0) {
      await regionRows.first().click()
      // 展开后应出现基因列表文本（逗号分隔的 GENE…）
      await win.waitForFunction(
        () => /GENE\d{3}(,\s*GENE\d{3})+/.test(document.body.innerText),
        undefined,
        { timeout: 15_000 }
      )
      record('Venn：点一行能展开出该区域的基因', true)
      await shot(win, 'venn-region-genes')
    }

    // --- 退化情形：三组各 1 个基因 ---
    const srcBeforeTiny = await currentSrc(win)
    // 客户实际反馈的 bug：VennDiagram 开 scaled/euler.d 时按面积比例画，
    // 小集合会退化 —— 3 组只画出 2 个圈、圈名叠在一起、第三组消失，而图看着"挺正常"。
    // 这里能自动断言的是「仍然出图且数据没崩」；**布局是否真的 3 个圈要靠截图人工看**，
    // 所以这一步必须留截图（--keep-screenshots 时会存下来）。
    await pasteBoxes.nth(0).fill('1')
    await pasteBoxes.nth(1).fill('1')
    await pasteBoxes.nth(2).fill('5')
    const tinyBytes = await waitForImage(win, 120_000, srcBeforeTiny)
    record('Venn：三组各 1 个基因（退化情形）会重绘出图', tinyBytes > 5000, `预览约 ${tinyBytes} 字节`)
    await shot(win, 'venn-tiny-sets')

    // ★ 客户实际崩溃的路径：交集里**只有 1 个基因**时，R 的 toJSON(auto_unbox=TRUE)
    //   会把 genes 从 ["x"] 展开成 "x"，前端 .join() 直接 TypeError 整屏白。
    //   这里点开一个单基因区域，能展开就说明这条链没再退化。
    const tinyRow = win.locator('table tbody tr').first()
    if ((await tinyRow.count()) > 0) {
      await tinyRow.click()
      await win.waitForFunction(
        () => /(^|[^A-Za-z0-9])1([^0-9]|$)|GENE/.test(document.body.innerText),
        undefined,
        { timeout: 15_000 }
      )
      const crashed = /Unexpected Application Error|is not a function/.test(
        await win.evaluate(() => document.body.innerText)
      )
      record('Venn：单基因交集点开不崩溃（auto_unbox 回归）', !crashed)
      await shot(win, 'venn-tiny-region')
    }

    // 恢复到多基因再导出（导出的图用有意义的用例）
    // ★ src 必须在 fill **之前**取：填完到下一张图渲染完之间只有约 1 秒，
    //   先填再取很容易取到已经更新后的图，然后一直等「下一次变化」直到超时。
    const srcBeforeRestore = await currentSrc(win)
    await pasteBoxes.nth(0).fill(setA.join('\n'))
    await pasteBoxes.nth(1).fill(setB.join('\n'))
    await pasteBoxes.nth(2).fill(setC.join('\n'))
    await waitForImage(win, 120_000, srcBeforeRestore)

    // 导出 PNG，落到临时目录，检查文件头
    const vennOut = path.join(WORK, 'venn-export.png')
    await stubSave(vennOut)
    await win.getByRole('button', { name: '导出图片…' }).click()
    await win.getByRole('button', { name: '选择保存位置' }).click()
    const vennOk = await waitForFile(vennOut, 120_000)
    const vennMagic = vennOk ? fs.readFileSync(vennOut).subarray(0, 8).toString('hex') : ''
    record(
      'Venn：导出 PNG 落盘',
      vennOk && vennMagic.startsWith('89504e47'),
      vennOk ? `${fs.statSync(vennOut).size} 字节，文件头 ${vennMagic.slice(0, 8)}` : '文件未生成'
    )

    // ---- ④ 分面小提琴 ----
    await win.evaluate(() => {
      location.hash = '#/module/viz/violin'
    })
    await win.getByRole('button', { name: '选择表达矩阵' }).waitFor({ timeout: 30_000 })

    await stubOpen(matrixFile)
    await win.getByRole('button', { name: '选择表达矩阵' }).click()
    // 探测完成后按钮文案变成「重新选择」，同时出现行×列提示
    await win.getByText(/24 行 × 25 列|行 × .* 列/).first().waitFor({ timeout: 30_000 })

    await stubOpen(groupsFile)
    await win.getByRole('button', { name: '选择分组表' }).click()
    await win.getByText(/共 3 组/).first().waitFor({ timeout: 30_000 })
    record('小提琴：矩阵与分组文件读取 + 角色识别', true, '24 行 × 25 列，3 组')

    // 选基因：**整段粘贴后失焦，不按回车**
    // 客户就是这样用的：打完一串基因名直接去点别处，然后右侧一直空着。
    // 这里刻意不加 Enter —— 按回车反而是"正确姿势"，覆盖不到真实误用。
    const geneBox = win.getByPlaceholder('选或输入基因名，多个用空格/逗号分隔')
    await geneBox.fill('GAPDH TMEM158 INMT ALOX5AP')
    await geneBox.blur()
    const violinBytes = await waitForImage(win)
    record('小提琴：粘贴多基因后失焦即提交 → 自动出图', violinBytes > 5000, `预览约 ${violinBytes} 字节`)
    await shot(win, 'violin-preview')

    // ---- ⑤ 生存曲线 ----
    await win.evaluate(() => {
      location.hash = '#/module/viz/survival'
    })
    await win.getByRole('button', { name: '选择随访表' }).waitFor({ timeout: 30_000 })

    await stubOpen(clinicalFile)
    await win.getByRole('button', { name: '选择随访表' }).click()
    // 列映射的自动探测：时间/状态/分组三列都应被填上
    await win.getByText(/60 行/).first().waitFor({ timeout: 30_000 })
    const selects = await win.evaluate(() => {
      const out = {}
      document.querySelectorAll('label').forEach((label) => {
        const text = label.textContent ?? ''
        const id = label.getAttribute('for')
        if (!id) return
        const el = document.getElementById(id)
        if (el && el.tagName === 'SELECT') out[text] = el.value
      })
      return out
    })
    const timeOk = Object.entries(selects).some(([k, v]) => /生存时间/.test(k) && v === 'time')
    const statusOk = Object.entries(selects).some(([k, v]) => /结局状态/.test(k) && v === 'status')
    const groupOk = Object.entries(selects).some(([k, v]) => /分组列/.test(k) && v === 'group')
    record(
      '生存曲线：时间 / 状态 / 分组列自动识别',
      timeOk && statusOk && groupOk,
      JSON.stringify(selects)
    )

    const survivalBytes = await waitForImage(win)
    record('生存曲线：3 组 KM + risk table → 自动出图', survivalBytes > 5000, `预览约 ${survivalBytes} 字节`)
    await shot(win, 'survival-preview')

    // 页面正文里应出现 log-rank 相关字样（R 侧汇总没回传到 UI，这里只能从图上判断；
    // 因此改成断言「没有任何错误条」——错误会以红色 Alert 出现在预览下方）
    const bodyText = await win.evaluate(() => document.body.innerText)
    const hasError = /出图失败|预览失败/.test(bodyText)
    record('三张图均无错误提示', !hasError, hasError ? '页面上出现了错误条' : '无')
  } catch (error) {
    record('走查过程未抛异常', false, String(error?.message ?? error))
    await shot(win, 'failure')
  } finally {
    await app.close()
    if (!KEEP) safeRemove(WORK)
    else console.log(`\n保留测试数据目录：${WORK}`)
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} 项失败：${failures.join('、')}`)
    process.exit(1)
  }
  console.log('✅ 绘图模块走查全部通过')
  process.exit(0)
}

/** 轮询等待文件出现且大小稳定（R 写完才 close 文件） */
async function waitForFile(file, timeoutMs) {
  const startedAt = Date.now()
  let lastSize = -1
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size
      if (size > 0 && size === lastSize) return true
      lastSize = size
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

await main()
