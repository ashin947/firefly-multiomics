/**
 * R 子进程 stdout 行协议（ARCHITECTURE §5.2 / 附录 A.1）。
 *
 * 本文件是**纯函数**：不依赖 Node、不依赖 Electron，主进程与单测两侧共用。
 *
 * 协议格式：`@@DEG@@ ` + 单行紧凑 JSON + `\n`
 *
 * 容错要求（T02 验收）：
 *   - 无前缀行  → null（调用方按 raw 日志处理）
 *   - 坏 JSON   → null
 *   - 超长行    → null（> 64 KB，R 侧必须改为写文件 + artifact）
 *   - 缺字段    → null（逐类型校验必填字段，避免脏数据流进业务层）
 */
import { MAX_PROTOCOL_LINE_BYTES, PROTOCOL_VERSION, STAGES, type Stage } from './constants'

export const PROTOCOL_PREFIX = '@@DEG@@ '

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface ProtocolBase {
  v: typeof PROTOCOL_VERSION
  seq: number
  ts: number
}

export interface HelloMessage extends ProtocolBase {
  type: 'hello'
  script: string
  rVersion: string
  pid: number
}

export interface LogMessage extends ProtocolBase {
  type: 'log'
  level: LogLevel
  msg: string
}

export interface ProgressMessage extends ProtocolBase {
  type: 'progress'
  stage: Stage
  /** 0..100，已做单调修正与范围钳制 */
  pct: number
  msg?: string
}

export interface ArtifactMessage extends ProtocolBase {
  type: 'artifact'
  kind: string
  /** 相对 runDir 的 POSIX 路径 */
  path: string
  rows?: number
  schema?: string
}

export interface ResultMessage extends ProtocolBase {
  type: 'result'
  ok: true
  summary: Record<string, unknown>
}

export interface ErrorMessage extends ProtocolBase {
  type: 'error'
  code: string
  message: string
  detail?: string
}

export type ProtocolMessage =
  | HelloMessage
  | LogMessage
  | ProgressMessage
  | ArtifactMessage
  | ResultMessage
  | ErrorMessage

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error']

/** 判断一行是否带协议前缀（调用方据此区分「协议行」与「R 原始输出」） */
export function hasProtocolPrefix(line: string): boolean {
  return typeof line === 'string' && line.startsWith(PROTOCOL_PREFIX)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 把任意值收敛成对象（排除 null / 数组 / 原始值） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 逐类型校验并归一化。
 * 校验失败返回 null —— 宁可丢一条消息（并计入解析失败计数触发兜底），
 * 也不让字段缺失的消息流进业务层造成 undefined 级联错误。
 */
function normalizeMessage(raw: unknown): ProtocolMessage | null {
  if (!isPlainObject(raw)) return null

  // 公共字段
  if (raw.v !== PROTOCOL_VERSION) return null
  if (!isFiniteNumber(raw.seq) || raw.seq < 1) return null
  if (!isNonEmptyString(raw.type)) return null
  const ts = isFiniteNumber(raw.ts) ? raw.ts : Date.now()
  const seq = Math.floor(raw.seq)

  switch (raw.type) {
    case 'hello': {
      if (!isNonEmptyString(raw.script)) return null
      if (!isNonEmptyString(raw.rVersion)) return null
      const pid = isFiniteNumber(raw.pid) ? Math.floor(raw.pid) : 0
      return { v: PROTOCOL_VERSION, type: 'hello', seq, ts, script: raw.script, rVersion: raw.rVersion, pid }
    }
    case 'log': {
      if (!isNonEmptyString(raw.level) || !LOG_LEVELS.includes(raw.level)) return null
      if (typeof raw.msg !== 'string') return null
      return {
        v: PROTOCOL_VERSION,
        type: 'log',
        seq,
        ts,
        level: raw.level as LogLevel,
        msg: raw.msg
      }
    }
    case 'progress': {
      if (!isNonEmptyString(raw.stage) || !(STAGES as readonly string[]).includes(raw.stage)) return null
      if (!isFiniteNumber(raw.pct)) return null
      const pct = Math.min(100, Math.max(0, raw.pct))
      const message: ProgressMessage = {
        v: PROTOCOL_VERSION,
        type: 'progress',
        seq,
        ts,
        stage: raw.stage as Stage,
        pct
      }
      if (typeof raw.msg === 'string' && raw.msg.length > 0) message.msg = raw.msg
      return message
    }
    case 'artifact': {
      if (!isNonEmptyString(raw.kind)) return null
      if (!isNonEmptyString(raw.path)) return null
      const message: ArtifactMessage = {
        v: PROTOCOL_VERSION,
        type: 'artifact',
        seq,
        ts,
        kind: raw.kind,
        path: raw.path
      }
      if (isFiniteNumber(raw.rows)) message.rows = Math.floor(raw.rows)
      if (typeof raw.schema === 'string') message.schema = raw.schema
      return message
    }
    case 'result': {
      if (raw.ok !== true) return null
      if (!isPlainObject(raw.summary)) return null
      return {
        v: PROTOCOL_VERSION,
        type: 'result',
        seq,
        ts,
        ok: true,
        summary: raw.summary as Record<string, unknown>
      }
    }
    case 'error': {
      if (!isNonEmptyString(raw.code)) return null
      if (typeof raw.message !== 'string') return null
      const message: ErrorMessage = {
        v: PROTOCOL_VERSION,
        type: 'error',
        seq,
        ts,
        code: raw.code,
        message: raw.message
      }
      if (typeof raw.detail === 'string' && raw.detail.length > 0) message.detail = raw.detail
      return message
    }
    default:
      return null
  }
}

/**
 * 解析一行 stdout。
 *
 * @returns 合法协议消息；无前缀 / 坏 JSON / 超长 / 缺字段 / 版本不符 均返回 null
 */
export function parseProtocolLine(line: string): ProtocolMessage | null {
  if (typeof line !== 'string') return null
  // 兼容 Windows CRLF：readline 通常已剥掉 \r，但手工拼接的行可能残留
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!trimmed.startsWith(PROTOCOL_PREFIX)) return null

  const json = trimmed.slice(PROTOCOL_PREFIX.length).trim()
  if (json.length === 0) return null
  // 超长行不解析：R 侧必须改为「写文件 + artifact 引用」（§5.2）
  if (json.length > MAX_PROTOCOL_LINE_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return normalizeMessage(parsed)
}

/** 解析 events.jsonl 全文（兜底通道重放用），跳过空行与坏行 */
export function parseEventsJsonl(content: string): ProtocolMessage[] {
  const messages: ProtocolMessage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const msg = parseProtocolLine(line)
    if (msg) messages.push(msg)
  }
  return messages
}

/** 序列化一条消息（仅单测与调试工具使用；生产由 R 侧写出） */
export function serializeProtocolMessage(msg: ProtocolMessage): string {
  return `${PROTOCOL_PREFIX}${JSON.stringify(msg)}`
}
