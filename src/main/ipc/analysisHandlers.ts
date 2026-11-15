/**
 * 分析层 IPC handler（ARCHITECTURE §7.3 / §6.9）。
 *
 * **三个通道与具体方法完全无关**：`method` 字段决定走哪个 module，
 * 新增分析类型（GSEA）不需要动这个文件 —— 这是 §6.9「零改动」承诺的一部分。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import { toAppError } from '@shared/errors'
import { IPC } from '@shared/ipc'
import type { DEConfig, DEResultRow } from '@shared/types/analysis'
import type { LoadedDEResult } from '@shared/types/project'
import { ResultLoadError, ResultLoader } from '../analysis/ResultLoader'
import { ServiceError } from '../project/ProjectService'
import { defineHandler, type AppContext } from './registerHandlers'

/* ------------------------------------------------------------------ *
 * 入参 schema
 * ------------------------------------------------------------------ */

const contrastSchema = z.object({
  groupColumn: z.string().default('group'),
  numerator: z.string().min(1),
  denominator: z.string().min(1)
})

const deConfigSchema = z.object({
  method: z.enum(['limma-voom', 'limma-lm', 'deseq2', 'edger']),
  dataType: z.enum(['counts', 'normalized']),
  contrast: contrastSchema,
  filter: z.object({
    enabled: z.boolean(),
    mode: z.enum(['filterByExpr', 'custom']),
    minCount: z.number().nonnegative().optional(),
    minSamplesPct: z.number().min(0).max(100).optional()
  }),
  fdrMethod: z.enum(['BH', 'BY', 'holm', 'none']),
  outputGeneName: z.boolean(),
  keepAllGenes: z.boolean(),
  /** DESeq2 高级选项（默认关闭） */
  shrinkLfc: z.boolean().optional(),
  /** limma-lm 专用：输入是否已经 log2 转换（缺省按 true 处理） */
  inputIsLog2: z.boolean().optional(),
  /** limma-lm 专用：counts → log2-CPM 的先验计数（缺省 2） */
  priorCount: z.number().optional()
})

const analysisRunSchema = z.object({
  method: z.enum(['limma-voom', 'limma-lm', 'deseq2', 'edger', 'ora-go', 'ora-kegg', 'gsea-go', 'gsea-kegg']),
  config: deConfigSchema
})

const cancelSchema = z.object({ runId: z.string().min(1) })
const loadResultSchema = z.object({ analysisId: z.string().min(1) })

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export function registerAnalysisHandlers(ctx: AppContext): void {
  defineHandler(ctx, IPC.analysis.run, analysisRunSchema, (req, app) => {
    // config.method 与请求的 method 必须一致：否则「用 DESeq2 的参数跑 limma」，
    // 结果会以错误的标签写进 project.json，用户看到的对比名与实际算法不符。
    if (req.config.method !== req.method) {
      throw new ServiceError(
        toAppError('E_VALIDATION', {
          message: `分析参数与所选方法不一致（method=${req.method}，config.method=${req.config.method}）。`,
          suggestion: '请在分析配置页重新选择方法后重试。'
        })
      )
    }
    return app.analysisRunner.start({
      method: req.method,
      config: req.config as DEConfig
    })
  })

  defineHandler(ctx, IPC.analysis.cancel, cancelSchema, async (req, app) => {
    return app.analysisRunner.cancel(req.runId)
  })

  /**
   * 运行前预检（只读）。
   *
   * 前端在参数变化后（300ms 防抖）调它来渲染预检清单与方法卡置灰，
   * 与 `run` 起 R 前的校验共用 `AnalysisRunner.collect()` 这一份规则，
   * 因此不会出现「界面说能跑、点了报错」。
   */
  defineHandler(ctx, IPC.analysis.preflight, analysisRunSchema, async (req, app) => {
    return app.analysisRunner.checkPreflight({
      method: req.method,
      config: req.config as DEConfig
    })
  })

  defineHandler(ctx, IPC.analysis.loadResult, loadResultSchema, (req, app) => {
    const root = app.projectStore.getRoot()
    const meta = app.projectStore.get()
    if (!root || !meta) {
      throw new ServiceError(toAppError('E_VALIDATION', { message: '当前没有打开的项目。' }))
    }

    const snapshot = meta.analyses.find((item) => item.id === req.analysisId) ?? null
    if (!snapshot) {
      throw new ServiceError(
        toAppError('E_RESULT_INVALID', {
          message: `找不到分析记录：${req.analysisId}`,
          suggestion: '该结果可能已被删除，请重新运行分析。'
        })
      )
    }

    const resultFile = path.join(root, snapshot.resultPath)
    if (!fs.existsSync(resultFile)) {
      throw new ServiceError(
        toAppError('E_RESULT_INVALID', {
          message: `结果文件不存在：${snapshot.resultPath}`,
          suggestion: '项目可能被移动过，请重新运行分析。'
        })
      )
    }

    const loader = new ResultLoader()
    let rows: DEResultRow[]
    try {
      rows = loader.load(path.dirname(resultFile), {
        fileName: path.basename(resultFile),
        thresholds: snapshot.thresholds ?? { ...DEFAULT_THRESHOLDS },
        filteredOutCount: snapshot.stats?.filteredOutCount ?? 0
      }).rows
    } catch (err) {
      if (err instanceof ResultLoadError) throw new ServiceError(err.appError)
      throw err
    }

    const loaded: LoadedDEResult = {
      rows,
      stats: snapshot.stats,
      snapshot
    }
    return loaded
  })
}
