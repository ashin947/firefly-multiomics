/**
 * 单细胞 IPC handler（3 条通道，均属第 1 步）。
 *
 * 与 wgcna / enrich 一致，是「同步等待」：调用方拿到最终结果，中间进度通过
 * `analysisProgress` / `analysisLog` 事件推给界面。构建对象可能几分钟，
 * 但那是单次阻塞操作，引入取消/轮询的复杂度不划算。
 *
 * `scanDir` 是唯一**不起 R** 的通道 —— 它只读文件名，必须瞬间返回。
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { ScrnaImportRequest } from '@shared/types/scrna'
import { ScrnaService } from '../scrna/ScrnaService'
import { defineHandler, type AppContext } from './registerHandlers'

const scanSchema = z.object({
  rootDir: z.string().min(1)
})

const importSchema = z.object({
  rootDir: z.string().min(1),
  samples: z
    .array(
      z.object({
        // 名字会写进 orig.ident 并出现在所有下游图里，限制长度防止图例被撑爆
        name: z.string().min(1).max(64),
        dir: z.string().min(1)
      })
    )
    .min(1)
    // 单次导入的样本数上限：再多就不是「少量批次」而是批次效应本身了，
    // 也不该在一个向导步骤里塞进去
    .max(64)
})

/**
 * QC 阈值：三个都可以为 null（= 不启用该条）。
 * 范围只挡明显不合理的输入（负的基因数、>100% 的线粒体比例），
 * 「这个阈值是否合适」是用户看着分布自己判断的事。
 */
const thresholdsSchema = z.object({
  minFeature: z.number().min(0).max(100_000).nullable(),
  minCount: z.number().min(0).max(10_000_000).nullable(),
  maxMt: z.number().min(0).max(1).nullable()
})

const qcSchema = z.object({
  scrnaId: z.string().min(1),
  thresholds: thresholdsSchema
})

const prepSchema = z.object({
  scrnaId: z.string().min(1),
  // 上限挡明显不合理的输入：2000 / 30 是客户脚本的取值
  nFeatures: z.number().int().min(200).max(20_000),
  nPcs: z.number().int().min(5).max(200)
})

const embedSchema = z.object({
  scrnaId: z.string().min(1),
  // 客户从 0.1 改到 0.25；上限挡明显不合理的输入
  resolution: z.number().positive().max(5),
  dims: z.number().int().min(5).max(200).optional()
})

/**
 * 导出统计表（csv）。**不能复用 exportObjectSchema** —— 那个的 `file` 枚举是
 * `obj_step1..4`（rds），传 `cluster_summary` 会被 zod 直接拒掉，
 * 用户看到的是「导出失败」而不知道是白名单不匹配（实测撞过）。
 */
const exportSummarySchema = z.object({
  scrnaId: z.string().min(1),
  outPath: z.string().min(1),
  file: z.enum(['qc_summary', 'cluster_summary', 'celltype_annotation']).optional()
})

const markersSchema = z.object({
  scrnaId: z.string().min(1),
  // 客户默认 0.5 / 0.05；上限只挡明显不合理的输入
  logfcThreshold: z.number().min(0).max(10),
  adjPvalFilter: z.number().gt(0).max(1)
})

const inspectSchema = z.object({
  path: z.string().min(1),
  targetStep: z.union([z.literal(4), z.literal(5), z.literal(6)])
})

const importObjectSchema = z.object({
  path: z.string().min(1),
  targetStep: z.union([z.literal(4), z.literal(5), z.literal(6)]),
  scrnaId: z.string().min(1).optional()
})

const markersTableSchema = z.object({
  scrnaId: z.string().min(1),
  cluster: z.string().max(64).optional(),
  search: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(2000),
  offset: z.number().int().min(0)
})

const exportMarkersSchema = z.object({
  scrnaId: z.string().min(1),
  outPath: z.string().min(1),
  table: z.enum(['sig', 'top10']),
  format: z.enum(['csv', 'xlsx'])
})

const exportObjectSchema = z.object({
  scrnaId: z.string().min(1),
  outPath: z.string().min(1),
  // 白名单，不是自由路径
  file: z
    .enum(['obj_step1', 'obj_step2', 'obj_step3', 'obj_step4', 'obj_step5', 'obj_step6'])
    .optional()
})

/**
 * 第 6 步预览：可选带一份注释表（导入后立刻回填输入框 + 对账）。
 *
 * `annotationFile` 走 `.optional()` 而不是 `.default('')`：`''` 与「没传」在
 * 服务里是同一个分支，但 zod 里混着两种表示容易在下游多写一个判断。
 */
const annotatePreviewSchema = z.object({
  scrnaId: z.string().min(1),
  annotationFile: z.string().min(1).optional()
})

/**
 * 人工注释。
 *
 * `assignments` 的 celltype 允许空串（= 用户只想先看个大概，R 侧会取 `cluster_N`），
 * 但 cluster 必须非空 —— 空的 cluster 行没有任何意义，且会让 R 侧的
 * `named[as.character(obj$clusters)]` 悄悄产生 NA。
 */
const annotateSchema = z.object({
  scrnaId: z.string().min(1),
  assignments: z
    .array(
      z.object({
        cluster: z.string().min(1).max(64),
        celltype: z.string().max(128)
      })
    )
    .max(1000)
    .optional(),
  annotationFile: z.string().min(1).optional()
})

const exportTemplateSchema = z.object({
  scrnaId: z.string().min(1),
  outPath: z.string().min(1)
})

/** 自选基因出图：上限 200 个（再多图也没法看，且 26k 细胞的 VlnPlot 会慢到分钟级） */
const customPlotsSchema = z.object({
  scrnaId: z.string().min(1),
  genes: z.array(z.string().min(1).max(128)).min(1).max(200)
})

/**
 * 基因查询：`splitBy` 只允许两个值 —— `''`（不拆分）与 `orig.ident`（按样本）。
 * 不开放任意列：客户手上这张表里其它列（nCount/percent.mt）当分组是没意义的，
 * 放开只会让他在图上看出一堆噪声。
 */
const geneQuerySchema = z.object({
  scrnaId: z.string().min(1),
  genes: z.array(z.string().min(1).max(128)).min(1).max(200),
  groupBy: z.union([z.literal('celltype'), z.literal('clusters')]),
  splitBy: z.union([z.literal(''), z.literal('orig.ident')]).optional()
})

const singleRSchema = z.object({
  scrnaId: z.string().min(1),
  refRds: z.string().min(1),
  labelColumn: z.string().max(64).optional()
})

const exportPlotSchema = z.object({
  scrnaId: z.string().min(1),
  file: z.string().min(1).max(200),
  format: z.enum(['png', 'pdf']),
  outPath: z.string().min(1)
})

const exportAllPlotsSchema = z.object({
  scrnaId: z.string().min(1),
  outDir: z.string().min(1),
  files: z.array(z.string().min(1).max(200)).max(500).optional()
})

export function registerScrnaHandlers(ctx: AppContext): void {
  const serviceOf = (app: AppContext): ScrnaService =>
    new ScrnaService({
      runner: app.runner,
      projectStore: app.projectStore,
      emit: app.emit
    })

  defineHandler(ctx, IPC.scrna.scanDir, scanSchema, (req) => serviceOf(ctx).scanDir(req.rootDir))

  defineHandler(ctx, IPC.scrna.import, importSchema, (req) =>
    serviceOf(ctx).import(req as ScrnaImportRequest)
  )

  defineHandler(ctx, IPC.scrna.exportObject, exportObjectSchema, (req) =>
    serviceOf(ctx).exportObject(req.scrnaId, req.outPath, req.file)
  )

  defineHandler(ctx, IPC.scrna.qc, qcSchema, (req) => serviceOf(ctx).qc(req))

  defineHandler(ctx, IPC.scrna.filter, qcSchema, (req) => serviceOf(ctx).filter(req))

  defineHandler(ctx, IPC.scrna.exportSummary, exportSummarySchema, (req) =>
    serviceOf(ctx).exportSummary(req.scrnaId, req.outPath, req.file)
  )

  defineHandler(ctx, IPC.scrna.prep, prepSchema, (req) => serviceOf(ctx).prep(req))

  defineHandler(ctx, IPC.scrna.embed, embedSchema, (req) => serviceOf(ctx).embed(req))

  defineHandler(ctx, IPC.scrna.markers, markersSchema, (req) => serviceOf(ctx).markers(req))

  defineHandler(ctx, IPC.scrna.exportMarkers, exportMarkersSchema, (req) =>
    serviceOf(ctx).exportMarkers(req)
  )

  defineHandler(ctx, IPC.scrna.markersTable, markersTableSchema, (req) =>
    serviceOf(ctx).markersTable(req)
  )

  defineHandler(ctx, IPC.scrna.inspectObject, inspectSchema, (req) =>
    serviceOf(ctx).inspectObject(req)
  )

  defineHandler(ctx, IPC.scrna.importObject, importObjectSchema, (req) =>
    serviceOf(ctx).importObject(req)
  )

  defineHandler(ctx, IPC.scrna.annotatePreview, annotatePreviewSchema, (req) =>
    serviceOf(ctx).annotatePreview(req)
  )

  defineHandler(ctx, IPC.scrna.annotate, annotateSchema, (req) => serviceOf(ctx).annotate(req))

  defineHandler(ctx, IPC.scrna.exportTemplate, exportTemplateSchema, (req) =>
    serviceOf(ctx).exportTemplate(req)
  )

  defineHandler(ctx, IPC.scrna.singleRPreview, singleRSchema, (req) =>
    serviceOf(ctx).singleRPreview(req)
  )

  defineHandler(ctx, IPC.scrna.customPlots, customPlotsSchema, (req) =>
    serviceOf(ctx).customPlots(req)
  )

  defineHandler(ctx, IPC.scrna.geneQuery, geneQuerySchema, (req) =>
    serviceOf(ctx).geneQuery({ ...req, splitBy: req.splitBy ?? '' })
  )

  defineHandler(ctx, IPC.scrna.exportPlot, exportPlotSchema, (req) =>
    serviceOf(ctx).exportPlot(req)
  )

  defineHandler(ctx, IPC.scrna.exportAllPlots, exportAllPlotsSchema, (req) =>
    serviceOf(ctx).exportAllPlots(req)
  )
}
