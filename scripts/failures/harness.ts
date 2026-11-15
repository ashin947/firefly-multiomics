/**
 * 失败路径冒烟的「生产代码侧」harness。
 *
 * 由 `scripts/smoke-r-failures.mjs` 用 esbuild 打包成 .mjs 后 `import()` 进来。
 * 为什么要绕这一道：冒烟脚本本身是 .mjs（不想为了跑一次测试去改构建配置），
 * 而它必须复用**真正的** `RProcessRunner` —— spawn 参数、`buildRenv()` 的环境变量、
 * 协议行解析、events.jsonl 兜底、`RErrorTranslator` 的翻译，全都在那里面。
 * 自己再拼一份 spawn 参数就等于测了个仿制品，参数漂移了也发现不了。
 *
 * 这里的 `electron` 由 esbuild 插件替换成桩（见 smoke-r-failures.mjs），
 * 否则 `paths.ts` 一 import 就拿不到 `app`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ChildProcessManager } from '../../src/main/process/ChildProcessManager'
import { RProcessRunner } from '../../src/main/process/RProcessRunner'
import { RErrorTranslator } from '../../src/main/process/RErrorTranslator'
import { pathService, type PathService } from '../../src/main/paths'
import { parseEventsJsonl } from '@shared/protocol'
import type { RRuntimeResolver } from '../../src/main/runtime/RRuntimeResolver'

export interface HarnessPaths {
  /** 仓库根的 resources/ */
  resourcesRoot: string
  /** 本次要用的 r/ 根（真实目录或其副本） */
  rScriptsRoot: string
  /** R_LIBS_SITE（可用空目录来屏蔽已装包） */
  rlibsRoot: string
  /** R_LIBS_USER */
  rlibsUserDir: string
  /** R 的 TMPDIR */
  tempDir: string
  /** 项目内的运行目录根（每个场景一个子目录） */
  runRoot: string
}

export interface RunOnceOptions extends HarnessPaths {
  runId: string
  /** 相对 r/ 根，如 'de/run_limma_voom.R' 或 'fixtures/boom.R' */
  scriptRelPath: string
  /** 会被写成 <runDir>/run_config.json */
  config: unknown
  /** Rscript 绝对路径 */
  rscriptPath: string
  timeoutMs?: number
}

export interface RunOnceResult {
  /** 进程退出码（spawn 失败时为 null） */
  exitCode: number | null
  /** RProcessRunner 判定的整体成功与否 */
  ok: boolean
  /** 主进程翻译出的错误码（成功时为 null） */
  translatedCode: string | null
  /** events.jsonl 里 type=error 的协议行携带的 code（无协议行时为 null） */
  protocolCode: string | null
  /** events.jsonl 里 type=error 的行数 */
  protocolErrorCount: number
  /** events.jsonl 是否存在 */
  hasEventsFile: boolean
  /** stderr 末尾（报告里贴出来用） */
  stderrTail: string
  /** 是否走了 events.jsonl 兜底通道 */
  usedFallback: boolean
  durationMs: number
}

/** 按真实 PathService 的接口实现，只覆盖 RProcessRunner 真正会用到的那几项 */
function makePaths(p: HarnessPaths): PathService {
  return {
    ...pathService,
    get isDev(): boolean {
      return true
    },
    getResourcesRoot: () => p.resourcesRoot,
    getRScriptsRoot: () => p.rScriptsRoot,
    getRlibsRoot: () => p.rlibsRoot,
    getRlibsUserDir: () => p.rlibsUserDir,
    getTempDir: () => p.tempDir,
    getRFontPath: () => path.join(p.resourcesRoot, 'runtime', 'fonts', 'NotoSansSC-Regular.otf'),
    getPlotThemePath: () => path.join(p.resourcesRoot, 'plotTheme.json'),
    getUserDataDir: () => p.tempDir,
    getMainLogDir: () => path.join(p.tempDir, 'logs')
  }
}

/** 读 events.jsonl 统计 error 协议行（这是"R 到底有没有把 code 发出来"的证据） */
function inspectEvents(runDir: string): {
  hasEventsFile: boolean
  protocolCode: string | null
  protocolErrorCount: number
} {
  const file = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(file)) {
    return { hasEventsFile: false, protocolCode: null, protocolErrorCount: 0 }
  }
  const messages = parseEventsJsonl(fs.readFileSync(file, 'utf8'))
  const errors = messages.filter((m) => m.type === 'error')
  const last = errors.length > 0 ? errors[errors.length - 1] : null
  return {
    hasEventsFile: true,
    protocolCode: last && 'code' in last ? String(last.code) : null,
    protocolErrorCount: errors.length
  }
}

/** 跑一个场景；返回进程级 + 协议级 + 翻译级三份结果 */
export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const runDir = path.join(opts.runRoot, opts.runId)
  fs.mkdirSync(runDir, { recursive: true })

  const paths = makePaths(opts)
  // rscriptPath 显式传入 → resolveRscript 直接返回，永远不会碰 resolver。
  // 这里给一个只会抛错的实现，避免"悄悄走了探测路径"这种情况被漏掉。
  const resolver = (): RRuntimeResolver => {
    throw new Error('harness: resolver should never be called (rscriptPath is explicit)')
  }
  const runner = new RProcessRunner(resolver, paths, new ChildProcessManager(), new RErrorTranslator())

  const result = await runner.run({
    runId: opts.runId,
    scriptRelPath: opts.scriptRelPath,
    config: opts.config,
    runDir,
    rscriptPath: opts.rscriptPath,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
  })

  const events = inspectEvents(runDir)
  const stderrLines = result.stderr.split(/\r?\n/)
  const tail = stderrLines.slice(Math.max(0, stderrLines.length - 12)).join('\n').trim()

  return {
    exitCode: result.exitCode,
    ok: result.ok,
    translatedCode: result.error ? result.error.code : null,
    protocolCode: events.protocolCode,
    protocolErrorCount: events.protocolErrorCount,
    hasEventsFile: events.hasEventsFile,
    stderrTail: tail,
    usedFallback: result.usedFallback,
    durationMs: result.durationMs
  }
}

/** 探测某个 R 包在给定库路径下是否可见（用于判断"缺包场景"能否构造出来） */
export async function probePackage(o: {
  rscriptPath: string
  pkg: string
  /** 传空串 = 不覆盖，让 R 用它自己的默认库路径 */
  rlibsRoot: string
  rlibsUserDir: string
  tempDir: string
  timeoutMs?: number
}): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: o.tempDir }
  if (o.rlibsRoot) env.R_LIBS_SITE = o.rlibsRoot
  if (o.rlibsUserDir) env.R_LIBS_USER = o.rlibsUserDir
  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      o.rscriptPath,
      ['--vanilla', '--no-save', '--no-restore', '-e', `cat(requireNamespace("${o.pkg}", quietly=TRUE))`],
      { env, windowsHide: true }
    )
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.once('error', () => resolve(false))
    child.once('close', () => resolve(out.includes('TRUE')))
  })
}
