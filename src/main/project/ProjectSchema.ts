/**
 * project.json 的 zod schema + 版本迁移（ARCHITECTURE §6.6 / T06）。
 *
 * 两条原则：
 *  1. **磁盘上的结构必须完整**：schema 不给字段设 default，缺失字段一律报错，
 *     默认值统一在 migrate() 里补 —— 这样「校验失败」与「版本升级」的职责不混在一起。
 *  2. 校验失败必须给出**人话**（哪个字段、期望什么），而不是 zod 的原始 issues 数组。
 */
import { z } from 'zod'
import { toAppError, type AppError } from '@shared/errors'
import type { ProjectMeta } from '@shared/types/project'

/** 携带结构化 AppError 的 schema 异常（handler 直接转 IpcResult） */
export class ProjectSchemaError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'ProjectSchemaError'
  }
}

/* ------------------------------------------------------------------ *
 * 基础片段
 * ------------------------------------------------------------------ */

const issueSchema = z.object({
  code: z.string(),
  /** PRD §8.3 规则 ID（新增于 T08，旧项目没有该字段，故 optional） */
  rule: z.string().optional(),
  level: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  suggestion: z.string().optional(),
  locator: z
    .object({
      row: z.number().optional(),
      column: z.string().optional(),
      sample: z.string().optional(),
      gene: z.string().optional()
    })
    .optional(),
  count: z.number().optional(),
  samples: z.array(z.string()).optional()
})

/**
 * dataset 分支使用 **passthrough**（见 docs/ARCHITECTURE-MODULES.md §4.3）。
 *
 * 为什么不能是默认的「剥掉未声明字段」：
 *  v1.1 起 dataset 会存单细胞（稀疏矩阵）/空转（矩阵+坐标）两种形态，
 *  它们是 `DatasetSummary` 之外的**超集字段**（kind / omics / features / observations…）。
 *  如果这里剥字段，用户用新版本打开项目再保存（哪怕只改了 status），
 *  这些字段就会被静默抹掉 —— 那才是真正的数据损坏。
 *  passthrough 让未知字段原样透传，加 variant 时无需升 schemaVersion、无需写迁移。
 *
 * 注意：这不代表我们「不校验」dataset —— 已声明的 18 个字段仍然逐个强校验，
 * 只是对**未来新增字段**保持宽容。真正的新形态校验由 T-omics-2 的
 * `dataset-omics.ts` 判别联合负责。
 */
const datasetSummarySchema = z
  .object({
    matrixSourceFile: z.string(),
    matrixPath: z.string(),
    rawMatrixPath: z.string(),
    encoding: z.enum(['utf-8', 'gb18030']),
    delimiter: z.enum([',', '\t', ';']),
    geneIdColumn: z.string(),
    geneIdType: z.enum(['SYMBOL', 'ENSEMBL', 'ENTREZ', 'UNKNOWN']),
    duplicateStrategy: z.enum(['mean', 'sum', 'max', 'first']),
    geneCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    samples: z.array(z.string()),
    groupColumn: z.string(),
    sampleColumn: z.string(),
    groups: z.record(z.array(z.string())),
    naRatio: z.number(),
    allZeroGeneCount: z.number().int().nonnegative(),
    issues: z.array(issueSchema),
    hasBlockingIssue: z.boolean()
  })
  .passthrough()

const speciesSchema = z.enum(['human', 'mouse'])
const dataTypeSchema = z.enum(['counts', 'normalized'])

const deConfigSchema = z.object({
  method: z.enum(['limma-voom', 'limma-lm', 'deseq2', 'edger']),
  dataType: dataTypeSchema,
  contrast: z.object({
    groupColumn: z.string(),
    numerator: z.string(),
    denominator: z.string()
  }),
  filter: z.object({
    enabled: z.boolean(),
    mode: z.enum(['filterByExpr', 'custom']),
    minCount: z.number().optional(),
    minSamplesPct: z.number().optional()
  }),
  fdrMethod: z.enum(['BH', 'BY', 'holm', 'none']),
  outputGeneName: z.boolean(),
  keepAllGenes: z.boolean(),
  // limma-lm 的两个分支参数。optional 保证老项目（没有这两个字段）照样能读回来
  inputIsLog2: z.boolean().optional(),
  priorCount: z.number().optional()
})

const deStatsSchema = z.object({
  totalGenesAfterFilter: z.number(),
  upCount: z.number(),
  downCount: z.number(),
  nsCount: z.number(),
  filteredOutCount: z.number()
})

const analysisMethodSchema = z.enum([
  'limma-voom',
  'limma-lm',
  'deseq2',
  'edger',
  'ora-go',
  'ora-kegg',
  'gsea-go',
  'gsea-kegg'
])

const analysisSnapshotSchema = z.object({
  id: z.string(),
  method: analysisMethodSchema,
  label: z.string(),
  config: deConfigSchema,
  resultPath: z.string(),
  stats: deStatsSchema,
  thresholds: z.object({ logFC: z.number(), fdr: z.number() }),
  durationMs: z.number(),
  createdAt: z.string(),
  rLogPath: z.string()
})

const enrichConfigSchema = z.object({
  // 从单库改成多库：客户要求 GO + KEGG 一次出全
  sources: z.array(z.enum(['go', 'kegg'])).min(1),
  species: z.enum(['human', 'mouse', 'rice']),
  background: z.enum(['builtin', 'custom']).default('builtin'),
  customGoPath: z.string().optional(),
  customPathwayPath: z.string().optional(),
  customTermPrefix: z.string().optional(),
  geneIdType: z.string().default('SYMBOL'),
  goOntology: z.array(z.enum(['BP', 'CC', 'MF'])),
  input: z.object({
    mode: z.enum(['degs', 'manual', 'gmt']),
    direction: z.enum(['all', 'up', 'down']),
    geneList: z.array(z.string()).optional(),
    gmtPath: z.string().optional(),
    thresholds: z.object({ logFC: z.number(), fdr: z.number() })
  }),
  pAdjustMethod: z.enum(['BH', 'BY', 'holm', 'none']),
  pvalueCutoff: z.number(),
  qvalueCutoff: z.number(),
  minGSSize: z.number(),
  maxGSSize: z.number(),
  readable: z.boolean()
})

const enrichSnapshotSchema = z.object({
  id: z.string(),
  source: z.enum(['go', 'kegg', 'go+kegg']),
  config: enrichConfigSchema,
  resultPath: z.string(),
  summary: z.object({
    termCount: z.number(),
    geneCount: z.number(),
    durationMs: z.number()
  }),
  createdAt: z.string(),
  rLogPath: z.string()
})

/* ------------------------------------------------------------------ *
 * 图表配置（判别联合）
 * ------------------------------------------------------------------ */

const plotBaseSchema = z.object({
  title: z.string(),
  palette: z.string(),
  fontSize: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  dpi: z.number(),
  formats: z.array(z.enum(['png', 'pdf'])),
  showGeneLabels: z.boolean()
})

const volcanoConfigSchema = plotBaseSchema.extend({
  type: z.literal('volcano'),
  logFC: z.number(),
  fdr: z.number(),
  topN: z.number(),
  pointSize: z.number()
})

const heatmapConfigSchema = plotBaseSchema.extend({
  type: z.literal('heatmap'),
  topN: z.number(),
  zScore: z.boolean(),
  clusterRows: z.boolean(),
  clusterCols: z.boolean(),
  clusterMethod: z.enum(['complete', 'average', 'ward.D2', 'single']),
  distance: z.enum(['euclidean', 'correlation', 'manhattan']),
  showGroupAnnotation: z.boolean()
})

const pcaConfigSchema = plotBaseSchema.extend({
  type: z.literal('pca'),
  topVariableGenes: z.number(),
  pcX: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  pcY: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  showEllipse: z.boolean(),
  logTransform: z.boolean()
})

const boxplotConfigSchema = plotBaseSchema.extend({
  type: z.literal('boxplot'),
  mode: z.enum(['gene', 'qc']),
  genes: z.array(z.string()),
  overlayPoints: z.boolean(),
  logAxis: z.boolean()
})

const enrichPlotConfigSchema = plotBaseSchema.extend({
  type: z.enum(['enrich-bubble', 'enrich-bar']),
  source: z.enum(['GO:BP', 'GO:CC', 'GO:MF', 'KEGG', 'Pathway']),
  topN: z.number(),
  orderBy: z.enum(['p.adjust', 'count']),
  sizeByCount: z.boolean(),
  colorByPAdjust: z.boolean()
})

const plotConfigSchema = z.discriminatedUnion('type', [
  volcanoConfigSchema,
  heatmapConfigSchema,
  pcaConfigSchema,
  boxplotConfigSchema,
  enrichPlotConfigSchema
])

/* ------------------------------------------------------------------ *
 * 顶层
 * ------------------------------------------------------------------ */

export const projectMetaSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  species: speciesSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  appVersion: z.string(),
  status: z.enum(['imported', 'analyzed', 'interrupted', 'enriched']),
  dataType: dataTypeSchema,
  dataset: datasetSummarySchema.optional(),
  analyses: z.array(analysisSnapshotSchema),
  activeAnalysisId: z.string().optional(),
  enrichRuns: z.array(enrichSnapshotSchema),
  plots: z.record(plotConfigSchema),
  lastRun: z
    .object({
      runId: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().optional(),
      status: z.enum(['running', 'success', 'failed', 'cancelled', 'interrupted'])
    })
    .optional()
})

/** 当前支持的最高 schemaVersion（更高说明是「新版本软件创建的项目」） */
export const CURRENT_SCHEMA_VERSION = 1

export class ProjectSchema {
  /**
   * 校验磁盘上的 project.json 结构。
   * @throws ProjectSchemaError（code = E_PROJECT_SCHEMA）
   */
  static validate(raw: unknown): ProjectMeta {
    const result = projectMetaSchema.safeParse(raw)
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')
      throw new ProjectSchemaError(
        toAppError('E_PROJECT_SCHEMA', {
          message: `project.json 结构不符合预期 —— ${detail}`,
          detail: JSON.stringify(result.error.issues, null, 2)
        })
      )
    }
    return result.data as ProjectMeta
  }

  /**
   * 版本迁移：把旧版本（或无版本号）的原始对象补齐到当前结构。
   * 无法迁移（版本更高）时抛 E_PROJECT_SCHEMA。
   *
   * @throws ProjectSchemaError
   */
  static migrate(raw: unknown): ProjectMeta {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ProjectSchemaError(
        toAppError('E_PROJECT_CORRUPT', { message: 'project.json 内容不是合法对象' })
      )
    }
    const obj = { ...(raw as Record<string, unknown>) }
    const version = obj.schemaVersion

    if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
      throw new ProjectSchemaError(
        toAppError('E_PROJECT_SCHEMA', {
          message: `该项目由更高版本的软件创建（schemaVersion=${version}），请升级「Firefly」后再打开。`
        })
      )
    }

    // v0（无 schemaVersion）→ v1：补默认值
    if (version === undefined || version === null || version === 0) {
      obj.schemaVersion = 1
    }

    // 结构性默认值（旧项目可能没有这些字段）
    if (!Array.isArray(obj.analyses)) obj.analyses = []
    if (!Array.isArray(obj.enrichRuns)) obj.enrichRuns = []
    if (typeof obj.plots !== 'object' || obj.plots === null || Array.isArray(obj.plots)) {
      obj.plots = {}
    }
    if (typeof obj.status !== 'string') obj.status = 'imported'
    if (typeof obj.dataType !== 'string') obj.dataType = 'counts'
    if (typeof obj.appVersion !== 'string') obj.appVersion = '0.0.0'
    if (typeof obj.updatedAt !== 'string') obj.updatedAt = obj.createdAt ?? new Date().toISOString()

    // plots 里可能有当前版本不认识的图表类型（未来版本写入的），直接剔除而不是让整个项目打不开
    const plots = obj.plots as Record<string, unknown>
    for (const key of Object.keys(plots)) {
      const single = plotConfigSchema.safeParse(plots[key])
      if (!single.success) delete plots[key]
    }

    return ProjectSchema.validate(obj)
  }
}
