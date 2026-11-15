/**
 * 差异分析模块的公共部分（表单 schema + run_config 组装）。
 *
 * 为什么抽出来：limma-voom / limma-lm / DESeq2 三个模块的**表单字段与参数结构
 * 高度重合**，如果各自复制一遍，改一个字段名就要改三处，迟早漏一处。
 * 差异部分（voom / 离散度 / lfcShrink）由各模块以 `extra` 追加。
 */
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import type { DEConfig } from '@shared/types/analysis'
import type { FormFieldSchema, RunContext } from '../registry'

/** 三个 DE 模块共用的表单字段（顺序即界面顺序） */
export function buildDeFormSchema(extra: FormFieldSchema[] = []): FormFieldSchema[] {
  return [
    {
      key: 'contrast.numerator',
      label: '实验组',
      type: 'select',
      options: (ctx) => ctx.groups.map((g) => ({ value: g, label: g })),
      helpText: 'logFC > 0 表示在该组上调（相对对照）'
    },
    {
      key: 'contrast.denominator',
      label: '对照（基线）',
      type: 'select',
      options: (ctx) => ctx.groups.map((g) => ({ value: g, label: g })),
      helpText: '作为分母的组，logFC 的符号由它决定'
    },
    {
      key: 'filter.enabled',
      label: '开启低表达过滤',
      type: 'switch',
      default: true,
      helpText: '过滤后基因数会显示在运行结果里'
    },
    {
      key: 'filter.mode',
      label: '过滤方式',
      type: 'select',
      default: 'filterByExpr',
      options: [
        { value: 'filterByExpr', label: 'filterByExpr（自动，推荐）' },
        { value: 'custom', label: '自定义阈值' }
      ],
      visibleWhen: { 'filter.enabled': true }
    },
    {
      key: 'filter.minCount',
      label: '表达量 ≥',
      type: 'number',
      default: 10,
      min: 0,
      step: 1,
      visibleWhen: { 'filter.mode': 'custom' }
    },
    {
      key: 'filter.minSamplesPct',
      label: '在 ≥ % 样本中检出',
      type: 'number',
      default: 50,
      min: 0,
      max: 100,
      step: 5,
      visibleWhen: { 'filter.mode': 'custom' }
    },
    {
      key: 'fdrMethod',
      label: '多重检验校正',
      type: 'select',
      default: 'BH',
      options: [
        { value: 'BH', label: 'BH（Benjamini-Hochberg，推荐）' },
        { value: 'BY', label: 'BY（Benjamini-Yekutieli）' },
        { value: 'holm', label: 'Holm' },
        { value: 'none', label: '不校正' }
      ]
    },
    {
      key: 'outputGeneName',
      label: '输出基因名（gene_name）',
      type: 'switch',
      default: true,
      helpText: '关闭后 gene_name 列为空，结果表更小'
    },
    {
      key: 'keepAllGenes',
      label: '不过滤，保留全部基因',
      type: 'switch',
      default: false,
      helpText: '开启后忽略上面的低表达过滤设置'
    },
    ...extra
  ]
}

/**
 * 组装 run_config.json（R 侧只读 `params$xxx`，路径一律绝对路径）。
 * 结构见 ARCHITECTURE §8 末尾的「通用外层结构」。
 *
 * `logFCThreshold` / `fdrThreshold` 是给 R 写 `de.csv` 的 `regulation` 列用的：
 * 让「用户在 Excel 里数出来的行数」和界面统计卡对得上。不传时 R 侧用 PRD 默认值，
 * 因此老项目/老配置的行为不变。
 */
export function buildDeRunConfig(config: DEConfig, ctx: RunContext, extraParams: Record<string, unknown> = {}): unknown {
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS
  return {
    runId: ctx.runId,
    projectRoot: ctx.projectRoot,
    runDir: ctx.runDir,
    themePath: ctx.themePath,
    fontPath: ctx.fontPath,
    params: {
      matrixPath: ctx.matrixPath,
      groupsPath: ctx.groupsPath,
      species: ctx.species,
      dataType: ctx.dataType,
      sampleColumn: ctx.sampleColumn,
      groupColumn: ctx.groupColumn,
      geneIdType: ctx.geneIdType,
      contrast: {
        groupColumn: config.contrast.groupColumn || ctx.groupColumn,
        numerator: config.contrast.numerator,
        denominator: config.contrast.denominator
      },
      filter: {
        enabled: config.filter.enabled && !config.keepAllGenes,
        mode: config.filter.mode,
        minCount: config.filter.minCount ?? 10,
        minSamplesPct: config.filter.minSamplesPct ?? 50
      },
      fdrMethod: config.fdrMethod,
      outputGeneName: config.outputGeneName,
      keepAllGenes: config.keepAllGenes,
      // R 写 de.csv 的 regulation 列时用这对阈值（默认 1.0 / 0.05）
      logFCThreshold: thresholds.logFC,
      fdrThreshold: thresholds.fdr,
      ...extraParams
    }
  }
}

/** 三个 DE 模块都产出这两份文件（内容必须一致，见 T10 完成标准） */
export const DE_OUTPUTS = [
  { kind: 'de_table' as const, fileName: 'de.csv', format: 'csv' as const },
  { kind: 'de_table' as const, fileName: 'de.json', format: 'json' as const }
]
