/**
 * DESeq2 模块（PRD R-10 / ARCHITECTURE §9 T10）。
 *
 * 两个产品决策写在这里，别处不要改：
 *  1. **`lfcShrink(apeglm)` 默认关闭**。开启后 logFC 会被收缩，与 DESeq2 vignette
 *     的原始 `results()` 输出不再逐位一致，会让「与 vignette 比对误差 < 1e-6」
 *     这条验收失败。因此它作为高级选项暴露，默认 false。
 *  2. **可用性只认 counts**：`dataType !== 'counts'` 直接置灰并给理由（PRD R-10）。
 *     R 侧还有一道整数性双保险（exit 13 → E_DATA_NOT_INTEGER）。
 */
import type { DEConfig, DEResultRow } from '@shared/types/analysis'
import type { AnalysisModule, FormFieldSchema } from '../registry'
import { computeStats, ResultLoader } from '../ResultLoader'
import { buildDeFormSchema, buildDeRunConfig, DE_OUTPUTS } from './deShared'

const loader = new ResultLoader()

/** DESeq2 配置 = 通用 DE 配置 + 收缩开关 */
export interface Deseq2Config extends DEConfig {
  /** 是否对 logFC 做 apeglm 收缩（默认 false，见文件头说明） */
  shrinkLfc: boolean
}

const deseq2ExtraFields: FormFieldSchema[] = [
  {
    key: 'shrinkLfc',
    label: 'logFC 收缩（apeglm，高级）',
    type: 'switch',
    default: false,
    helpText: '开启后 logFC 会被收缩，更稳健但与 DESeq2 官方示例数值不再逐位一致，默认关闭'
  }
]

export const deseq2Module: AnalysisModule<Deseq2Config, DEResultRow> = {
  id: 'deseq2',
  label: 'DESeq2（原始 counts）',
  category: 'de',

  availability(ctx) {
    if (!ctx.runtimeOk) {
      return { enabled: false, reason: 'R 运行环境不可用，请先修复环境。' }
    }
    if (ctx.dataType !== 'counts') {
      return { enabled: false, reason: 'DESeq2 需要原始整数 counts。' }
    }
    if (ctx.groups.length < 2) {
      return { enabled: false, reason: '至少需要 2 个分组才能做差异分析。' }
    }
    // 每组样本数 < 2 时 DESeq2 的离散度估计会直接失败，提前给出可读理由
    for (const [name, size] of Object.entries(ctx.groupSizes)) {
      if (size < 2) {
        return { enabled: false, reason: `组 ${name} 只有 ${size} 个样本，无法估计离散度。` }
      }
    }
    return { enabled: true }
  },

  formSchema: buildDeFormSchema(deseq2ExtraFields),
  rScript: 'de/run_deseq2.R',
  // 与 run_deseq2.R 的 deg_ensure_pkgs 保持一致：filterByExpr 与公共层都依赖 edgeR，
  // 读写矩阵依赖 data.table。缺任何一个都跑不起来，所以全部声明在这里。
  requiredPackages: ['DESeq2', 'edgeR', 'data.table'],
  // 声明「需要非负整数 counts」：Runner 据此在起 R 之前先拦一次（R 侧还有第二道）
  requiresIntegerCounts: true,
  buildRunConfig: (config, ctx) =>
    buildDeRunConfig(config, ctx, { shrinkLfc: config.shrinkLfc === true }),
  outputs: DE_OUTPUTS,

  async loadResult(runDir) {
    return loader.load(runDir).rows
  },

  // 阈值统计由模块提供：Runner 只负责调用，不关心 up/down 怎么算
  computeStats: (rows, thresholds, filteredOutCount) =>
    computeStats(rows, thresholds, filteredOutCount)
}
