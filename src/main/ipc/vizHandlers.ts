/**
 * 绘图模块 IPC handler。
 *
 * 两条通道：
 *  - inspectSource：只读探测表格文件，给界面填下拉框
 *  - render      ：出图（给了 outPath 是导出，不给是预览 dataURL）
 *
 * ## 为什么用 `z.discriminatedUnion`
 *
 * 三张图的参数集合几乎不相交。如果写成一个「什么字段都 optional」的大对象，
 * 传错了（例如小提琴请求里带了 clinicalPath）也能通过校验，一路走到 R 才报
 * 一个看不懂的错。用判别联合后，`kind` 一旦确定，其余字段就是**必须**齐全的。
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { VizRenderRequest } from '@shared/types/viz'
import { VizRenderer } from '../viz/VizRenderer'
import { inspectTable } from '../viz/VizSourceReader'
import { defineHandler, type AppContext } from './registerHandlers'

/** 图幅上限 30 英寸：A4 也就 8.27in，再大没有使用场景，只会让 R 白占内存 */
const baseShape = {
  widthIn: z.number().positive().max(30),
  heightIn: z.number().positive().max(30),
  dpi: z.number().min(72).max(1200).optional(),
  outPath: z.string().min(1).optional(),
  format: z.enum(['png', 'pdf']).optional(),
  title: z.string().max(200).optional()
}

const vennSchema = z.object({
  kind: z.literal('venn'),
  ...baseShape,
  sets: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        genes: z.array(z.string()).max(50_000)
      })
    )
    // 2 组以下不是 Venn 图；8 组以上任何排布都无法读，直接在入口拒掉
    .min(2)
    .max(7),
  options: z.object({
    fill: z.boolean(),
    showCount: z.boolean(),
    showPercent: z.boolean(),
    palette: z.array(z.string()).max(12),
    labelSize: z.number().min(3).max(30).optional()
  })
})

const violinSchema = z.object({
  kind: z.literal('violin'),
  ...baseShape,
  source: z.object({
    matrixPath: z.string().min(1),
    groupsPath: z.string().min(1).optional(),
    geneColumn: z.string().min(1).optional(),
    // 分面图一次最多 60 个基因：再多单个分面就小到看不清，应该拆成多张图
    genes: z.array(z.string().min(1)).min(1).max(60)
  }),
  options: z.object({
    plotType: z.enum(['violin', 'box', 'beeswarm']),
    inputIsLog2: z.boolean(),
    testMethod: z.enum(['wilcox', 't']),
    pLabel: z.enum(['p', 'fdr']),
    refGroup: z.string().optional(),
    showPoints: z.boolean(),
    showMean: z.boolean(),
    palette: z.string().min(1),
    facetFreeY: z.boolean(),
    yLabel: z.string().max(80).optional(),
    xLabel: z.string().max(80).optional()
  })
})

const survivalSchema = z.object({
  kind: z.literal('survival'),
  ...baseShape,
  source: z.object({
    clinicalPath: z.string().min(1),
    matrixPath: z.string().min(1).optional()
  }),
  options: z.object({
    groupBy: z.enum(['table', 'gene']),
    groupColumn: z.string().optional(),
    timeColumn: z.string().optional(),
    statusColumn: z.string().optional(),
    gene: z.string().optional(),
    cutMethod: z.enum(['median', 'tertile', 'quartile', 'optimal']).optional(),
    inputIsLog2: z.boolean().optional(),
    palette: z.string().min(1),
    confInt: z.boolean(),
    pval: z.boolean(),
    pvalMethod: z.boolean(),
    logRankWeights: z.string().min(1).max(20),
    riskTable: z.boolean(),
    riskTableHeight: z.number().min(0).max(0.6),
    legendLabs: z.array(z.string()).max(20).optional(),
    xLabel: z.string().max(80).optional(),
    yLabel: z.string().max(80).optional()
  })
})

const renderSchema = z.discriminatedUnion('kind', [vennSchema, violinSchema, survivalSchema])

const inspectSchema = z.object({ filePath: z.string().min(1) })

export function registerVizHandlers(ctx: AppContext): void {
  const rendererOf = (app: AppContext): VizRenderer =>
    new VizRenderer({ runner: app.runner, paths: app.paths })

  defineHandler(ctx, IPC.viz.render, renderSchema, (req) =>
    // 校验层与 `VizRenderRequest` 描述同一件事，但 zod 推导出的类型在
    // optional 与 undefined 上比手写接口更宽/更窄，这里显式断言一次，
    // 真正的形状保证来自上面的 schema。
    rendererOf(ctx).render(req as unknown as VizRenderRequest)
  )

  defineHandler(ctx, IPC.viz.inspectSource, inspectSchema, (req) => inspectTable(req.filePath))
}
