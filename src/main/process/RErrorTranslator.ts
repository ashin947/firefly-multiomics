/**
 * 错误翻译层（ARCHITECTURE §6.3 / PRD R-29）。
 *
 * 优先级：
 *  1. R 主动发出的 error 消息（带 code）—— R 知道得更准，直接采信 code；
 *  2. 取消 / 超时 —— 有明确语义，不当作失败；
 *  3. ERROR_RULES 正则规则表（10 条，按 priority 顺序）；
 *  4. 退出码映射（§5.5）；
 *  5. 兜底 E_R_GENERIC。
 */
import {
  ERROR_META,
  EXIT_CODE_ERROR,
  isErrorCode,
  matchErrorRule,
  toAppError,
  truncateDetail,
  type AppError,
  type ErrorCode
} from '@shared/errors'
import { logger } from '../logger'

export interface ProtocolErrorLike {
  code: string
  message: string
  detail?: string
}

export interface TranslateContext {
  /** 完整 stderr（已按 2000 行 / 512 KB 截断） */
  stderr: string
  exitCode: number | null
  signal?: NodeJS.Signals | null
  /** R 侧通过协议发出的 error 消息 */
  protocolError?: ProtocolErrorLike | null
  /** 当前阶段（用于补充定位信息） */
  stage?: string | null
  /**
   * 本次实际启动的 Rscript 路径。
   *
   * 缺包类错误必须带上它：客户两次（WGCNA、单细胞）都撞在「设置里指定了自定义 R，
   * 而那份 R 没装包」，但界面上完全看不出用的是哪份 R —— 只说「缺少 Seurat」，
   * 用户会以为软件没装好，而不是「你连的不是内置那份」。
   */
  rscriptPath?: string
  cancelled?: boolean
  timedOut?: boolean
}

/**
 * 从 stderr 里抠出「缺的是哪个包」。
 *
 * 两种写法都要认（中文 locale 下 R 会把消息翻成中文）：
 *   `there is no package called 'RhpcBLASctl'`
 *   `不存在叫'RhpcBLASctl'这个名字的程辑包`
 *   `package or namespace load failed for 'harmony'`  ← 加载失败时给的是要加载的那个包
 *
 * 拿到包名后 message 里点名，用户才知道该装什么；拿不到就退回泛化文案。
 */
function extractMissingPackage(stderr: string): string | null {
  const patterns = [
    /there is no package called ['"`]([\w.]+)['"`]/i,
    /不存在叫[‘'""]?([\w.]+)[’'""]?这个名字的程辑包/,
    /package or namespace load failed for ['"`]([\w.]+)['"`]/i
  ]
  for (const re of patterns) {
    const m = re.exec(stderr ?? '')
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * 缺包 / 缺 R 这类错误，把「本次实际用的 Rscript」补进 message。
 *
 * 只对**环境类**错误补：其它错误（数据问题、R 内部异常）带上路径只会干扰阅读，
 * 而这两类错误用户唯一能动手的地方就是「换一份 R / 给它装包」。
 */
function withRPath(message: string, code: ErrorCode, rscriptPath?: string): string {
  if (!rscriptPath) return message
  if (code !== 'E_RT_PKG_MISSING' && code !== 'E_RT_MISSING' && code !== 'E_RT_ENV_BROKEN') {
    return message
  }
  // 已经带了就不重复追加（有的 message 来自主进程预检，里面已有路径）
  if (message.includes(rscriptPath)) return message
  return `${message}（当前使用的 R：${rscriptPath}）`
}

export class RErrorTranslator {
  translate(ctx: TranslateContext): AppError {
    const { stderr, exitCode, protocolError } = ctx

    // 1) 用户取消：不是错误，UI 只弹 Snackbar（§11.3）
    if (ctx.cancelled) {
      return toAppError('E_CANCELLED', { message: '任务已被用户取消' })
    }

    // 2) 超时
    if (ctx.timedOut) {
      return toAppError('E_R_GENERIC', {
        title: '任务超时',
        message: `R 计算超过预定时间仍未完成，已强制终止。${ctx.stage ? `（阶段：${ctx.stage}）` : ''}`,
        suggestion: '数据量较大时可先开启低表达过滤，或改用 limma + voom（比 DESeq2 快）。',
        detail: stderr
      })
    }

    // 3) R 主动报错：采信 R 的 code，只补中文 title/suggestion
    if (protocolError) {
      const code: ErrorCode = isErrorCode(protocolError.code) ? protocolError.code : 'E_R_GENERIC'
      const meta = ERROR_META[code]
      logger.debug('err', `采信 R 侧错误码 code=${protocolError.code}`)
      const rawMessage = protocolError.message || meta.title
      return toAppError(code, {
        title: meta.title,
        message: withRPath(rawMessage, code, ctx.rscriptPath),
        detail: protocolError.detail ?? stderr,
        suggestion: meta.suggestion
      })
    }

    // 4) 被信号杀死（且不是我们主动取消）→ 视为取消
    if (exitCode === null && ctx.signal) {
      return toAppError('E_CANCELLED', {
        message: `R 进程被信号 ${ctx.signal} 终止`,
        detail: stderr
      })
    }

    // 4.5) R 环境加载失败（必须早于规则表，理由见 isEnvironmentLoadFailure）
    if (this.isEnvironmentLoadFailure(stderr, exitCode)) {
      const meta = ERROR_META.E_RT_ENV_BROKEN
      logger.warn('err', '判定为 R 环境加载失败（exit=1 且只有 warning 级根因）')
      return toAppError('E_RT_ENV_BROKEN', {
        title: meta.title,
        message: `${meta.title}：R 启动后未能加载分析脚本（退出码 1，且没有真正的错误栈）。`,
        suggestion: meta.suggestion,
        detail: stderr
      })
    }

    // 5) 规则表匹配
    const rule = matchErrorRule(stderr)
    if (rule) {
      // ★ 缺包时**点出包名**：泛化的「缺少 R 包：Error in ... 」用户看不出该装什么。
      //   同时用 ERROR_META 里那句可操作的 suggestion（去设置点重新检测 / 清空自定义 R 路径），
      //   而不是规则表里那句面向开发者的旧文案。
      if (rule.code === 'E_RT_PKG_MISSING') {
        const meta = ERROR_META.E_RT_PKG_MISSING
        const missing = extractMissingPackage(stderr)
        const base = missing
          ? `R 环境缺少必需包：${missing}`
          : this.buildMessage(rule.code, stderr, exitCode)
        return toAppError(rule.code, {
          title: meta.title,
          message: withRPath(base, rule.code, ctx.rscriptPath),
          suggestion: meta.suggestion,
          detail: stderr
        })
      }
      return toAppError(rule.code, {
        title: rule.title,
        message: this.buildMessage(rule.code, stderr, exitCode),
        suggestion: rule.suggestion,
        detail: stderr
      })
    }

    // 6) 退出码映射
    if (exitCode !== null && EXIT_CODE_ERROR[exitCode]) {
      const code = EXIT_CODE_ERROR[exitCode]
      return toAppError(code, {
        message: this.buildMessage(code, stderr, exitCode),
        detail: stderr
      })
    }

    // 7) 兜底
    return toAppError('E_R_GENERIC', {
      message: this.buildMessage('E_R_GENERIC', stderr, exitCode),
      detail: stderr
    })
  }

  /**
   * 判断「R 环境加载失败」——这类故障的形态是「进程正常退出 1、根因只有 warning、
   * 没有真正的错误栈」，用户看到「R 脚本执行失败」等于什么都没看到。
   *
   * 为什么必须**早于**规则表（第 5 步）：规则表优先级 1 的
   * `/could not find function ["'`]/` 会把这个环境故障判成「缺少 R 包」，
   * 用户照着去装包，装完还是跑不了——错误的诊断比没有诊断更糟。
   *
   * 真实抓到的 stderr（Windows 10 + R 4.3.2 + LC_ALL=C.UTF-8，见
   * scripts/smoke-r-failures.mjs 的单测夹具）：
   *   During startup - Warning messages:
   *   1: Setting LC_CTYPE=C.UTF-8 failed
   *   Warning message:
   *   In source(file.path(.deg_root, "common", "bootstrap.R"), encoding = "UTF-8") :
   *     invalid input found on input connection '.../r/common/bootstrap.R'
   *   Error in deg_main(...) : could not find function "deg_main"
   *   Execution halted
   *
   * ★ 注意上面**确实有** "Error in" 一行——那是 source() 半途返回之后的次生错误，
   *   不是根因。所以判定不能写成「stderr 里没有 Error 字样」，否则这条规则在
   *   真实样本上永远不触发。这里改为「识别已知的环境加载签名」+「只有 warning
   *   没有错误栈」两条并列，任一条命中即成立。
   */
  private isEnvironmentLoadFailure(stderr: string, exitCode: number | null): boolean {
    // 10–14 有明确语义（脚本自己 quit 的），不参与本判定
    if (exitCode !== 1) return false
    if (!/\bwarning\b/i.test(stderr)) return false

    const knownSignature =
      /invalid input found on input connection/i.test(stderr) ||
      /could not find function\s*["'`]?deg_main/i.test(stderr) ||
      /cannot open file .*bootstrap\.R/i.test(stderr)
    if (knownSignature) return true

    // 退一步：R 以 1 退出、只吐了 warning、连 "Error in" 都没有（source() 静默失败）
    const warningOnly = !/\bError in\b/i.test(stderr) && !/\bExecution halted\b/i.test(stderr)
    return warningOnly
  }

  /**
   * 生成具体说明。
   * 优先取 stderr 中最后一条以 Error 开头的行（R 的 stop() 输出形如
   * "Error in ... : message"，最后一条通常是最贴近根因的那条）。
   */
  private buildMessage(code: ErrorCode, stderr: string, exitCode: number | null): string {
    const meta = ERROR_META[code]
    const tail = this.extractErrorLine(stderr)
    const suffix = exitCode !== null ? `（退出码 ${exitCode}）` : ''
    return tail ? `${meta.title}：${tail}${suffix}` : `${meta.title}${suffix}`
  }

  private extractErrorLine(stderr: string): string | null {
    if (!stderr.trim()) return null
    const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (/^\s*(error|错误)\b/i.test(line) || /^Error in\b/i.test(line)) {
        return truncateDetail(line.trim(), 500)
      }
    }
    return truncateDetail(lines[lines.length - 1].trim(), 500)
  }
}
