import { describe, expect, it } from 'vitest'
import {
  hasProtocolPrefix,
  parseEventsJsonl,
  parseProtocolLine,
  serializeProtocolMessage,
  PROTOCOL_PREFIX,
  type ProtocolMessage
} from '../protocol'

/** 构造一行合法协议消息 */
function line(payload: Record<string, unknown>): string {
  return `${PROTOCOL_PREFIX}${JSON.stringify({ v: 1, seq: 1, ts: 1750000000000, ...payload })}`
}

describe('parseProtocolLine —— 6 种消息类型', () => {
  it('解析 hello', () => {
    const msg = parseProtocolLine(
      line({ type: 'hello', script: 'de/run_deseq2.R', rVersion: '4.3.2', pid: 24188 })
    )
    expect(msg).toMatchObject({
      type: 'hello',
      v: 1,
      seq: 1,
      script: 'de/run_deseq2.R',
      rVersion: '4.3.2',
      pid: 24188
    })
  })

  it('解析 log', () => {
    const msg = parseProtocolLine(line({ type: 'log', level: 'info', msg: '读取表达矩阵 5432 × 48' }))
    expect(msg).toMatchObject({ type: 'log', level: 'info', msg: '读取表达矩阵 5432 × 48' })
  })

  it('解析 progress 并保留可选 msg', () => {
    const msg = parseProtocolLine(
      line({ type: 'progress', stage: 'dispersion', pct: 62, msg: '正在估计离散度' })
    )
    expect(msg).toMatchObject({ type: 'progress', stage: 'dispersion', pct: 62, msg: '正在估计离散度' })
  })

  it('解析 artifact（rows/schema 可选）', () => {
    const msg = parseProtocolLine(
      line({ type: 'artifact', kind: 'de_table', path: 'de.csv', rows: 5432, schema: 'DEResultRow[]' })
    )
    expect(msg).toMatchObject({ type: 'artifact', kind: 'de_table', path: 'de.csv', rows: 5432 })

    const minimal = parseProtocolLine(line({ type: 'artifact', kind: 'figure', path: 'volcano.png' }))
    expect(minimal).toMatchObject({ type: 'artifact', kind: 'figure', path: 'volcano.png' })
    expect((minimal as { rows?: number }).rows).toBeUndefined()
  })

  it('解析 result', () => {
    const msg = parseProtocolLine(
      line({ type: 'result', ok: true, summary: { genesAfterFilter: 5120, up: 702, down: 582 } })
    )
    expect(msg).toMatchObject({ type: 'result', ok: true })
    expect((msg as { summary: Record<string, unknown> }).summary).toEqual({
      genesAfterFilter: 5120,
      up: 702,
      down: 582
    })
  })

  it('解析 error', () => {
    const msg = parseProtocolLine(
      line({
        type: 'error',
        code: 'E_DATA_NOT_INTEGER',
        message: 'detected 1284 non-integer values',
        detail: 'first at row 12 col S03'
      })
    )
    expect(msg).toMatchObject({
      type: 'error',
      code: 'E_DATA_NOT_INTEGER',
      message: 'detected 1284 non-integer values',
      detail: 'first at row 12 col S03'
    })
  })
})

describe('parseProtocolLine —— 容错', () => {
  it('无前缀的裸输出返回 null（调用方按 raw 日志处理）', () => {
    expect(parseProtocolLine('Loading required package: limma')).toBeNull()
    expect(parseProtocolLine('')).toBeNull()
    expect(hasProtocolPrefix('plain text')).toBe(false)
    expect(hasProtocolPrefix(line({ type: 'log', level: 'info', msg: 'x' }))).toBe(true)
  })

  it('坏 JSON 返回 null', () => {
    expect(parseProtocolLine(`${PROTOCOL_PREFIX}{not json`)).toBeNull()
    expect(parseProtocolLine(`${PROTOCOL_PREFIX}   `)).toBeNull()
    expect(parseProtocolLine(`${PROTOCOL_PREFIX}[1,2,3]`)).toBeNull()
  })

  it('超长行（> 64 KB）返回 null', () => {
    const huge = 'x'.repeat(64 * 1024 + 10)
    const longLine = `${PROTOCOL_PREFIX}${JSON.stringify({
      v: 1,
      seq: 1,
      ts: 1,
      type: 'log',
      level: 'info',
      msg: huge
    })}`
    expect(parseProtocolLine(longLine)).toBeNull()
  })

  it('缺字段返回 null（逐类型校验）', () => {
    // hello 缺 rVersion
    expect(parseProtocolLine(line({ type: 'hello', script: 'a.R', pid: 1 }))).toBeNull()
    // log 缺 level
    expect(parseProtocolLine(line({ type: 'log', msg: 'hi' }))).toBeNull()
    // log 的 level 非法
    expect(parseProtocolLine(line({ type: 'log', level: 'trace', msg: 'hi' }))).toBeNull()
    // progress 缺 pct
    expect(parseProtocolLine(line({ type: 'progress', stage: 'read' }))).toBeNull()
    // progress 的 stage 不在枚举内
    expect(parseProtocolLine(line({ type: 'progress', stage: 'unknown-stage', pct: 10 }))).toBeNull()
    // artifact 缺 path
    expect(parseProtocolLine(line({ type: 'artifact', kind: 'de_table' }))).toBeNull()
    // result 缺 summary
    expect(parseProtocolLine(line({ type: 'result', ok: true }))).toBeNull()
    // error 缺 code
    expect(parseProtocolLine(line({ type: 'error', message: 'boom' }))).toBeNull()
    // 未知 type
    expect(parseProtocolLine(line({ type: 'nope' }))).toBeNull()
  })

  it('版本不符 / seq 非法返回 null', () => {
    expect(
      parseProtocolLine(`${PROTOCOL_PREFIX}${JSON.stringify({ v: 2, seq: 1, ts: 1, type: 'log', level: 'info', msg: 'x' })}`)
    ).toBeNull()
    expect(parseProtocolLine(line({ type: 'log', level: 'info', msg: 'x', seq: 0 }))).toBeNull()
    expect(parseProtocolLine(line({ type: 'log', level: 'info', msg: 'x', seq: 'a' }))).toBeNull()
  })

  it('兼容 CRLF 行尾', () => {
    const msg = parseProtocolLine(`${line({ type: 'log', level: 'warn', msg: 'crlf' })}\r`)
    expect(msg).toMatchObject({ type: 'log', level: 'warn', msg: 'crlf' })
  })

  it('pct 超出范围时钳制到 0..100', () => {
    const low = parseProtocolLine(line({ type: 'progress', stage: 'read', pct: -20 }))
    const high = parseProtocolLine(line({ type: 'progress', stage: 'read', pct: 999 }))
    expect((low as { pct: number }).pct).toBe(0)
    expect((high as { pct: number }).pct).toBe(100)
  })
})

describe('parseEventsJsonl —— 兜底通道重放', () => {
  it('跳过空行与坏行，只保留合法消息', () => {
    const content = [
      line({ type: 'hello', script: 'a.R', rVersion: '4.3.2', pid: 1 }),
      '',
      'garbage line',
      `${PROTOCOL_PREFIX}{broken`,
      line({ type: 'result', ok: true, summary: { up: 1 } })
    ].join('\n')

    const messages = parseEventsJsonl(content)
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('hello')
    expect(messages[1].type).toBe('result')
  })
})

describe('serializeProtocolMessage', () => {
  it('与 parseProtocolLine 互为逆运算', () => {
    const msg: ProtocolMessage = {
      v: 1,
      type: 'log',
      seq: 3,
      ts: 1750000000000,
      level: 'debug',
      msg: '往返测试'
    }
    const parsed = parseProtocolLine(serializeProtocolMessage(msg))
    expect(parsed).toEqual(msg)
  })
})
