/**
 * RErrorTranslator 单测 —— 重点是「环境加载失败」这条新规则。
 *
 * 为什么这条规则值得单独一组用例：它的触发条件依赖 exitCode **和** stderr 内容，
 * 且必须排在规则表之前（规则表优先级 1 的 /could not find function/ 会把它误判成
 * 「缺少 R 包」）。这个误判真实发生过——用户被引导去装包，装完还是跑不了。
 */
import { describe, expect, it } from 'vitest'
import { RErrorTranslator } from '../RErrorTranslator'

/**
 * 真实抓到的 stderr 原文。
 *
 * 采集环境：Windows 10 + R 4.3.2 (ucrt) + 主进程导出的 LC_ALL=C.UTF-8，
 * 命令：`Rscript --vanilla --no-save --no-restore r/de/run_limma_voom.R --config ...`
 * 现象：进程 exit 1、stdout 零协议行、events.jsonl 未创建。
 * 这份夹具请勿"美化"——它存在的意义就是保住这个真实签名。
 */
const ENV_BROKEN_STDERR = [
  'During startup - Warning messages:',
  '1: Setting LC_COLLATE=C.UTF-8 failed ',
  '2: Setting LC_CTYPE=C.UTF-8 failed ',
  '3: Setting LC_MONETARY=C.UTF-8 failed ',
  '4: Setting LC_TIME=C.UTF-8 failed ',
  'Warning message:',
  'In source(file.path(.deg_root, "common", "bootstrap.R"), encoding = "UTF-8") :',
  "  invalid input found on input connection 'D:/ai/shengxin/r/common/bootstrap.R'",
  'Error in deg_main("de/run_limma_voom.R", function(ctx) { : ',
  '  could not find function "deg_main"',
  'Execution halted'
].join('\n')

describe('RErrorTranslator —— R 环境加载失败', () => {
  const translator = new RErrorTranslator()

  it('exit 1 + 只有 warning 级根因 → E_RT_ENV_BROKEN，并给出可操作建议', () => {
    const err = translator.translate({ stderr: ENV_BROKEN_STDERR, exitCode: 1 })

    expect(err.code).toBe('E_RT_ENV_BROKEN')
    expect(err.title).toContain('环境加载失败')
    expect(err.suggestion).toContain('诊断')
    // 原始 stderr 必须保留，否则用户/支持无法定位
    expect(err.detail).toContain('invalid input found on input connection')
  })

  it('不会被优先级 1 的「could not find function」规则抢走（误判成缺包）', () => {
    const err = translator.translate({ stderr: ENV_BROKEN_STDERR, exitCode: 1 })
    expect(err.code).not.toBe('E_RT_PKG_MISSING')
  })

  it('R 主动发出的 error 协议行优先级更高（R 知道得比规则准）', () => {
    const err = translator.translate({
      stderr: ENV_BROKEN_STDERR,
      exitCode: 1,
      protocolError: { code: 'E_VALIDATION', message: 'contrast is required' }
    })
    expect(err.code).toBe('E_VALIDATION')
  })

  it('正常退出（exit 0）时即使只有 warning 也不判为环境失败', () => {
    const err = translator.translate({ stderr: ENV_BROKEN_STDERR, exitCode: 0 })
    expect(err.code).not.toBe('E_RT_ENV_BROKEN')
  })

  it('业务 stop()（exit 10、有真实错误栈）不判为环境失败', () => {
    const err = translator.translate({
      stderr: 'Error in f(): boom: intentional failure\nExecution halted',
      exitCode: 10
    })
    expect(err.code).toBe('E_R_GENERIC')
    expect(err.code).not.toBe('E_RT_ENV_BROKEN')
  })

  it('缺包（exit 12 + 标准 stderr）仍走缺包规则', () => {
    const err = translator.translate({
      stderr: "Error in library(x) : there is no package called 'limma'\nExecution halted",
      exitCode: 12
    })
    expect(err.code).toBe('E_RT_PKG_MISSING')
  })

  /*
   * 中文 locale 的回归用例。
   *
   * 客户机器上 harmony 缺 RhpcBLASctl 时报的是：
   *   `不存在叫'RhpcBLASctl'这个名字的程辑包`
   * 原来规则表只认英文，这条会落到 E_R_GENERIC 兜底 —— 界面上只显示「失败」，
   * 用户完全不知道该装什么。
   */
  it('中文 locale 的缺包消息也认（并点名包名）', () => {
    const err = translator.translate({
      stderr:
        "Error in RhpcBLASctl::blas_get_num_procs() :\n" +
        "  不存在叫'RhpcBLASctl'这个名字的程辑包\nExecution halted",
      exitCode: 1
    })
    expect(err.code).toBe('E_RT_PKG_MISSING')
    expect(err.message).toContain('RhpcBLASctl')
    // 可操作的那句建议必须跟着走，否则用户还是不知道点哪儿
    expect(err.suggestion).toMatch(/重新检测|自定义 R 路径/)
  })

  it('缺包消息里点出包名，并补上实际使用的 Rscript 路径', () => {
    const err = translator.translate({
      stderr: "Error in library(seurat) : there is no package called 'Seurat'\nExecution halted",
      exitCode: 12,
      rscriptPath: 'D:/R-4.3.2/bin/x64/Rscript.exe'
    })
    expect(err.code).toBe('E_RT_PKG_MISSING')
    expect(err.message).toContain('Seurat')
    expect(err.message).toContain('D:/R-4.3.2/bin/x64/Rscript.exe')
  })

  it('非环境类错误不追加 Rscript 路径（避免噪音）', () => {
    const err = translator.translate({
      stderr: 'Error: cannot allocate vector of size 2.4 Gb',
      exitCode: 1,
      rscriptPath: 'D:/R-4.3.2/bin/x64/Rscript.exe'
    })
    expect(err.code).toBe('E_R_MEMORY')
    expect(err.message).not.toContain('Rscript.exe')
  })
})

describe('RErrorTranslator —— 既有路径不回归', () => {
  const translator = new RErrorTranslator()

  it('取消不是错误', () => {
    const err = translator.translate({ stderr: '', exitCode: null, cancelled: true })
    expect(err.code).toBe('E_CANCELLED')
  })

  it('超时给出可操作建议', () => {
    const err = translator.translate({ stderr: '', exitCode: null, timedOut: true })
    expect(err.title).toContain('超时')
    expect(err.suggestion).toBeTruthy()
  })

  it('协议行里的 code 若不是合法错误码，退化为 E_R_GENERIC 而不是污染联合类型', () => {
    const err = translator.translate({
      stderr: '',
      exitCode: 0,
      protocolError: { code: 'NOT_A_REAL_CODE', message: 'boom' }
    })
    expect(err.code).toBe('E_R_GENERIC')
  })

  it('退出码 14 在 stderr 无有效线索时兜底为写盘失败', () => {
    const err = translator.translate({ stderr: '', exitCode: 14 })
    expect(err.code).toBe('E_IO_PERMISSION')
  })
})
