/**
 * 分析入口分派页 —— `/module/:omicsId/analysis/:analysisId` 的落地组件。
 *
 * 为什么要多这一层：
 *  路由表里只有**一条**分析配置路由，分析类型由 `analysisId` 决定。
 *  这样新增 GSEA / WGCNA / 单细胞聚类时，只需在下面的 `CONFIG_PAGES`
 *  加一行，路由文件一行都不用改；也不需要给每个分析复制一套
 *  `config / result` 路由（那会变成 6 个分析 × 3 个页面 = 18 条路由）。
 *
 * 分派规则（顺序即优先级）：
 *  1. `import` → 数据导入向导（它有自己的页面，不走配置页）
 *  2. 已接入 UI 的分析（`CONFIG_PAGES`）→ 真正的配置页
 *  3. 其余（规划中 / 后端就绪但 UI 待接入）→ 占位页，说明「会输出什么」
 *
 * 注意：未知 omicsId / 未知 analysisId 一律不 404 —— 占位页会给出
 * 「找不到 + 返回工作台」的引导，比白屏或 404 对用户友好得多。
 */
import { Navigate, useParams } from 'react-router-dom'
import { findAnalysis, findModule } from '@shared/modules'
import { routes } from '@shared/routes'
import { AnalysisConfigPage } from './AnalysisConfigPage'
import { PlannedAnalysisPage } from './PlannedAnalysisPage'

/**
 * 已接入真实配置页的分析。key = `${omicsId}/${analysisId}`，value = 页面组件。
 * 目前只有转录组的差异表达分析（`transcriptome/de`）；接入新分析时在这里加一行即可。
 *
 * ★ key 必须是「组学 + 分析」的复合键，不能只用 analysisId：
 *   `AnalysisEntry.id` 只需要在**本模块内**唯一（目录层），而配置页组件是按
 *   **执行语义**区分的。单细胞接入后 `scrna/cluster` 与 `spatial/cluster` 是两个
 *   不同实现（Seurat vs 空间聚类），若用裸 `cluster` 做 key，后注册的会静默覆盖
 *   先注册的 —— 不报错，但点进去跑的是另一个分析的页面。这类「看起来正常但是
 *   错的」故障比 404 难查得多。
 */
const CONFIG_PAGES: Record<string, () => JSX.Element> = {
  'transcriptome/de': () => <AnalysisConfigPage />
}

export function AnalysisEntryPage(): JSX.Element {
  const { omicsId, analysisId } = useParams<{ omicsId: string; analysisId: string }>()
  const module = findModule(omicsId ?? '')
  const entry = findAnalysis(omicsId ?? '', analysisId ?? '')

  // 1. 数据导入：地址统一收敛到 `/module/<id>/data`。
  //    但只有「该模块的导入能力可用」时才跳 —— 空转模块的「空间数据导入」是规划中的，
  //    跳过去会得到转录组的 bulk 矩阵向导，那是错误信息，必须留在占位页。
  if (analysisId === 'import' && entry?.status === 'available' && module) {
    return <Navigate to={routes.data(module.id)} replace />
  }

  // 2. 已接入配置页的分析：只有模块与分析都可用时才允许进入
  //    复合键 `${omicsId}/${analysisId}`：见 CONFIG_PAGES 的注释（防止跨模块撞 key）
  const ConfigPage =
    omicsId && analysisId ? CONFIG_PAGES[`${omicsId}/${analysisId}`] : undefined
  if (ConfigPage && module?.status === 'available' && entry?.status === 'available') {
    return ConfigPage()
  }

  // 3. 其余情况：占位页（含「分析不存在」的兜底）
  return <PlannedAnalysisPage />
}
