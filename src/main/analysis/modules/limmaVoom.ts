/**
 * limma + voom 模块（PRD R-09 / ARCHITECTURE §9 T09）。
 *
 * 适用：**原始 counts**。voom 会做「counts → log2 CPM + 观测权重」的转换，
 * 然后用加权最小二乘拟合，因此对 counts 的均值-方差关系建模最充分。
 *
 * 可用性：非 counts 数据（已归一化）不给用 —— 那种数据应该走 limma-lm，
 * 否则 voom 会对着 log2 值再算一次 CPM，结果没有任何统计意义。
 */
import type { DEConfig, DEResultRow } from '@shared/types/analysis'
import type { AnalysisModule } from '../registry'
import { computeStats, ResultLoader } from '../ResultLoader'
import { buildDeFormSchema, buildDeRunConfig, DE_OUTPUTS } from './deShared'

const loader = new ResultLoader()

export const limmaVoomModule: AnalysisModule<DEConfig, DEResultRow> = {
  id: 'limma-voom',
  label: 'limma + voom（counts 推荐）',
  category: 'de',

  availability(ctx) {
    if (!ctx.runtimeOk) {
      return { enabled: false, reason: 'R 运行环境不可用，请先修复环境。' }
    }
    if (ctx.dataType !== 'counts') {
      return {
        enabled: false,
        reason: 'limma + voom 适用于原始 counts；已归一化数据请改用「limma 线性模型」。'
      }
    }
    if (ctx.groups.length < 2) {
      return { enabled: false, reason: '至少需要 2 个分组才能做差异分析。' }
    }
    return { enabled: true }
  },

  formSchema: buildDeFormSchema(),
  rScript: 'de/run_limma_voom.R',
  // 与 run_limma_voom.R 的 deg_ensure_pkgs 保持一致（data.table 用于读写矩阵）
  requiredPackages: ['limma', 'edgeR', 'data.table'],
  buildRunConfig: (config, ctx) => buildDeRunConfig(config, ctx),
  outputs: DE_OUTPUTS,

  async loadResult(runDir) {
    return loader.load(runDir).rows
  },

  // 阈值统计由模块提供：Runner 只负责调用，不关心 up/down 怎么算
  computeStats: (rows, thresholds, filteredOutCount) =>
    computeStats(rows, thresholds, filteredOutCount)
}
