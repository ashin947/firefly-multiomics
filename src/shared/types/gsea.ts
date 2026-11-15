/**
 * GSEA（基因集富集分析）的共享类型。
 *
 * ## 为什么单独一个文件，而不是塞进 enrich.ts
 *
 * ORA 与 GSEA 的输入语义不同：ORA 吃「一组基因」，GSEA 吃「全部基因 + logFC 排序」。
 * 混在一个类型里会让每个字段都得标注「仅 GSEA 有效」，反而更容易写错。
 */

/** 基因集来源 */
export type GseaSource = 'human' | 'mouse' | 'custom'

/**
 * 内置集合（MSigDB 2024.1 的 symbol 版）
 *
 * 注意：小鼠**没有** kegg —— MSigDB 未提供 `m2.cp.kegg_legacy`，这不是漏打包。
 * 界面要在小鼠时把该选项藏掉，否则用户选了才报错。
 */
export type GseaCollection = 'hallmark' | 'kegg' | 'reactome'

/** 启动一次 GSEA 的入参 */
export interface GseaRunRequest {
  /** 差异结果文件（需要含基因列与 logFC 列） */
  degPath: string
  /** 列名覆盖；留空则由 R 侧按常见列名自动识别 */
  geneColumn?: string
  logfcColumn?: string
  pColumn?: string
  /** p 值预过滤阈值；1 = 不过滤（GSEA 标准做法是用全部基因排序） */
  pvalueCutoff: number
  source: GseaSource
  collection: GseaCollection
  /** source='custom' 时的 GMT 路径 */
  gmtPath?: string
  /** 默认画前 N 个基因集（按 p 值） */
  topN: number
  /** 用户额外指定的基因集名（可空） */
  pathways: string[]
  minSize: number
  maxSize: number
  nperm: number
  widthIn: number
  heightIn: number
  /** 曲线配色（十六进制数组，按顺序取；不够时循环）。空 = 用默认（客户原脚本那套） */
  palette?: string[]
}

/** 结果表的一行 */
export interface GseaResultRow {
  pathway: string
  description: string
  size: number
  es: number
  nes: number
  pvalue: number
  pAdjust: number
  /** 核心富集基因，斜杠分隔 */
  leadingEdge: string
}

export interface GseaRunResult {
  gseaId: string
  rows: GseaResultRow[]
  /** R 侧汇总：基因集数、输入基因数、重叠数、显著数、耗时 */
  summary: Record<string, unknown>
  /** top-N 总览图（data URL），生成失败时为 null */
  topPlot: string | null
  /** 指定通路详情图（data URL），没有指定通路时为 null */
  detailPlot: string | null
}
