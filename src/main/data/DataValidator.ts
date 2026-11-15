/**
 * 数据校验器（ARCHITECTURE §9 T08 / PRD §8.3 全部 13 条规则）。
 *
 * 为什么单独成类而不是塞进 MatrixImporter：
 *  1. 校验规则会随产品迭代反复调整（阈值、文案、级别），而解析逻辑应保持稳定；
 *  2. 规则必须是**纯函数**：给定同一份数据，任何时候都产出同一份 Issue 列表，
 *     这样才能给 13 条规则各写一个夹具测试；
 *  3. 同一份数据在不同分析方法下判定不同（counts 整数性：DESeq2 是 error，
 *     limma 是 info），把「方法」作为入参而不是散落在解析期做分支。
 *
 * 13 条规则（PRD §8.3，KEGG 无网络属于富集运行期，不在此列）：
 *   1 样本名不匹配 / 2 分组列只有 1 个取值 / 3 某组样本数 < 2 / 4 某组样本数 = 2
 *   5 重复基因名 / 6 重复样本名 / 7 非数值单元格 / 8 counts 含小数或负数
 *   9 全零基因 / 10 NA 比例过高 / 11 编码无法识别 / 12 矩阵为空或只有 1 列
 *   13 内存风险
 */
import os from 'node:os'
import { toAppError, type AppError } from '@shared/errors'
import type { Issue, ValidationRuleId } from '@shared/types/dataset'
import type { AnalysisMethodId, DataType } from '@shared/types/project'
import { countDuplicates, findDuplicates, type CleanedMatrix } from './MatrixImporter'

/** 携带结构化错误的校验异常（仅用于「无法继续」的情况，普通问题走 Issue） */
export class DataValidationError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'DataValidationError'
  }
}

/** 导入阶段的源文件信息（用于第 11、12 条规则的复检） */
export interface ImportPreconditions {
  fileSizeBytes: number
  /** 表头列数（含基因 ID 列） */
  headerColumnCount: number
  /** 数据行数 */
  dataRowCount: number
  /** 编码探测结果；'unknown' 表示探测失败 */
  encoding: 'utf-8' | 'gb18030' | 'unknown'
}

export interface ValidationSubject {
  matrix: CleanedMatrix
  /** 分组：{ Tumor: ['S01', ...] }；未导入分组表时为 null */
  groups: Record<string, string[]> | null
  /** 分组表的列名（仅用于文案） */
  groupColumn?: string
  dataType: DataType
  /** 用户准备使用的分析方法（决定第 8 条的级别） */
  method?: AnalysisMethodId
  /** 导入阶段信息；不给则跳过第 11、12 条 */
  source?: ImportPreconditions
  /** 注入可用内存（单测用小值触发第 13 条）；默认 os.totalmem() * 0.6 */
  availableMemoryBytes?: number
}

/**
 * PRD §8.3 的 13 条规则清单（顺序与文档一致）。
 * 单测用它断言「一条都不能少」：任何一条规则被误删，测试立刻失败。
 */
export const VALIDATION_RULES: ValidationRuleId[] = [
  'sample-mismatch',
  'group-too-few',
  'group-too-small',
  'group-small-power',
  'dup-gene',
  'dup-sample',
  'non-numeric',
  'counts-not-integer',
  'all-zero-gene',
  'na-ratio',
  'encoding',
  'empty-matrix',
  'memory-risk'
]

/** NA 比例告警阈值（PRD §8.1：> 20% 警告） */
const NA_RATIO_THRESHOLD = 0.2

/** 内存估算系数：每个数值在 R 里约 8 字节，分析过程通常需要 3 份拷贝 */
const MEMORY_FACTOR = 3

/** 差集最多列多少个样本（PRD §8.3 要求「各最多列 20 个 + 总数」） */
const DIFF_LIST_LIMIT = 20

/** 每组建议的最小样本数 */
const RECOMMENDED_GROUP_SIZE = 3

export class DataValidator {
  /**
   * 执行全部 13 条规则。
   * @returns Issue[]（按规则顺序；UI 自行按 level 排序展示）
   */
  validate(subject: ValidationSubject): Issue[] {
    const issues: Issue[] = []

    // ---- 11 编码无法识别 ----
    if (subject.source && subject.source.encoding === 'unknown') {
      issues.push({
        code: 'E_DATA_ENCODING',
        rule: 'encoding',
        level: 'error',
        message: '文件编码无法识别，请在 Excel 中另存为 UTF-8 CSV 后重试',
        suggestion: 'Excel：文件 → 另存为 → 选择「CSV UTF-8（逗号分隔）」。'
      })
    }

    // ---- 12 矩阵为空 / 只有 1 列 ----
    const source = subject.source
    const emptyMatrix =
      subject.matrix.geneCount === 0 ||
      subject.matrix.sampleCount === 0 ||
      (source ? source.headerColumnCount < 2 || source.dataRowCount === 0 : false)
    if (emptyMatrix) {
      issues.push({
        code: 'E_DATA_EMPTY',
        rule: 'empty-matrix',
        level: 'error',
        message: '未识别到有效数据列，请确认第一列为基因 ID、其后为各样本',
        suggestion: '若文件用分号或制表符分隔，请另存为标准 CSV 后重试。'
      })
    }

    // ---- 6 重复样本名 ----
    const dupSamples = findDuplicates(subject.matrix.samples)
    if (dupSamples.length > 0) {
      issues.push({
        code: 'E_DATA_DUP_SAMPLE',
        rule: 'dup-sample',
        level: 'error',
        message: `列名 ${dupSamples.slice(0, 10).join('、')} 出现 2 次以上，请检查表头`,
        suggestion: '每个样本列名必须唯一（区分大小写）。',
        count: dupSamples.length,
        samples: dupSamples.slice(0, DIFF_LIST_LIMIT)
      })
    }

    // ---- 5 重复基因名 ----
    // 注意：矩阵已按策略聚合过的话 geneIds 里不会再有重复，这条自然不触发。
    const dupGenes = countDuplicates(subject.matrix.geneIds)
    if (dupGenes.length > 0) {
      issues.push({
        code: 'E_DATA_DUP_GENE',
        rule: 'dup-gene',
        level: 'error',
        message: `发现 ${dupGenes.length} 个重复基因名，请选择聚合方式`,
        suggestion: '取均值 / 求和 / 保留最大表达 / 保留第一条。',
        count: dupGenes.length,
        samples: dupGenes.slice(0, DIFF_LIST_LIMIT).map((d) => `${d.name}×${d.count}`)
      })
    }

    // ---- 7 非数值单元格 ----
    if (subject.matrix.nonNumericCount > 0) {
      const first = subject.matrix.nonNumericDetails[0]
      issues.push({
        code: 'E_DATA_NON_NUMERIC',
        rule: 'non-numeric',
        level: 'warning',
        message: first
          ? `第 ${first.row} 行 ${first.column} 列为「${first.raw}」，已按缺失处理（共 ${subject.matrix.nonNumericCount} 处）`
          : `发现 ${subject.matrix.nonNumericCount} 个非数值单元格，已按缺失处理`,
        suggestion: '请确认原始数据；缺失值统一写成 NA。',
        ...(first ? { locator: { row: first.row, column: first.column } } : {}),
        count: subject.matrix.nonNumericCount
      })
    }

    // ---- 8 counts 含小数或负数（级别随方法变化） ----
    issues.push(...this.checkIntegerCounts(subject))

    // ---- 9 全零基因 ----
    if (subject.matrix.allZeroGeneCount > 0) {
      issues.push({
        code: 'E_DATA_ALL_ZERO',
        rule: 'all-zero-gene',
        level: 'warning',
        message: `${subject.matrix.allZeroGeneCount} 个基因在所有样本中为 0，将被自动过滤`,
        suggestion: '这些基因不携带差异信息，过滤不影响结论。',
        count: subject.matrix.allZeroGeneCount
      })
    }

    // ---- 10 NA 比例过高（按基因） ----
    issues.push(...this.checkNaRatio(subject.matrix))

    // ---- 1 样本名不匹配（双向差集） ----
    issues.push(...this.checkSampleMismatch(subject))

    // ---- 2 / 3 / 4 分组相关 ----
    issues.push(...this.checkGroups(subject))

    // ---- 13 内存风险 ----
    issues.push(...this.checkMemory(subject))

    return issues
  }

  /* ---------------------------------------------------------------- *
   * 各条规则
   * ---------------------------------------------------------------- */

  /** 第 8 条：counts 整数性。DESeq2 → error；limma/未指定 → info */
  private checkIntegerCounts(subject: ValidationSubject): Issue[] {
    // 已归一化的数据（log2 表达值）本来就不是整数，这条不适用
    if (subject.dataType !== 'counts') return []

    const { values } = subject.matrix
    let negativeCount = 0
    let decimalCount = 0
    let firstDecimal: number | null = null
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      if (v < 0) negativeCount += 1
      else if (Math.abs(v - Math.round(v)) > 1e-8) {
        decimalCount += 1
        if (firstDecimal === null) firstDecimal = v
      }
    }
    if (negativeCount === 0 && decimalCount === 0) return []

    // ★ 关键：只有用户选 DESeq2 时才升级为 error。
    //   否则芯片/已归一化数据的用户会被一条「含小数」的红色错误莫名拦住。
    const isDeseq2 = subject.method === 'deseq2'
    const level = isDeseq2 ? 'error' : 'info'
    const parts: string[] = []
    if (decimalCount > 0) {
      parts.push(
        `检测到表达值含小数${firstDecimal !== null ? `（如 ${Number(firstDecimal.toFixed(3))}）` : ''}，共 ${decimalCount} 个`
      )
    }
    if (negativeCount > 0) parts.push(`检测到 ${negativeCount} 个负值`)
    const head = parts.join('；')

    const message = isDeseq2
      ? `${head}。DESeq2 需要原始整数 counts，建议改用 limma+voom`
      : `${head}。当前方法（limma）可以接受非整数表达值，无需处理`
    return [
      {
        code: 'E_DATA_NOT_INTEGER',
        rule: 'counts-not-integer',
        level,
        message,
        suggestion: isDeseq2
          ? '改用 limma + voom 分析，或提供原始整数 counts。'
          : '若后续改用 DESeq2，需要先提供整数 counts。',
        count: decimalCount + negativeCount
      }
    ]
  }

  /** 第 10 条：按基因统计 NA 比例，> 20% 警告 */
  private checkNaRatio(matrix: CleanedMatrix): Issue[] {
    const { sampleCount, values, geneIds } = matrix
    if (sampleCount === 0 || geneIds.length === 0) return []

    const offenders: { gene: string; ratio: number }[] = []
    let totalNa = 0
    for (let g = 0; g < geneIds.length; g += 1) {
      let na = 0
      for (let s = 0; s < sampleCount; s += 1) {
        if (!Number.isFinite(values[g * sampleCount + s])) na += 1
      }
      totalNa += na
      const ratio = na / sampleCount
      if (ratio > NA_RATIO_THRESHOLD) offenders.push({ gene: geneIds[g], ratio })
    }

    if (offenders.length === 0) return []

    // 整体 NA 比例也一并给出，方便用户判断是「个别基因脏」还是「整表有问题」
    const overall = totalNa / (geneIds.length * sampleCount)
    const worst = offenders
      .slice(0, 5)
      .map((o) => `${o.gene}（${(o.ratio * 100).toFixed(0)}%）`)
      .join('、')
    return [
      {
        code: 'E_DATA_NA_RATIO',
        rule: 'na-ratio',
        level: 'warning',
        message: `${offenders.length} 个基因缺失比例超过 ${NA_RATIO_THRESHOLD * 100}%：${worst}${
          offenders.length > 5 ? ' 等' : ''
        }；整体缺失率 ${(overall * 100).toFixed(1)}%`,
        suggestion: '建议过滤缺失比例过高的基因，或补齐原始数据。',
        count: offenders.length,
        samples: offenders.slice(0, DIFF_LIST_LIMIT).map((o) => o.gene),
        locator: { gene: offenders[0].gene }
      }
    ]
  }

  /** 第 1 条：样本名双向差集（各最多 20 个 + 总数） */
  private checkSampleMismatch(subject: ValidationSubject): Issue[] {
    const groups = subject.groups
    if (!groups) return []

    const matrixSamples = new Set(subject.matrix.samples)
    const groupSamples = new Set<string>()
    for (const samples of Object.values(groups)) {
      for (const s of samples) groupSamples.add(s)
    }

    const missingInMatrix = [...groupSamples].filter((s) => !matrixSamples.has(s))
    const missingInGroups = [...matrixSamples].filter((s) => !groupSamples.has(s))
    if (missingInMatrix.length === 0 && missingInGroups.length === 0) return []

    const parts: string[] = []
    if (missingInMatrix.length > 0) {
      parts.push(
        `分组表中有 ${missingInMatrix.length} 个样本在矩阵中找不到：${missingInMatrix
          .slice(0, DIFF_LIST_LIMIT)
          .join('、')}${missingInMatrix.length > DIFF_LIST_LIMIT ? ' …' : ''}`
      )
    }
    if (missingInGroups.length > 0) {
      parts.push(
        `矩阵中有 ${missingInGroups.length} 个样本未分组：${missingInGroups
          .slice(0, DIFF_LIST_LIMIT)
          .join('、')}${missingInGroups.length > DIFF_LIST_LIMIT ? ' …' : ''}`
      )
    }

    return [
      {
        code: 'E_DATA_SAMPLE_MISMATCH',
        rule: 'sample-mismatch',
        level: 'error',
        message: parts.join('；'),
        suggestion: '可使用「自动取交集」把两边的样本名对齐后继续。',
        count: missingInMatrix.length + missingInGroups.length,
        samples: [...missingInMatrix.slice(0, DIFF_LIST_LIMIT), ...missingInGroups.slice(0, DIFF_LIST_LIMIT)]
      }
    ]
  }

  /** 第 2、3、4 条：分组数量与组内样本数 */
  private checkGroups(subject: ValidationSubject): Issue[] {
    const groups = subject.groups
    if (!groups) return []

    const groupNames = Object.keys(groups)
    const groupColumn = subject.groupColumn ?? 'group'
    const issues: Issue[] = []

    // 第 2 条：只有 1 个取值（含 0 个）
    if (groupNames.length < 2) {
      const only = groupNames.length === 1 ? `（${groupNames[0]}）` : ''
      issues.push({
        code: 'E_DATA_GROUP_TOO_FEW',
        rule: 'group-too-few',
        level: 'error',
        message: `分组列 \`${groupColumn}\` 只检测到 ${groupNames.length} 个取值${only}，差异分析至少需要 2 组`,
        suggestion: '请检查分组列是否选对了。'
      })
      return issues
    }

    for (const name of groupNames) {
      const size = groups[name].length
      if (size < 2) {
        // 第 3 条：< 2 → error
        issues.push({
          code: 'E_DATA_GROUP_TOO_SMALL',
          rule: 'group-too-small',
          level: 'error',
          message: `组 \`${name}\` 只有 ${size} 个样本，无法估计组内方差`,
          suggestion: '每组至少需要 2 个样本，建议 ≥ 3。',
          locator: { sample: groups[name][0] }
        })
      } else if (size === 2) {
        // 第 4 条：= 2 → warning
        issues.push({
          code: 'E_DATA_GROUP_TOO_SMALL',
          rule: 'group-small-power',
          level: 'warning',
          message: `组 \`${name}\` 只有 2 个样本，统计功效较低，建议每组 ≥ ${RECOMMENDED_GROUP_SIZE}`,
          suggestion: '补充样本或谨慎解读结果。'
        })
      }
    }
    return issues
  }

  /** 第 13 条：内存风险估算（行 × 列 × 8 字节 × 3 份拷贝 vs 可用内存） */
  private checkMemory(subject: ValidationSubject): Issue[] {
    const rows = subject.matrix.geneCount
    const cols = subject.matrix.sampleCount
    if (rows === 0 || cols === 0) return []

    const estimateBytes = rows * cols * 8 * MEMORY_FACTOR
    const availableBytes =
      subject.availableMemoryBytes ?? Math.max(0, os.totalmem() * 0.6)

    if (availableBytes <= 0 || estimateBytes <= availableBytes) return []

    const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    return [
      {
        code: 'E_DATA_MEMORY_RISK',
        rule: 'memory-risk',
        level: 'warning',
        message: `矩阵规模 ${rows.toLocaleString()} × ${cols}，预计占用 ${gb(estimateBytes)} 内存，当前可用 ${gb(
          availableBytes
        )}`,
        suggestion: '① 开启低表达过滤 ② 减少基因数 ③ 改用 limma + voom（比 DESeq2 省内存）。',
        count: rows
      }
    ]
  }
}

/**
 * 校验结果的汇总判断（供 handler 与 UI 复用）。
 * @returns true 表示存在阻断级问题，不能进入分析页
 */
export function hasBlockingIssue(issues: Issue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}

/**
 * 自动取交集（PRD §8.3 的「提供自动取交集」动作）。
 * 返回对齐后的分组表与被丢弃的样本清单，供 UI 二次确认。
 */
export function intersectSamples(
  groups: Record<string, string[]>,
  matrixSamples: string[]
): {
  groups: Record<string, string[]>
  dropped: { fromGroups: string[]; fromMatrix: string[] }
} {
  const matrixSet = new Set(matrixSamples)
  const next: Record<string, string[]> = {}
  const fromGroups: string[] = []

  for (const [name, samples] of Object.entries(groups)) {
    const kept = samples.filter((s) => matrixSet.has(s))
    const removed = samples.filter((s) => !matrixSet.has(s))
    fromGroups.push(...removed)
    if (kept.length > 0) next[name] = kept
  }

  const groupedSet = new Set(Object.values(next).flat())
  const fromMatrix = matrixSamples.filter((s) => !groupedSet.has(s))
  return { groups: next, dropped: { fromGroups, fromMatrix } }
}

/** 把「无法继续」的场景收敛成带 appError 的异常（保持与其它服务一致的风格） */
export function validationFailure(message: string): DataValidationError {
  return new DataValidationError(toAppError('E_VALIDATION', { message }))
}
