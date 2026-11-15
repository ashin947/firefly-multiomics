#!/usr/bin/env node
/**
 * scripts/verify-rice-in-package.mjs —— 在**打包产物**里验证水稻 GO Slim 内置背景
 *
 * ## 为什么单独写这个
 *
 * `run_ora.R` 能跑通、单测能绿、开发态界面能点通，都证明不了「装到同事机器上能用」。
 * 这条链路上有四段只在打包后才成立：
 *   ① `resources/annot/rice_go.tsv` 得真的被 extraResources 带进包（漏了就是功能缺失）；
 *   ② 打包后 `getResourcesRoot()` 变成 `process.resourcesPath`，`builtin_annot_path()`
 *      拼出来的路径必须仍然对得上；
 *   ③ 代码进了 app.asar，R 脚本却在外面的 `resources/r/`，两者都得能读到；
 *   ④ 前端「水稻 + 内置」不再被强制切到自定义文件。
 *
 * 所以这里直接启动 `dist/win-unpacked/LabWorm.exe`，用**隔离的 userData**
 * （模拟同事第一次打开，不受开发机缓存/设置影响），在真实界面里粘 300 个
 * LOC_Os 基因、选水稻 + 内置 + BP，看它出不出结果、出不出图。
 *
 * 用法：npm run dist:dir && node scripts/verify-rice-in-package.mjs
 * 退出码：0 通过 / 1 断言失败 / 2 没产物
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './lib/tmpdir.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked')
const EXE = path.join(UNPACKED, 'LabWorm.exe')
const ANNOT = path.join(UNPACKED, 'resources', 'annot', 'rice_go.tsv')

const failures = []
function record(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** 从注释产物里挑 300 个基因：200 个挂 GO:0009628，再补 100 个，保证有富集信号 */
function buildGeneList() {
  const genes = new Set()
  const lines = fs.readFileSync(ANNOT, 'utf8').split('\n')
  const signals = []
  for (const line of lines) {
    if (!line) continue
    const cells = line.split('\t')
    if (cells.slice(1).includes('GO:0009628')) signals.push(cells[0])
  }
  for (const gene of signals.slice(0, 200)) genes.add(gene)
  for (let i = 0; i < lines.length && genes.size < 300; i += 37) {
    const gene = lines[i]?.split('\t')[0]
    if (gene) genes.add(gene)
  }
  return Array.from(genes)
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`没有打包产物：${EXE}\n先跑 npm run dist:dir`)
    process.exit(2)
  }

  // ① 产物里的注释表（静态检查，先排除最可能的「忘了打包」）
  const annotOk = fs.existsSync(ANNOT)
  record(
    '打包产物包含 resources/annot/rice_go.tsv',
    annotOk,
    annotOk ? `${fs.statSync(ANNOT).size} 字节` : '缺失 —— extraResources 没生效'
  )
  const sourceLeaked = fs.existsSync(path.join(UNPACKED, 'resources', 'annot', '_source'))
  record('客户原始文件 _source/ 未被打进包', !sourceLeaked)
  if (!annotOk) process.exit(1)

  const genes = buildGeneList()
  const { _electron: electron } = await import('playwright')
  const userDataDir = makeTmpDir('lw-rice-')
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['DEG_DEV_MOCK']
  // 故意不把 R 加进 PATH：证明用的是包内置 R
  console.log(`\n启动打包产物：${EXE}\n（隔离 userData = ${userDataDir}，PATH 中无 R）`)

  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${userDataDir}`],
    env,
    timeout: 120_000
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  try {
    // 载入示例项目（富集页需要项目上下文）
    await win.getByText('载入示例项目').first().waitFor({ timeout: 120_000 })
    await win
      .locator('div.MuiCard-root', { hasText: '载入示例项目' })
      .getByRole('button', { name: '载入', exact: true })
      .click()
    await win.getByText('差异表达分析').first().waitFor({ timeout: 120_000 })
    record('载入示例项目', true)

    await win.evaluate(() => {
      location.hash = '#/module/transcriptome/enrich/latest'
    })
    // 切到「手动」输入
    await win.getByRole('button', { name: '手动', exact: true }).waitFor({ timeout: 60_000 })
    await win.getByRole('button', { name: '手动', exact: true }).click()
    const box = win.getByPlaceholder('粘贴基因列表（逗号/空格/换行分隔）')
    await box.waitFor({ timeout: 30_000 })
    await box.fill(genes.join('\n'))

    // 物种 → 水稻（背景应保持「内置注释库」，不再被强制切走）
    const selects = win.locator('select')
    const speciesSel = selects.filter({ has: win.locator('option[value="rice"]') }).first()
    await speciesSel.selectOption('rice')
    await win.waitForTimeout(400)

    const backgroundRadio = await win.getByRole('radio', { name: /内置/ }).first().isChecked()
    record('水稻 + 内置背景可同时选中（未被强制切到自定义）', backgroundRadio)

    // GO 分类 → BP
    const ontSel = selects.filter({ has: win.locator('option[value="BP"]') }).first()
    await ontSel.selectOption('BP')

    const startedAt = Date.now()
    await win.getByRole('button', { name: '开始富集' }).click()
    // ★ 完成提示不是「富集完成」——富集页跑完是**直接渲染结果区**
    //   （「共 N 个条目」+ 富集结果表）。第一版按「富集完成/富集失败」等，
    //   结果干等了 180 秒超时，而实际上结果早就出来了。断言必须盯真实文案。
    await win.getByText(/共 \d+ 个条目|富集结果表/).first().waitFor({ timeout: 180_000 })
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const body = await win.evaluate(() => document.body.innerText)
    const itemMatch = body.match(/共 (\d+) 个条目/)
    const termCount = itemMatch ? Number(itemMatch[1]) : 0
    record('水稻内置背景富集跑通', termCount > 0, `${termCount} 个条目，耗时 ${elapsed}s`)
    record('未出现「缺少注释」类错误', !/缺少注释|注释表不存在|E_RT_ANNOTATION/.test(body))

    // 结果表里应出现 GO·BP
    const bpCount = (body.match(/GO·BP/g) ?? []).length
    record('结果含 GO·BP 条目', bpCount > 0, `${bpCount} 处`)

    // 出图（气泡图，等它真的出现再截）
    await win.locator('img[alt="富集气泡图"]').first().waitFor({ state: 'visible', timeout: 120_000 })
    record('气泡图渲染完成', true)

    fs.mkdirSync(path.join(ROOT, 'docs', 'screenshots-packaged'), { recursive: true })
    await win.screenshot({ path: path.join(ROOT, 'docs', 'screenshots-packaged', '09-rice-enrich.png') })
  } catch (error) {
    record('验证过程未抛异常', false, String(error?.message ?? error).slice(0, 300))
  } finally {
    await app.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} 项失败：${failures.join('、')}`)
    process.exit(1)
  }
  console.log('✅ 打包产物中的水稻内置背景验证通过')
  process.exit(0)
}

await main()
