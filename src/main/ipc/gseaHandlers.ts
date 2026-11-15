/**
 * GSEA IPC handler。
 *
 * 两条通道：
 *  - run        ：同步跑一次 GSEA，返回结果表 + 两张图（10 分钟超时）
 *  - exportPlot ：把已经画好的图复制到用户选择的位置
 *
 * 和 enrichHandlers 一样是「同步等待」：一次 GSEA 在几千基因 × 几十个基因集上
 * 通常 3~10 秒，做成异步要引入整套进度/取消机制，收益不抵复杂度。
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { GseaRunRequest } from '@shared/types/gsea'
import { GseaService } from '../enrich/GseaService'
import { defineHandler, type AppContext } from './registerHandlers'

const runSchema = z.object({
  degPath: z.string().min(1),
  geneColumn: z.string().optional(),
  logfcColumn: z.string().optional(),
  pColumn: z.string().optional(),
  // 允许 1 = 不过滤（GSEA 标准做法），也允许用户收紧到 0.05
  pvalueCutoff: z.number().gt(0).max(1),
  source: z.enum(['human', 'mouse', 'custom']),
  collection: z.enum(['hallmark', 'kegg', 'reactome']),
  gmtPath: z.string().optional(),
  topN: z.number().int().min(1).max(50),
  pathways: z.array(z.string().min(1)).max(200).default([]),
  minSize: z.number().int().min(2).max(10_000),
  maxSize: z.number().int().min(3).max(50_000),
  nperm: z.number().int().min(100).max(100_000),
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(20).optional()
})

const exportPlotSchema = z.object({
  gseaId: z.string().min(1),
  which: z.enum(['top', 'detail']),
  outPath: z.string().min(1),
  // 省略按 png：老调用方不用改
  format: z.enum(['png', 'pdf']).optional()
})

const exportTableSchema = z.object({
  gseaId: z.string().min(1),
  outPath: z.string().min(1),
  format: z.enum(['csv', 'xlsx'])
})

export function registerGseaHandlers(ctx: AppContext): void {
  const serviceOf = (app: AppContext): GseaService =>
    new GseaService({
      runner: app.runner,
      projectStore: app.projectStore
    })

  defineHandler(ctx, IPC.gsea.run, runSchema, (req) => serviceOf(ctx).run(req as GseaRunRequest))

  defineHandler(ctx, IPC.gsea.exportPlot, exportPlotSchema, (req) => serviceOf(ctx).exportPlot(req))

  defineHandler(ctx, IPC.gsea.exportTable, exportTableSchema, (req) =>
    serviceOf(ctx).exportTable(req)
  )
}
