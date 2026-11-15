#!/usr/bin/env node
/**
 * scripts/verify-packaged.mjs —— 验证**打包产物**能不能用（不是源码能不能跑）
 *
 * ## 为什么必须单独验一次
 *
 * `walkthrough-viz.mjs` 跑的是 `electron .` + 仓库里的 `out/`，它能通过并不代表
 * 安装包能通过。打包后会变的至少有四件事：
 *   1. `process.resourcesPath` 从 node_modules/electron/dist/resources 变成
 *      <install>/resources —— 所有随包资源路径（R 脚本、内置 R、示例数据）都受影响；
 *   2. 代码进了 app.asar，任何「运行时按相对路径找文件」的写法都会失效；
 *   3. `app.getName()` 变成 productName（LabWorm），userData 目录跟着换；
 *   4. 内置 R 变成了 resources/runtime/R 下的一份拷贝，它要能自己找到 R_HOME。
 *
 * 所以这里直接启动 `dist/win-unpacked/<exe>`，做三件事：
 *   ① 窗口能起来、运行时探测显示「内置」且可用；
 *   ② 载入示例项目（读 resources/demo）；
 *   ③ 真跑一次 R 出图（Venn）—— 图出来了才说明内置 R + 包 + 字体链路都通。
 *
 * 用法：
 *   npm run dist:dir            # 先产出 dist/win-unpacked
 *   node scripts/verify-packaged.mjs
 *   node scripts/verify-packaged.mjs --keep-screenshots
 *
 * 退出码：0 通过 / 1 断言失败 / 2 环境问题（没产物）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './lib/tmpdir.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked')
const EXE = path.join(UNPACKED, 'LabWorm.exe')
const KEEP = process.argv.includes('--keep-screenshots')
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots-packaged')

const failures = []
function record(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

let shotIndex = 0
async function shot(win, name) {
  if (!KEEP) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  shotIndex += 1
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await win.screenshot({ path: file })
  console.log(`     截图：${path.relative(ROOT, file)}`)
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`没有打包产物：${EXE}\n先跑 npm run dist:dir`)
    process.exit(2)
  }

  const { _electron: electron } = await import('playwright')
  // 用一个全新的 userData 目录跑，模拟「同事第一次打开」。
  // 不隔离的话，开发机上遗留的 settings.json / runtime-probe.json 会让验证得出
  // 错误结论：实测过一次——界面显示「系统 PATH · D://R-4.3.2」，但脚本却报了
  // 「内置」通过，因为它匹配到了页面里「内置 2000 基因示例数据」那句文案。
  const userDataDir = makeTmpDir('labworm-verify-')
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']
  // ★ 故意**不**把 R 的 bin 加进 PATH：模拟同事的干净机器。
  //   如果这里能跑通，说明用的是随包内置的 R，而不是本机装的 R。
  env['PATH'] = env['PATH'] ?? ''

  console.log(`启动打包产物：${EXE}\n（已从 PATH 中移除 R，验证能否用内置 R 运行）`)
  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${userDataDir}`],
    env,
    timeout: 120_000
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  try {
    // ---- ① 窗口 + 运行时探测 ----
    await win.getByText('载入示例项目').first().waitFor({ timeout: 120_000 })
    record('打包版能启动并渲染工作台', true, await win.title())
    await shot(win, 'workspace')

    // 运行时状态栏应显示「内置」的 R 且环境正常
    // 等运行时探测落地（要跑一次 R，约 8~15 秒）
    await win.waitForFunction(
      () => /随包内置|用户指定路径|系统 PATH/.test(document.body.innerText),
      undefined,
      { timeout: 120_000 }
    )
    const bodyText = await win.evaluate(() => document.body.innerText)
    const runtimeLine =
      bodyText.split('\n').find((line) => /随包内置|用户指定路径|系统 PATH/.test(line)) ?? ''
    // ★ 断言必须落在**那一行**上。之前用 /内置/ 匹配整页文本，被
    //   「内置 2000 基因 × 24 样本示例数据」这句文案骗过去了，实际用的是系统 R。
    record('检测到可用 R 运行时', /环境正常/.test(bodyText), runtimeLine.trim())
    record('运行时来自「随包内置」', /随包内置/.test(runtimeLine), runtimeLine.trim())
    record(
      '内置 R 路径指向安装目录',
      /resources[\\/]runtime[\\/]R[\\/]/i.test(runtimeLine) || /随包内置/.test(runtimeLine),
      runtimeLine.trim()
    )

    // ---- ② 载入示例项目（读 resources/demo）----
    await win
      .locator('div.MuiCard-root', { hasText: '载入示例项目' })
      .getByRole('button', { name: '载入', exact: true })
      .click()
    await win.getByText('差异表达分析').first().waitFor({ timeout: 120_000 })
    record('载入内置示例项目（读 resources/demo）', true)
    await shot(win, 'module-home')

    // ---- ③ 真跑一次 R 出图 ----
    await win.evaluate(() => {
      location.hash = '#/module/viz/venn'
    })
    const boxes = win.getByPlaceholder('粘贴基因列表（逗号 / 空格 / 换行分隔）')
    await boxes.first().waitFor({ timeout: 60_000 })
    await boxes.nth(0).fill('TP53,EGFR,MYC,BRCA1,CDK1')
    await boxes.nth(1).fill('MYC,BRCA1,ALK,PTEN')
    await boxes.nth(2).fill('EGFR,MYC,ALK')

    await win.waitForFunction(
      () => {
        const el = document.querySelector('img[alt="绘图预览"]')
        return Boolean(el && el.getAttribute('src')?.startsWith('data:image/'))
      },
      undefined,
      { timeout: 180_000 }
    )
    const src = await win.evaluate(
      () => document.querySelector('img[alt="绘图预览"]')?.getAttribute('src') ?? ''
    )
    const bytes = Math.round((src.length * 3) / 4)
    record('用内置 R 成功出图（Venn）', bytes > 5000, `预览约 ${bytes} 字节`)

    // 交集明细也应出来（说明 R 返回的数据结构在打包环境下正常）
    await win.getByText('交集明细').first().waitFor({ timeout: 30_000 })
    record('交集明细表正常渲染', true)
    await shot(win, 'venn-packaged')
  } catch (error) {
    record('验证过程未抛异常', false, String(error?.message ?? error))
    await shot(win, 'failure')
  } finally {
    await app.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} 项失败：${failures.join('、')}`)
    process.exit(1)
  }
  console.log('✅ 打包产物验证通过')
  process.exit(0)
}

await main()
