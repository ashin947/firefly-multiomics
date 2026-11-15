/**
 * 导出类 IPC handler：图片落盘 + 结果表落盘。
 *
 * 职责边界：**只负责「把前端已经算好的东西写成文件」**。
 * 表格怎么筛（只要显著 / 全部）由渲染进程决定，这里不重算 —— 一旦主进程
 * 拿另一套阈值再去筛，就会出现「界面显示 75 行、导出的 CSV 里 118 行」这种
 * 不报错但结论不一致的问题（历史 bug，见 de.R 里 regulation 列的注释）。
 *
 * 实际写盘逻辑在 `../io/OutputWriter`（纯 node:fs，可被单测直接调用）。
 */
import { z } from 'zod'
import { toAppError } from '@shared/errors'
import { IPC } from '@shared/ipc'
import type { AppError } from '@shared/errors'
import type {
  HeatmapExportRequest,
  HeatmapPreviewRequest,
  PlotExportRequest,
  PlotPreviewRequest
} from '@shared/types/ipc-contract'
import { writeImageDataUrl, writeTableCsv } from '../io/OutputWriter'
import { HeatmapExporter } from '../plot/HeatmapExporter'
import { VolcanoExporter } from '../plot/VolcanoExporter'
import { defineHandler, type AppContext } from './registerHandlers'

/* ------------------------------------------------------------------ *
 * 入参 schema
 * ------------------------------------------------------------------ */

/** 允许落盘的导出格式（数据源是前端 canvas / jsPDF，不是任意内容） */
const ALLOWED_DATA_URL_MIMES = ['image/png', 'image/jpeg', 'application/pdf']

const saveImageSchema = z.object({
  outPath: z.string().min(1),
  /*
   * 只接受这几种 MIME 的 dataURL，防止把任意字符串当文件写出去。
   * 注意 jsPDF 的 `output('datauristring')` 会带参数：
   *   `data:application/pdf;filename=generated.pdf;base64,....`
   * 所以不能只匹配 `^data:<mime>;base64,`，中间可能夹着 `;filename=xxx`。
   */
  dataUrl: z
    .string()
    .refine((value) => {
      const match = /^data:([^;,]+)(;[^,]*)?;base64,[A-Za-z0-9+/=\s]+$/.exec(value)
      return match !== null && ALLOWED_DATA_URL_MIMES.includes(match[1])
    }, '只支持 PNG / JPEG / PDF 三种导出格式')
})

/** 火山图导出（走 R/ggplot2）。行数上限防手滑传了百万行把内存打满 */
const plotExportSchema = z.object({
  outPath: z.string().min(1),
  format: z.enum(['png', 'pdf']),
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30),
  dpi: z.number().min(72).max(1200),
  thresholds: z.object({
    logFC: z.number().nonnegative(),
    fdr: z.number().positive(),
    basis: z.enum(['pValue', 'adjPValue']).optional()
  }),
  colors: z.object({
    up: z.string().min(4),
    down: z.string().min(4),
    ns: z.string().min(4)
  }),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200_000),
  title: z.string().optional()
})

/** 预览请求：与导出同样的校验，只是不带 outPath */
const plotPreviewSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200_000),
  thresholds: z.object({
    logFC: z.number().nonnegative(),
    fdr: z.number().positive(),
    basis: z.enum(['pValue', 'adjPValue']).optional()
  }),
  colors: z.object({
    up: z.string().min(4),
    down: z.string().min(4),
    ns: z.string().min(4)
  }),
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30),
  title: z.string().optional()
})

/** 热图共用字段（预览与导出只差 outPath/format/dpi） */
const heatmapBase = {
  geneList: z.array(z.string()).max(5000),
  topN: z.number().int().min(1).max(500),
  clusterRows: z.boolean(),
  clusterCols: z.boolean(),
  scale: z.enum(['none', 'row', 'column']),
  showGeneNames: z.boolean(),
  showSampleNames: z.boolean(),
  showGroupAnnotation: z.boolean(),
  colors: z.object({
    low: z.string().min(4),
    mid: z.string().min(4),
    high: z.string().min(4)
  }),
  title: z.string().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200_000),
  thresholds: z.object({
    logFC: z.number().nonnegative(),
    fdr: z.number().positive(),
    basis: z.enum(['pValue', 'adjPValue']).optional()
  }),
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30)
}

const heatmapPreviewSchema = z.object(heatmapBase)

const heatmapExportSchema = z.object({
  ...heatmapBase,
  outPath: z.string().min(1),
  format: z.enum(['png', 'pdf']),
  dpi: z.number().min(72).max(1200)
})

const exportTableSchema = z.object({
  kind: z.enum(['de', 'enrich']),
  format: z.enum(['csv', 'xlsx']),
  rows: z.array(z.record(z.string(), z.unknown())),
  outPath: z.string().min(1)
})

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export function registerOutputHandlers(ctx: AppContext): void {
  defineHandler(ctx, IPC.plot.saveImage, saveImageSchema, async (req) => {
    try {
      return writeImageDataUrl(req.outPath, req.dataUrl)
    } catch (err) {
      // writeImageDataUrl 里的格式错误已经是 AppError，原样抛（不要包成「写盘失败」）
      if (err && typeof err === 'object' && 'code' in err) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw toAppError('E_IO_PERMISSION', {
        message: `图片保存失败 —— ${detail}`,
        suggestion: '请确认目标文件夹存在且当前用户有写入权限，或换一个保存位置。'
      })
    }
  })

  defineHandler(ctx, IPC.plot.export, plotExportSchema, (req) =>
    new VolcanoExporter({ runner: ctx.runner, paths: ctx.paths }).export(req as PlotExportRequest)
  )

  defineHandler(ctx, IPC.plot.preview, plotPreviewSchema, (req) =>
    new VolcanoExporter({ runner: ctx.runner, paths: ctx.paths }).preview(req as PlotPreviewRequest)
  )

  defineHandler(ctx, IPC.plot.previewHeatmap, heatmapPreviewSchema, (req) =>
    new HeatmapExporter({
      runner: ctx.runner,
      paths: ctx.paths,
      projectStore: ctx.projectStore
    }).preview(req as HeatmapPreviewRequest)
  )

  defineHandler(ctx, IPC.plot.exportHeatmap, heatmapExportSchema, (req) =>
    new HeatmapExporter({
      runner: ctx.runner,
      paths: ctx.paths,
      projectStore: ctx.projectStore
    }).export(req as HeatmapExportRequest)
  )

  defineHandler(ctx, IPC.export.table, exportTableSchema, async (req) => {
    if (req.format === 'xlsx') {
      // 契约里预留了 xlsx，但 v1.0 没有引入 xlsx 写库。
      // 明确报错，不要「产出 csv 却叫 .xlsx」——那种文件 Excel 会弹格式警告。
      const error: AppError = toAppError('E_VALIDATION', {
        message: '当前版本暂不支持直接导出 xlsx。',
        suggestion: '请选择 CSV 格式（Excel 可直接打开）。'
      })
      throw error
    }

    try {
      return writeTableCsv(req.outPath, req.rows)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw toAppError('E_IO_PERMISSION', {
        message: `表格保存失败 —— ${detail}`,
        suggestion: '请确认文件没有被 Excel 等程序占用，或换一个保存位置。'
      })
    }
  })
}
