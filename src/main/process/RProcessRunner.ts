/**
 * R 进程运行器（ARCHITECTURE §5 / §6.2 / T05）。
 *
 * 职责边界：
 *  - 负责 spawn、环境变量、行协议解析、进度节流、超时/取消、stderr 收集、events.jsonl 兜底；
 *  - **不负责**业务语义（哪个脚本、什么参数、结果怎么入库）—— 那是 AnalysisRunner 的事。
 *
 * 四个容易写错的地方（这里都做了显式处理）：
 *  1. Windows 上 `detached: true` 会弹黑窗 → 平台分支；POSIX 需要 detached 才能整组 kill。
 *  2. `pct` 必须单调不回退，且 100 ms 节流（否则 UI 抖动）。
 *  3. raw 输出（R 的 print/包消息）必须节流到 50 行/秒，否则日志面板被刷屏。
 *  4. 退出后若无 result/error，必须回读 events.jsonl 重放（Windows 编码坑的兜底）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { LIMITS } from '@shared/constants'
import { toAppError, type AppError, type ErrorCode } from '@shared/errors'
import { missingPackagesFor } from '@shared/runtimeStatus'
import {
  hasProtocolPrefix,
  parseEventsJsonl,
  parseProtocolLine,
  type ArtifactMessage,
  type ErrorMessage,
  type ProgressMessage,
  type ProtocolMessage
} from '@shared/protocol'
import type { RRuntimeInfo } from '@shared/types/runtime'
import type { AnalysisLogLevel } from '@shared/types/ipc-contract'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRuntimeResolver } from '../runtime/RRuntimeResolver'
import type { RLibsDefaultsProvider } from '../runtime/RDefaultLibs'
import { composeLibPath } from '../runtime/RDefaultLibs'
import { ChildProcessManager } from './ChildProcessManager'
import { RErrorTranslator } from './RErrorTranslator'

/** 转发给 UI 的一行日志 */
export interface LogMsg {
  ts: number
  level: AnalysisLogLevel
  line: string
}

export interface RunROptions {
  runId: string
  /** 相对 r/ 根，如 'de/run_deseq2.R' */
  scriptRelPath: string
  /** 会被写成 runDir/run_config.json */
  config: unknown
  /** 项目内临时运行目录（同时作为子进程 cwd） */
  runDir: string
  /** 默认 30 min */
  timeoutMs?: number
  onProgress?(p: ProgressMessage): void
  onLog?(l: LogMsg): void
  onArtifact?(a: ArtifactMessage): void
  signal?: AbortSignal
  /** 完整 stdout+stderr 落盘位置（logs/<runId>.log），不传则不写 */
  logFile?: string
  /**
   * 显式指定 Rscript 路径（能力自检用）。
   * 不传时通过 RRuntimeResolver.resolve() 解析。
   */
  rscriptPath?: string
  /**
   * 本次任务**真正需要**的 R 包（模块的 `requiredPackages`）。
   *
   * 为什么需要：`RRuntimeInfo.ok` 是按全局清单判的（含 DESeq2、clusterProfiler 等
   * 只被特定方法/富集分析用到的包）。若按全局判，机器上只缺 DESeq2 时
   * limma-voom 也会被拦在 `E_RT_PKG_MISSING` —— 而预检是全绿的，用户看到的是
   * 「清单说能跑、一点就报错」。给了这个字段就按「本任务所需」判；
   * 不给则退回全局判（保持旧行为）。
   */
  requiredPackages?: string[]
}

export interface RunRResult {
  ok: boolean
  exitCode: number | null
  summary?: Record<string, unknown>
  artifacts: ArtifactMessage[]
  stderr: string
  durationMs: number
  cancelled: boolean
  /**
   * 失败时的结构化错误。
   * 说明：ARCHITECTURE §4.9 的 RunRResult 未列该字段，但 §7.3 时序图要求
   * runner 把 AppError 交给 AnalysisRunner，故补上（见交付说明）。
   */
  error?: AppError
  /** 是否走了 events.jsonl 兜底通道 */
  usedFallback: boolean
}

/**
 * 结构化接口：只声明「能跑一个 R 任务」。
 *
 * AnalysisRunner / GeneIdResolver 依赖这个接口而不是具体类，
 * 单测就能注入一个「假 R」——按真实协议行回放进度、写出 de.csv，
 * 从而在不安装 R 的机器上验证整条链路（见 __tests__/echoModule.test.ts）。
 */
export interface RRunner {
  run(opts: RunROptions): Promise<RunRResult>
}

/** 允许传入实例，或传入返回实例的函数（用于打破 resolver ↔ runner 的构造循环） */
export type ResolverRef = RRuntimeResolver | (() => RRuntimeResolver)

export class RProcessRunner {
  constructor(
    private readonly resolverRef: ResolverRef,
    private readonly paths: PathService,
    private readonly children: ChildProcessManager,
    private readonly translator: RErrorTranslator = new RErrorTranslator(),
    /**
     * R 的原始默认库路径（`R_LIBS_USER` / `R_LIBS_SITE`）。
     *
     * 可选：失败路径冒烟脚本（scripts/failures/harness.ts）自己控制 `R_LIBS_*`，
     * 传 undefined 时 buildRenv 只用应用自己的两个目录。生产环境必须传。
     */
    private readonly rlibsDefaults: RLibsDefaultsProvider | null = null
  ) {}

  private get resolver(): RRuntimeResolver {
    return typeof this.resolverRef === 'function' ? this.resolverRef() : this.resolverRef
  }

  async run(opts: RunROptions): Promise<RunRResult> {
    const startedAt = Date.now()

    // ---------- 0) 解析 Rscript ----------
    const resolved = await this.resolveRscript(opts.rscriptPath, opts.requiredPackages)
    if ('error' in resolved) {
      return {
        ok: false,
        exitCode: null,
        artifacts: [],
        stderr: '',
        durationMs: Date.now() - startedAt,
        cancelled: false,
        error: resolved.error,
        usedFallback: false
      }
    }
    const rscriptPath = resolved.rscriptPath

    // ---------- 0.5) 确保已知 R 的原始默认库路径 ----------
    // 必须在 spawn 之前：buildRenv() 是同步的，只能取已解析好的值。
    // 首次约 0.3 s（之后走内存/磁盘缓存），失败时不阻断（拿不到就只用应用自己的库）。
    if (this.rlibsDefaults) {
      await this.rlibsDefaults.ensure(rscriptPath)
    }

    // ---------- 1) 准备运行目录与配置文件 ----------
    try {
      fs.mkdirSync(opts.runDir, { recursive: true })
    } catch (err) {
      return this.failFast(startedAt, 'E_IO_PERMISSION', '无法创建运行目录', err)
    }

    const configPath = path.join(opts.runDir, 'run_config.json')
    try {
      this.writeJsonAtomic(configPath, opts.config)
    } catch (err) {
      return this.failFast(startedAt, 'E_IO_PERMISSION', '无法写入 run_config.json', err)
    }

    const scriptPath = path.join(this.paths.getRScriptsRoot(), opts.scriptRelPath)
    if (!fs.existsSync(scriptPath)) {
      return this.failFast(
        startedAt,
        'E_R_GENERIC',
        `R 脚本不存在：${scriptPath}`,
        undefined,
        '软件安装不完整，请重新安装或执行 npm run verify:r 检查。'
      )
    }

    // ---------- 2) spawn ----------
    const isWin = process.platform === 'win32'
    const args = ['--vanilla', '--no-save', '--no-restore', scriptPath, '--config', configPath]

    let child: ChildProcess
    try {
      child = spawn(rscriptPath, args, {
        cwd: opts.runDir,
        env: this.buildRenv(rscriptPath),
        windowsHide: true,
        // ★ POSIX 需要独立进程组才能 kill(-pid)；Windows 上 detached 会弹新控制台
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return this.failFast(startedAt, 'E_RT_MISSING', 'R 进程启动失败', err)
    }

    this.children.register(opts.runId, child)
    logger.info('proc', `启动 R runId=${opts.runId} pid=${child.pid ?? '?'} script=${opts.scriptRelPath}`)

    // ---------- 3) 状态 ----------
    const artifacts: ArtifactMessage[] = []
    let resultSummary: Record<string, unknown> | undefined
    let protocolError: ErrorMessage | null = null
    let cancelled = false
    let timedOut = false
    let parseFailures = 0
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let usedFallback = false

    // 进度节流状态
    let lastPct = -1
    let lastProgressEmitAt = 0
    let pendingProgress: ProgressMessage | null = null
    let progressTimer: NodeJS.Timeout | null = null

    // raw 行节流状态（每秒最多 50 行）
    let rawWindowStart = Date.now()
    let rawInWindow = 0
    let rawDropped = 0

    // stderr 缓冲（2000 行 / 512 KB）
    const stderrChunks: string[] = []
    let stderrBytes = 0
    let stderrLines = 0
    let stderrTruncated = false

    // 完整日志（可选落盘）
    let logStream: fs.WriteStream | null = null
    if (opts.logFile) {
      try {
        fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
        logStream = fs.createWriteStream(opts.logFile, { flags: 'a', encoding: 'utf8' })
        // ★ 必须挂 error 监听：日志目录不可写时 write stream 会异步 emit 'error'，
        //   没有监听器会直接让主进程崩溃（比「日志写不进去」严重得多）。
        logStream.on('error', (err) => {
          logger.warn('proc', `日志文件写入失败（已忽略）: ${String(err)}`)
          logStream = null
        })
      } catch (err) {
        logger.warn('proc', `无法创建日志文件（已忽略）: ${String(err)}`)
      }
    }
    const writeLog = (prefix: string, line: string): void => {
      if (!logStream) return
      try {
        logStream.write(`${prefix}${line}\n`)
      } catch {
        // 日志写入失败不影响主流程
      }
    }

    const emitLog = (level: AnalysisLogLevel, line: string): void => {
      opts.onLog?.({ ts: Date.now(), level, line })
    }

    const flushPendingProgress = (): void => {
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      if (!pendingProgress) return
      const p = pendingProgress
      pendingProgress = null
      lastProgressEmitAt = Date.now()
      opts.onProgress?.(p)
    }

    const handleProgress = (msg: ProgressMessage): void => {
      // ★ 单调修正：R 侧各阶段独立上报 pct，跨阶段可能回退
      const pct = Math.max(msg.pct, lastPct)
      lastPct = pct
      const corrected: ProgressMessage = { ...msg, pct }
      const now = Date.now()
      if (now - lastProgressEmitAt >= LIMITS.progressThrottleMs) {
        lastProgressEmitAt = now
        opts.onProgress?.(corrected)
        return
      }
      // 节流窗口内：只保留最新一条，并在窗口结束时补发（保证 100% 一定能到 UI）
      pendingProgress = corrected
      if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = null
          flushPendingProgress()
        }, LIMITS.progressThrottleMs)
      }
    }

    const handleRawLine = (line: string): void => {
      writeLog('', line)
      const now = Date.now()
      if (now - rawWindowStart >= 1000) {
        if (rawDropped > 0) {
          emitLog('info', `…（为保持流畅，已省略 ${rawDropped} 行原始输出）`)
          rawDropped = 0
        }
        rawWindowStart = now
        rawInWindow = 0
      }
      if (rawInWindow < LIMITS.rawLinesPerSecond) {
        rawInWindow += 1
        emitLog('raw', line)
      } else {
        rawDropped += 1
      }
    }

    /** 统一处理一条协议消息（stdout 实时通道与 events.jsonl 兜底通道共用） */
    const handleMessage = (msg: ProtocolMessage, fromFallback: boolean): void => {
      switch (msg.type) {
        case 'hello':
          logger.debug('proc', `R hello runId=${opts.runId} r=${msg.rVersion} pid=${msg.pid}`)
          writeLog('', `# hello r=${msg.rVersion} pid=${msg.pid} script=${msg.script}`)
          return
        case 'log':
          writeLog('', `# [${msg.level}] ${msg.msg}`)
          emitLog(msg.level, msg.msg)
          return
        case 'progress':
          if (!fromFallback) handleProgress(msg)
          return
        case 'artifact':
          artifacts.push(msg)
          writeLog('', `# artifact ${msg.kind} -> ${msg.path}${msg.rows ? ` (${msg.rows} 行)` : ''}`)
          opts.onArtifact?.(msg)
          return
        case 'result':
          resultSummary = msg.summary
          return
        case 'error':
          protocolError = msg
          emitLog('error', `[${msg.code}] ${msg.message}`)
          writeLog('', `# error ${msg.code}: ${msg.message}`)
          return
        default:
          return
      }
    }

    // ---------- 4) stdout 逐行解析 ----------
    const rl = child.stdout ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) : null
    rl?.on('line', (line: string) => {
      if (!hasProtocolPrefix(line)) {
        handleRawLine(line)
        return
      }
      const msg = parseProtocolLine(line)
      if (!msg) {
        // 有前缀但解析失败：累计计数，连续 3 行触发 events.jsonl 兜底
        parseFailures += 1
        writeLog('', `# [parse-fail] ${line.slice(0, 300)}`)
        if (parseFailures === LIMITS.parseFailureFallbackThreshold) {
          logger.warn('proc', `stdout 连续解析失败 ${parseFailures} 行，将启用 events.jsonl 兜底`)
        }
        return
      }
      parseFailures = 0
      handleMessage(msg, false)
    })

    // ---------- 5) stderr 收集 ----------
    const errRl = child.stderr
      ? readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
      : null
    errRl?.on('line', (line: string) => {
      writeLog('[stderr] ', line)
      if (stderrTruncated) return
      const bytes = Buffer.byteLength(line, 'utf8') + 1
      if (stderrLines >= LIMITS.stderrMaxLines || stderrBytes + bytes > LIMITS.stderrMaxBytes) {
        stderrTruncated = true
        stderrChunks.push('\n[truncated] stderr 超过上限，后续内容已丢弃')
        return
      }
      stderrLines += 1
      stderrBytes += bytes
      stderrChunks.push(line)
      // stderr 里的 error 行立即进日志面板（§5.4），其余只在「展开原始日志」看
      if (/\berror\b/i.test(line)) emitLog('error', line)
    })

    // ---------- 6) 超时 / 取消 ----------
    const timeoutMs = opts.timeoutMs ?? LIMITS.runTimeoutMs
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      logger.warn('proc', `R 任务超时 runId=${opts.runId} timeout=${timeoutMs}ms`)
      void this.children.kill(opts.runId)
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

    const onAbort = (): void => {
      if (cancelled) return
      cancelled = true
      logger.info('proc', `收到取消信号 runId=${opts.runId}`)
      void this.children.kill(opts.runId)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    // ---------- 7) 等待退出 ----------
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once('error', (err) => resolve(err))
      // 用 close 而不是 exit：确保 stdio 已读完，否则最后几行协议消息会丢
      child.once('close', (code, signal) => {
        exitCode = code
        exitSignal = signal
        resolve(null)
      })
    })

    clearTimeout(timeoutTimer)
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    flushPendingProgress()
    rl?.close()
    errRl?.close()
    this.children.unregister(opts.runId)

    if (spawnError) {
      logStream?.end()
      return this.failFast(
        startedAt,
        'E_RT_MISSING',
        `无法启动 R 进程：${spawnError.message}`,
        spawnError
      )
    }

    // ---------- 8) events.jsonl 兜底 ----------
    const noOutcome = !resultSummary && !protocolError
    const tooManyParseFailures = parseFailures >= LIMITS.parseFailureFallbackThreshold
    const zeroExitWithoutArtifact = exitCode === 0 && artifacts.length === 0 && !protocolError
    const needFallback =
      !cancelled && (noOutcome || tooManyParseFailures || zeroExitWithoutArtifact)

    if (needFallback) {
      const replayed = this.replayEvents(opts.runDir)
      if (replayed.length > 0) {
        // 兜底通道不重放 progress：避免 pct 回退（进度已由实时通道推过）
        for (const msg of replayed) handleMessage(msg, true)
        // 只有「真的补上了缺失的结果」才算用了兜底；exit 0 且本来就无产物的脚本
        // （如 check_runtime.R）不该被标记成「回退解析」，否则日志会误导用户
        if (noOutcome || tooManyParseFailures) {
          usedFallback = true
          logger.warn(
            'proc',
            `使用 events.jsonl 兜底重放 runId=${opts.runId} 消息数=${replayed.length}`
          )
          emitLog('warn', '已使用日志文件回退解析（stdout 协议通道可能受编码影响）')
        }
      }
    }

    logStream?.end()

    // ---------- 9) 判定 ----------
    const durationMs = Date.now() - startedAt
    const stderrText = stderrChunks.join('\n')
    const hasOutcome = Boolean(resultSummary) || Boolean(protocolError)
    const ok =
      !cancelled &&
      !timedOut &&
      !protocolError &&
      exitCode === 0 &&
      Boolean(resultSummary) &&
      hasOutcome

    const result: RunRResult = {
      ok,
      exitCode,
      artifacts,
      stderr: stderrText,
      durationMs,
      cancelled,
      usedFallback
    }
    if (resultSummary) result.summary = resultSummary

    if (!ok) {
      result.error = this.translator.translate({
        stderr: stderrText,
        exitCode,
        signal: exitSignal,
        protocolError,
        cancelled,
        timedOut,
        // 让缺包类错误能说出「你在用哪份 R」
        rscriptPath
      })
    }

    logger.info(
      'proc',
      `R 结束 runId=${opts.runId} ok=${ok} exit=${String(exitCode)} 耗时=${durationMs}ms artifacts=${artifacts.length}`
    )
    return result
  }

  /** 读取 runDir/events.jsonl 并解析（兜底通道） */
  private replayEvents(runDir: string): ProtocolMessage[] {
    const file = path.join(runDir, 'events.jsonl')
    try {
      if (!fs.existsSync(file)) return []
      // 强制 UTF-8 解码：Windows 下 R 写出的文件可能是本地编码
      const content = fs.readFileSync(file, 'utf8')
      return parseEventsJsonl(content)
    } catch (err) {
      logger.warn('proc', `读取 events.jsonl 失败: ${String(err)}`)
      return []
    }
  }

  /** 解析 Rscript 路径；失败时返回结构化错误 */
  private async resolveRscript(
    explicitPath?: string,
    requiredPackages?: string[]
  ): Promise<{ rscriptPath: string } | { error: AppError }> {
    if (explicitPath) return { rscriptPath: explicitPath }

    let info: RRuntimeInfo
    try {
      info = await this.resolver.resolve()
    } catch (err) {
      return {
        error: toAppError('E_RT_MISSING', {
          message: `R 运行时探测失败：${err instanceof Error ? err.message : String(err)}`
        })
      }
    }

    if (info.ok && info.rscriptPath) return { rscriptPath: info.rscriptPath }

    // 区分几种失败，给出可操作的文案
    if (!info.rscriptPath) {
      return {
        error: toAppError('E_RT_MISSING', {
          message: '未找到可用的 Rscript，请先配置 R 运行环境。',
          detail: info.warnings.join('\n')
        })
      }
    }

    // 缺包按「本次任务所需的包」判；没给就按全局清单（旧行为）
    // ★ 判法只有一处：`missingPackagesFor()`。这里自己再写一遍
    //   `required.filter(pkg => !packages.some(ok))` 的话，规则一改就分叉。
    const required = requiredPackages ?? []
    const missing =
      required.length > 0 ? missingPackagesFor(info, required) : info.missingPackages
    if (missing.length > 0) {
      return {
        error: toAppError('E_RT_PKG_MISSING', {
          message: `R 环境缺少必需包：${missing.join('、')}（当前使用的 R：${info.rscriptPath}）`,
          // ★ 这句是给**用户**看的，不是给开发者看的。
          //   原来的「执行 npm run assemble:r」只有我们自己看得懂；而这条错误最常见
          //   的两种真实原因是：① 用户改过包但探测缓存还没过期（7 天 TTL，
          //   光重启软件不会重探，必须点「重新检测」）；② 用户在设置里指定了
          //   自己的 R，而那份 R 没装这些包 —— 内置 R 是随包分发的，一定齐全。
          suggestion:
            '先到「设置 / 诊断」点「重新检测」（装完包后必须点它，重启软件不会重新探测）。' +
            '若仍缺失，说明当前使用的 R 缺这些包：软件自带的 R 已包含全部依赖，' +
            '在设置里清空「自定义 R 路径」即可改用它。'
        })
      }
    }
    // 任务所需的包都齐了 → 放行。全局缺的包由首页三盏灯与诊断页提示，不该阻断本次分析。
    if (required.length > 0) return { rscriptPath: info.rscriptPath }

    return {
      error: toAppError('E_RT_VERSION', {
        message: `R 版本 ${info.version || '未知'} 低于要求的 4.2.0`
      })
    }
  }

  /**
   * 组装 R 子进程环境变量（§5.1 第 3 条）。
   *
   * ## 库路径为什么这么排（★ 这里最容易记反）
   *
   * 实测 R 4.3.2（`?Startup` 亦有说明）的搜索顺序是：
   *
   *     R_LIBS  →  R_LIBS_USER  →  R_LIBS_SITE  →  .Library（= R_HOME/library）
   *
   * `R_LIBS_USER` 排在 `R_LIBS_SITE` **前面**。所以「随包分发的受控版本必须赢、
   * 用户自己装的重名包不能覆盖它」这个要求，**不能**靠「受控库放 R_LIBS_SITE、
   * 用户库放 R_LIBS_USER」实现 —— 那样用户个人库里的 limma 会盖掉受控版本。
   * 正确做法是把受控库放在 `R_LIBS_USER` 的**第一位**：
   *
   *   ① resources/runtime/R-libs  随包受控版本（永远最先命中）
   *   ② userData/r-libs-user      应用自己的可写库（用户经本软件安装）
   *   ③ R 的原始 R_LIBS_USER      用户在 R 里手工 install.packages 装到这里
   *
   * ③ 的值**问 R 要**（见 RDefaultLibs），不硬编码 `~/R/win-library/x.y`：
   * 那个路径随平台 / R 版本 / `LOCALAPPDATA` 而变，写死必然过期。
   *
   * `R_LIBS_SITE` 不再指向应用目录（否则就出现上面说的倒挂），改为还原成 R 自己的
   * 默认值。这样「用户把包装进 <R_HOME>/site-library」这种情况也能被看见，
   * 少一处硬编码。
   *
   * 多路径的分隔符是平台相关的（Windows `;`、POSIX `:`）。写成 Windows 上不认的
   * `:` 时 R 会把整串当成一个不存在的目录，`.libPaths()` 里一条都不出现 —— 静默失效。
   */
  private buildRenv(rscriptPath: string): NodeJS.ProcessEnv {
    const tmp = this.paths.getTempDir()
    const defaults = this.rlibsDefaults?.getFor(rscriptPath) ?? null

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R_LIBS_USER: composeLibPath([
        this.paths.getRlibsRoot(),
        this.paths.getRlibsUserDir(),
        defaults?.user ?? ''
      ]),
      R_ENCODING: 'UTF-8',
      LANG: 'zh_CN.UTF-8',
      // ★ 不要无条件写 LC_ALL='C.UTF-8'：Windows 版 R（含 4.3.2）不支持这个名字，
      //   设了只会得到 4 条 "Setting LC_COLLATE=C.UTF-8 failed" 启动警告，并且
      //   LC_CTYPE 退回 "C"（ASCII）。在 ASCII native 编码下，R 里
      //   source(..., encoding="UTF-8") 会因 UTF-8→native 转换失败而**只发 warning
      //   就半途返回**，脚本随后死在 "could not find function deg_main"
      //   （exit 1、无协议行、无 events.jsonl）——主进程只看到「进程退出了但没有
      //   结果」，是最难查的一类故障。实测：Windows 10 + R 4.3.2 + LC_ALL=C.UTF-8
      //   时 r/de/run_limma_voom.R 必挂。
      //   传空串 = 让 R 用系统默认 locale（中文 Windows 即 Chinese_..._.utf8）。
      //   R 侧另有 r/common/loader.R 做与 locale 无关的源码加载，这里是第一道防线。
      //   POSIX 下 C.UTF-8 是真实存在的 locale，保留原值。
      LC_ALL: process.platform === 'win32' ? '' : 'C.UTF-8',
      // ★ 不用系统 TEMP：中文用户名 + 空格路径会让 R 的 tempdir 出问题
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      // 供 R 脚本定位自身与资源（common/bootstrap.R 依赖 DEG_R_ROOT）
      DEG_R_ROOT: this.paths.getRScriptsRoot(),
      DEG_FONT_PATH: this.paths.getRFontPath(),
      DEG_THEME_PATH: this.paths.getPlotThemePath(),
      DEG_RESOURCES_ROOT: this.paths.getResourcesRoot()
    }

    // R_LIBS_SITE：先删掉继承来的值（用户 shell 里可能有），再还原成 R 的默认值。
    // 探测失败时保持「未设置」—— 未设置时 R 自己会算出同一个默认值，行为一致。
    delete env.R_LIBS_SITE
    if (defaults && defaults.site.length > 0) env.R_LIBS_SITE = defaults.site

    // R_LIBS 优先级最高，最容易「意外赢过受控库」，一律清掉，不让它从父进程漏进来
    delete env.R_LIBS

    return env
  }

  /** 原子写 JSON：先写 .tmp 再 rename，避免写一半断电留下半截配置 */
  private writeJsonAtomic(file: string, data: unknown): void {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  private failFast(
    startedAt: number,
    code: ErrorCode,
    message: string,
    err?: unknown,
    suggestion?: string
  ): RunRResult {
    const detail = err instanceof Error ? err.stack : undefined
    logger.error('proc', message, err)
    const error = toAppError(code, { message, detail, suggestion })
    return {
      ok: false,
      exitCode: null,
      artifacts: [],
      stderr: detail ?? '',
      durationMs: Date.now() - startedAt,
      cancelled: false,
      error,
      usedFallback: false
    }
  }
}
