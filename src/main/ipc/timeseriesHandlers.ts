/**
 * 时序转录组 IPC handler（单序列 SAM）。
 *
 * 四条通道里三条是「同步等待」：
 *   · inspectMatrix：**不起 R**，只读表头 → 毫秒级
 *   · run          ：SAM（200 次置换），实测 1.9 万基因 × 21 样本约 2 s，给 10 分钟超时
 *   · curves       ：自选基因曲线，约 1 s
 *   · exportTable  ：csv 直拷 / xlsx 生成
 *
 * 与其它模块一致：中间进度走 `analysisProgress` / `analysisLog` 事件，
 * 这里只返回最终结果。
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { TsRunRequest } from '@shared/types/timeseries'
import { TimeSeriesService } from '../timeseries/TimeSeriesService'
import { defineHandler, type AppContext } from './registerHandlers'

const inspectSchema = z.object({
  path: z.string().min(1),
  rule: z.enum(['group-time-rep', 'time-rep', 'genotype-treatment']).optional()
})

const sampleSchema = z.object({
  name: z.string().min(1).max(200),
  // 组可以为空（单序列）；时间点必须由界面补齐（这里允许空，由服务给可读报错）
  group: z.string().max(64),
  time: z.string().max(64),
  rep: z.string().max(32)
})

const runSchema = z.object({
  path: z.string().min(1),
  samples: z.array(sampleSchema).min(2).max(2000),
  log2: z.boolean(),
  // 保留条件：上限挡明显不合理的输入（>100 等于「几乎不保留」）
  minSamplesExpr: z.number().int().min(1).max(100),
  // 置换次数：客户脚本 200；下限 20 是「少于这个 q 值没有意义」
  nperm: z.number().int().min(20).max(10_000),
  fdr: z.number().gt(0).max(1),
  absD: z.number().min(0).max(100)
})

const curvesSchema = z.object({
  tsId: z.string().min(1),
  // 一张图最多 24 个基因：再多 facet 就看不清了（R 侧同样有上限）
  genes: z.array(z.string().min(1).max(128)).min(1).max(24)
})

const moaninSchema = z.object({
  path: z.string().min(1),
  samples: z.array(sampleSchema).min(6).max(2000),
  // 上限在服务里按「时间点数 − 2」再校验一次（这里只挡明显不合理）
  degreesOfFreedom: z.number().int().min(2).max(20),
  varianceCutoff: z.number().gt(0).lt(1),
  contrasts: z.array(z.string().min(1).max(64)).max(20).default([]),
  nClusters: z.number().int().min(2).max(12),
  fdr: z.number().gt(0).max(1),
  lfcCutoff: z.number().min(0).max(50)
})

const moaninCurvesSchema = z.object({
  tsId: z.string().min(1),
  genes: z.array(z.string().min(1).max(128)).min(1).max(24)
})

const exportPlotSchema = z.object({
  tsId: z.string().min(1),
  file: z.string().min(1).max(200),
  format: z.enum(['png', 'pdf']),
  outPath: z.string().min(1)
})

const exportAllPlotsSchema = z.object({
  tsId: z.string().min(1),
  outDir: z.string().min(1),
  files: z.array(z.string().min(1).max(200)).max(500).optional()
})

const exportTableSchema = z.object({
  tsId: z.string().min(1),
  outPath: z.string().min(1),
  which: z.enum(['all', 'sig', 'moanin_all', 'moanin_sig']),
  format: z.enum(['csv', 'xlsx'])
})

export function registerTimeSeriesHandlers(ctx: AppContext): void {
  const serviceOf = (app: AppContext): TimeSeriesService =>
    new TimeSeriesService({
      runner: app.runner,
      projectStore: app.projectStore,
      emit: app.emit
    })

  defineHandler(ctx, IPC.timeseries.inspectMatrix, inspectSchema, (req) =>
    serviceOf(ctx).inspectMatrix(req)
  )

  defineHandler(ctx, IPC.timeseries.run, runSchema, (req) =>
    serviceOf(ctx).run(req as TsRunRequest)
  )

  defineHandler(ctx, IPC.timeseries.curves, curvesSchema, (req) => serviceOf(ctx).curves(req))

  defineHandler(ctx, IPC.timeseries.runMoanin, moaninSchema, (req) =>
    serviceOf(ctx).runMoanin(req)
  )

  defineHandler(ctx, IPC.timeseries.moaninCurves, moaninCurvesSchema, (req) =>
    serviceOf(ctx).moaninCurves(req)
  )

  defineHandler(ctx, IPC.timeseries.exportPlot, exportPlotSchema, (req) =>
    serviceOf(ctx).exportPlot(req)
  )

  defineHandler(ctx, IPC.timeseries.exportAllPlots, exportAllPlotsSchema, (req) =>
    serviceOf(ctx).exportAllPlots(req)
  )

  defineHandler(ctx, IPC.timeseries.exportTable, exportTableSchema, (req) =>
    serviceOf(ctx).exportTable(req)
  )
}
