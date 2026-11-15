/**
 * limma 线性模型模块（PRD R-09 的「走 lmFit」分支）。
 *
 * 这个方法有**两个真实分支**，由 `inputIsLog2` 决定，不是「一个方法两种叫法」：
 *
 *  - `inputIsLog2 = true`（默认）：芯片 / 已用其它工具归一化的 **log2 表达值**，
 *    直接 `lmFit` → `contrasts.fit` → `eBayes()`（不带 trend）。
 *  - `inputIsLog2 = false`：**原始 counts**，先 TMM + `cpm(log = TRUE, prior.count)`，
 *    再 `lmFit` → `eBayes(trend = TRUE)`（limma-trend）。
 *
 * 因此可用性不再限制 `dataType`：以前写死成「只有 normalized 能用」，导致
 * 客户拿到 counts 时只能选 voom / DESeq2，而 limma-trend 在样本量大、counts 干净时
 * 是最快的一条路。
 */
import type { DEConfig, DEResultRow } from '@shared/types/analysis'
import type { AnalysisModule, FormFieldSchema } from '../registry'
import { computeStats, ResultLoader } from '../ResultLoader'
import { buildDeFormSchema, buildDeRunConfig, DE_OUTPUTS } from './deShared'

const loader = new ResultLoader()

/** limma-lm 独有的两个字段（其余与 voom / DESeq2 共用） */
const limmaLmExtraFields: FormFieldSchema[] = [
  {
    key: 'inputIsLog2',
    label: '数据已 log2 转换',
    type: 'switch',
    default: true,
    helpText:
      '已 log2 的芯片/归一化数据请保持开启，直接拟合线性模型；' +
      '原始 counts 请关闭，软件会先做 log2-CPM 转换（limma-trend）。' +
      '开启时低表达过滤会自动改用 log2 表达量阈值（≥1 且在 ≥50% 样本中检出），因为 filterByExpr 只适用于 counts。'
  },
  {
    key: 'priorCount',
    label: '先验计数（prior.count）',
    type: 'number',
    default: 2,
    min: 0.5,
    max: 10,
    step: 0.5,
    visibleWhen: { inputIsLog2: false },
    helpText: '仅用于 counts → log2-CPM 转换，越大越保守；limma-trend 常用 2'
  }
]

export const limmaNormModule: AnalysisModule<DEConfig, DEResultRow> = {
  id: 'limma-lm',
  label: 'limma 线性模型',
  category: 'de',

  availability(ctx) {
    if (!ctx.runtimeOk) {
      return { enabled: false, reason: 'R 运行环境不可用，请先修复环境。' }
    }
    // ★ 不再限制 dataType：log2 数据走分支一，counts 走分支二（limma-trend），
    //   两个分支都能处理，所以「数据类型」不再是可用性条件。
    if (ctx.groups.length < 2) {
      return { enabled: false, reason: '至少需要 2 个分组才能做差异分析。' }
    }
    return { enabled: true }
  },

  formSchema: buildDeFormSchema(limmaLmExtraFields),
  rScript: 'de/run_limma_norm.R',
  // 与 run_limma_norm.R 的 deg_ensure_pkgs 保持一致（filterByExpr / cpm 来自 edgeR）
  requiredPackages: ['limma', 'edgeR', 'data.table'],
  buildRunConfig: (config, ctx) =>
    buildDeRunConfig(config, ctx, {
      inputIsLog2: config.inputIsLog2 ?? true,
      priorCount: config.priorCount ?? 2
    }),
  outputs: DE_OUTPUTS,

  async loadResult(runDir) {
    return loader.load(runDir).rows
  },

  // 阈值统计由模块提供：Runner 只负责调用，不关心 up/down 怎么算
  computeStats: (rows, thresholds, filteredOutCount) =>
    computeStats(rows, thresholds, filteredOutCount)
}
