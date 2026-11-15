/**
 * 状态栏 R 状态文案走查（抓「偶发」的假信息）。
 *
 * ## 为什么必须逐帧采样
 *
 * 这个 bug 只在启动后的几十毫秒到几秒内出现：探针还没回来，界面已经渲染出
 * 「R 未检测到 · 环境待完善」。等你去截图，它早变成「R 4.3.2 · 环境正常」了。
 * 所以脚本一进页面就装一个 16ms 的采样器，把这块的**每一句不同文案**连时间戳记下来。
 *
 * ## 断言
 *
 *  1. 采样序列里**不允许出现「未检测到」**（本机装了 R，说没有就是假的）；
 *  2. 也不允许出现「环境待完善」这类**结论**（探针没回来时不能给灯色）；
 *  3. 最终稳定在「R x.y.z」；
 *  4. 若曾出现「正在检测 R…」，说明 pending 态真的被渲染过（记一笔，不强制——
 *     探针命中缓存时可能不到一帧）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
const { _electron } = await import('playwright')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const USERDATA =
  process.env.DEG_WALKTHROUGH_USERDATA || path.join(ROOT, '.tmp', 'statusbar-walkthrough-userdata')

const results = []
const expect = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

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

// 尽早装采样器：每 16ms 读一次，只在文案变化时记一条
await win.evaluate(() => {
  window.__statusSamples = []
  const t0 = performance.now()
  const timer = setInterval(() => {
    const el = document.querySelector('[data-testid="runtime-status"]')
    const txt = el ? (el.textContent || '').trim() : ''
    const last = window.__statusSamples[window.__statusSamples.length - 1]
    if (txt && (!last || last.txt !== txt)) {
      window.__statusSamples.push({ at: Math.round(performance.now() - t0), txt })
    }
  }, 16)
  setTimeout(() => clearInterval(timer), 12000)
})

try {
  await win.getByText('载入示例项目').first().waitFor({ timeout: 90000 })
  // 探测没回来时抓一张证据图（冷启动这段有数秒，足够截到）
  await win.waitForTimeout(600)
  const shotDir = path.join(ROOT, '.tmp', 'statusbar-shots')
  fs.mkdirSync(shotDir, { recursive: true })
  const bar = win.locator('[data-testid="runtime-status"]').first()
  const pendingTxt = ((await bar.textContent().catch(() => '')) || '').trim()
  if (pendingTxt.includes('正在检测')) {
    await bar.screenshot({ path: path.join(shotDir, 'pending.png') })
    console.log(`[截图] pending 态：${path.join(shotDir, 'pending.png')}`)
  }
  // 等稳定：状态栏出现 R 版本号（本机装了 R）
  await win
    .locator('[data-testid="runtime-status"]', { hasText: /^R \d/ })
    .first()
    .waitFor({ timeout: 60000 })
  await win.waitForTimeout(1500)
  await bar.screenshot({ path: path.join(shotDir, 'ready.png') })

  const samples = await win.evaluate(() => window.__statusSamples)
  console.log('--- 采样序列 ---')
  for (const s of samples) console.log(`  +${s.at}ms  ${s.txt}`)

  const texts = samples.map((s) => s.txt).join(' | ')
  expect('采样到了状态栏文案', samples.length > 0, `${samples.length} 条`)
  expect('从未出现「R 未检测到」', !texts.includes('未检测到'), texts.slice(0, 160))
  expect('从未出现未经探测的结论（环境待完善/环境不可用）', !/环境待完善|环境不可用/.test(texts))
  expect('最终稳定在「R x.y.z」', /^R \d/.test(samples[samples.length - 1]?.txt ?? ''),
    samples[samples.length - 1]?.txt ?? '')
  const sawPending = samples.some((s) => s.txt.includes('正在检测'))
  console.log(`[说明] 是否捕捉到 pending 态：${sawPending ? '是' : '否（探针命中缓存，可能不足一帧）'}`)
  expect('渲染进程无报错', consoleErrs.length === 0, consoleErrs.slice(-3).join(' | '))
} catch (err) {
  console.log('ERR:', err instanceof Error ? err.message : String(err))
  console.log('--- 控制台错误 ---')
  console.log(consoleErrs.slice(-5).join('\n'))
} finally {
  await app.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
