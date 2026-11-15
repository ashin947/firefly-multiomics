/**
 * 与「当前项目」绑定的前端状态，在项目切换时必须整体清空。
 *
 * ## 不清会怎样（真实反馈）
 *
 * 用户新建一个项目，进入结果页，看到的却是**上一个项目**的差异结果 ——
 * 因为 `analysisStore.rows` 是全局单例，只有 `loadResult()` 才会覆盖它，
 * 而新项目没有任何分析结果，`loadResult` 根本不会被调用。
 *
 * 更隐蔽的是外部导入表（`plotDataStore.external`）：它甚至不依赖项目，
 * 换了项目之后图还是别人那张表，标题却写着新项目名。
 *
 * 这类「数据串项目」的问题不会报错，只会让用户得出错误结论，所以必须在
 * **每一个项目边界**上清干净：新建、打开、载入示例、关闭。
 *
 * ## 为什么阈值也重置
 *
 * 阈值是「这次分析怎么判定显著」的一部分。上一个项目调成 logFC 2.5，
 * 新项目里还留着 2.5，用户会以为新数据显著基因特别少 —— 默认值才符合
 * 「新项目从零开始」的预期。
 */
import { useAnalysisStore } from './analysisStore'
import { usePlotDataStore } from './plotDataStore'
import { useThresholdStore } from './thresholdStore'

/** 清空所有「属于某个项目」的前端状态。项目切换的四个入口都必须调用。 */
export function resetProjectScopedState(): void {
  useAnalysisStore.getState().reset()
  useThresholdStore.getState().reset()
  usePlotDataStore.getState().clearExternal()
}
