/**
 * 分析模块注册表（ARCHITECTURE §6.9 / §4.9 / T09）。
 *
 * **这是整个软件最重要的扩展点**：新增一种分析（比如 v1.1 的 GSEA）只需
 *   ① 写一个 R 脚本；② 写一个 module 并 register；③ 在 AnalysisMethodId 里加类型。
 * `AnalysisRunner` / `analysisHandlers` / 前端表单渲染**一行都不用改**。
 *
 * 为了守住这条承诺，本文件只做「声明与查找」，不含任何具体方法的业务分支：
 * 任何 `if (id === 'deseq2')` 之类的代码出现在这里都是设计退化。
 */
import { toAppError, type AppError } from '@shared/errors'
import type { DEStats, ThresholdState } from '@shared/types/analysis'
import type { AnalysisMethodId, DataType, Species } from '@shared/types/project'

/** 注册表相关错误（id 重复、模块不存在） */
export class RegistryError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'RegistryError'
  }
}

/* ------------------------------------------------------------------ *
 * 表单 schema（前端 FormFieldRenderer 通用渲染，六种控件覆盖 v1.0 全部需求）
 * ------------------------------------------------------------------ */

export type FormFieldType = 'select' | 'number' | 'switch' | 'slider' | 'multiSelect' | 'geneSearch'

export interface FieldOption {
  value: string
  label: string
  /** 该选项在什么条件下禁用（浅比较，见 visibleWhen） */
  disabledWhen?: Record<string, unknown>
}

/** 渲染表单时注入的上下文（**由主进程提供**，渲染进程不参与计算） */
export interface SchemaContext {
  /** 分组名列表（顺序即分组表出现顺序） */
  groups: string[]
  species: Species
  dataType: DataType
  geneCount: number
  sampleCount: number
}

export interface FormFieldSchema {
  /** 点路径，如 'filter.minCount' */
  key: string
  label: string
  type: FormFieldType
  /**
   * 选项：静态数组，或依赖运行时上下文的函数（如分组名）。
   * 函数形式在主进程 `schemas(ctx)` 时求值，渲染进程永远只拿到数组。
   */
  options?: FieldOption[] | ((ctx: SchemaContext) => FieldOption[])
  default?: unknown
  min?: number
  max?: number
  step?: number
  helpText?: string
  /** 简单条件渲染（浅比较） */
  visibleWhen?: Record<string, unknown>
}

/** 求值后的表单 schema（options 一定是数组，可直接 JSON 化） */
export interface ResolvedFormFieldSchema extends Omit<FormFieldSchema, 'options'> {
  options?: FieldOption[]
}

/* ------------------------------------------------------------------ *
 * 模块契约
 * ------------------------------------------------------------------ */

export interface ArtifactSpec {
  kind: 'de_table' | 'enrich_table' | 'pca_coords' | 'heatmap_payload' | 'figure' | 'log'
  /** 相对 runDir */
  fileName: string
  format: 'csv' | 'json' | 'png' | 'pdf'
}

/** 可用性判定上下文（PRD R-10：不满足时置灰并给出 reason） */
export interface AvailabilityContext {
  dataType: DataType
  species: Species
  groups: string[]
  groupSizes: Record<string, number>
  geneCount: number
  sampleCount: number
  /** R 运行时是否可用（核心包齐全） */
  runtimeOk: boolean
  /** 当前物种注释库是否就位（仅富集/映射类模块需要） */
  speciesLibReady: boolean
}

/** 运行上下文：模块 buildRunConfig 需要的所有绝对路径与元信息 */
export interface RunContext {
  runId: string
  projectRoot: string
  runDir: string
  species: Species
  dataType: DataType
  /** 清洗后的表达矩阵绝对路径（data/expression.clean.csv） */
  matrixPath: string
  /** 分组表绝对路径（data/groups.csv） */
  groupsPath: string
  sampleColumn: string
  groupColumn: string
  geneIdType: string
  groups: Record<string, string[]>
  themePath: string
  fontPath: string
}

export interface AnalysisModule<TConfig = unknown, TRow = unknown> {
  id: AnalysisMethodId
  label: string
  category: 'de' | 'enrich' | 'gsea'
  availability(ctx: AvailabilityContext): { enabled: boolean; reason?: string }
  formSchema: FormFieldSchema[]
  /** 相对 r/ 根，如 'de/run_deseq2.R' */
  rScript: string
  /**
   * 该方法**实际依赖**的 R 包（声明式）。
   *
   * 为什么必须由模块声明：R 环境里通常只缺一两个包（例如客户机器上装了 limma
   * 但没装 DESeq2）。如果 Runner 用「缺任何一个包就全部方法不可用」，用户选了
   * limma 也会被 DESeq2 拦住 —— 这是最容易被投诉的假阻断。
   * 声明在这里之后，主进程预检可以精确回答「当前这个方法缺哪个包」。
   */
  requiredPackages?: string[]
  /**
   * 该方法的输入必须是「非负整数 counts」（目前 DESeq2 与 edgeR）。
   *
   * 用**声明式能力位**而不是 `if (method === 'deseq2')`：
   * Runner 只问「这个模块需不需要整数」，永远不知道方法名，
   * 新增一个同样要求整数的方法（edgeR 就是这么加进来的）无需改 Runner。
   */
  requiresIntegerCounts?: boolean
  buildRunConfig(config: TConfig, ctx: RunContext): unknown
  outputs: ArtifactSpec[]
  /** 读结果文件（DE 模块转 DEResultRow[]；GSEA 模块转 GseaRow[]，Runner 不关心形状） */
  loadResult(runDir: string): Promise<TRow[]>
  /**
   * 按阈值统计（可选）。
   * DE 类模块提供；富集/GSEA 模块没有「上调/下调」概念，可以省略。
   * Runner 只负责调用，不关心具体算法 —— 这是扩展点的另一半。
   */
  computeStats?(rows: TRow[], thresholds: ThresholdState, filteredOutCount: number): DEStats
}

/** 前端拉取的表单描述 */
export interface ModuleSchema {
  id: AnalysisMethodId
  label: string
  category: 'de' | 'enrich' | 'gsea'
  formSchema: ResolvedFormFieldSchema[]
  availability: { enabled: boolean; reason?: string }
}

export class AnalysisRegistry {
  private readonly modules = new Map<AnalysisMethodId, AnalysisModule>()

  /** 注册模块；id 重复直接抛错（防止两份实现悄悄覆盖） */
  register(module: AnalysisModule): void {
    if (this.modules.has(module.id)) {
      throw new RegistryError(
        toAppError('E_VALIDATION', {
          message: `分析模块 ${module.id} 重复注册。`,
          suggestion: '请检查 registry 的注册顺序，每个方法只能注册一次。'
        })
      )
    }
    this.modules.set(module.id, module)
  }

  /** 取模块；不存在时抛 RegistryError（Runner 会把它转成中文提示） */
  get(id: AnalysisMethodId): AnalysisModule {
    const module = this.modules.get(id)
    if (!module) {
      throw new RegistryError(
        toAppError('E_VALIDATION', {
          message: `未实现的分析方法：${id}`,
          suggestion: '请升级软件，或在分析配置页选择其它方法。'
        })
      )
    }
    return module
  }

  /** 取模块，不存在返回 null（用于「可用方法列表」这类可空查询） */
  tryGet(id: AnalysisMethodId): AnalysisModule | null {
    return this.modules.get(id) ?? null
  }

  has(id: AnalysisMethodId): boolean {
    return this.modules.has(id)
  }

  list(category?: 'de' | 'enrich' | 'gsea'): AnalysisModule[] {
    const all = [...this.modules.values()]
    return category ? all.filter((m) => m.category === category) : all
  }

  /**
   * 下发表单 schema（`deg:analysis:schemas` 的数据来源）。
   * options 里的函数在这里求值 —— 渲染进程拿到的是纯数据。
   */
  schemas(ctx: SchemaContext, availability?: AvailabilityContext): ModuleSchema[] {
    return [...this.modules.values()].map((module) => {
      const schema: ModuleSchema = {
        id: module.id,
        label: module.label,
        category: module.category,
        formSchema: module.formSchema.map((field) => resolveField(field, ctx)),
        availability: availability
          ? module.availability(availability)
          : { enabled: true }
      }
      return schema
    })
  }
}

/** 把函数形式的 options 求值成数组 */
export function resolveField(field: FormFieldSchema, ctx: SchemaContext): ResolvedFormFieldSchema {
  const { options, ...rest } = field
  const resolved: ResolvedFormFieldSchema = { ...rest }
  if (typeof options === 'function') {
    resolved.options = options(ctx)
  } else if (options) {
    resolved.options = options
  }
  return resolved
}

/* ------------------------------------------------------------------ *
 * 单例注册表
 * ------------------------------------------------------------------ */

export const registry = new AnalysisRegistry()

/** 注册 v1.0 的全部差异分析方法（T09 + T10） */
export function registerBuiltinModules(modules: AnalysisModule[]): void {
  for (const module of modules) {
    if (!registry.has(module.id)) registry.register(module)
  }
}
