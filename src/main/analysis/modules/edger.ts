/**
 * edgeR 模块（负二项 GLM + quasi-likelihood F 检验）。
 *
 * 适用：**原始 counts**。与 DESeq2 同属「负二项」家族，但用 quasi-likelihood
 * 把「离散度估计本身的不确定性」也计入，每组 2~3 个样本时比 DESeq2 的 Wald 检验
 * 更稳；而且天然支持任意 contrast，与 limma / DESeq2 共用同一套对比语义。
 *
 * 与 limma-voom 的关系：两者都能跑 counts，差别在方差建模方式
 * （voom 用观测权重 + 加权最小二乘，edgeR 用负二项 + QL F）。保留两条路径是有意的：
 * 客户手上的数据在两种模型下结论不一致时，能同时给出两份结果比只有一份更有说服力。
 */
import type { DEConfig, DEResultRow } from '@shared/types/analysis'
import type { AnalysisModule } from '../registry'
import { computeStats, ResultLoader } from '../ResultLoader'
import { buildDeFormSchema, buildDeRunConfig, DE_OUTPUTS } from './deShared'

const loader = new ResultLoader()

export const edgerModule: AnalysisModule<DEConfig, DEResultRow> = {
  id: 'edger',
  label: 'edgeR（QL F-test）',
  category: 'de',

  availability(ctx) {
    if (!ctx.runtimeOk) {
      return { enabled: false, reason: 'R 运行环境不可用，请先修复环境。' }
    }
    if (ctx.dataType !== 'counts') {
      return { enabled: false, reason: 'edgeR 需要原始整数 counts。' }
    }
    if (ctx.groups.length < 2) {
      return { enabled: false, reason: '至少需要 2 个分组才能做差异分析。' }
    }
    // estimateDisp / glmQLFit 都要估计组内离散度，每组 1 个样本时 R 侧会直接失败，
    // 提前置灰比让用户等 20 秒再报错好
    for (const [name, size] of Object.entries(ctx.groupSizes)) {
      if (size < 2) {
        return { enabled: false, reason: `组 ${name} 只有 ${size} 个样本，无法估计离散度。` }
      }
    }
    return { enabled: true }
  },

  formSchema: buildDeFormSchema(),
  rScript: 'de/run_edger.R',
  // 与 run_edger.R 的 deg_ensure_pkgs 保持一致：**limma 必须有**（makeContrasts 来自
  // limma，edgeR 不导出它），data.table 用于读写矩阵。漏声明会在客户机器上把
  // 「缺包」报成「R 错误」，用户不知道该装什么。
  requiredPackages: ['edgeR', 'limma', 'data.table'],
  // QL F-test 与 DESeq2 一样要求非负整数 counts：Runner 靠这个能力位在起 R 之前
  // 先拦一次（R 侧还有第二道，见 run_edger.R 的 deg_ensure_pkgs 与 de.R 的说明）
  requiresIntegerCounts: true,
  buildRunConfig: (config, ctx) => buildDeRunConfig(config, ctx),
  outputs: DE_OUTPUTS,

  async loadResult(runDir) {
    return loader.load(runDir).rows
  },

  // 阈值统计由模块提供：Runner 只负责调用，不关心 up/down 怎么算
  computeStats: (rows, thresholds, filteredOutCount) =>
    computeStats(rows, thresholds, filteredOutCount)
}
