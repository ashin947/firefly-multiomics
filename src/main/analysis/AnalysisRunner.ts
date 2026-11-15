/**
 * 分析调度器（ARCHITECTURE §7.3 / §6.9 / T09）。
 *
 * **核心约束：对具体分析方法零感知。**
 * 本文件里不允许出现 `if (method === 'deseq2')` 这类分支 —— 方法差异全部由
 * `registry.get(id)` 拿到的 module 承担（rScript / buildRunConfig / loadResult）。
 * 这样 v1.1 加 GSEA 时这里一行都不用改，扩展点才真正成立。
 *
 * 一次运行的完整生命周期：
 *   预检（数据/环境/对比）→ 建 runDir → 标记 lastRun=running（断电可恢复）
 *   → spawn R → 转发 progress/log → 成功则 loadResult + 写 meta + 更新 project.json
 *   → 发 analysisDone → 清理 AbortController。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_THRESHOLDS, PROJECT_FILES } from '@shared/constants'
import { toAppError, type AppError, type ErrorCode } from '@shared/errors'
import { IPC } from '@shared/ipc'
import type { IpcEventChannel } from '@shared/ipc'
import { missingPackagesFor } from '@shared/runtimeStatus'
import type {
  AnalysisPreflightResult,
  DEConfig,
  DEStats,
  MethodAvailabilityEntry,
  PreflightItem
} from '@shared/types/analysis'
import type {
  AnalysisDoneEvent,
  AnalysisLogEvent,
  AnalysisProgressEvent,
  AnalysisRunRequest,
  AnalysisRunStartResult,
  AnalysisCancelResult
} from '@shared/types/ipc-contract'
import type { AnalysisSnapshot, ProjectMeta, Species } from '@shared/types/project'
import type { RRuntimeInfo } from '@shared/types/runtime'
import type { Issue } from '@shared/types/dataset'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'
import type { ChildProcessManager } from '../process/ChildProcessManager'
import type { ProjectService } from '../project/ProjectService'
import { ServiceError } from '../project/ProjectService'
import type { ProjectStore } from '../project/ProjectStore'
import type { CleanedMatrix } from '../data/MatrixImporter'
import { createAnalysisId, createRunId } from '../util/id'
import { AnalysisRegistry, RegistryError, type AnalysisModule, type AvailabilityContext, type RunContext } from './registry'
import { ResultLoadError } from './ResultLoader'

export interface AnalysisRunnerDeps {
  runner: RRunner
  paths: PathService
  projectStore: ProjectStore
  projectService: ProjectService
  registry: AnalysisRegistry
  children: ChildProcessManager
  /** 主进程 → 渲染进程事件 */
  emit(channel: IpcEventChannel, payload: unknown): void
  /** 当前 R 运行时信息（预检用）；未提供则跳过环境预检 */
  runtimeInfo?: () => Promise<RRuntimeInfo | null>
  /** 当前内存中的清洗矩阵（TS 层整数性双保险用）；未提供则跳过 */
  getCleanedMatrix?: () => CleanedMatrix | null
  now?: () => number
}

/** 单次运行的内存状态 */
interface ActiveRun {
  runId: string
  controller: AbortController
  startedAt: number
  promise: Promise<void>
}

/**
 * 内部预检发现。
 *
 * 比 IPC 载荷 `PreflightItem` 多带 `code / suggestion / locator` —— 这些是
 * 「抛给界面的结构化错误」需要的字段，但预检清单本身不该把它们显示出来
 * （用户看到 `E_DATA_GROUP_TOO_SMALL` 只会更困惑）。
 */
interface PreflightFinding extends PreflightItem {
  code?: ErrorCode
  suggestion?: string
  /** 问题定位信息（与 Issue.locator 同构，前端可渲染成「第 N 行 · 样本 S」） */
  locator?: Issue['locator']
}

export class AnalysisRunner {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly deps: AnalysisRunnerDeps) {}

  /* ---------------------------------------------------------------- *
   * 对外接口
   * ---------------------------------------------------------------- */

  /**
   * 启动一次分析。**同步返回 runId**，真正的执行在后台进行，
   * 进度/日志/结果通过 `deg:event:*` 事件推送（§7.3 的时序）。
   */
  start(request: AnalysisRunRequest): AnalysisRunStartResult {
    // 预检规则与 `checkPreflight()` 是同一份实现（见 collect 注释）。
    // 这里不传 runtime：R 环境检查在 execute() 里做，那里能给出更精确的错误码，
    // 且本方法是同步的（要给界面立刻返回 runId），无法 await 探测。
    const { findings, module, runContext } = this.collect(request, undefined)
    if (!module || !runContext || findings.some((f) => f.level === 'error')) {
      throw this.firstBlockingError(findings)
    }

    const runId = createRunId()
    const controller = new AbortController()
    const startedAt = this.now()

    // ★ 先落 lastRun=running：如果此时断电/强杀，下次打开项目能识别出「中断」
    this.updateLastRun({ runId, startedAt: new Date(startedAt).toISOString(), status: 'running' })

    const promise = this.execute({
      runId,
      request,
      module,
      ctx: { ...runContext, runId },
      controller,
      startedAt
    }).catch((err: unknown) => {
      // execute 内部已处理错误；这里只兜「连 emit 都失败」的极端情况
      logger.error('analysis', `运行 ${runId} 未捕获异常`, err)
    })

    this.active.set(runId, { runId, controller, startedAt, promise })
    void promise.finally(() => {
      this.active.delete(runId)
    })

    logger.info('analysis', `启动分析 runId=${runId} method=${request.method}`)
    return { runId }
  }

  /** 取消运行：先 abort（RProcessRunner 会 taskkill 整棵进程树），再确认进程状态 */
  async cancel(runId: string): Promise<AnalysisCancelResult> {
    const run = this.active.get(runId)
    if (!run) {
      return { killed: false }
    }
    logger.info('analysis', `用户取消运行 runId=${runId}`)
    run.controller.abort()
    // RProcessRunner 收到 abort 后会调用 children.kill()，这里再兜一次：
    // 若进程还在（例如 abort 事件丢失），确保它被真正杀掉（PRD R-28：不留僵尸进程）
    const killed = this.deps.children.has(runId)
      ? await this.deps.children.kill(runId)
      : true
    return { killed }
  }

  /** 当前正在运行的任务 ID（UI 刷新后可据此恢复「运行中」状态） */
  getActiveRunIds(): string[] {
    return [...this.active.keys()]
  }

  /** 等待某次运行结束（单测与「退出前等待」用） */
  async waitFor(runId: string): Promise<void> {
    await this.active.get(runId)?.promise
  }

  /* ---------------------------------------------------------------- *
   * 预检
   *
   * ★ 只有一份规则：`collect()` 是唯一实现，两个调用方共用
   *   ① `checkPreflight()` —— IPC `deg:analysis:preflight`，把结论交给界面渲染；
   *   ② `start()`           —— 起 R 之前用它拦一次，抛结构化 AppError。
   *   如果前端另写一份（历史实现就是这样），两处迟早漂移，用户会看到
   *   「按钮亮着但点了报错」——比直接禁用更难解释。
   * ---------------------------------------------------------------- */

  /**
   * 预检（只读，不起 R 进程）。
   * 会自己取当前 R 运行时信息，因此是 async；界面侧请加防抖再调用。
   */
  async checkPreflight(request: AnalysisRunRequest): Promise<AnalysisPreflightResult> {
    const runtime = (await this.deps.runtimeInfo?.()) ?? null
    const { findings, methods, module, runContext } = this.collect(request, runtime)
    const canRun = Boolean(module) && Boolean(runContext) && findings.every((f) => f.level !== 'error')
    return {
      canRun,
      method: request.method,
      // 内部错误码/suggestion 不外泄给渲染进程（它们只用于 start() 抛 ServiceError）
      items: findings.map(({ id, label, level, detail }) => ({ id, label, level, detail })),
      methods
    }
  }

  /**
   * 收集全部预检结论。
   *
   * @param runtime `undefined` 表示「不检查 R 环境」（`start()` 的同步路径：
   *                真正的 R 检查在 execute() 里做，且那里能给出更精确的错误码）；
   *                传 `null` 表示「已检查但没有探测到 R」。
   */
  private collect(
    request: AnalysisRunRequest,
    runtime: RRuntimeInfo | null | undefined
  ): {
    findings: PreflightFinding[]
    methods: MethodAvailabilityEntry[]
    module: AnalysisModule | null
    runContext: Omit<RunContext, 'runId'> | null
  } {
    const findings: PreflightFinding[] = []
    const meta = this.deps.projectStore.get()
    const root = this.deps.projectStore.getRoot()
    const ctx = this.availabilityContext(meta, runtime)
    const methods = this.methodsAvailability(ctx, runtime)

    // ---- ① 项目 ----
    if (!meta || !root) {
      findings.push({
        id: 'project',
        label: '项目',
        level: 'error',
        detail: '当前没有打开的项目。',
        code: 'E_VALIDATION',
        suggestion: '请先在首页新建或打开一个项目。'
      })
      return { findings, methods, module: null, runContext: null }
    }

    // ---- ② 数据集与矩阵文件 ----
    const dataset = meta.dataset
    if (!dataset) {
      findings.push({
        id: 'dataset',
        label: '表达矩阵',
        level: 'error',
        detail: '当前项目还没有导入表达矩阵。',
        code: 'E_DATA_EMPTY',
        suggestion: '请先在「数据导入」页导入表达矩阵与分组表。'
      })
      return { findings, methods, module: null, runContext: null }
    }

    const matrixPath = path.join(root, dataset.matrixPath)
    if (!fs.existsSync(matrixPath)) {
      findings.push({
        id: 'matrix-file',
        label: '矩阵文件',
        level: 'error',
        detail: `表达矩阵文件不存在：${dataset.matrixPath}`,
        code: 'E_DATA_EMPTY',
        suggestion: '项目可能被移动或文件被删除，请重新导入数据。'
      })
      return { findings, methods, module: null, runContext: null }
    }

    // ---- ③ 数据层的阻断问题（导入阶段的 13 条校验结论）----
    const blocking = dataset.issues.filter((issue) => issue.level === 'error')
    if (blocking.length > 0) {
      findings.push({
        id: 'data-issues',
        label: '数据校验',
        level: 'error',
        detail: `数据存在 ${blocking.length} 个阻断级问题：${blocking[0].message}`,
        code: 'E_VALIDATION',
        suggestion: '请回到数据导入页处理这些问题后重试。',
        ...(blocking[0].locator ? { locator: blocking[0].locator } : {})
      })
    } else {
      findings.push({ id: 'data-issues', label: '数据校验', level: 'ok', detail: '导入阶段的 13 项校验没有阻断级问题。' })
    }

    // ---- ④ 矩阵规模（仅提示，不阻断）----
    const cells = dataset.geneCount * dataset.sampleCount
    findings.push({
      id: 'matrix-scale',
      label: '矩阵规模',
      level: cells > 50_000_000 ? 'warn' : 'ok',
      detail: `${dataset.geneCount.toLocaleString()} 基因 × ${dataset.sampleCount} 样本${
        cells > 50_000_000 ? '（规模较大，内存占用可能超过 4 GB）' : ''
      }`
    })

    // ---- ⑤ 分组 ----
    const groups = dataset.groups ?? {}
    const groupNames = Object.keys(groups)
    const groupSizes: Record<string, number> = {}
    for (const [name, samples] of Object.entries(groups)) groupSizes[name] = samples.length

    if (groupNames.length === 0) {
      findings.push({
        id: 'groups',
        label: '分组信息',
        level: 'error',
        detail: '当前项目还没有导入分组表。',
        code: 'E_DATA_SAMPLE_MISMATCH',
        suggestion: '请先在「数据导入」页导入分组表（sample / group 两列）。'
      })
    } else if (groupNames.length < 2) {
      findings.push({
        id: 'groups',
        label: '分组数量',
        level: 'error',
        detail: `只有 ${groupNames.length} 个分组（${groupNames.join('、')}），至少需要 2 个。`,
        code: 'E_VALIDATION',
        suggestion: '差异分析需要实验组与对照组，请在分组表中补充。'
      })
    } else {
      const small = groupNames.filter((name) => groupSizes[name] < 2)
      findings.push({
        id: 'groups',
        label: '分组数量',
        level: small.length > 0 ? 'error' : 'ok',
        detail:
          small.length > 0
            ? `分组 ${small.map((n) => `${n}(${groupSizes[n]})`).join('、')} 的样本数不足 2 例，无法估计组内方差。`
            : `${groupNames.length} 个分组：${groupNames.map((n) => `${n}(${groupSizes[n]})`).join('、')}`,
        ...(small.length > 0
          ? {
              code: 'E_DATA_GROUP_TOO_SMALL' as ErrorCode,
              suggestion: '每组至少需要 2 个样本；样本不足的分组请合并或补充数据。'
            }
          : {})
      })
    }

    // ---- ⑥ 样本匹配（矩阵列 ↔ 分组表）----
    const sampleCount = dataset.samples.length
    const groupedCount = Object.values(groups).flat().length
    if (sampleCount === 0) {
      findings.push({
        id: 'samples',
        label: '样本匹配',
        level: 'error',
        detail: '矩阵中没有样本列。',
        code: 'E_DATA_SAMPLE_MISMATCH',
        suggestion: '请确认表达矩阵首列为基因 ID，其余列为样本。'
      })
    } else if (groupedCount !== sampleCount) {
      findings.push({
        id: 'samples',
        label: '样本匹配',
        level: 'error',
        detail: `矩阵 ${sampleCount} 个样本，分组表覆盖 ${groupedCount} 个，两者必须一致。`,
        code: 'E_DATA_SAMPLE_MISMATCH',
        suggestion: '请回到导入向导使用「自动取交集」对齐样本后重试。'
      })
    } else {
      findings.push({ id: 'samples', label: '样本匹配', level: 'ok', detail: `${sampleCount} 个样本全部有分组` })
    }

    // ---- ⑦ 对比组 ----
    const contrast = request.config.contrast
    if (!contrast?.numerator || !contrast?.denominator) {
      findings.push({
        id: 'contrast',
        label: '对比组',
        level: 'error',
        detail: '请选择实验组与对照组。',
        code: 'E_VALIDATION',
        suggestion: '在「对比组」里指定哪一组作为实验组、哪一组作为基线。'
      })
    } else if (contrast.numerator === contrast.denominator) {
      findings.push({
        id: 'contrast',
        label: '对比组',
        level: 'error',
        detail: `实验组与对照组不能是同一组（都是「${contrast.numerator}」）。`,
        code: 'E_VALIDATION',
        suggestion: '请选择两个不同的分组。'
      })
    } else {
      const missingGroup = [contrast.numerator, contrast.denominator].filter((name) => !(name in groups))
      if (missingGroup.length > 0) {
        findings.push({
          id: 'contrast',
          label: '对比组',
          level: 'error',
          detail: `分组表中找不到组「${missingGroup.join('、')}」。`,
          code: 'E_DATA_SAMPLE_MISMATCH',
          suggestion: `可用的组：${groupNames.join('、') || '(无)'}`
        })
      } else {
        findings.push({
          id: 'contrast',
          label: '对比组',
          level: 'ok',
          detail: `${contrast.numerator} vs ${contrast.denominator}（logFC > 0 表示在 ${contrast.numerator} 中上调）`
        })
      }
    }

    // ---- ⑧ 方法可用性 ----
    const module = this.deps.registry.tryGet(request.method)
    if (!module) {
      findings.push({
        id: 'method',
        label: '分析方法',
        level: 'error',
        detail: `未实现的分析方法：${request.method}`,
        code: 'E_VALIDATION',
        suggestion: '请升级软件，或在分析配置页选择其它方法。'
      })
      return { findings, methods, module: null, runContext: null }
    }
    const availability = methods.find((m) => m.id === module.id)
    findings.push({
      id: 'method',
      label: '分析方法',
      level: availability?.enabled === false ? 'error' : 'ok',
      detail:
        availability?.enabled === false
          ? `${module.label} 当前不可用：${availability.reason ?? '条件不满足'}`
          : `${module.label} 可用于当前数据`,
      ...(availability?.enabled === false
        ? { code: 'E_VALIDATION' as ErrorCode, suggestion: availability.reason }
        : {})
    })

    // ---- ⑨ counts 整数性（能力位由模块声明，Runner 不认识方法名）----
    if (module.requiresIntegerCounts) {
      const integerCheck = this.checkIntegerCounts()
      findings.push({
        id: 'counts',
        label: 'counts 整数性',
        level: integerCheck.ok ? 'ok' : 'error',
        /**
         * ★ 一律用 `integerCheck.detail`，**不要**在 ok 分支写死文案。
         *
         * 曾经这里是 `integerCheck.ok ? 'DESeq2 需要整数 counts，已确认数据为整数。' : detail`，
         * 而「没有内存矩阵」时 `checkIntegerCounts()` 返回的是 `ok: true` + 「当前没有可检查
         * 的内存矩阵」。两句话都被丢掉，界面上就变成「已确认数据为整数」——一次检查都没做
         * 却给了肯定结论。会撒谎的校验比没有校验更糟。
         */
        detail: integerCheck.detail,
        ...(integerCheck.ok
          ? {}
          : {
              code: 'E_DATA_NOT_INTEGER' as ErrorCode,
              suggestion: '改用 limma + voom 分析，或提供原始整数 counts。'
            })
      })
    } else {
      findings.push({
        id: 'counts',
        label: 'counts 整数性',
        level: 'ok',
        detail: `${module.label} 接受非整数表达值，无需检查。`
      })
    }

    // ---- ⑩ 全零基因（不阻断）----
    const allZero = dataset.allZeroGeneCount ?? 0
    findings.push({
      id: 'allzero',
      label: '全零基因',
      level: allZero > 0 ? 'warn' : 'ok',
      detail: allZero > 0 ? `${allZero} 个基因全为 0，已自动过滤（不参与分析）。` : '未发现全零基因。'
    })

    // ---- ⑪ R 环境（按**当前方法**实际需要的包判定）----
    if (runtime !== undefined) {
      findings.push(this.runtimeFinding(module, runtime))
    }

    const runContext: Omit<RunContext, 'runId'> = {
      projectRoot: root,
      // 真正的 runDir 在 execute() 里按 runId 生成；这里只用于 buildRunConfig 的占位
      runDir: path.join(root, 'results', 'de', 'pending'),
      species: meta.species as Species,
      dataType: meta.dataType,
      matrixPath,
      groupsPath: path.join(root, PROJECT_FILES.groups),
      sampleColumn: dataset.sampleColumn || 'sample',
      groupColumn: dataset.groupColumn || 'group',
      geneIdType: dataset.geneIdType,
      groups,
      themePath: this.deps.paths.getPlotThemePath(),
      fontPath: this.deps.paths.getRFontPath()
    }

    return { findings, methods, module, runContext }
  }

  /** 组装可用性上下文（无项目时给一组「空数据」，让方法卡能正常渲染成置灰） */
  private availabilityContext(
    meta: ProjectMeta | null,
    runtime: RRuntimeInfo | null | undefined
  ): AvailabilityContext {
    const dataset = meta?.dataset ?? null
    const groups = dataset?.groups ?? {}
    const groupSizes: Record<string, number> = {}
    for (const [name, samples] of Object.entries(groups)) groupSizes[name] = samples.length
    const species = (meta?.species ?? 'human') as Species
    return {
      dataType: meta?.dataType ?? 'counts',
      species,
      groups: Object.keys(groups),
      groupSizes,
      geneCount: dataset?.geneCount ?? 0,
      sampleCount: dataset?.sampleCount ?? 0,
      // runtime === undefined 表示「本轮不检查 R」，按可用处理（旧行为，不新增阻断）
      runtimeOk: runtime === undefined ? true : Boolean(runtime?.rscriptPath),
      speciesLibReady:
        runtime === undefined ? true : (runtime?.speciesLibs as Record<string, boolean> | undefined)?.[species] === true
    }
  }

  /**
   * 全部 DE 方法的可用性。
   *
   * 两层判定：
   *   ① 模块自己的 `availability()`（数据类型 / 分组数等业务规则）；
   *   ② 该模块 `requiredPackages` 里声明、而 R 环境实际缺失的包。
   * 第 ② 层必须按方法分别判 —— 缺 DESeq2 不该拦住 limma。
   *
   * ★ 第 ② 层**读 `runtime.methods`**（`RRuntimeResolver` 算好的），不在这里重算：
   *   首页黄灯的展开详情、诊断页、这里的预检必须是同一个结论，
   *   否则又会出现「首页说 limma 能用、预检说不能用」。
   *   只有 `methods` 缺失时（老缓存 / 未注册模块）才回落到 `missingPackagesFor()`。
   */
  private methodsAvailability(
    ctx: AvailabilityContext,
    runtime: RRuntimeInfo | null | undefined
  ): MethodAvailabilityEntry[] {
    return this.deps.registry.list('de').map((module) => {
      const base = module.availability(ctx)
      const entry: MethodAvailabilityEntry = {
        id: module.id,
        label: module.label,
        enabled: base.enabled,
        ...(base.reason ? { reason: base.reason } : {})
      }
      if (!base.enabled) return entry
      if (runtime && runtime.rscriptPath) {
        const missing = this.missingFor(module, runtime)
        if (missing.length > 0) {
          return { ...entry, enabled: false, reason: `R 环境缺少 ${missing.join('、')}，无法运行 ${module.label}。` }
        }
      }
      return entry
    })
  }

  /** 某个方法在给定运行时下缺的包（优先读运行时已算好的 methods） */
  private missingFor(module: AnalysisModule, runtime: RRuntimeInfo): string[] {
    const fromRuntime = runtime.methods?.find((m) => m.id === module.id)
    if (fromRuntime) return fromRuntime.missingPackages
    return missingPackagesFor(runtime, module.requiredPackages ?? [])
  }

  /** R 环境那一项（只报告当前方法真正需要的包，其余缺失降级为提示） */
  private runtimeFinding(module: AnalysisModule, runtime: RRuntimeInfo | null): PreflightFinding {
    if (!runtime || !runtime.rscriptPath) {
      return {
        id: 'runtime',
        label: 'R 环境',
        level: 'error',
        detail: '未检测到 R，无法运行分析。',
        code: 'E_RT_MISSING',
        suggestion: '请到「设置 / 诊断」指定 R 路径（例如 D:\\R-4.3.2\\bin\\x64\\Rscript.exe）。'
      }
    }
    const needed = module.requiredPackages ?? []
    const missingForMethod = this.missingFor(module, runtime)
    if (missingForMethod.length > 0) {
      return {
        id: 'runtime',
        label: 'R 环境',
        level: 'error',
        detail: `当前方法需要 ${needed.join('、')}，缺少：${missingForMethod.join('、')}`,
        code: 'E_RT_PKG_MISSING',
        suggestion: `在 R 里执行 install.packages(c(${missingForMethod.map((p) => `"${p}"`).join(', ')}))`
      }
    }
    const otherMissing = runtime.missingPackages.filter((pkg) => !needed.includes(pkg))
    return {
      id: 'runtime',
      label: 'R 环境',
      level: 'ok',
      detail:
        otherMissing.length > 0
          ? `R ${runtime.version} 可用；当前方法所需包齐全（另缺 ${otherMissing.join('、')}，不影响本次运行）`
          : `R ${runtime.version} 可用，所需包齐全`
    }
  }

  /** 把预检发现转成可抛出的 ServiceError（取第一条 error） */
  private firstBlockingError(findings: PreflightFinding[]): ServiceError {
    const blocking = findings.find((f) => f.level === 'error')
    if (!blocking) {
      return new ServiceError(toAppError('E_VALIDATION', { message: '预检未通过，但未能给出具体原因。' }))
    }
    return new ServiceError(
      toAppError(blocking.code ?? 'E_VALIDATION', {
        message: blocking.detail,
        ...(blocking.suggestion ? { suggestion: blocking.suggestion } : {}),
        ...(blocking.locator ? { locator: blocking.locator } : {})
      })
    )
  }

  /**
   * TS 层整数性检查：避免起一个注定失败的 R 进程（30 s 才报错的体验很差）。
   * 返回结论而不是直接抛，让预检通道能把这一项渲染成清单里的一行。
   *
   * `checked` 与 `ok` 必须分开：`ok` 只回答「能不能跑」，`checked` 回答「到底查没查」。
   * 合成一个布尔值就会出现「没查也算通过」，界面只能把两种情况渲染成同一句话。
   */
  private checkIntegerCounts(): { ok: boolean; checked: boolean; detail: string } {
    const matrix = this.deps.getCleanedMatrix?.()
    if (!matrix) {
      return {
        ok: true,
        checked: false,
        detail: '当前没有可检查的内存矩阵，将由 R 侧在分析时二次校验。'
      }
    }
    const { values } = matrix
    let decimal = 0
    let negative = 0
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      if (v < 0) negative += 1
      else if (Math.abs(v - Math.round(v)) > 1e-8) decimal += 1
    }
    if (decimal === 0 && negative === 0) {
      return { ok: true, checked: true, detail: '已确认数据为非负整数。' }
    }

    const parts: string[] = []
    if (decimal > 0) parts.push(`${decimal} 个非整数值`)
    if (negative > 0) parts.push(`${negative} 个负值`)
    return {
      ok: false,
      checked: true,
      detail: `检测到 ${parts.join('、')}，DESeq2 需要原始整数 counts。建议改用 limma+voom`
    }
  }

  /* ---------------------------------------------------------------- *
   * 执行
   * ---------------------------------------------------------------- */

  private async execute(args: {
    runId: string
    request: AnalysisRunRequest
    module: AnalysisModule
    ctx: RunContext
    controller: AbortController
    startedAt: number
  }): Promise<void> {
    const { runId, module, ctx, controller, startedAt, request } = args
    const runDir = path.join(ctx.projectRoot, 'results', 'de', runId)
    const logFile = path.join(ctx.projectRoot, 'logs', `${runId}.log`)
    const config = request.config as DEConfig
    // 本次分析的显著性阈值：R 用它写 de.csv 的 regulation 列，Runner 用它算 DEStats，
    // 快照也记这一对。三处必须是同一个值 —— 否则「CSV 数出来的数」和「统计卡」会分叉。
    const thresholds = config.thresholds ?? { ...DEFAULT_THRESHOLDS }

    const emitProgress = (stage: string, pct: number, msg?: string): void => {
      const payload: AnalysisProgressEvent = { runId, stage: stage as never, pct }
      if (msg) payload.msg = msg
      this.deps.emit(IPC.event.analysisProgress, payload)
    }

    try {
      fs.mkdirSync(runDir, { recursive: true })
      fs.mkdirSync(path.dirname(logFile), { recursive: true })

      // 运行前的环境预检 —— 失败直接给结构化错误，不起进程。
      //
      // ★ 这里必须按**所选方法的 requiredPackages** 判断，而不是按全局清单
      //   （`RRuntimeInfo.ok`）。原因：全局清单里既有只被 deseq2 用的 DESeq2，
      //   也有只被富集分析用的 clusterProfiler/DOSE/enrichplot。按全局判的后果是
      //   「机器上只缺 DESeq2，limma-voom 也点不动」，而且**预检是全绿的**
      //   （`collect()` 里 runtimeOk 只看 rscriptPath 是否存在）—— 于是用户看到的
      //   是「清单说能跑、一点就报 E_RT_PKG_MISSING」，正是预检要避免的那种不一致。
      //   全局清单继续用于首页三盏灯与诊断页。
      const info = await this.deps.runtimeInfo?.()
      if (info) {
        if (!info.rscriptPath) {
          throw new ServiceError(
            toAppError('E_RT_MISSING', {
              message: '未检测到可用的 R 运行环境。',
              detail: info.warnings.join('\n')
            })
          )
        }
        const missingForMethod = this.missingFor(module, info)
        if (missingForMethod.length > 0) {
          throw new ServiceError(
            toAppError('E_RT_PKG_MISSING', {
              message: `R 环境缺少「${module.label}」所需的包：${missingForMethod.join('、')}`,
              suggestion: '请点击右下角「运行环境诊断」查看包的搜索路径，或在 R 里安装缺失的包。',
              detail: info.warnings.join('\n')
            })
          )
        }
      }

      emitProgress('read', 1, '准备运行')

      const result = await this.deps.runner.run({
        runId,
        scriptRelPath: module.rScript,
        // 让 runner 按「本方法所需的包」判门禁，而不是全局清单
        ...(module.requiredPackages ? { requiredPackages: module.requiredPackages } : {}),
        config: module.buildRunConfig(config, { ...ctx, runDir }),
        runDir,
        logFile,
        signal: controller.signal,
        onProgress: (msg) => {
          const payload: AnalysisProgressEvent = { runId, stage: msg.stage, pct: msg.pct }
          if (msg.msg) payload.msg = msg.msg
          this.deps.emit(IPC.event.analysisProgress, payload)
        },
        onLog: (line) => {
          const payload: AnalysisLogEvent = {
            runId,
            ts: line.ts,
            level: line.level,
            line: line.line
          }
          this.deps.emit(IPC.event.analysisLog, payload)
        }
      })

      if (result.cancelled) {
        this.finishCancelled(runId, startedAt)
        return
      }

      if (!result.ok) {
        const error =
          result.error ??
          toAppError('E_R_GENERIC', {
            message: 'R 运行失败，但没有返回可识别的错误信息。',
            detail: result.stderr
          })
        this.finishFailed(runId, startedAt, error)
        return
      }

      // ---- 结果加载（★ 通过 module.loadResult，Runner 不知道结果长什么样）----
      let payload: { rows: unknown[]; stats: DEStats }
      try {
        const summary = (result.summary ?? {}) as Record<string, unknown>
        const filteredOut = typeof summary.filteredOut === 'number' ? summary.filteredOut : 0
        const rows = await module.loadResult(runDir)
        // DE 模块提供 computeStats；其它类别（富集/GSEA）暂不产出 DEStats
        const stats: DEStats =
          module.computeStats?.(rows, thresholds, filteredOut) ?? {
            totalGenesAfterFilter: rows.length,
            upCount: 0,
            downCount: 0,
            nsCount: 0,
            filteredOutCount: filteredOut
          }
        payload = { rows, stats }
      } catch (err) {
        const error =
          err instanceof ResultLoadError
            ? err.appError
            : toAppError('E_RESULT_INVALID', {
                message: '分析结果文件无法解析。',
                detail: err instanceof Error ? err.message : String(err)
              })
        this.finishFailed(runId, startedAt, error)
        return
      }

      // ---- 落 meta.json（可复现：config + summary + 耗时） ----
      const finishedAt = this.now()
      const metaPath = path.join(runDir, 'meta.json')
      this.writeJson(metaPath, {
        runId,
        method: request.method,
        label: this.buildLabel(module, config),
        config,
        summary: result.summary ?? {},
        stats: payload.stats,
        thresholds: { ...thresholds },
        durationMs: result.durationMs,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        usedFallback: result.usedFallback,
        artifacts: result.artifacts.map((a) => ({ kind: a.kind, path: a.path, rows: a.rows }))
      })

      // ---- 更新 project.json ----
      const snapshot: AnalysisSnapshot = {
        id: createAnalysisId(),
        method: request.method,
        label: this.buildLabel(module, config),
        config,
        resultPath: this.toRelative(ctx.projectRoot, path.join(runDir, 'de.csv')),
        stats: payload.stats,
        thresholds: { ...thresholds },
        durationMs: result.durationMs,
        createdAt: new Date(finishedAt).toISOString(),
        rLogPath: this.toRelative(ctx.projectRoot, logFile)
      }

      const current = this.deps.projectStore.require()
      this.deps.projectService.save({
        analyses: [...current.analyses, snapshot],
        activeAnalysisId: snapshot.id,
        status: 'analyzed',
        lastRun: {
          runId,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(finishedAt).toISOString(),
          status: 'success'
        }
      })

      const done: AnalysisDoneEvent = {
        runId,
        status: 'success',
        result: { analysisId: snapshot.id, stats: payload.stats, rowCount: payload.rows.length }
      }
      this.deps.emit(IPC.event.analysisDone, done)
      emitProgress('write', 100, '完成')
      logger.info(
        'analysis',
        `分析完成 runId=${runId} method=${request.method} 行数=${payload.rows.length} 耗时=${result.durationMs}ms`
      )
    } catch (err) {
      const error = this.toAppError(err)
      this.finishFailed(runId, startedAt, error)
    }
  }

  private finishCancelled(runId: string, startedAt: number): void {
    logger.info('analysis', `运行已取消 runId=${runId}`)
    this.updateLastRun({
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'cancelled'
    })
    const done: AnalysisDoneEvent = { runId, status: 'cancelled' }
    this.deps.emit(IPC.event.analysisDone, done)
  }

  private finishFailed(runId: string, startedAt: number, error: AppError): void {
    logger.error('analysis', `运行失败 runId=${runId} code=${error.code} ${error.message}`)
    this.updateLastRun({
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'failed'
    })
    const done: AnalysisDoneEvent = { runId, status: 'failed', error }
    this.deps.emit(IPC.event.analysisDone, done)
  }

  /* ---------------------------------------------------------------- *
   * 工具
   * ---------------------------------------------------------------- */

  /** 更新 project.json 的 lastRun（失败不阻断主流程：运行结果比元数据更重要） */
  private updateLastRun(lastRun: NonNullable<ProjectMeta['lastRun']>): void {
    try {
      if (!this.deps.projectStore.has()) return
      this.deps.projectService.save({ lastRun })
    } catch (err) {
      logger.warn('analysis', `更新 lastRun 失败（忽略）: ${String(err)}`)
    }
  }

  private buildLabel(module: AnalysisModule, config: DEConfig): string {
    const num = config.contrast?.numerator ?? '?'
    const den = config.contrast?.denominator ?? '?'
    return `${module.label} · ${num} vs ${den}`
  }

  private toRelative(projectRoot: string, abs: string): string {
    return path.relative(projectRoot, abs).split(path.sep).join('/')
  }

  private writeJson(file: string, data: unknown): void {
    try {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      logger.warn('analysis', `写入 ${path.basename(file)} 失败（忽略）: ${String(err)}`)
    }
  }

  private toAppError(err: unknown): AppError {
    if (err instanceof ServiceError) return err.appError
    if (err instanceof RegistryError) return err.appError
    if (err instanceof ResultLoadError) return err.appError
    if (err && typeof err === 'object' && 'appError' in err) {
      const candidate = (err as { appError?: unknown }).appError
      if (candidate && typeof candidate === 'object' && 'code' in candidate) {
        return candidate as AppError
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return toAppError('E_R_GENERIC', {
      message,
      detail: err instanceof Error ? err.stack : undefined
    })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
}

/** 便于测试：把 Issue 列表里的阻断项挑出来 */
export function blockingIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.level === 'error')
}
