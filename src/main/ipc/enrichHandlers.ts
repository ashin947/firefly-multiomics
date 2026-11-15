/**
 * 富集分析 IPC handler。
 *
 * 三条通道：
 *  - run        ：同步跑一次 ORA，直接返回结果行（1~5 秒，值得等）
 *  - loadResult ：重开项目 / 切页面时读回已有结果
 *  - plot       ：气泡图（预览返回 dataURL，导出写文件）
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { EnrichPlotRequest, EnrichRunRequest } from '@shared/types/ipc-contract'
import { EnrichService } from '../enrich/EnrichService'
import { defineHandler, type AppContext } from './registerHandlers'

const runSchema = z.object({
  genes: z.array(z.string().min(1)).min(1).max(50_000),
  geneIdType: z.string().min(1).default('SYMBOL'),
  species: z.enum(['human', 'mouse', 'rice', 'other']),
  // 至少选一个库，否则跑完必然是空结果
  sources: z.array(z.enum(['go', 'kegg'])).min(1),
  ontology: z.enum(['BP', 'MF', 'CC', 'ALL']),
  // 阈值上限放到 1，允许用户先看「全部条目」再自行筛
  pvalueCutoff: z.number().gt(0).max(1),
  qvalueCutoff: z.number().gt(0).max(1),
  customGoPath: z.string().optional(),
  customPathwayPath: z.string().optional(),
  customTermPrefix: z.string().optional()
})

const loadSchema = z.object({ enrichId: z.string().min(1) })

const plotSchema = z.object({
  enrichId: z.string().min(1),
  outPath: z.string().min(1).optional(),
  format: z.enum(['png', 'pdf']).optional(),
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30),
  dpi: z.number().min(72).max(1200).optional(),
  topN: z.number().int().min(1).max(100),
  splitByOntology: z.boolean(),
  title: z.string().optional(),
  palette: z.array(z.string()).length(3).optional()
})

const exportTableSchema = z.object({
  enrichId: z.string().min(1),
  outPath: z.string().min(1),
  format: z.enum(['csv', 'xlsx'])
})

export function registerEnrichHandlers(ctx: AppContext): void {
  const serviceOf = (app: AppContext): EnrichService =>
    new EnrichService({
      runner: app.runner,
      paths: app.paths,
      projectStore: app.projectStore
    })

  defineHandler(ctx, IPC.enrich.run, runSchema, (req) => serviceOf(ctx).run(req as EnrichRunRequest))

  defineHandler(ctx, IPC.enrich.loadResult, loadSchema, (req) => serviceOf(ctx).load(req.enrichId))

  defineHandler(ctx, IPC.enrich.plot, plotSchema, (req) => serviceOf(ctx).plot(req.enrichId, req as EnrichPlotRequest))

  // 导出结果表：导出的是 R 侧写出的**全量**结果，不是界面筛选后的视图
  defineHandler(ctx, IPC.enrich.exportTable, exportTableSchema, (req) =>
    serviceOf(ctx).exportTable(req)
  )
}
