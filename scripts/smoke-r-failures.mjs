/**
 * 失败路径契约冒烟 —— 验证 R 的退出码 10/11/12/13/14 与错误码**真的能到达主进程**。
 *
 * 为什么需要它：
 *   `src/shared/__tests__/protocol.test.ts` 测的是主进程侧的字符串解析（完全不碰 R）；
 *   `scripts/smoke-r-de.R` 是 happy path（一次失败都不走）。结果是这套契约
 *   「写着但没生效」——2026-11 真的在 Windows 上抓到两处：
 *     ① `source(..., encoding="UTF-8")` 半途返回 → 所有脚本 exit 1、零协议行；
 *     ② `emit_error` 参数个数不对 → 错误处理器自己先崩，11/12/13/14 全部丢失。
 *   这两条靠读代码都发现不了，只有驱动真实进程才会暴露。
 *
 * 断言口径（严格，不做"非 0 即可"这种安慰剂）：
 *   对每个场景同时断言四件事
 *     a) 进程退出码 **精确等于** 期望值；
 *     b) events.jsonl 里恰好有 1 条 type=error 的协议行；
 *     c) 协议行里的 code **精确等于** 期望错误码（R 侧有没有把 code 发出来）；
 *     d) 主进程翻译出的 error.code **精确等于** 期望错误码（能不能到达主进程）。
 *   d 是这条链路的终点，也是用户最终看到的那条文案的来源。
 *
 * 复用生产代码：
 *   所有场景都通过 `scripts/failures/harness.ts` 里**真正的** `RProcessRunner`
 *   执行（同样的 `--vanilla --no-save --no-restore`、同样的 `--config` 传参、
 *   同样的 `buildRenv()` 环境变量、同样的 cwd=runDir）。harness 由 esbuild 现场
 *   打包成 .mjs 后 import，因此不存在"自己拼一份 spawn 参数"的漂移风险。
 *
 * 用法：
 *   node scripts/smoke-r-failures.mjs
 *   node scripts/smoke-r-failures.mjs --keep     # 保留临时工作目录（排查用）
 *   DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-r-failures.mjs
 *
 * 退出码：全部通过 0 / 有断言失败 1 / 找不到 Rscript 4
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { makeTmpDir, safeRemove } from './lib/tmpdir.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const R_ROOT = path.join(ROOT, 'r')
const RESOURCES = path.join(ROOT, 'resources')
const DEMO = path.join(RESOURCES, 'demo')
const DOCS = path.join(ROOT, 'docs')
const FIXTURES = path.join(__dirname, 'failures', 'fixtures')
const HARNESS_TS = path.join(__dirname, 'failures', 'harness.ts')

const keepTmp = process.argv.includes('--keep')

/* ------------------------------------------------------------------ *
 * 0. 找 Rscript（本项目里 R 常常不在 PATH 上）
 * ------------------------------------------------------------------ */
function findRscript() {
  const fromEnv = process.env.DEG_RSCRIPT
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const names = process.platform === 'win32' ? ['Rscript.exe', 'Rscript'] : ['Rscript']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  const guesses =
    process.platform === 'win32'
      ? ['D:/R-4.3.2/bin/x64/Rscript.exe', 'C:/Program Files/R/R-4.3.2/bin/x64/Rscript.exe']
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript']
  return guesses.find((p) => fs.existsSync(p)) ?? null
}

const rscript = findRscript()
if (!rscript) {
  console.error('[无法验证] 找不到 Rscript。请安装 R 4.2+，或用 DEG_RSCRIPT 指定绝对路径：')
  console.error('  DEG_RSCRIPT="D:/R-4.3.2/bin/x64/Rscript.exe" node scripts/smoke-r-failures.mjs')
  process.exit(4)
}

const rVersion = (() => {
  try {
    return execFileSync(rscript, ['--version'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  } catch {
    return 'unknown'
  }
})()

/* ------------------------------------------------------------------ *
 * 1. 现场打包 harness（复用真正的 RProcessRunner）
 * ------------------------------------------------------------------ */
const tmpRoot = makeTmpDir('deg-failures-')
const cleanup = () => {
  if (!keepTmp) safeRemove(tmpRoot)
}

/** electron 在纯 Node 里是"二进制路径字符串"，app 会是 undefined —— 这里给个桩 */
function stubElectronPlugin() {
  return {
    name: 'stub-electron',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        loader: 'js',
        contents: `
          const userData = ${JSON.stringify(path.join(tmpRoot, 'userData'))};
          export const app = {
            isPackaged: false,
            getAppPath: () => ${JSON.stringify(ROOT)},
            getPath: () => userData,
            getName: () => 'deg-studio-smoke'
          };
          export default { app };
        `
      }))
    }
  }
}

async function bundleHarness() {
  const outfile = path.join(tmpRoot, 'harness.mjs')
  await build({
    entryPoints: [HARNESS_TS],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    tsconfig: path.join(ROOT, 'tsconfig.node.json'),
    logLevel: 'silent',
    plugins: [stubElectronPlugin()]
  })
  return outfile
}

/* ------------------------------------------------------------------ *
 * 2. 工作区：r/ 副本 + 数据变体 + 空库目录
 * ------------------------------------------------------------------ */
function prepareWorkspace() {
  const rScriptsRoot = path.join(tmpRoot, 'r')
  fs.cpSync(R_ROOT, rScriptsRoot, { recursive: true })
  // 夹具放进 r/ 副本里（保持"脚本在 <root>/<category>/x.R"的目录约定）
  const fixtureDir = path.join(rScriptsRoot, 'fixtures')
  fs.mkdirSync(fixtureDir, { recursive: true })
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(fixtureDir, f))
  }

  const emptyLibs = path.join(tmpRoot, 'libs-empty')
  fs.mkdirSync(emptyLibs, { recursive: true })

  // 「残缺 limma」shim：只有 DESCRIPTION，没有 Meta/package.rds 与 R/ 代码。
  // R 会认为这个 limma 不可用 → requireNamespace() 返回 FALSE（不抛错）。
  // 用它把 limma 顶到 .libPaths() 最前面，就能在「limma 装在 R 自带 library」的
  // 机器上重现缺包场景，而不用去动用户库或 R 安装目录。
  const pkgShim = path.join(tmpRoot, 'pkg-shim')
  const shimPkg = path.join(pkgShim, 'limma')
  fs.mkdirSync(shimPkg, { recursive: true })
  fs.writeFileSync(
    path.join(shimPkg, 'DESCRIPTION'),
    [
      'Package: limma',
      'Version: 0.0.0',
      'Title: broken shim (smoke-r-failures)',
      'Description: Intentionally unusable package used to reproduce the missing-package path.',
      'Author: Lab Worm smoke test',
      'Maintainer: smoke <smoke@example.invalid>',
      'License: MIT',
      ''
    ].join('\n'),
    'utf8'
  )

  return {
    rScriptsRoot,
    resourcesRoot: RESOURCES,
    rlibsRoot: emptyLibs,
    rlibsUserDir: emptyLibs,
    tempDir: path.join(tmpRoot, 'tmp'),
    runRoot: path.join(tmpRoot, 'runs'),
    pkgShim
  }
}

/** 从 demo 数据派生场景需要的数据变体 */
function prepareData() {
  const dataDir = path.join(tmpRoot, 'data')
  const expr = fs.readFileSync(path.join(DEMO, 'expression.csv'), 'utf8').trim().split(/\r?\n/)
  const groups = fs.readFileSync(path.join(DEMO, 'groups.csv'), 'utf8').trim().split(/\r?\n/)

  const write = (name, exprLines, groupLines) => {
    const dir = path.join(dataDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'expression.csv'), `${exprLines.join('\n')}\n`, 'utf8')
    fs.writeFileSync(path.join(dir, 'groups.csv'), `${groupLines.join('\n')}\n`, 'utf8')
    return dir
  }

  // ① 正常数据
  const valid = write('valid', expr, groups)

  // ② 每组只有 1 个样本：矩阵只留 S01（Tumor）+ S13（Normal）
  const header = expr[0].split(',')
  const keepIdx = [0, header.indexOf('S01'), header.indexOf('S13')]
  const twoCols = expr.map((line) => {
    const cells = line.split(',')
    return keepIdx.map((i) => cells[i]).join(',')
  })
  const twoGroups = [groups[0], ...groups.filter((l) => /^S0?1,Tumor$/.test(l) || /^S13,Normal$/.test(l))]
  const onePerGroup = write('one-per-group', twoCols, twoGroups)

  // ③ 分组表里有一个矩阵没有的样本（S99）
  const extraGroups = [...groups, 'S99,Tumor']
  const extraSample = write('extra-sample', expr, extraGroups)

  return { valid, onePerGroup, extraSample }
}

/* ------------------------------------------------------------------ *
 * 3. 场景定义
 * ------------------------------------------------------------------ */
function makeConfig({ dataDir, runDir, contrast = true }) {
  const params = {
    matrixPath: path.join(dataDir, 'expression.csv'),
    groupsPath: path.join(dataDir, 'groups.csv'),
    species: 'human',
    dataType: 'counts',
    sampleColumn: 'sample',
    groupColumn: 'group',
    geneIdType: 'SYMBOL',
    filter: { enabled: true, mode: 'filterByExpr', minCount: 10, minSamplesPct: 50 },
    fdrMethod: 'BH',
    outputGeneName: true,
    keepAllGenes: false
  }
  // 场景②：故意缺 contrast，验 E_VALIDATION / 11
  if (contrast) params.contrast = { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' }
  return {
    runId: 'smoke',
    projectRoot: tmpRoot,
    runDir,
    themePath: path.join(RESOURCES, 'plotTheme.json'),
    fontPath: path.join(RESOURCES, 'runtime', 'fonts', 'NotoSansSC-Regular.otf'),
    params
  }
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== 实验室的虫 · R 失败路径契约验证 ===')
  console.log(`仓库根目录 : ${ROOT}`)
  console.log(`Rscript    : ${rscript}`)
  console.log(`R 版本     : ${rVersion}`)
  console.log(`临时目录   : ${tmpRoot}${keepTmp ? '（--keep 保留）' : ''}`)

  const harnessPath = await bundleHarness()
  const { runOnce, probePackage } = await import(pathToFileURL(harnessPath).href)

  const ws = prepareWorkspace()
  fs.mkdirSync(ws.tempDir, { recursive: true })
  fs.mkdirSync(ws.runRoot, { recursive: true })
  const data = prepareData()

  // 夹具 pkg-missing.R 会读它（buildRenv 会原样传递 process.env）
  process.env.DEG_SMOKE_PKG_SHIM = ws.pkgShim

  // 包可见性：按 app 的库路径（空目录）与 R 自己的默认库路径各探一次。
  // 两者不一致本身就是个值得报的信号（见报告里的"环境提示"）。
  const pkgArgs = { rscriptPath: rscript, pkg: 'limma', tempDir: ws.tempDir }
  const limmaVisibleToApp = await probePackage({ ...pkgArgs, rlibsRoot: ws.rlibsRoot, rlibsUserDir: ws.rlibsUserDir })
  const limmaVisibleToR = await probePackage({ ...pkgArgs, rlibsRoot: '', rlibsUserDir: '' })
  console.log(
    `limma 可见性: 按 app 库路径 ${limmaVisibleToApp ? '是' : '否'} / 按 R 默认库路径 ${limmaVisibleToR ? '是' : '否'}`
  )

  // 装了 limma 就用真正的 de 脚本，没装则退到夹具（夹具走同样的 prepare/contrast 序列）
  const entryOf = (realRel, fixtureRel) =>
    limmaVisibleToApp ? { scriptRelPath: realRel, label: realRel } : { scriptRelPath: fixtureRel, label: `${fixtureRel}（夹具）` }

  const scenarios = [
    {
      id: 'pkg-missing',
      title: '缺必需包（limma 不可用）',
      expectExit: 12,
      expectCode: 'E_RT_PKG_MISSING',
      // 用夹具：limma 若装在 R 自带 library，环境变量屏蔽不掉（.Library 永远在
      // .libPaths() 最前，R_LIBS_* 只能往后面追加）。夹具把「残缺 limma」顶到
      // 最前面，然后调**同一个** deg_ensure_pkgs()。详见该夹具文件头。
      entry: { scriptRelPath: 'fixtures/pkg-missing.R', label: 'fixtures/pkg-missing.R（夹具）' },
      dataDir: data.valid
    },
    {
      id: 'config-invalid',
      title: 'config 缺字段（contrast）',
      expectExit: 11,
      expectCode: 'E_VALIDATION',
      entry: entryOf('de/run_limma_voom.R', 'fixtures/prepare-only.R'),
      dataDir: data.valid,
      configExtra: { contrast: false }
    },
    {
      id: 'group-too-small',
      title: '每组只有 1 个样本',
      expectExit: 13,
      expectCode: 'E_DATA_GROUP_TOO_SMALL',
      entry: entryOf('de/run_limma_voom.R', 'fixtures/prepare-only.R'),
      dataDir: data.onePerGroup
    },
    {
      id: 'sample-mismatch',
      title: '分组表里有矩阵没有的样本',
      expectExit: 13,
      expectCode: 'E_DATA_SAMPLE_MISMATCH',
      entry: entryOf('de/run_limma_voom.R', 'fixtures/prepare-only.R'),
      dataDir: data.extraSample
    },
    {
      id: 'write-failure',
      title: '写盘失败（de.csv.tmp 被同名目录占用）',
      expectExit: 14,
      expectCode: 'E_IO_PERMISSION',
      entry: entryOf('de/run_limma_voom.R', 'fixtures/write-failure.R'),
      dataDir: data.valid,
      // 关键构造：在 runDir 里预建一个名为 de.csv.tmp 的**目录**，
      // 于是 deg_write_csv() 的 fwrite 必然失败 → E_IO_PERMISSION / 14
      preCreate: (runDir) => fs.mkdirSync(path.join(runDir, 'de.csv.tmp'), { recursive: true })
    },
    {
      id: 'script-stop',
      title: '脚本内 stop()',
      expectExit: 10,
      expectCode: 'E_R_GENERIC',
      entry: { scriptRelPath: 'fixtures/boom.R', label: 'fixtures/boom.R（夹具）' },
      dataDir: data.valid
    }
  ]

  const rows = []
  for (const sc of scenarios) {
    const runDir = path.join(ws.runRoot, sc.id)
    fs.mkdirSync(runDir, { recursive: true })
    if (sc.preCreate) sc.preCreate(runDir)

    const config = makeConfig({
      dataDir: sc.dataDir,
      runDir,
      contrast: sc.configExtra?.contrast !== false
    })

    const result = await runOnce({
      ...ws,
      runId: sc.id,
      scriptRelPath: sc.entry.scriptRelPath,
      config,
      rscriptPath: rscript,
      timeoutMs: 180_000
    })

    // 缺包场景的"无法构造"判定：库路径已屏蔽却仍然跑成功 → limma 装在 R 自带 library
    const unconstructable = sc.id === 'pkg-missing' && result.ok

    const checks = [
      { name: 'exitCode', expected: sc.expectExit, actual: result.exitCode, pass: result.exitCode === sc.expectExit },
      {
        name: '协议行',
        expected: 1,
        actual: result.protocolErrorCount,
        pass: result.protocolErrorCount === 1
      },
      {
        name: '协议 code',
        expected: sc.expectCode,
        actual: result.protocolCode,
        pass: result.protocolCode === sc.expectCode
      },
      {
        name: '翻译 code',
        expected: sc.expectCode,
        actual: result.translatedCode,
        pass: result.translatedCode === sc.expectCode
      }
    ]
    const pass = !unconstructable && checks.every((c) => c.pass)
    const status = unconstructable ? 'skip' : pass ? 'pass' : 'fail'

    rows.push({ scenario: sc, result, checks, status })

    const flag = status === 'pass' ? 'OK  ' : status === 'skip' ? 'SKIP' : 'FAIL'
    console.log(
      `[${flag}] ${sc.id.padEnd(16)} exit=${String(result.exitCode).padEnd(4)} code=${String(result.translatedCode).padEnd(20)} ${sc.title}`
    )
    if (status !== 'pass') {
      for (const c of checks) {
        if (!c.pass) console.log(`        ✗ ${c.name}: 期望 ${c.expected}，实际 ${c.actual}`)
      }
      if (unconstructable) {
        console.log('        ✗ 无法构造：limma 在 R 自带 library 里，环境变量屏蔽不掉')
      }
    }
  }

  writeReport({ rows, limmaVisibleToApp, limmaVisibleToR })
  const failed = rows.filter((r) => r.status !== 'pass').length
  console.log(`\n报告已写入：${path.join(DOCS, 'SMOKE-R-FAILURES.md')}`)
  console.log(`总体：${rows.length - failed}/${rows.length} 通过${failed > 0 ? `（${failed} 个未通过）` : ''}`)
  return failed === 0 ? 0 : 1
}

/* ------------------------------------------------------------------ *
 * 5. 报告
 * ------------------------------------------------------------------ */
function writeReport({ rows, limmaVisibleToApp, limmaVisibleToR }) {
  const passed = rows.filter((r) => r.status === 'pass').length
  const skipped = rows.filter((r) => r.status === 'skip').length
  const allOk = passed === rows.length

  const lines = [
    '# R 失败路径契约验证报告',
    '',
    '> 本文件由 `scripts/smoke-r-failures.mjs` 自动生成，请勿手工编辑。',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 平台：${process.platform} ${process.arch}`,
    `- Rscript：\`${rscript}\``,
    `- R 版本：${rVersion}`,
    `- 执行方式：真实 \`RProcessRunner\`（同样的 \`--vanilla\` / \`--config\` / \`buildRenv()\` / cwd=runDir）`,
    `- **总体结论：${allOk ? '全部通过 ✅' : `存在失败 ❌`}**（通过 ${passed} / 共 ${rows.length}${
      skipped > 0 ? `，跳过 ${skipped}` : ''
    }）`,
    '',
    '## 断言口径',
    '',
    '每个场景同时断言四件事，全部精确相等（不做「非 0 即可」这种安慰剂）：',
    '',
    '1. 进程退出码 == 期望值',
    '2. `events.jsonl` 里恰好 1 条 `type=error` 协议行',
    '3. 协议行里的 `code` == 期望错误码（R 侧有没有把 code 发出来）',
    '4. 主进程翻译出的 `error.code` == 期望错误码（能不能到达主进程，用户最终看到的就是它）',
    '',
    '## 结果',
    '',
    '| # | 场景 | 入口脚本 | 期望 exit | 实际 exit | 期望 code | 实际 code | 协议行 | 结论 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]

  rows.forEach((r, i) => {
    const s = r.scenario
    const st = r.status === 'pass' ? '✅' : r.status === 'skip' ? '⚠ 跳过' : '❌'
    lines.push(
      `| ${i + 1} | ${s.title} | \`${s.entry.label}\` | ${s.expectExit} | ${String(r.result.exitCode)} | ${s.expectCode} | ${
        String(r.result.translatedCode)
      } | ${r.result.protocolErrorCount} 条 | ${st} |`
    )
  })

  lines.push('', '## 环境提示', '')
  lines.push(
    `- limma 按 **app 的库路径**（\`R_LIBS_SITE\`/\`R_LIBS_USER\` = 应用自己的目录）可见：**${
      limmaVisibleToApp ? '是' : '否'
    }**`
  )
  lines.push(`- limma 按 **R 默认库路径**可见：**${limmaVisibleToR ? '是' : '否'}**`)
  if (!limmaVisibleToApp && limmaVisibleToR) {
    lines.push(
      '',
      '> ⚠ **库路径不一致**：包装在 R 的默认个人库里，但 `buildRenv()` 把 `R_LIBS_USER` 指到了应用自己的目录，',
      '> 因此**应用看不到它**。用户按「环境诊断」给的命令装完包，仍然会被告知「缺少 R 包」。',
      '> 这不是本脚本的问题，是产品侧的路径策略问题，已单独上报。'
    )
  }
  if (limmaVisibleToApp) {
    lines.push('', '> limma 可见 → 失败场景走真正的 `de/run_limma_voom.R`，不是夹具。')
  } else {
    lines.push(
      '',
      '> limma 不可见 → config / 数据 / 写盘三个场景退到 `scripts/failures/fixtures/*.R`。',
      '> 原因：`run_limma_voom.R` 第 3 行就 `deg_ensure_pkgs(limma)`，缺包时一律 exit 12，',
      '> 会把 11/13/14 全部挡住，等于测不到。夹具走**完全相同**的 `deg_validate_common` →',
      '> `deg_de_prepare` → `deg_de_contrast` 序列，只是去掉了包门禁。',
      '> 装上 limma 后重跑本脚本会自动改回真脚本，无需改代码。'
    )
  }

  lines.push('', '## 每个场景是怎么构造出来的', '')
  lines.push(
    '| 场景 | 构造方式 |',
    '| --- | --- |',
    '| 缺必需包 | 夹具把一个「残缺 limma」（只有 DESCRIPTION、无 Meta/package.rds）顶到 `.libPaths()` 最前，`deg_ensure_pkgs()` 遂报缺包 |',
    '| config 缺字段 | config JSON 里删掉 `contrast` → `deg_param_required()` 抛 `E_VALIDATION` |',
    '| 每组 1 个样本 | 矩阵只留 S01(Tumor) + S13(Normal)，`deg_de_prepare()` 的组内样本数检查触发 |',
    '| 样本不匹配 | 分组表多一行 `S99`（矩阵里没有）→ `deg_validate_samples()` 触发 |',
    '| 写盘失败 | runDir 里预建一个名为 `de.csv.tmp` 的**目录**，`deg_write_csv()` 的 fwrite 必然失败 |',
    '| 脚本内 stop | 夹具直接 `stop("boom")` → `E_R_GENERIC` / 10 |'
  )

  const bad = rows.filter((r) => r.status !== 'pass')
  if (bad.length > 0) {
    lines.push('', '## 未通过场景的原始 stderr', '')
    for (const r of bad) {
      lines.push(`### ${r.scenario.id} —— ${r.scenario.title}`, '', '```', r.result.stderrTail || '(空)', '```', '')
      if (r.result.usedFallback) lines.push('> 注意：本次走了 `events.jsonl` 兜底通道（stdout 协议通道可能受编码影响）。', '')
    }
  }

  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true })
  fs.writeFileSync(path.join(DOCS, 'SMOKE-R-FAILURES.md'), `${lines.join('\n')}\n`, 'utf8')
}

main()
  .then((code) => {
    cleanup()
    process.exit(code)
  })
  .catch((err) => {
    cleanup()
    console.error('[脚本自身异常]', err)
    process.exit(2)
  })
