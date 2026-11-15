/**
 * ID 生成工具。
 *
 * runId 格式见 ARCHITECTURE §11.1：`run-20250612T102233-a1b2`
 * （可读的时间戳 + 4 位随机后缀，便于用户在日志里一眼定位到某次运行）。
 */
import crypto from 'node:crypto'

/** 本地时间的 YYYYMMDDTHHMMSS（用本地时间而不是 UTC：用户看日志时更直观） */
function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 4 位小写 base36 随机后缀 */
function suffix(): string {
  const value = crypto.randomInt(0, 36 ** 4)
  return value.toString(36).padStart(4, '0')
}

/** 生成 runId，满足 shared/constants 里的 RUN_ID_PATTERN */
export function createRunId(date: Date = new Date()): string {
  return `run-${stamp(date)}-${suffix()}`
}

/** 生成分析快照 ID（与 runId 区分，便于日志里分辨「运行」与「结果」） */
export function createAnalysisId(date: Date = new Date()): string {
  return `ana-${stamp(date)}-${suffix()}`
}

/** 生成富集运行 ID */
export function createEnrichId(date: Date = new Date()): string {
  return `enr-${stamp(date)}-${suffix()}`
}
