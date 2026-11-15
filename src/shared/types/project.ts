/**
 * 项目相关类型（ARCHITECTURE §4.1）：物种、状态、项目元数据、分析快照。
 *
 * project.json 是「唯一真源」的落盘形态，因此这里的字段名必须与
 * ProjectSchema.ts 的 zod schema 严格一致（schema 校验失败会报 E_PROJECT_SCHEMA）。
 */
import type { DatasetSummary } from './dataset'
import type { DEConfig, DEStats, DEResultRow } from './analysis'
import type { EnrichConfig } from './enrich'
import type { PlotConfig, PlotType } from './plot'

export type Species = 'human' | 'mouse'

export type DataType = 'counts' | 'normalized'

export type ProjectStatus = 'imported' | 'analyzed' | 'interrupted' | 'enriched'

/**
 * 分析方法 ID。
 * 后两个（gsea-*）v1.0 不实现，仅类型预留（P1-01 扩展点）。
 */
export type AnalysisMethodId =
  | 'limma-voom'
  | 'limma-lm'
  | 'deseq2'
  | 'edger'
  | 'ora-go'
  | 'ora-kegg'
  | 'gsea-go'
  | 'gsea-kegg'

/**
 * 单次运行的状态。
 *
 * `interrupted` 与 `failed` 的区别（产品决策，2025-06 定稿）：
 *  - `failed`      = 分析**报错了**（R 抛异常/校验不通过）→ 用户应去看日志找原因；
 *  - `interrupted` = 分析**被打断了**（软件被强杀/断电/崩溃，进程已不存在）→ 用户直接重跑即可。
 * 两者对用户的行动指引完全不同，混用会让 PRD US-09 的「人话错误提示」变成误导。
 */
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted'

/** 一次差异分析的历史快照（v1.0 只用最后一个，结构支持 P1-09 对比） */
export interface AnalysisSnapshot {
  id: string
  method: AnalysisMethodId
  /** "DESeq2 · Tumor vs Normal" */
  label: string
  /** ★ 完整参数快照 */
  config: DEConfig
  /** 相对项目根，如 results/de/20250612-1022-de.csv */
  resultPath: string
  stats: DEStats
  /** 上次使用的阈值 */
  thresholds: { logFC: number; fdr: number }
  durationMs: number
  createdAt: string
  /** logs/<runId>.log */
  rLogPath: string
}

/** 一次富集运行的历史快照 */
export interface EnrichSnapshot {
  id: string
  source: 'go' | 'kegg'
  config: EnrichConfig
  resultPath: string
  summary: { termCount: number; geneCount: number; durationMs: number }
  createdAt: string
  rLogPath: string
}

/** project.json 的完整结构（schemaVersion 用于迁移） */
export interface ProjectMeta {
  schemaVersion: 1
  /** crypto.randomUUID() */
  projectId: string
  name: string
  species: Species
  /** ISO 8601 UTC */
  createdAt: string
  updatedAt: string
  /** 写入时的软件版本 */
  appVersion: string
  status: ProjectStatus
  dataType: DataType
  /** 未导入数据时为 undefined */
  dataset?: DatasetSummary
  analyses: AnalysisSnapshot[]
  activeAnalysisId?: string
  enrichRuns: EnrichSnapshot[]
  /** ★ 图表参数快照，重开还原 */
  plots: Partial<Record<PlotType, PlotConfig>>
  lastRun?: {
    runId: string
    startedAt: string
    finishedAt?: string
    status: RunStatus
  }
}

/** 最近项目列表项 */
export interface RecentProject {
  /** 项目根目录绝对路径（.degproj 文件夹） */
  dir: string
  name: string
  species: Species
  status: ProjectStatus
  updatedAt: string
}

/** 打开项目的结果 */
export interface OpenProjectResult {
  meta: ProjectMeta
  dataset?: DatasetSummary
  /** 全量表达数据（箱线图 / PCA 兜底渲染用）；无数据时为 undefined */
  expression?: {
    geneIds: string[]
    geneNames: string[]
    samples: string[]
    values: number[]
  }
}

/** 新建项目入参 */
export interface ProjectCreateRequest {
  name: string
  species: Species
  /** 父目录（项目文件夹将创建在 parentDir/<name>.degproj） */
  parentDir: string
}

/**
 * 内置示例数据集的规模。
 *
 *  `default` = 2000 基因 × 24 样本（limma-voom 实测 1.1 秒，进度只采到 3 个台阶）
 *  `stress`  = 20000 基因 × 48 样本（实测 2.8 秒，8 个台阶，过滤后 14600 基因）
 *
 * 两份数据**共存**：压力数据不能替换默认数据 —— 首次上手的人应该立刻看到结果。
 * ★ 这里写的是**实测值**，不是估算：曾经按「2 万基因大概要 30–60 秒」写文案，
 *   实测 2.8 秒，差了一个数量级。limma-voom 在 2 万基因上本来就很快，
 *   想要分钟级压测得把矩阵再放大一个量级（见 `npm run gen:demo:stress` 的可覆盖参数）。
 */
export type DemoVariant = 'default' | 'stress'

/** 已加载的差异结果（带快照信息，供结果页还原） */
export interface LoadedDEResult {
  rows: DEResultRow[]
  stats: DEStats
  snapshot: AnalysisSnapshot | null
}
