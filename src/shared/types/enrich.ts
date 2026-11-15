/**
 * 富集分析相关类型（ARCHITECTURE §4.4）。
 */
import type { ThresholdState } from './analysis'

/**
 * 富集分析支持的物种。
 *
 * `'other'` = 非模式生物，必须自带注释文件（GO / KEGG）。
 * 选它时界面会强制「自定义文件」并隐藏「内置注释库」——
 * 没有内置注释的物种选「内置」只会得到 0 命中。
 *
 * 特意不复用项目里的 `Species`（只有 human/mouse）：表达矩阵那条链路的物种
 * 决定用哪个注释库做基因名映射，而富集这边客户明确要求支持水稻 ——
 * 把 rice 塞进全局 Species 会波及导入向导、数据校验等一堆无关的地方。
 */
export type EnrichSpecies = 'human' | 'mouse' | 'rice' | 'other'

/** 富集背景来源 */
export type EnrichBackgroundSource = 'builtin' | 'custom'

/** 富集分析配置 */
export interface EnrichConfig {
  /** 同时跑多库（客户要求 GO + KEGG 一起出） */
  sources: ('go' | 'kegg')[]
  species: EnrichSpecies
  /** 背景：内置注释库 / 用户提供的注释文件 */
  background: EnrichBackgroundSource
  /** background==='custom' 时的 GO 注释文件（gene<TAB>GO:xxx<TAB>...） */
  customGoPath?: string
  /** background==='custom' 时的 pathway 注释文件（gene<TAB>KEGG:.../Reactome:...） */
  customPathwayPath?: string
  /** 只保留以该前缀开头的 term（如 'KEGG' / 'Reactome'），空串表示全部 */
  customTermPrefix?: string
  /** 基因 ID 类型（SYMBOL / ENSEMBL / ENTREZID），内置物种转 ENTREZ 时用 */
  geneIdType: string
  /** 仅 GO 有效 */
  goOntology: ('BP' | 'CC' | 'MF')[]
  input: {
    mode: 'degs' | 'manual' | 'gmt'
    /** 从差异结果取子集 */
    direction: 'all' | 'up' | 'down'
    /** mode==='manual' */
    geneList?: string[]
    /** mode==='gmt'（P1） */
    gmtPath?: string
    /** 快照：用哪套阈值挑基因 */
    thresholds: ThresholdState
  }
  pAdjustMethod: 'BH' | 'BY' | 'holm' | 'none'
  pvalueCutoff: number
  qvalueCutoff: number
  minGSSize: number
  maxGSSize: number
  /** 是否把 ENTREZ 转回 SYMBOL */
  readable: boolean
}

/** 自定义背景没有 ontology 概念，单独一类 */
export type EnrichSource = 'GO:BP' | 'GO:CC' | 'GO:MF' | 'KEGG' | 'Pathway'

/** 富集结果一行（PRD R-23 的 9 字段） */
export interface EnrichResultRow {
  /** GO:0007049 / hsa04110 */
  id: string
  description: string
  /** "42/1284" */
  geneRatio: string
  /** "1284/18800" */
  bgRatio: string
  pvalue: number
  pAdjust: number
  qvalue: number
  /** "/" 分隔 */
  geneId: string
  count: number
  source: EnrichSource
}

/** 一次富集运行的汇总 */
export interface EnrichRunSummary {
  enrichId: string
  termCount: number
  geneCount: number
  durationMs: number
  rows: EnrichResultRow[]
}
