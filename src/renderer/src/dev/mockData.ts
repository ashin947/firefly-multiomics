/**
 * 开发期演示数据（`DEG_DEV_MOCK=1` 时启用）。
 *
 * 存在理由：客户机器上 R 已安装但只有基础包（无 limma/DESeq2），跑不出真实结果，
 * 而 UI 必须先验收。这里用**确定性伪随机**生成规模与真实数据同量级的假数据：
 *   - 5000 基因 × 24 样本，两组各 12 例（Tumor / Normal）；
 *   - 结果表 5000 行，默认阈值（|logFC|≥1、FDR<0.05）下约 8~12% 显著；
 *   - 同一 seed 每次生成完全一致，截图与手工验证可复现。
 *
 * 生产构建里这份代码不可达：入口处用 `AppInfo.mock` 把关，而 `mock` 在打包后恒为 false
 * （主进程侧 `isDev && DEG_DEV_MOCK==='1'`，isDev 是硬门）。
 */
import type { AnalysisSnapshot } from '@shared/types/project'
import type { RecentProject } from '@shared/types/project'
import type { RRuntimeInfo } from '@shared/types/runtime'
import type { AnalysisPreflightResult, DEConfig, DEResultRow, DEStats, PreflightItem } from '@shared/types/analysis'
import type {
  DatasetSummary,
  ExpressionPayload,
  GroupImportResult,
  ImportMatrixResult,
  Issue
} from '@shared/types/dataset'
import { DEFAULT_THRESHOLDS } from '@shared/constants'
import { countByThreshold } from '../utils/threshold'

/** 线性同余伪随机（可复现，不依赖 Math.random） */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** 常见基因符号（让表格看起来像真的，而不是 GENE0001 一片） */
const REAL_SYMBOLS = [
  'TP53', 'EGFR', 'MYC', 'KRAS', 'BRCA1', 'BRCA2', 'PTEN', 'RB1', 'CDKN2A', 'MDM2',
  'AKT1', 'MTOR', 'PIK3CA', 'MAPK1', 'MAPK3', 'JUN', 'FOS', 'STAT3', 'NFKB1', 'RELA',
  'VEGFA', 'HIF1A', 'CXCL8', 'IL6', 'TNF', 'IFNG', 'CD274', 'PDCD1LG2', 'CTLA4', 'FOXP3',
  'MKI67', 'PCNA', 'CCND1', 'CCNE1', 'CDK1', 'CDK4', 'E2F1', 'GATA3', 'ESR1', 'ERBB2',
  'ALB', 'APOA1', 'APOB', 'SERPINA1', 'TF', 'HBB', 'HBA1', 'GAPDH', 'ACTB', 'TUBB'
]

export const MOCK_SAMPLES: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)
]

export const MOCK_GROUPS: Record<string, string[]> = {
  Normal: MOCK_SAMPLES.slice(0, 12),
  Tumor: MOCK_SAMPLES.slice(12)
}

function geneSymbol(index: number): string {
  if (index < REAL_SYMBOLS.length) return REAL_SYMBOLS[index]
  return `LOC${100000 + index * 7}`
}

/** 演示用最近项目列表（工作台表格） */
export function mockRecentProjects(): RecentProject[] {
  const now = Date.now()
  const iso = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()
  return [
    {
      dir: 'D:\\deg-projects\\肺腺癌-Tumor-vs-Normal.degproj',
      name: '肺腺癌 Tumor vs Normal',
      species: 'human',
      status: 'analyzed',
      updatedAt: iso(38)
    },
    {
      dir: 'D:\\deg-projects\\小鼠肝损伤模型.degproj',
      name: '小鼠肝损伤模型',
      species: 'mouse',
      status: 'interrupted',
      updatedAt: iso(60 * 26)
    },
    {
      dir: 'D:\\deg-projects\\示例项目.degproj',
      name: '示例项目（demo）',
      species: 'human',
      status: 'imported',
      updatedAt: iso(60 * 24 * 3)
    }
  ]
}

/** 演示用校验问题（无 error，保证「下一步」可点） */
function mockIssues(): Issue[] {
  return [
    {
      code: 'E_DATA_ALL_ZERO',
      rule: 'all-zero-gene',
      level: 'info',
      message: '检测到 37 个基因在所有样本中表达量均为 0，已自动过滤（不参与后续分析）。',
      suggestion: '如需保留请检查原始矩阵是否含大量未检出基因。',
      count: 37
    },
    {
      code: 'E_DATA_NA_RATIO',
      rule: 'na-ratio',
      level: 'warning',
      message: '有 12 个基因的缺失值比例超过 20%，其中最高为 SLC25A1（31.2%）。',
      suggestion: '建议确认这些基因的定量是否可靠；缺失值将由分析流程按方法内置规则处理。',
      count: 12
    },
    {
      code: 'E_DATA_GROUP_TOO_SMALL',
      rule: 'group-small-power',
      level: 'warning',
      message: '分组 Normal 与 Tumor 各 12 个样本，满足最低要求；建议每组 ≥3 例以保证统计功效。',
      suggestion: '当前样本量可用于探索性分析。'
    }
  ]
}

/** 演示用数据集摘要（2000 × 24） */
export function mockDatasetSummary(): DatasetSummary {
  return {
    matrixSourceFile: 'GSE_demo_expression.csv',
    matrixPath: 'data/expression.clean.csv',
    rawMatrixPath: 'data/expression.raw.csv',
    encoding: 'utf-8',
    delimiter: ',',
    geneIdColumn: 'gene_id',
    geneIdType: 'SYMBOL',
    duplicateStrategy: 'mean',
    geneCount: 2000,
    sampleCount: 24,
    samples: MOCK_SAMPLES,
    groupColumn: 'group',
    sampleColumn: 'sample',
    groups: MOCK_GROUPS,
    naRatio: 0.004,
    allZeroGeneCount: 37,
    issues: mockIssues(),
    hasBlockingIssue: false
  }
}

/** 演示用矩阵导入结果（含 12 行预览） */
export function mockMatrixResult(): ImportMatrixResult {
  const summary = mockDatasetSummary()
  const rand = lcg(20250612)
  const previewColumns = ['gene_id', ...MOCK_SAMPLES.slice(0, 8)]
  const rows: (string | number)[][] = Array.from({ length: 12 }, (_, r) => {
    const symbol = geneSymbol(r)
    const values = previewColumns.slice(1).map(() => Math.round(rand() * 4000))
    return [symbol, ...values]
  })
  return {
    summary,
    preview: { columns: previewColumns, rows },
    detectedGeneIdType: 'SYMBOL',
    geneIdSample: Array.from({ length: 5 }, (_, i) => geneSymbol(i)),
    requiresChoice: false,
    expression: mockExpression()
  }
}

/** 演示用分组导入结果 */
export function mockGroupResult(): GroupImportResult {
  return {
    groups: MOCK_GROUPS,
    issues: [],
    preview: {
      columns: ['sample', 'group'],
      rows: MOCK_SAMPLES.map((s) => [s, s.startsWith('N') ? 'Normal' : 'Tumor'])
    },
    sampleColumn: 'sample',
    groupColumn: 'group'
  }
}

/** 演示用全量表达矩阵（箱线图 / PCA 兜底渲染用） */
export function mockExpression(): ExpressionPayload {
  const geneCount = 2000
  const sampleCount = MOCK_SAMPLES.length
  const values = new Float64Array(geneCount * sampleCount)
  const naMask = new Uint8Array(geneCount * sampleCount)
  const rand = lcg(777)
  for (let g = 0; g < geneCount; g += 1) {
    const base = 20 + rand() * 2000
    // 后 12 个样本（Tumor）给一部分基因一个整体抬升，让 PCA 能分出两组
    const tumorBoost = g % 7 === 0 ? 1.45 : 1
    for (let s = 0; s < sampleCount; s += 1) {
      const boost = s >= 12 ? tumorBoost : 1
      const noise = 0.85 + rand() * 0.3
      values[g * sampleCount + s] = Math.round(base * boost * noise)
    }
  }
  return {
    geneIds: Array.from({ length: geneCount }, (_, i) => geneSymbol(i)),
    geneNames: Array.from({ length: geneCount }, (_, i) => geneSymbol(i)),
    samples: [...MOCK_SAMPLES],
    values,
    naMask
  }
}

/**
 * 演示用差异结果（默认 5000 行）。
 *
 * 数值构造刻意让「显著基因」呈合理分布：
 *  - logFC 在 -3..3 之间近似均匀；
 *  - p 值由 t = logFC / se 推出（se 随机），因此大 |logFC| 天然更显著；
 *  - adjP 用 p 的近似放大，保证默认阈值下显著比例约 10%。
 */
export function mockDeRows(count = 5000): DEResultRow[] {
  const rand = lcg(424242)
  const rows: DEResultRow[] = []
  for (let i = 0; i < count; i += 1) {
    const logFC = (rand() - 0.5) * 6
    const se = 0.15 + rand() * 0.55
    const t = logFC / se
    const pValue = 2 * Math.exp(-1.6 * Math.abs(t))
    const adjPValue = Math.min(1, pValue * 3.2)
    const regulation: DEResultRow['regulation'] =
      Math.abs(logFC) >= 1 && pValue < 0.05 ? (logFC > 0 ? 'up' : 'down') : 'ns'
    rows.push({
      geneId: geneSymbol(i),
      geneName: geneSymbol(i),
      logFC: Number(logFC.toFixed(4)),
      aveExpr: Number((2 + rand() * 12).toFixed(3)),
      t: Number(t.toFixed(3)),
      pValue,
      adjPValue,
      b: null,
      regulation
    })
  }
  rows.sort((a, b) => a.pValue - b.pValue)
  return rows
}

/** 演示用统计（按默认阈值现算，保证与表格/火山图一致） */
export function mockDeStats(rows: DEResultRow[]): DEStats {
  const counts = countByThreshold(rows, { ...DEFAULT_THRESHOLDS })
  return {
    totalGenesAfterFilter: rows.length,
    upCount: counts.up,
    downCount: counts.down,
    nsCount: counts.ns,
    filteredOutCount: 37
  }
}

/** 演示用分析快照（结果页标题区用） */
export function mockAnalysisSnapshot(rows: DEResultRow[]): AnalysisSnapshot {
  return {
    id: 'analysis-mock-0001',
    method: 'limma-voom',
    label: 'limma-voom · Tumor vs Normal',
    config: mockDeConfig(),
    resultPath: 'results/de/mock/de.csv',
    stats: mockDeStats(rows),
    thresholds: { ...DEFAULT_THRESHOLDS },
    durationMs: 42_300,
    createdAt: new Date(Date.now() - 38 * 60_000).toISOString(),
    rLogPath: 'logs/mock.log'
  }
}

/** 演示用差异分析配置 */
export function mockDeConfig(): DEConfig {
  return {
    method: 'limma-voom',
    dataType: 'counts',
    contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
    filter: { enabled: true, mode: 'filterByExpr', minCount: 10, minSamplesPct: 30 },
    fdrMethod: 'BH',
    outputGeneName: true,
    keepAllGenes: false,
    // limma-lm 的两个分支参数：演示数据是 counts，但演示配置用的是 limma-voom，
    // 这两个字段只是让「切到 limma-lm」时表单有确定的初值（不是 undefined）
    inputIsLog2: true,
    priorCount: 2
  }
}

/**
 * 演示用 R 运行时信息。
 *
 * 为什么演示模式要伪造它：本机没有 R（或只有基础包），真实探测结果是「红灯 + 缺包」，
 * 那样首页三盏灯全红、分析配置页所有方法都置灰，客户看不到产品**设计上的正常形态**。
 * 演示模式给一份健康环境，界面就能呈现「一切就绪」的样子；
 * 真实环境下的红灯/置灰行为由不开启演示模式的启动来验证（截图 08 即此用途）。
 */
export function mockRuntimeInfo(): RRuntimeInfo {
  const packages = [
    { name: 'limma', version: '3.58.1', ok: true, required: true },
    { name: 'edgeR', version: '4.0.16', ok: true, required: true },
    { name: 'DESeq2', version: '1.42.0', ok: true, required: true },
    { name: 'clusterProfiler', version: '4.10.1', ok: true, required: true },
    { name: 'AnnotationDbi', version: '1.64.1', ok: true, required: true },
    { name: 'data.table', version: '1.15.4', ok: true, required: true },
    { name: 'ggplot2', version: '3.5.1', ok: true, required: true },
    { name: 'ragg', version: '1.3.0', ok: true, required: false },
    { name: 'org.Hs.eg.db', version: '3.18.0', ok: true, required: false },
    { name: 'org.Mm.eg.db', version: '3.18.0', ok: false, required: false }
  ]
  return {
    ok: true,
    source: 'custom',
    rscriptPath: 'D:\\R-4.3.2\\bin\\x64\\Rscript.exe',
    rHome: 'D:\\R-4.3.2',
    version: '4.3.2',
    arch: 'x86_64',
    libPaths: ['D:\\R-4.3.2\\library'],
    packages,
    missingPackages: [],
    missingSpeciesLibs: ['org.Mm.eg.db'],
    speciesLibs: { human: true, mouse: false },
    fontAvailable: true,
    probedAt: new Date().toISOString(),
    warnings: [],
    // 演示环境是「一切就绪」，因此每个方法都可用（与 packages 全 ok 一致）
    methods: [
      { id: 'limma-voom', label: 'limma-voom', requiredPackages: ['limma', 'edgeR', 'data.table'], missingPackages: [], available: true },
      { id: 'limma-lm', label: 'limma-lm', requiredPackages: ['limma', 'edgeR', 'data.table'], missingPackages: [], available: true },
      { id: 'deseq2', label: 'DESeq2', requiredPackages: ['DESeq2', 'edgeR', 'data.table'], missingPackages: [], available: true },
      { id: 'edger', label: 'edgeR', requiredPackages: ['edgeR', 'limma', 'data.table'], missingPackages: [], available: true }
    ]
  }
}

/**
 * 演示模式的预检结果（仅 `DEG_DEV_MOCK=1` 可达）。
 *
 * 为什么需要它：真实预检要走 `deg:analysis:preflight`，而演示模式没有真实项目，
 * 主进程会返回「当前没有打开的项目」，配置页就会整屏报错 —— 客户看到的将是一个
 * 打不开的界面。这里用与真实数据同构的假结论，让界面在没有 R 的机器上仍能走查。
 *
 * ★ 注意：这里**不是**第二份预检规则。规则仍在主进程（`AnalysisRunner.collect`），
 *   本函数只是「演示数据的结论」，不参与任何真实判定。
 */
export function mockPreflight(config: DEConfig): AnalysisPreflightResult {
  const runtime = mockRuntimeInfo()
  const dataset = mockDatasetSummary()
  const groups = Object.keys(dataset.groups)
  const groupText = groups.map((g) => `${g}(${dataset.groups[g].length})`).join('、')

  const items: PreflightItem[] = [
    { id: 'data-issues', label: '数据校验', level: 'ok', detail: '导入阶段的 13 项校验没有阻断级问题。' },
    {
      id: 'matrix-scale',
      label: '矩阵规模',
      level: 'ok',
      detail: `${dataset.geneCount.toLocaleString()} 基因 × ${dataset.sampleCount} 样本`
    },
    { id: 'groups', label: '分组数量', level: 'ok', detail: `${groups.length} 个分组：${groupText}` },
    { id: 'samples', label: '样本匹配', level: 'ok', detail: `${dataset.sampleCount} 个样本全部有分组` },
    {
      id: 'contrast',
      label: '对比组',
      level: 'ok',
      detail: `${config.contrast.numerator} vs ${config.contrast.denominator}（logFC > 0 表示在 ${config.contrast.numerator} 中上调）`
    },
    { id: 'method', label: '分析方法', level: 'ok', detail: `${config.method} 可用于当前数据` },
    {
      id: 'counts',
      label: 'counts 整数性',
      level: 'ok',
      // 与主进程 AnalysisRunner.collect 的 ⑨ 同构：只有声明了 requiresIntegerCounts
      // 的方法（deseq2 / edger）才真的检查；其余方法这句「无需检查」是真的
      detail:
        config.method === 'deseq2' || config.method === 'edger'
          ? '已确认数据为非负整数。'
          : `${config.method} 接受非整数表达值，无需检查。`
    },
    {
      id: 'allzero',
      label: '全零基因',
      level: 'warn',
      detail: `${dataset.allZeroGeneCount} 个基因全为 0，已自动过滤（不参与分析）。`
    },
    {
      id: 'runtime',
      label: 'R 环境',
      level: 'ok',
      detail: `R ${runtime.version} 可用，所需包齐全`
    }
  ]

  return {
    canRun: true,
    method: config.method,
    items,
    methods: [
      { id: 'limma-voom', label: 'limma + voom', enabled: config.dataType === 'counts' },
      // limma-lm 现在两个分支都能处理（log2 直接拟合 / counts 走 limma-trend），
      // 所以不再看 dataType —— 与主进程 limmaNormModule.availability 保持一致
      { id: 'limma-lm', label: 'limma 线性模型', enabled: true },
      { id: 'deseq2', label: 'DESeq2', enabled: config.dataType === 'counts' },
      { id: 'edger', label: 'edgeR', enabled: config.dataType === 'counts' }
    ]
  }
}
