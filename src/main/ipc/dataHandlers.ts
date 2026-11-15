/**
 * 数据层 IPC handler（ARCHITECTURE §9 T07/T08）。
 *
 * 职责边界：**只做「校验入参 → 调服务 → 落 project.json」**，
 * 解析/清洗/校验逻辑全在 MatrixImporter / GroupImporter / DataValidator 里。
 * 这样单测可以直接调服务类，不必起 Electron。
 */
import path from 'node:path'
import { z } from 'zod'
import { PROJECT_FILES } from '@shared/constants'
import { toAppError } from '@shared/errors'
import { IPC } from '@shared/ipc'
import type { DatasetSummary, Issue } from '@shared/types/dataset'
import type { AnalysisMethodId, DataType } from '@shared/types/project'
import { DataValidator, hasBlockingIssue } from '../data/DataValidator'
import { DETableReader } from '../data/DETableReader'
import { ServiceError } from '../project/ProjectService'
import { defineHandler, type AppContext } from './registerHandlers'

/* ------------------------------------------------------------------ *
 * 入参 schema
 * ------------------------------------------------------------------ */

const duplicateStrategySchema = z.enum(['mean', 'sum', 'max', 'first'])

const matrixImportSchema = z.object({
  filePath: z.string().min(1),
  dataType: z.enum(['counts', 'normalized']),
  species: z.enum(['human', 'mouse']),
  geneIdColumn: z.string().min(1).optional(),
  duplicateStrategy: duplicateStrategySchema.optional()
})

const groupImportSchema = z.object({
  filePath: z.string().min(1),
  sampleColumn: z.string().min(1).optional(),
  groupColumn: z.string().min(1).optional()
})

const validateSchema = z
  .object({
    overrides: z
      .object({
        dataType: z.enum(['counts', 'normalized']).optional(),
        /** 用户准备使用的方法：决定 counts 整数性是 error 还是 info */
        method: z
          .enum(['limma-voom', 'limma-lm', 'deseq2', 'edger', 'ora-go', 'ora-kegg', 'gsea-go', 'gsea-kegg'])
          .optional()
      })
      .optional()
  })
  .optional()

const setGeneIdColumnSchema = z.object({ column: z.string().min(1) })
const aggregateDuplicatesSchema = z.object({ strategy: duplicateStrategySchema })

/* 外部差异表：探列 / 按映射解析（只读文件） */
const inspectDETableSchema = z.object({ filePath: z.string().min(1) })

const detRoleSchema = z.enum([
  'ignore',
  'geneId',
  'geneName',
  'logFC',
  'pValue',
  'adjPValue',
  'aveExpr',
  't'
])

const importDETableSchema = z.object({
  filePath: z.string().min(1),
  mapping: z.record(z.string(), detRoleSchema)
})
const resolveGeneIdsSchema = z.object({
  target: z.enum(['SYMBOL', 'ENSEMBL', 'ENTREZ', 'UNKNOWN'])
})

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export function registerDataHandlers(ctx: AppContext): void {
  defineHandler(ctx, IPC.data.importMatrix, matrixImportSchema, (req, app) => {
    const root = requireProjectRoot(app)
    const result = app.matrixImporter.importMatrix({ ...req, projectRoot: root })
    // dataType 立刻落盘：后续 validate / 分析预检都以 project.json 为准
    app.projectService.save({ dataType: req.dataType as DataType })
    return result
  })

  defineHandler(ctx, IPC.data.importGroups, groupImportSchema, (req, app) => {
    const root = requireProjectRoot(app)
    const result = app.groupImporter.importGroups(req)
    // 落 data/groups.csv：R 脚本与「重开项目后校验」都以它真源
    app.groupImporter.writeNormalized(result.groups, root)
    return result
  })

  defineHandler(ctx, IPC.data.validate, validateSchema, (req, app) => {
    const root = requireProjectRoot(app)
    // 重启后内存矩阵是空的，先只读恢复一次（详见 ensureMatrix 的注释）
    ensureMatrix(app)
    const meta = app.projectStore.require()
    const matrix = app.matrixImporter.getCleaned()
    const base = app.matrixImporter.getLastSummary()
    if (!matrix || !base) {
      throw new ServiceError(
        toAppError('E_DATA_EMPTY', {
          message: '尚未导入表达矩阵，无法校验。',
          suggestion: '请先在导入向导中选择表达矩阵文件。'
        })
      )
    }

    const groups = app.groupImporter.readNormalized(root)
    const dataType = (req?.overrides?.dataType ?? meta.dataType) as DataType
    const method = req?.overrides?.method as AnalysisMethodId | undefined
    const source = app.matrixImporter.getSourceInfo()

    const issues: Issue[] = app.dataValidator.validate({
      matrix,
      groups,
      groupColumn: base.groupColumn,
      dataType,
      ...(method ? { method } : {}),
      ...(source ? { source } : {})
    })

    // 分组表自身的解析级问题（重复样本行等）也一并回传
    const summary: DatasetSummary = {
      ...base,
      groups: groups ?? {},
      naRatio: matrix.naRatio,
      allZeroGeneCount: matrix.allZeroGeneCount,
      issues,
      hasBlockingIssue: hasBlockingIssue(issues)
    }

    app.projectService.save({
      dataset: summary,
      dataType,
      status: meta.status === 'analyzed' ? 'imported' : meta.status
    })

    return { issues, summary }
  })

  defineHandler(ctx, IPC.data.setGeneIdColumn, setGeneIdColumnSchema, (req, app) => {
    requireProjectRoot(app)
    ensureMatrix(app)
    return app.matrixImporter.setGeneIdColumn(req.column)
  })

  defineHandler(ctx, IPC.data.aggregateDuplicates, aggregateDuplicatesSchema, (req, app) => {
    requireProjectRoot(app)
    ensureMatrix(app)
    return app.matrixImporter.aggregateDuplicates(req.strategy)
  })

  defineHandler(ctx, IPC.data.resolveGeneIds, resolveGeneIdsSchema, async (req, app) => {
    const root = requireProjectRoot(app)
    ensureMatrix(app)
    const meta = app.projectStore.require()
    const matrix = app.matrixImporter.getCleaned()
    if (!matrix) {
      throw new ServiceError(
        toAppError('E_DATA_EMPTY', {
          message: '尚未导入表达矩阵，无法做基因 ID 转换。'
        })
      )
    }
    return app.geneIdResolver.resolveGeneIds({
      species: meta.species,
      target: req.target,
      ids: matrix.geneIds,
      projectRoot: root
    })
  })

  /* ---- 外部差异表（旁路数据源）------------------------------------------
   *
   * ★ 这两个 handler **刻意不调用 requireProjectRoot**：
   *   "我手上有一张表，只想画个火山图"是完全合理的场景，用户可能连项目都没建。
   *   它们只读用户选的文件，不碰项目目录 —— 这也是「不影响上游分析数据」的实现保证。
   */
  defineHandler(ctx, IPC.data.inspectDETable, inspectDETableSchema, (req) =>
    new DETableReader().inspect(req.filePath)
  )

  defineHandler(ctx, IPC.data.importDETable, importDETableSchema, (req) =>
    new DETableReader().importRows(req)
  )
}

/** 取当前项目根；没有打开项目时给出可读错误 */
export function requireProjectRoot(app: AppContext): string {
  const root = app.projectStore.getRoot()
  if (!root) {
    throw new ServiceError(
      toAppError('E_VALIDATION', {
        message: '当前没有打开的项目。',
        suggestion: '请先在首页新建或打开一个项目。'
      })
    )
  }
  return root
}

/**
 * `ensureMatrix` 只需要这两样东西。
 *
 * 用 `Pick` 而不是整个 `AppContext`：分析层的矩阵注入点（`registerHandlers` 里构造
 * `AnalysisRunner` 的那一行）拿不到 AppContext —— 它本身就是被塞进 AppContext 的对象。
 * 结构类型让两边都能调同一个函数，而不是各写一份「取根目录 → 找 clean.csv」的逻辑
 * （那样两份实现迟早会分叉）。
 */
export type MatrixDeps = Pick<AppContext, 'matrixImporter' | 'projectStore'>

/**
 * 懒恢复内存矩阵（重启 / 重新打开项目后的第一次「需要矩阵」的操作）。
 *
 * 为什么需要它：`MatrixImporter` 是纯内存态（只持有本进程内导入过的矩阵），而
 * `project.json` 与 `data/expression.clean.csv` 是持久的。于是「重启后自动恢复上次
 * 项目」只把 meta / dataset / expression 放回了渲染层，主进程一调 `validate()` 就报
 * `E_DATA_EMPTY：尚未导入表达矩阵`——用户看到的是「数据没了」，其实是没读回来。
 *
 * 为什么放在 handler 层、而不是启动时自动跑：
 *  1. 启动路径上解析矩阵会把冷启动成本压到首页（2 万基因要一两秒），而首页根本不需要矩阵；
 *  2. 只有真正需要矩阵的 handler 才值得付这个成本，`importMatrix` / `importGroups` 不需要；
 *  3. 放进 `importMatrix` 更不行：那会把「用户新选的文件」和「项目里的旧 clean.csv」混在
 *     一起，用户选错文件时看到的是上一次的数据。
 *
 * 只做一件事：内存里没有矩阵、而项目里有一份，就**只读**恢复它。
 * 任何失败都静默跳过（返回 void）——恢复是优化不是前置条件，它失败时调用方仍按原来的
 * 错误路径报错，用户看到的文案与修复前一致。
 */
export function ensureMatrix(app: MatrixDeps): void {
  // 内存里已有矩阵：正常导入后的每一次调用都走这一行，开销是一次布尔判断
  if (app.matrixImporter.hasData()) return

  const root = app.projectStore.getRoot()
  // 没有打开的项目：不在这里报错。调用方紧接着就会用自己的文案报 E_VALIDATION，
  // 多报一次只会让用户看到两条不同的提示（见 verify-restore-project ⑤a）。
  if (!root) return

  const persisted = app.projectStore.get()?.dataset ?? null
  // matrixPath 正常是相对项目根的 'data/expression.clean.csv'；用 isAbsolute 兜住
  // 手工改过 project.json 的情况，避免 path.join 把绝对路径又接在根目录后面。
  const relative = persisted?.matrixPath ?? PROJECT_FILES.cleanMatrix
  const matrixPath = path.isAbsolute(relative) ? relative : path.join(root, relative)

  // 文件不存在 / 解析失败由 restoreFromProject 自己记 warn 并返回 null，
  // 这里不接管错误（调用方随后报的 E_DATA_EMPTY 才是用户该看到的那句话）。
  app.matrixImporter.restoreFromProject(root, matrixPath, persisted)
}

/** 供测试与诊断：暴露校验器类型（避免测试重复 new） */
export type { DataValidator }
