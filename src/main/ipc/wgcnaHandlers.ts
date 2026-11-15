/**
 * WGCNA IPC handler（6 条通道）。
 *
 * 与 enrich / gsea 一样是「同步等待」：调用方拿到的是最终结果。WGCNA 的第一段
 * 通常几秒到一分钟，第二段可能几十分钟，所以服务层通过 `analysisProgress` /
 * `analysisLog` 事件把中间进度推给界面 —— 但 IPC 本身仍是 request/response，
 * 不需要引入取消/轮询那一套。
 *
 * zod 只做**形状与范围**校验：文件是否存在、列名对不对由服务层和 R 侧判断，
 * 那里能给出更贴近真实原因的提示。
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { WgcnaNetworkRequest, WgcnaPrepareRequest } from '@shared/types/wgcna'
import { WgcnaService } from '../wgcna/WgcnaService'
import { defineHandler, type AppContext } from './registerHandlers'

const prepareSchema = z.object({
  // 路径是否存在交给服务层判；这里只挡类型错误。traitPath 允许空串（= 不做性状分析）
  matrixPath: z.string(),
  traitPath: z.string().optional(),
  varianceFilter: z.enum(['top25', 'top50', 'all']),
  transform: z.enum(['auto', 'log2', 'none']),
  sampleCutHeight: z.number().positive().nullable().optional(),
  minSamples: z.number().int().min(3).max(1000).optional()
})

const networkSchema = z.object({
  wgcnaId: z.string().min(1),
  softPower: z.number().int().min(1).max(30),
  minModuleSize: z.number().int().min(10).max(5000),
  mergeHeight: z.number().min(0).max(1),
  heatmapPalette: z.enum(['blueWhiteRed', 'greenWhiteRed', 'rdbu', 'rdylbu', 'coolwarm', 'puor']),
  profileModule: z.string().optional(),
  tomSampleSize: z.number().int().min(100).max(5000).optional()
})

const exportPlotSchema = z.object({
  wgcnaId: z.string().min(1),
  plotId: z.string().min(1),
  outPath: z.string().min(1),
  // 省略按 png：老调用方（只导 png 的那版界面）不用改
  format: z.enum(['png', 'pdf']).optional()
})

const exportAllSchema = z.object({
  wgcnaId: z.string().min(1),
  dir: z.string().min(1),
  // 省略 = 两种都给（PNG 贴 PPT、PDF 投稿）
  formats: z.array(z.enum(['png', 'pdf'])).min(1).max(2).optional()
})

const exportTableSchema = z.object({
  wgcnaId: z.string().min(1),
  table: z.enum(['powers', 'genes', 'modules', 'traits', 'eigengenes']),
  outPath: z.string().min(1),
  format: z.enum(['csv', 'xlsx'])
})

const loadSchema = z.object({
  wgcnaId: z.string().min(1)
})

const moduleGenesSchema = z.object({
  wgcnaId: z.string().min(1),
  module: z.string().min(1).max(64)
})

const exportModuleGenesSchema = z.object({
  wgcnaId: z.string().min(1),
  // 省略 = 全部模块（长表 module,gene）
  module: z.string().min(1).max(64).optional(),
  outPath: z.string().min(1),
  format: z.enum(['csv', 'xlsx', 'txt'])
})

export function registerWgcnaHandlers(ctx: AppContext): void {
  const serviceOf = (app: AppContext): WgcnaService =>
    new WgcnaService({
      runner: app.runner,
      projectStore: app.projectStore,
      // 进度/日志事件由主进程广播，服务层不直接依赖 BrowserWindow
      emit: app.emit
    })

  defineHandler(ctx, IPC.wgcna.prepare, prepareSchema, (req) =>
    serviceOf(ctx).prepare(req as WgcnaPrepareRequest)
  )

  defineHandler(ctx, IPC.wgcna.network, networkSchema, (req) =>
    serviceOf(ctx).network(req as WgcnaNetworkRequest)
  )

  defineHandler(ctx, IPC.wgcna.exportPlot, exportPlotSchema, (req) =>
    serviceOf(ctx).exportPlot(req)
  )

  defineHandler(ctx, IPC.wgcna.exportAll, exportAllSchema, (req) => serviceOf(ctx).exportAll(req))

  defineHandler(ctx, IPC.wgcna.exportTable, exportTableSchema, (req) =>
    serviceOf(ctx).exportTable(req)
  )

  defineHandler(ctx, IPC.wgcna.loadResult, loadSchema, (req) => serviceOf(ctx).loadResult(req))

  defineHandler(ctx, IPC.wgcna.moduleGenes, moduleGenesSchema, (req) =>
    serviceOf(ctx).moduleGenes(req)
  )

  defineHandler(ctx, IPC.wgcna.exportModuleGenes, exportModuleGenesSchema, (req) =>
    serviceOf(ctx).exportModuleGenes(req)
  )
}
