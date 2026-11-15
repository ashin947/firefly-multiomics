/**
 * 路由表（HashRouter）。
 *
 * 为什么用 hash 而不是 browser history：生产期页面通过 `file://` 加载，
 * history 模式下刷新/深链会 404。hash 在 Electron 里是唯一稳的方案。
 *
 * 结构（与 docs/ARCHITECTURE-MODULES.md §3.1 对齐，两级）：
 *   /                                        工作台
 *   /module/:omicsId                         模块首页
 *   /module/:omicsId/data                    数据导入（按组学分派子向导）
 *   /module/:omicsId/analysis/:analysisId    分析配置（analysisId 决定分析类型）
 *   /module/:omicsId/result/:runId           结果总览（runId=latest 表示当前活动分析）
 *   /module/:omicsId/plot/:runId             作图（下一批次）
 *   /module/:omicsId/enrich/:runId           富集
 *   /module/:omicsId/{venn,violin,survival}  绘图模块三张图
 *   /settings                                设置 / 诊断
 *
 * ★ 为什么 analysisId 必须在路径里而不是写死 `/de/config`：
 *   转录组会有 de / gsea / wgcna，单细胞会有 cluster / annotate …
 *   把分析类型放进路径，新增分析时**不需要改本文件**，也不需要给每个分析
 *   复制一套 config/result 路由；分派逻辑集中在 AnalysisEntryPage。
 *
 * ★ 未知 omicsId / 未知 analysisId 一律不 404：模块页与占位页都会给出
 *   「未找到 + 返回工作台」的引导（见 ModuleHomePage / PlannedAnalysisPage）。
 *
 * ★ 所有地址由 `@shared/routes` 生成，页面里不要再拼裸字符串。
 */
import { Navigate, createHashRouter } from 'react-router-dom'
import { routes } from '@shared/routes'
import { AppShell } from './components/layout/AppShell'
import { RouteErrorBoundary } from './components/common/RouteErrorBoundary'
import { AnalysisEntryPage } from './pages/AnalysisEntryPage'
import { ImportWizardPage } from './pages/ImportWizardPage'
import { ModuleHomePage } from './pages/ModuleHomePage'
import { NotYetPage } from './pages/NotYetPage'
import { ResultPage } from './pages/ResultPage'
import { EnrichPage } from './pages/EnrichPage'
import { GseaPage } from './pages/GseaPage'
import { TimeSeriesPage } from './pages/TimeSeriesPage'
import { WgcnaPage } from './pages/WgcnaPage'
import { ScRnaPipelinePage } from './pages/ScRnaPipelinePage'
import { VennPage } from './pages/VennPage'
import { ViolinPage } from './pages/ViolinPage'
import { SurvivalPage } from './pages/SurvivalPage'
import { SettingsPage } from './pages/SettingsPage'
import { WorkspacePage } from './pages/WorkspacePage'

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    // 任何子路由渲染期抛异常都在这里接住：显示可读信息 + 重试/回工作台，
    // 而不是让用户对着一屏红字堆栈重开应用
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <WorkspacePage /> },

      // 组学模块（转录组 / 单细胞 / 空转 / 更多 共用同一套页面）
      { path: 'module/:omicsId', element: <ModuleHomePage /> },
      { path: 'module/:omicsId/data', element: <ImportWizardPage /> },
      { path: 'module/:omicsId/analysis/:analysisId', element: <AnalysisEntryPage /> },
      { path: 'module/:omicsId/result/:runId', element: <ResultPage /> },

      // 作图 / 富集：独立页面未交付，路由先占位（深链不会 404）
      { path: 'module/:omicsId/plot/:runId', element: <NotYetPage kind="plot" /> },
      { path: 'module/:omicsId/enrich/:runId', element: <EnrichPage /> },
      { path: 'module/:omicsId/gsea', element: <GseaPage /> },
      { path: 'module/:omicsId/timeseries', element: <TimeSeriesPage /> },
      // WGCNA：两段式（先定 β 再建网络），结果靠 ?wgcnaId= 从磁盘恢复
      { path: 'module/:omicsId/wgcna', element: <WgcnaPage /> },
      // 单细胞：九步流水线，只有第 1 步（导入）可点，其余在页内灰显
      { path: 'module/:omicsId/pipeline', element: <ScRnaPipelinePage /> },

      // 绘图模块：三张即时出图的工具页，没有 runId（不产生可回访的运行记录）
      { path: 'module/:omicsId/venn', element: <VennPage /> },
      { path: 'module/:omicsId/violin', element: <ViolinPage /> },
      { path: 'module/:omicsId/survival', element: <SurvivalPage /> },

      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to={routes.workspace} replace /> }
    ]
  }
])
