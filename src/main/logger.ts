/**
 * 主进程日志。
 *
 * 三条硬要求（ARCHITECTURE §6 / T03）：
 *  1. 按天切分：userData/logs/main-YYYYMMDD.log
 *  2. 单文件 10 MB 上限，超出后切到 main-YYYYMMDD.1.log（避免长期运行撑爆磁盘）
 *  3. 内存环形缓冲 2000 条，供「导出日志」把最近上下文一起交出去
 *
 * 实现取舍：使用同步 appendFileSync。
 * 理由：主进程日志量小（每次分析几十行级别，raw R 输出不进这里），
 * 同步写能保证「崩溃前的最后一行一定落盘」，这比异步的吞吐更重要。
 */
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '@shared/constants'
import { getMainLogDir } from './paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  /** ISO 8601 UTC */
  ts: string
  level: LogLevel
  scope: string
  message: string
}

/** 依赖注入用的最小日志接口（避免单测被迫加载 electron） */
export interface LoggerLike {
  debug(scope: string, message: string, meta?: unknown): void
  info(scope: string, message: string, meta?: unknown): void
  warn(scope: string, message: string, meta?: unknown): void
  error(scope: string, message: string, meta?: unknown): void
  ringBuffer(): LogLine[]
  flush(): void
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地日期（日志按用户本地时间切分，便于用户自己找「今天」的日志） */
function localDateStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
}

function serializeMeta(meta: unknown): string {
  if (meta === undefined) return ''
  if (meta instanceof Error) return ` err="${meta.message}"`
  try {
    return ` ${JSON.stringify(meta)}`
  } catch {
    return ' [meta 无法序列化]'
  }
}

export class Logger implements LoggerLike {
  private readonly ring: LogLine[] = []
  private currentDate = ''
  private currentFile = ''
  private currentSize = 0
  private dirEnsured = false

  constructor(private readonly maxRing: number = LIMITS.logRingBuffer) {}

  debug(scope: string, message: string, meta?: unknown): void {
    this.write('debug', scope, message, meta)
  }

  info(scope: string, message: string, meta?: unknown): void {
    this.write('info', scope, message, meta)
  }

  warn(scope: string, message: string, meta?: unknown): void {
    this.write('warn', scope, message, meta)
  }

  error(scope: string, message: string, meta?: unknown): void {
    this.write('error', scope, message, meta)
  }

  /** 最近 N 条日志（供「导出日志」与诊断页） */
  ringBuffer(): LogLine[] {
    return [...this.ring]
  }

  /** 把环形缓冲渲染成可复制的文本 */
  dump(): string {
    return this.ring
      .map((l) => `${l.ts} [${l.level.toUpperCase()}] [${l.scope}] ${l.message}`)
      .join('\n')
  }

  /** 强制落盘（同步实现，保留接口以便未来切换异步队列） */
  flush(): void {
    // appendFileSync 每次调用即落盘，这里无需额外动作；
    // 保留方法是为了让调用方语义清晰，并为将来的异步队列留出替换点。
  }

  private write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
    const now = new Date()
    const line: LogLine = { ts: now.toISOString(), level, scope, message }

    // 1) 环形缓冲（内存，永远不失败）
    this.ring.push(line)
    if (this.ring.length > this.maxRing) {
      this.ring.splice(0, this.ring.length - this.maxRing)
    }

    // 2) 文件（失败不能影响业务：磁盘满 / 只读目录时静默降级为仅内存）
    try {
      this.ensureFile(now)
      const text = `${line.ts} [${level.toUpperCase()}] [${scope}] ${message}${serializeMeta(meta)}\n`
      fs.appendFileSync(this.currentFile, text, 'utf8')
      this.currentSize += Buffer.byteLength(text, 'utf8')
    } catch {
      // 有意吞掉：日志系统自身故障不得让主进程崩溃
    }
  }

  private ensureFile(now: Date): void {
    const stamp = localDateStamp(now)
    if (!this.dirEnsured) {
      fs.mkdirSync(getMainLogDir(), { recursive: true })
      this.dirEnsured = true
    }
    if (this.currentDate === stamp && this.currentFile && this.currentSize < LIMITS.logFileMaxBytes) {
      return
    }
    // 跨天或超出单文件上限 → 重新打开
    this.currentDate = stamp
    this.currentFile = path.join(getMainLogDir(), `main-${stamp}.log`)
    if (this.currentSize >= LIMITS.logFileMaxBytes) {
      const rotated = path.join(getMainLogDir(), `main-${stamp}.${Date.now()}.log`)
      this.currentFile = rotated
    }
    this.currentSize = fs.existsSync(this.currentFile) ? fs.statSync(this.currentFile).size : 0
    if (this.currentSize === 0) {
      fs.writeFileSync(this.currentFile, '', 'utf8')
    }
  }
}

/** 全局单例（主进程各处共享同一份环形缓冲） */
export const logger = new Logger()
