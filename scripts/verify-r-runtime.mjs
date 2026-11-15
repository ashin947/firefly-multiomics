#!/usr/bin/env node
/**
 * verify-r-runtime.mjs —— 校验 R 运行时是否可用（T04 第 6 条，供 CI 与打包前自检）
 *
 * 检查项：
 *   1. Rscript 可执行文件存在（三级探测：resources/runtime/R → 系统 PATH）
 *   2. 内置中文字体文件存在
 *   3. 跑一次 r/probe/check_runtime.R，读 result.summary
 *   4. 必需 R 包齐全（对照 resources/r-libs-manifest.json）
 *
 * 退出码：0 全部通过；1 有检查项不通过；2 脚本自身异常
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './lib/tmpdir.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const RESOURCES = path.join(REPO_ROOT, 'resources')
const R_RUNTIME_ROOT = path.join(RESOURCES, 'runtime', 'R')
const R_LIBS = path.join(RESOURCES, 'runtime', 'R-libs')
const R_SCRIPTS = path.join(REPO_ROOT, 'r')
const FONT_PATH = path.join(RESOURCES, 'runtime', 'fonts', 'NotoSansSC-Regular.otf')
const MANIFEST = path.join(RESOURCES, 'r-libs-manifest.json')

const isWin = process.platform === 'win32'
const RSCRIPT_NAME = isWin ? 'Rscript.exe' : 'Rscript'

function findRscript() {
  const bundled = path.join(R_RUNTIME_ROOT, 'bin', RSCRIPT_NAME)
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled' }

  const probe = spawnSync(isWin ? 'where' : 'which', ['Rscript'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0]
    if (first && fs.existsSync(first)) return { path: first, source: 'system' }
  }
  return null
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function main() {
  const startedAt = Date.now()
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })

  // ---- 1. Rscript ----
  const rscript = findRscript()
  push(
    'Rscript 可执行文件',
    Boolean(rscript),
    rscript ? `${rscript.path}（${rscript.source === 'bundled' ? '随包内置' : '系统 PATH'}）` : '未找到（三级探测全部失败）'
  )

  // ---- 2. 字体 ----
  push('内置中文字体 NotoSansSC', fs.existsSync(FONT_PATH), fs.existsSync(FONT_PATH) ? FONT_PATH : `缺失：${FONT_PATH}`)

  // ---- 3. 清单 ----
  const manifest = readManifest()
  push(
    'R 包清单',
    !manifest.error && Array.isArray(manifest.packages),
    manifest.error ? manifest.error : `${manifest.packages.length} 条记录`
  )

  // ---- 4. R 能力自检 ----
  let probeSummary = null
  if (rscript) {
    const tmpDir = makeTmpDir('deg-verify-')
    const configPath = path.join(tmpDir, 'run_config.json')
    const required = (manifest.packages ?? []).filter((p) => p.required).map((p) => p.name)
    const config = {
      runId: `verify-${Date.now().toString(36)}`,
      projectRoot: tmpDir,
      runDir: tmpDir,
      themePath: path.join(RESOURCES, 'plotTheme.json'),
      fontPath: FONT_PATH,
      params: {
        requiredPackages: required,
        speciesLibs: manifest.speciesLibs ?? { human: 'org.Hs.eg.db', mouse: 'org.Mm.eg.db' },
        fontFamily: 'DEGSans'
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const env = {
      ...process.env,
      DEG_R_ROOT: R_SCRIPTS,
      DEG_FONT_PATH: FONT_PATH,
      DEG_THEME_PATH: path.join(RESOURCES, 'plotTheme.json'),
      DEG_RESOURCES_ROOT: RESOURCES,
      // ★ 与 RProcessRunner.buildRenv 的**优先级**保持一致：受控库放在 R_LIBS_USER
      //   的第一位。R 的搜索顺序是 R_LIBS → R_LIBS_USER → R_LIBS_SITE → .Library，
      //   所以只有放 R_LIBS_USER 才能保证「R 里也装了同名包时，被用到的是我们这份」。
      //   之前这里用 R_LIBS_SITE，会让 R 自带 library 里的版本悄悄赢过受控版本，
      //   于是校验脚本报「一切正常」而实际运行用的是别的版本。
      R_LIBS_USER: R_LIBS,
      R_ENCODING: 'UTF-8',
      // 与 RProcessRunner.buildRenv 保持一致：Windows 版 R 不认 C.UTF-8，
      // 设了会让 LC_CTYPE 退回 "C"，进而让 R 脚本的 source(encoding="UTF-8")
      // 半途返回（详见 r/common/loader.R 文件头）。空串 = 用系统默认 locale。
      LC_ALL: process.platform === 'win32' ? '' : 'C.UTF-8',
      TMPDIR: tmpDir
    }

    const run = spawnSync(
      rscript.path,
      ['--vanilla', '--no-save', '--no-restore', path.join(R_SCRIPTS, 'probe', 'check_runtime.R'), '--config', configPath],
      { cwd: tmpDir, env, encoding: 'utf8', timeout: 120000 }
    )

    const stdout = String(run.stdout || '')
    const stderr = String(run.stderr || '')
    const resultLine = stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('@@DEG@@ '))
      .map((l) => l.slice('@@DEG@@ '.length))
      .map((json) => {
        try {
          return JSON.parse(json)
        } catch {
          return null
        }
      })
      .filter((m) => m && m.type === 'result')
      .pop()

    if (resultLine && resultLine.summary) {
      probeSummary = resultLine.summary
      push('R 能力自检', true, `R ${probeSummary.rVersion ?? '?'} (${probeSummary.rArch ?? '?'})`)
    } else {
      push(
        'R 能力自检',
        false,
        `未收到 result 消息（exit=${run.status}）。stderr 片段：${stderr.split(/\r?\n/).slice(-5).join(' | ') || '(空)'}`
      )
    }
  } else {
    push('R 能力自检', false, '跳过（没有可用的 Rscript）')
  }

  // ---- 5. 必需包 ----
  if (probeSummary) {
    const reported = new Map((probeSummary.packages ?? []).map((p) => [p.name, p]))
    const required = (manifest.packages ?? []).filter((p) => p.required)
    const missing = required.filter((p) => {
      const status = reported.get(p.name)
      return !status || status.ok !== true
    })
    push(
      '必需 R 包',
      missing.length === 0,
      missing.length === 0 ? `${required.length} 个必需包全部可用` : `缺失：${missing.map((p) => p.name).join('、')}`
    )

    const species = probeSummary.speciesLibs ?? {}
    push('Human 注释库', species.human === true, species.human ? 'org.Hs.eg.db 可用' : 'org.Hs.eg.db 不可用')
    push('Mouse 注释库', species.mouse === true, species.mouse ? 'org.Mm.eg.db 可用' : 'org.Mm.eg.db 不可用')
    const fonts = probeSummary.fontFamilies ?? []
    push('中文字体注册', fonts.includes('DEGSans'), fonts.includes('DEGSans') ? 'DEGSans 已注册' : `已注册字体：${fonts.join(', ') || '(无)'}`)
  }

  // ---- 报告 ----
  const failed = checks.filter((c) => !c.ok)
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log('# 实验室的虫 · R 运行时校验报告')
  console.log('')
  console.log(`- 时间：${new Date().toISOString()}`)
  console.log(`- 平台：${process.platform} ${process.arch}`)
  console.log(`- 结论：${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项未通过`}`)
  console.log(`- 耗时：${elapsed}s`)
  console.log('')
  console.log('| 检查项 | 结果 | 详情 |')
  console.log('|---|---|---|')
  for (const c of checks) {
    console.log(`| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail).replace(/\|/g, '\\|')} |`)
  }
  console.log('')
  if (failed.length > 0) {
    console.log('## 修复建议')
    console.log('')
    if (!rscript) {
      console.log('- 执行 `npm run assemble:r -- --from "<R_HOME>"` 装配 R 运行时，或安装 R 4.2+ 并加入 PATH。')
    }
    if (!fs.existsSync(FONT_PATH)) {
      console.log(`- 把 Noto Sans SC 字体放到 ${FONT_PATH}（否则图表中文可能显示为方框）。`)
    }
    const missingPkg = checks.find((c) => c.name === '必需 R 包' && !c.ok)
    if (missingPkg) {
      console.log(`- 补装缺失 R 包：${missingPkg.detail}`)
    }
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error(`verify-r-runtime 自身异常：${err instanceof Error ? err.stack : String(err)}`)
  process.exit(2)
}
