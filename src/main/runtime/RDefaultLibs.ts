/**
 * 「R 自己认为的默认库路径」—— 也就是 `R_LIBS_USER` / `R_LIBS_SITE` 在**未被我们改写时**
 * 的原始默认值。
 *
 * ## 为什么必须问 R，而不是自己拼字符串
 *
 * 默认个人库的位置随平台、R 版本、`R_USER` / `LOCALAPPDATA` 等环境变量而变：
 *   - Windows：`%LOCALAPPDATA%/R/win-library/<major.minor>`
 *   - Linux/macOS：`~/R/<platform>-library/<major.minor>`
 * 硬编码 `~/R/win-library/4.3` 这种写法有两个必然过期的理由：用户改了 R 的库配置就
 * 对不上；R 从 4.3 升到 4.4 之后 `<major.minor>` 也变了。所以启动时**问一次 R**，
 * 把答案缓存到磁盘（`userData/r-default-libs.json`），之后同步取用。
 *
 * ## 为什么不能复用 check_runtime.R 的结果
 *
 * 那次探测是在 `R_LIBS_USER` 已被 `buildRenv()` 改写过的环境里跑的，它看到的是
 * **最终值**，原始默认值已经丢了。所以这里单开一个最小进程（`--vanilla` + 把
 * `R_LIBS` / `R_LIBS_USER` / `R_LIBS_SITE` 从环境里摘掉）再问一次。
 * 这个进程只在「首次启动 / R 换了路径 / R 被就地升级」时跑一次，约 0.3 s。
 *
 * ## 实测到的库搜索顺序（R 4.3.2，`?Startup` 亦有说明）
 *
 *     R_LIBS  →  R_LIBS_USER  →  R_LIBS_SITE  →  .Library（= R_HOME/library）
 *
 * ★ 注意 `R_LIBS_USER` 排在 `R_LIBS_SITE` **前面**，这一点很容易记反。
 *   所以「随包分发的受控版本必须赢」不能靠 `R_LIBS_SITE` 实现 —— 详见
 *   `RProcessRunner.buildRenv()` 里的注释。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../logger'
import type { PathService } from '../paths'

/** 探测结果的持久化结构 */
export interface RDefaultLibsInfo {
  /** 探测用的 Rscript 绝对路径（缓存键之一） */
  rscriptPath: string
  /** Rscript 的 mtime（缓存键之一：R 就地升级会改它） */
  rscriptMtimeMs: number
  /** `R_LIBS_USER` 的原始默认值；R 已把 `%v` / `%p` 展开成绝对路径 */
  user: string
  /** `R_LIBS_SITE` 的原始默认值（通常是 `<R_HOME>/site-library`） */
  site: string
  /** 形如 "4.3.2" */
  rVersion: string
  /** R.home() */
  rHome: string
  /** 上述默认环境下的 `.libPaths()`（**不含**应用目录），用于诊断对照 */
  baseLibPaths: string[]
  /** ISO 8601 */
  probedAt: string
}

/**
 * `RProcessRunner` 依赖的最小接口。
 *
 * 用接口而不是具体类，是为了让失败路径冒烟脚本（scripts/failures/harness.ts）
 * 能传 `undefined` —— 那时它自己控制 `R_LIBS_USER`，不需要这套解析。
 */
export interface RLibsDefaultsProvider {
  /** 保证已解析（幂等）；解析失败返回 null，不抛 */
  ensure(rscriptPath: string): Promise<RDefaultLibsInfo | null>
  /** 同步取用（供 buildRenv 这种同步路径调用）；未解析时为 null */
  getFor(rscriptPath: string): RDefaultLibsInfo | null
}

/** 探测脚本输出的行前缀 */
const PROBE_PREFIX = '##RLIBS:'

/** 缓存文件 schema 版本（结构变更时 +1，旧缓存自动失效） */
const CACHE_SCHEMA_VERSION = 1

/** 探测超时：R 启动 ~0.2–0.4 s，给 8 s 足够宽松 */
const PROBE_TIMEOUT_MS = 8_000

/** `baseLibPaths` 内部的分隔符（Windows 路径里不可能出现 `|`） */
const LIST_SEP = '|'

/**
 * 探测表达式。
 *
 * 刻意只做「读环境变量 + 打印」，不 source 任何项目脚本：
 * 这一步要的是**最干净**的 R 视角，任何项目代码都可能反过来改库路径。
 * 输出用行前缀 + `=` 分隔，不依赖 jsonlite（便携 R 里不一定装了它）。
 */
const PROBE_EXPR = [
  'cat("##RLIBS:user=", Sys.getenv("R_LIBS_USER", unset = ""), "\\n", sep = "")',
  'cat("##RLIBS:site=", Sys.getenv("R_LIBS_SITE", unset = ""), "\\n", sep = "")',
  'cat("##RLIBS:rver=", R.version$major, ".", R.version$minor, "\\n", sep = "")',
  'cat("##RLIBS:rhome=", R.home(), "\\n", sep = "")',
  `cat("##RLIBS:lib=", paste(.libPaths(), collapse = "${LIST_SEP}"), "\\n", sep = "")`
].join('; ')

/**
 * 多个库目录拼接成一个环境变量值。
 *
 * 分隔符必须按平台来：Windows 用 `;`，POSIX 用 `:`。
 * 实测（R 4.3.2 / Windows）：写成 `a:b` 时 R 会把整串当成**一个**不存在的目录，
 * `.libPaths()` 里一条都不出现 —— 静默失效，比报错更难查。
 * 空串与重复项会被剔除（重复项会让 `.libPaths()` 出现两行一样的路径）。
 */
export function composeLibPath(entries: readonly string[]): string {
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const raw of entries) {
    const value = raw.trim()
    if (value.length === 0) continue
    // 比较时忽略大小写与末尾分隔符：Windows 上 D:\a 与 d:/a/ 是同一个目录
    const key = normalizeForCompare(value)
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(value)
  }
  return cleaned.join(libSeparator())
}

/** R 的库路径分隔符（平台相关，见 composeLibPath 的注释） */
export function libSeparator(): string {
  return process.platform === 'win32' ? ';' : ':'
}

/** 路径比较用的归一化形式（只用于判重，不用于回填） */
export function normalizeForCompare(value: string): string {
  const unified = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 解析探测脚本的 stdout；没有 `##RLIBS:` 行时返回 null（说明探测没跑起来） */
export function parseProbeStdout(stdout: string): {
  user: string
  site: string
  rVersion: string
  rHome: string
  baseLibPaths: string[]
} | null {
  const seen = new Set<string>()
  const values: Record<string, string> = {}
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(PROBE_PREFIX)) continue
    const body = line.slice(PROBE_PREFIX.length)
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq)
    values[key] = body.slice(eq + 1)
    seen.add(key)
  }
  // user 可能合法地为空串，因此用「键是否出现过」判断，而不是判断非空
  if (!seen.has('user')) return null
  return {
    user: values['user'] ?? '',
    site: values['site'] ?? '',
    rVersion: values['rver'] ?? '',
    rHome: values['rhome'] ?? '',
    baseLibPaths: (values['lib'] ?? '')
      .split(LIST_SEP)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
}

export class RDefaultLibs implements RLibsDefaultsProvider {
  private memory: RDefaultLibsInfo | null = null
  /** 同一 Rscript 的并发 ensure 只跑一次探测 */
  private inflight: { rscriptPath: string; promise: Promise<RDefaultLibsInfo | null> } | null = null

  constructor(private readonly paths: PathService) {}

  /** 同步取用：路径必须与缓存一致，否则视为未知 */
  getFor(rscriptPath: string): RDefaultLibsInfo | null {
    if (!this.memory) return null
    return normalizeForCompare(this.memory.rscriptPath) === normalizeForCompare(rscriptPath)
      ? this.memory
      : null
  }

  async ensure(rscriptPath: string): Promise<RDefaultLibsInfo | null> {
    const mtimeMs = this.mtimeOf(rscriptPath)

    if (this.memory && this.isFresh(this.memory, rscriptPath, mtimeMs)) return this.memory

    const disk = this.readCache()
    if (disk && this.isFresh(disk, rscriptPath, mtimeMs)) {
      this.memory = disk
      return disk
    }

    if (this.inflight && normalizeForCompare(this.inflight.rscriptPath) === normalizeForCompare(rscriptPath)) {
      return this.inflight.promise
    }

    const promise = this.probe(rscriptPath, mtimeMs).finally(() => {
      this.inflight = null
    })
    this.inflight = { rscriptPath, promise }
    return promise
  }

  /** 探测失败时返回 null —— 拿不到 R 的默认库不该阻断分析 */
  private async probe(rscriptPath: string, mtimeMs: number): Promise<RDefaultLibsInfo | null> {
    try {
      const stdout = await this.runProbe(rscriptPath)
      const parsed = parseProbeStdout(stdout)
      if (!parsed) {
        logger.warn('runtime', `读取 R 默认库路径失败（未拿到 ${PROBE_PREFIX} 行），将只用应用自己的库`)
        return null
      }
      const info: RDefaultLibsInfo = {
        rscriptPath,
        rscriptMtimeMs: mtimeMs,
        user: parsed.user,
        site: parsed.site,
        rVersion: parsed.rVersion,
        rHome: parsed.rHome,
        baseLibPaths: parsed.baseLibPaths,
        probedAt: new Date().toISOString()
      }
      this.memory = info
      this.writeCache(info)
      logger.info(
        'runtime',
        `R 默认库路径：user=${info.user || '（空）'} site=${info.site || '（空）'}`
      )
      return info
    } catch (err) {
      logger.warn('runtime', `读取 R 默认库路径异常：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private runProbe(rscriptPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      // 摘掉这三个变量，才能看到 R 的**原始**默认值
      delete env['R_LIBS']
      delete env['R_LIBS_USER']
      delete env['R_LIBS_SITE']
      // 与 buildRenv 一致：Windows 版 R 不认 C.UTF-8，设了只会刷 4 条启动警告
      if (process.platform === 'win32') delete env['LC_ALL']

      const child = spawn(rscriptPath, ['--vanilla', '-e', PROBE_EXPR], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => {
          child.kill()
          reject(new Error(`探测 R 默认库路径超时（${PROBE_TIMEOUT_MS} ms）`))
        })
      }, PROBE_TIMEOUT_MS)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        // 这个探测只输出几行，超过 64 KB 说明哪里不对，直接截断防止内存被吃
        if (stdout.length < 64 * 1024) stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 8 * 1024) stderr += chunk
      })
      child.on('error', (err) => finish(() => reject(err)))
      child.on('close', (code) => {
        finish(() => {
          if (parseProbeStdout(stdout)) resolve(stdout)
          else reject(new Error(`R 探测进程退出码 ${String(code)}：${stderr.slice(0, 400)}`))
        })
      })
    })
  }

  private isFresh(info: RDefaultLibsInfo, rscriptPath: string, mtimeMs: number): boolean {
    return (
      normalizeForCompare(info.rscriptPath) === normalizeForCompare(rscriptPath) &&
      // mtime 未知（文件读不到）时不做 mtime 校验，避免缓存永远失效
      (mtimeMs <= 0 || info.rscriptMtimeMs === mtimeMs)
    )
  }

  private mtimeOf(file: string): number {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return 0
    }
  }

  private cacheFile(): string {
    return path.join(this.paths.getUserDataDir(), 'r-default-libs.json')
  }

  private readCache(): RDefaultLibsInfo | null {
    try {
      const file = this.cacheFile()
      if (!fs.existsSync(file)) return null
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      if (raw['schemaVersion'] !== CACHE_SCHEMA_VERSION) return null
      const user = raw['user']
      const rscriptPath = raw['rscriptPath']
      if (typeof user !== 'string' || typeof rscriptPath !== 'string') return null
      return {
        rscriptPath,
        rscriptMtimeMs: typeof raw['rscriptMtimeMs'] === 'number' ? raw['rscriptMtimeMs'] : 0,
        user,
        site: typeof raw['site'] === 'string' ? raw['site'] : '',
        rVersion: typeof raw['rVersion'] === 'string' ? raw['rVersion'] : '',
        rHome: typeof raw['rHome'] === 'string' ? raw['rHome'] : '',
        baseLibPaths: Array.isArray(raw['baseLibPaths'])
          ? raw['baseLibPaths'].filter((item): item is string => typeof item === 'string')
          : [],
        probedAt: typeof raw['probedAt'] === 'string' ? raw['probedAt'] : ''
      }
    } catch (err) {
      logger.warn('runtime', `读取 r-default-libs.json 失败（忽略缓存）：${String(err)}`)
      return null
    }
  }

  private writeCache(info: RDefaultLibsInfo): void {
    const file = this.cacheFile()
    const payload = { schemaVersion: CACHE_SCHEMA_VERSION, ...info }
    try {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      // 缓存写不进去不影响功能（下次启动重跑一次探测而已）
      logger.warn('runtime', `写入 r-default-libs.json 失败：${String(err)}`)
    }
  }
}
