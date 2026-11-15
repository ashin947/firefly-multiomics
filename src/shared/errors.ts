/**
 * 错误码、中文文案与「stderr → 错误」规则表。
 *
 * 设计要点（ARCHITECTURE §6.3）：
 *  1. 规则表是**数据**而不是 if-else 链 —— 便于逐条单测、便于后续加规则；
 *  2. R 侧若已发出 error 消息并带 code，则优先采信 R 的 code，翻译层只补 title/suggestion；
 *  3. 所有面向用户的中文只出现在这里（R 侧只发英文/中性 message）。
 */
import type { Issue } from './types/dataset'

export type ErrorCode =
  | 'E_RT_MISSING'
  | 'E_RT_VERSION'
  | 'E_RT_PKG_MISSING'
  | 'E_RT_FONT_MISSING'
  | 'E_RT_NETWORK'
  | 'E_RT_ENV_BROKEN'
  | 'E_DATA_NOT_INTEGER'
  | 'E_DATA_SAMPLE_MISMATCH'
  | 'E_DATA_ENCODING'
  | 'E_DATA_GROUP_TOO_FEW'
  | 'E_DATA_GROUP_TOO_SMALL'
  | 'E_DATA_DUP_GENE'
  | 'E_DATA_DUP_SAMPLE'
  | 'E_DATA_EMPTY'
  | 'E_DATA_NA_RATIO'
  | 'E_DATA_NON_NUMERIC'
  | 'E_DATA_ALL_ZERO'
  | 'E_DATA_MEMORY_RISK'
  | 'E_RESULT_INVALID'
  | 'E_R_MEMORY'
  | 'E_R_GENEID_MAP'
  | 'E_KEGG_NETWORK'
  | 'E_R_GENERIC'
  | 'E_CANCELLED'
  | 'E_IO_PERMISSION'
  | 'E_PROJECT_CORRUPT'
  | 'E_PROJECT_SCHEMA'
  | 'E_VALIDATION'
  | 'E_UNKNOWN'

/** 统一信封：所有 invoke 都返回它，永不 throw 到渲染进程（§4.8） */
export interface AppError {
  code: ErrorCode
  /** 一句话标题：「DESeq2 需要整数 counts」 */
  title: string
  /** 具体说明（含定位信息） */
  message: string
  /** 建议动作：「改用 limma + voom 重试」 */
  suggestion?: string
  /** 可展开的原始 R stderr（截断到 20k 字符） */
  detail?: string
  locator?: Issue['locator']
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError }

/** 错误码 → 中文标题 / 建议动作（无正则匹配时的兜底文案来源） */
export interface ErrorMeta {
  title: string
  suggestion?: string
  /** UI 呈现方式（§11.3）：banner = 横幅；issue = 行内问题；dialog = 需要决策；toast = 轻提示 */
  presentation: 'banner' | 'issue' | 'dialog' | 'toast' | 'form'
}

export const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  E_RT_MISSING: {
    title: '未检测到 R 运行环境',
    suggestion:
      '把 R 便携版放到 resources/runtime/R/ 目录，或安装 R 4.2 及以上版本，然后点击「重新检测」。',
    presentation: 'banner'
  },
  E_RT_VERSION: {
    title: 'R 版本过低',
    suggestion: '本软件需要 R 4.2.0 及以上版本，建议使用 4.3.2。',
    presentation: 'banner'
  },
  E_RT_PKG_MISSING: {
    title: '缺少 R 包',
    /*
     * ★ 这句是给**用户**看的，不要写 npm 命令。
     *   最常见的真实原因是「设置里指定了自定义 R 路径，而那份 R 没装这些包」——
     *   内置 R 是随包分发的，一定齐全。用户需要知道的是「去哪改」，不是构建命令。
     */
    suggestion:
      '先到「设置 / 诊断」点「重新检测」（装完包必须点它，重启软件不会重新探测）；' +
      '若仍缺失，多半是当前使用的 R 缺包 —— 软件内置的 R 已包含全部依赖，' +
      '在设置里清空「自定义 R 路径」即可改用它。',
    presentation: 'banner'
  },
  E_RT_NETWORK: {
    title: '参考数据下载失败',
    /*
     * 自动注释要用参考集（celldex 几百 MB，首次联网下载）。
     * 离线/网络受限时 R 抛的是 curl 那一长串，用户看不出是网络问题 ——
     * 这里必须直说「需要联网」并给替代方案（导入自有参考 rds）。
     */
    suggestion:
      '该步骤首次运行需要联网下载参考数据（之后会缓存复用）。' +
      '若本机不能联网，请在能联网的机器上下载后，用「导入自己的参考 .rds」这条路。',
    presentation: 'banner'
  },
  E_RT_FONT_MISSING: {
    title: '中文字体缺失',
    suggestion: '运行「环境诊断」补装内置中文字体，否则图表中的中文可能显示为方框。',
    presentation: 'banner'
  },
  /**
   * R 进程"正常"退出 1、但根因在**环境加载**（不是业务报错，也不是缺包）。
   * 典型形态：Windows 上 LC_CTYPE=C 时 `source(..., encoding="UTF-8")` 只发一条
   * warning 就半途返回，脚本随后死在 `could not find function "deg_main"`。
   * 这条错误码的意义是把用户从「R 脚本执行失败」这种无信息文案，导向
   * 「检查安装完整性 / 运行诊断」这个可操作的动作。
   */
  E_RT_ENV_BROKEN: {
    title: 'R 环境加载失败',
    suggestion:
      '请检查安装完整性：点击右下角「运行环境诊断」查看缺哪些组件；若刚升级或搬动过 R，请重新执行 npm run assemble:r。',
    presentation: 'banner'
  },
  E_DATA_NOT_INTEGER: {
    title: 'DESeq2 需要整数 counts',
    suggestion: '检测到表达值含小数或负数，请改用 limma + voom 分析。',
    presentation: 'issue'
  },
  E_DATA_SAMPLE_MISMATCH: {
    title: '样本名不匹配',
    suggestion: '回到导入向导，用「自动取交集」对齐矩阵列名与分组表样本名。',
    presentation: 'issue'
  },
  E_DATA_ENCODING: {
    title: '文件编码无法识别',
    suggestion: '请在 Excel 中将文件另存为 UTF-8 编码的 CSV 后重试。',
    presentation: 'issue'
  },
  E_DATA_GROUP_TOO_FEW: {
    title: '分组数量不足',
    suggestion: '差异分析至少需要 2 个分组，请检查分组列是否选对。',
    presentation: 'issue'
  },
  E_DATA_GROUP_TOO_SMALL: {
    title: '组内样本数不足',
    suggestion: '每组至少需要 2 个样本才能估计组内方差，建议每组 ≥ 3。',
    presentation: 'issue'
  },
  E_DATA_DUP_GENE: {
    title: '存在重复基因名',
    suggestion: '请选择重复基因的聚合方式（均值 / 求和 / 最大 / 第一条）。',
    presentation: 'issue'
  },
  E_DATA_DUP_SAMPLE: {
    title: '存在重复样本名',
    suggestion: '请检查表头，确保每个样本列名唯一。',
    presentation: 'issue'
  },
  E_DATA_EMPTY: {
    title: '未识别到有效数据',
    suggestion: '请确认第一列为基因 ID、其后各列为样本。',
    presentation: 'issue'
  },
  E_DATA_NA_RATIO: {
    title: '缺失值比例过高',
    suggestion: '建议过滤缺失比例过高的基因，或补齐原始数据。',
    presentation: 'issue'
  },
  E_DATA_NON_NUMERIC: {
    title: '存在非数值单元格',
    suggestion: '非数值单元格已按缺失处理，建议确认原始数据。',
    presentation: 'issue'
  },
  E_DATA_ALL_ZERO: {
    title: '存在全零基因',
    suggestion: '这些基因在所有样本中表达量都为 0，已自动过滤。',
    presentation: 'issue'
  },
  E_DATA_MEMORY_RISK: {
    title: '矩阵规模可能导致内存不足',
    suggestion: '① 开启低表达过滤 ② 减少基因数 ③ 改用 limma + voom（比 DESeq2 省内存）。',
    presentation: 'issue'
  },
  E_RESULT_INVALID: {
    title: '结果文件格式不正确',
    suggestion: '结果文件可能被外部程序修改过，请重新运行分析。',
    presentation: 'banner'
  },
  E_R_MEMORY: {
    title: '内存不足',
    suggestion: '① 关闭其他占用内存的程序 ② 开启低表达过滤 ③ 改用 limma + voom（比 DESeq2 省内存）。',
    presentation: 'banner'
  },
  E_R_GENEID_MAP: {
    title: '基因 ID 无法映射',
    suggestion: '在导入页确认基因 ID 类型（SYMBOL / ENSEMBL / ENTREZ），或先做 ID 转换。',
    presentation: 'banner'
  },
  E_KEGG_NETWORK: {
    title: 'KEGG 需要联网',
    suggestion: 'KEGG 通路数据需联网获取，请连接网络后重试（GO 富集可离线正常使用）。',
    presentation: 'dialog'
  },
  E_R_GENERIC: {
    title: 'R 运行出错',
    suggestion: '展开原始日志查看详情，或「导出日志」后寻求技术支持。',
    presentation: 'banner'
  },
  E_CANCELLED: {
    title: '已取消',
    presentation: 'toast'
  },
  E_IO_PERMISSION: {
    title: '文件写入失败',
    suggestion: '请检查项目目录的读写权限，或换一个保存位置（不要放在 C:\\Program Files）。',
    presentation: 'dialog'
  },
  E_PROJECT_CORRUPT: {
    title: '项目文件损坏',
    suggestion: 'project.json 无法解析。可从备份恢复，或新建项目重新导入数据。',
    presentation: 'dialog'
  },
  E_PROJECT_SCHEMA: {
    title: '项目版本不兼容',
    suggestion: '该项目可能由更高版本的软件创建，请升级软件后再打开。',
    presentation: 'dialog'
  },
  E_VALIDATION: {
    title: '参数校验未通过',
    suggestion: '请检查表单中标红的字段。',
    presentation: 'form'
  },
  E_UNKNOWN: {
    title: '未知错误',
    suggestion: '请「导出日志」后联系技术支持。',
    presentation: 'banner'
  }
}

/** 一条 stderr 匹配规则（数据驱动，§6.3） */
export interface ErrorRule {
  /** 规则优先级（数字小的优先匹配），仅用于文档与调试 */
  priority: number
  code: ErrorCode
  /** 作用于 stderr 全文，不区分大小写；禁止加 g 标志（会带 lastIndex 状态） */
  pattern: RegExp
  title: string
  suggestion?: string
}

/**
 * 10 条规则，按优先级排列。
 * 注意：全部使用 i 标志、不使用 g 标志 —— 复用同一 RegExp 实例时 g 会导致 test() 结果不稳定。
 */
export const ERROR_RULES: readonly ErrorRule[] = [
  {
    priority: 1,
    code: 'E_RT_PKG_MISSING',
    /*
     * ★ 必须同时认**中文**错误：R 在中文 locale 下把
     *   `there is no package called 'X'` 翻成「不存在叫'X'这个名字的程辑包」。
     *   只写英文模式的话，客户机器上那条 harmony 缺 RhpcBLASctl 的报错会落到
     *   E_R_GENERIC 兜底，界面上只显示「失败」——用户不知道该装什么。
     *   （实测：Windows + 中文 locale 的 R 4.3.2）
     */
    pattern:
      /there is no package called ['"]([\w.]+)|不存在叫[‘'"]?[\w.]+[’'"]?这个名字的程辑包|package or namespace load failed|could not find function ["'`]/i,
    title: '缺少 R 包',
    suggestion:
      '先到「设置 / 诊断」点「重新检测」；若仍缺失，检查设置里的「自定义 R 路径」——' +
      '软件内置的 R 已包含全部依赖，清空该路径即可改用它。'
  },
  {
    priority: 2,
    code: 'E_R_MEMORY',
    pattern:
      /cannot allocate vector of size|memoryerror|cannot allocate memory|out of memory|std::bad_alloc/i,
    title: '内存不足',
    suggestion: '① 关闭其他程序 ② 开启低表达过滤 ③ 改用 limma + voom（比 DESeq2 省内存）。'
  },
  {
    priority: 3,
    code: 'E_DATA_NOT_INTEGER',
    pattern:
      /non-integer|counts must be|every gene contains at least one zero|deseq2.*integer|not integer|含有小数/i,
    title: 'DESeq2 需要整数 counts',
    suggestion: '改用 limma + voom 分析，或提供原始整数 counts。'
  },
  {
    priority: 4,
    code: 'E_DATA_SAMPLE_MISMATCH',
    pattern: /sample.*mismatch|all\(.*%in%.*\) is not true|样本.*不匹配/i,
    title: '样本名不匹配',
    suggestion: '回到导入向导，用「自动取交集」对齐样本名。'
  },
  {
    priority: 5,
    code: 'E_R_GENEID_MAP',
    pattern:
      /none of the keys entered are valid keys|no gene can be mapped|annotationdbi.*invalid|invalid keys/i,
    title: '基因 ID 无法映射',
    suggestion: '在导入页确认基因 ID 类型（SYMBOL / ENSEMBL / ENTREZ）。'
  },
  {
    priority: 6,
    code: 'E_KEGG_NETWORK',
    pattern:
      /cannot open url|could not resolve host|kegg.*download|failed to download kegg data|timeout was reached|internet.*unavailable/i,
    title: 'KEGG 需要联网',
    suggestion: '连接网络后重试；GO 富集可离线使用。'
  },
  {
    priority: 7,
    code: 'E_IO_PERMISSION',
    pattern: /permission denied|cannot open the connection|read-only file system|access is denied/i,
    title: '文件写入失败',
    suggestion: '检查项目目录权限，或换保存位置（不要放 C:\\Program Files）。'
  },
  {
    priority: 8,
    code: 'E_RT_FONT_MISSING',
    pattern: /font family not found|invalid font type|font.*not found/i,
    title: '中文字体缺失',
    suggestion: '运行环境诊断以补装内置中文字体。'
  },
  {
    priority: 9,
    code: 'E_DATA_NON_NUMERIC',
    pattern: /non-numeric argument|invalid 'type' \(character\)|无法转换为数值/i,
    title: '存在非数值单元格',
    suggestion: '请确认表达矩阵中除基因 ID 列外均为数值。'
  },
  {
    priority: 10,
    code: 'E_R_GENERIC',
    // 兜底规则：匹配任意非空文本。必须带 i 标志以与其余规则保持一致的 flags 约定
    pattern: /[\s\S]*/i,
    title: 'R 运行出错',
    suggestion: '展开原始日志查看详情，或「导出日志」后寻求技术支持。'
  }
] as const

/**
 * 退出码 → 错误码（§5.5，用于 stderr 无法归类时兜底）。
 *
 * ★ 这里**故意没有 13**：13 表示「数据不满足前置条件」，但对应多个数据类错误码
 *   （E_DATA_SAMPLE_MISMATCH / E_DATA_GROUP_TOO_SMALL / E_DATA_NOT_INTEGER /
 *   E_DATA_EMPTY / E_DATA_DUP_GENE …），单值映射必然猜错。正确来源是 R 主动
 *   发出的 error 协议行（带 code），退出码只用于「协议行丢失」时兜底。
 *   如果哪天要补 13，请先想清楚映射到哪一个——不要随便填一个让表看起来齐整。
 */
export const EXIT_CODE_ERROR: Record<number, ErrorCode> = {
  10: 'E_R_GENERIC',
  11: 'E_VALIDATION',
  12: 'E_RT_PKG_MISSING',
  14: 'E_IO_PERMISSION',
  // 15 = R 侧的网络类失败（目前只有单细胞参考集下载）
  15: 'E_RT_NETWORK'
}

/** 错误码是否属于「运行时/环境」类（这类错误阻断进入分析页，§11.3） */
export function isRuntimeError(code: ErrorCode): boolean {
  return code.startsWith('E_RT_')
}

/**
 * 判断一个任意字符串是否是合法错误码。
 * R 侧发来的 code 是自由字符串，必须先校验再落到 AppError.code（否则 union 类型会被污染）。
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_META, value)
}

/** 错误码是否属于「数据」类（走导入向导 IssueList） */
export function isDataError(code: ErrorCode): boolean {
  return code.startsWith('E_DATA_')
}

/** 截断过长的原始日志（保留头部，因为 R 的报错信息通常在前部） */
export function truncateDetail(text: string, max = 20000): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（日志过长已截断，共 ${text.length} 字符）`
}

/**
 * 用规则表匹配 stderr，返回命中的规则（未命中返回 null）。
 * 规则表最后一条是「全匹配兜底」，所以只要 stderr 非空必定命中；
 * 空 stderr 时返回 null，交由调用方按退出码判断。
 */
export function matchErrorRule(stderr: string): ErrorRule | null {
  const text = stderr ?? ''
  if (!text.trim()) return null
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(text)) return rule
  }
  return null
}

/**
 * 构造 AppError。
 * overrides 可覆盖 title/message/suggestion/detail/locator；
 * 未提供的字段从 ERROR_META 补齐。
 */
export function toAppError(
  code: ErrorCode,
  overrides: Partial<Omit<AppError, 'code'>> = {}
): AppError {
  const meta = ERROR_META[code] ?? ERROR_META.E_UNKNOWN
  const error: AppError = {
    code,
    title: overrides.title ?? meta.title,
    message: overrides.message ?? overrides.title ?? meta.title
  }
  const suggestion = overrides.suggestion ?? meta.suggestion
  if (suggestion) error.suggestion = suggestion
  if (overrides.detail) error.detail = truncateDetail(overrides.detail)
  if (overrides.locator) error.locator = overrides.locator
  return error
}

/** 把任意异常收敛成 AppError（避免把 Error 对象序列化成字符串丢结构） */
export function fromUnknownError(err: unknown, fallback: ErrorCode = 'E_UNKNOWN'): AppError {
  if (err && typeof err === 'object' && 'code' in err && 'title' in err && 'message' in err) {
    return err as AppError
  }
  const message = err instanceof Error ? err.message : String(err)
  return toAppError(fallback, { message, detail: err instanceof Error ? err.stack : undefined })
}

/** 便捷构造成功/失败信封 */
export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(error: AppError): IpcResult<never> {
  return { ok: false, error }
}
