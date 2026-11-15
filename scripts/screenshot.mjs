/**
 * 截图脚本（Playwright + Electron）。
 *
 * 用法：
 *   npm run build          # 先构建 out/（脚本加载的是构建产物，保证与交付一致）
 *   node scripts/screenshot.mjs
 *
 * 注意：本机环境变量里若带 ELECTRON_RUN_AS_NODE=1，Electron 会以纯 Node 模式启动、
 * 拿不到 app 对象直接退出，因此脚本里必须显式删除它（见 docs/DEV-NOTES.md 第 1 节）。
 *
 * 两阶段：
 *   阶段 1（DEG_DEV_MOCK=1）：演示数据，产出 01–07，展示产品设计上的正常形态；
 *   阶段 2（不开启演示）：真实环境，产出 08，展示「未检测到 R」时的红灯与 R 路径配置入口。
 *
 * 截图尺寸固定 1440×900，输出到 docs/screenshots/。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')

const VIEWPORT = { width: 1440, height: 900 }

/** 阶段 1：演示数据下的 7 张必交截图（地址与 @shared/routes 一致） */
const MOCK_SHOTS = [
  { hash: '#/', file: '01-workspace.png', label: '工作台' },
  { hash: '#/module/transcriptome', file: '02-transcriptome.png', label: '转录组模块首页' },
  { hash: '#/module/scrna', file: '03-scrna.png', label: '单细胞模块首页' },
  { hash: '#/module/spatial', file: '04-spatial.png', label: '空转模块首页' },
  { hash: '#/module/transcriptome/data', file: '05-import.png', label: '导入向导' },
  { hash: '#/module/transcriptome/analysis/de', file: '06-de-config.png', label: '差异分析配置' },
  { hash: '#/module/transcriptome/result/latest', file: '07-result.png', label: '结果总览' },
  // 附加：规划中分析的占位页（客户要求「不能只弹 toast，要有页面说明会输出什么」）
  { hash: '#/module/scrna/analysis/cluster', file: '09-planned-analysis.png', label: '规划中分析占位页' }
]

/** 阶段 2：真实环境（无 R）下的诊断与 R 路径配置 */
const REAL_SHOTS = [{ hash: '#/settings', file: '08-settings-runtime.png', label: '设置/诊断（真实环境）' }]

async function launch({ mock }) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (mock) env.DEG_DEV_MOCK = '1'
  else delete env.DEG_DEV_MOCK

  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 60_000 })
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')

  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate((win, size) => {
    win.setContentSize(size.width, size.height)
    win.center()
  }, VIEWPORT)

  await page.waitForSelector('nav', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  return { app, page }
}

async function capture(page, shots) {
  for (const shot of shots) {
    await page.evaluate((hash) => {
      window.location.hash = hash
    }, shot.hash)
    // 等路由渲染 + ECharts 首次绘制（图表是异步 setOption）
    await page.waitForTimeout(1400)
    const textLength = await page.evaluate(() => (document.body.innerText || '').trim().length)
    if (textLength < 20) {
      throw new Error(`${shot.label} 页面疑似空白（innerText 长度 ${textLength}）`)
    }
    await page.screenshot({ path: path.join(OUT_DIR, shot.file) })
    console.log(`[screenshot] ✓ ${shot.file} — ${shot.label}`)
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  console.log('[screenshot] 阶段 1：演示数据模式（DEG_DEV_MOCK=1）')
  {
    const { app, page } = await launch({ mock: true })
    try {
      const bridgeOk = await page.evaluate(() => typeof window.deg === 'object')
      console.log(`[screenshot] preload 桥${bridgeOk ? '可用' : '不可用（截图仍会继续）'}`)
      await capture(page, MOCK_SHOTS)
    } finally {
      await app.close()
    }
  }

  console.log('[screenshot] 阶段 2：真实环境（不开启演示数据）')
  {
    const { app, page } = await launch({ mock: false })
    try {
      await capture(page, REAL_SHOTS)
    } finally {
      await app.close()
    }
  }

  console.log(`[screenshot] 全部完成，输出目录：${OUT_DIR}`)
}

main().catch((err) => {
  console.error('[screenshot] 失败：', err)
  process.exitCode = 1
})
