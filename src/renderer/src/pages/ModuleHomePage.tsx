/**
 * 模块首页（三个组学模块共用一套模板）。
 *
 * 模板固定三段：模块标题区 → 分析流程卡片网格 → 该模块的最近任务。
 * 「最近任务」在模块未开放时显示引导文案而不是空白表格 ——
 * 客户看 UI 时最怕的就是大片空白，会误以为功能坏了。
 *
 * 路由参数是 `:omicsId`（与 `@shared/routes` 一致），不要写成 `moduleId`，
 * 否则 useParams 拿到 undefined、页面会误报「模块不存在」。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import HistoryIcon from '@mui/icons-material/History'
import { useNavigate, useParams } from 'react-router-dom'
import { findModule } from '@shared/modules'
import { routes } from '@shared/routes'
import { AnalysisCardGrid } from '../components/module/AnalysisCardGrid'
import { ModuleHeader } from '../components/module/ModuleHeader'
import { EmptyState } from '../components/common/EmptyState'
import { useProjectStore } from '../store/projectStore'
import { formatDateTime, formatDuration } from '../utils/formatting'

export function ModuleHomePage(): JSX.Element {
  const { omicsId } = useParams<{ omicsId: string }>()
  const navigate = useNavigate()
  const module = findModule(omicsId ?? '')
  const meta = useProjectStore((s) => s.meta)

  if (!module) {
    return (
      <Box sx={{ p: 4 }}>
        <EmptyState
          title="模块不存在"
          description={`找不到模块「${omicsId ?? ''}」，可能链接已过期。`}
          actionLabel="返回工作台"
          onAction={() => navigate(routes.workspace)}
        />
      </Box>
    )
  }

  const availableCount = module.analyses.filter((a) => a.status === 'available').length
  // 只有「会留下运行记录」的模块才展示项目里的分析记录。
  // `AnalysisSnapshot` 目前不带 omicsId，所以不能按 omicsId 过滤 —— 只能用模块
  // 自己声明要不要看这份记录。绘图模块是即时出图、不写 analyses，如果不看这个
  // 标记，它会把转录组跑过的差异分析列成自己的「最近任务」。
  const analyses = module.tracksRuns ? meta?.analyses ?? [] : []
  const hasImport = module.analyses.some((a) => a.id === 'import')
  const dataPath = routes.data(module.id)

  return (
    <Box sx={{ p: 3, maxWidth: 1360, mx: 'auto' }}>
      <ModuleHeader
        module={module}
        actions={
          module.status !== 'available' ? (
            <Chip size="small" label="该模块规划中" variant="outlined" />
          ) : hasImport ? (
            <Button size="small" variant="contained" onClick={() => navigate(dataPath)}>
              开始导入数据
            </Button>
          ) : null
          // 没有导入流程的模块（绘图）不显示这个按钮。
          // 之前是「显示但禁用」，在绘图模块首页右上角挂一个灰掉的
          // 「开始导入数据」—— 用户会以为功能坏了或者自己没权限，
          // 而这个动作在这个模块里根本不存在。
        }
      />

      {module.status === 'planned' && (
        <Card
          variant="outlined"
          sx={{ p: 2, mb: 2.5, backgroundColor: '#F7FBF8', borderStyle: 'dashed', borderColor: '#D8DFE9' }}
        >
          <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8 }}>
            该模块已列入产品路线，界面与流程按最终形态呈现，<strong>功能尚未开放</strong>。
            点击任意分析卡片可以查看它计划输出什么；转录组模块当前即可使用。
          </Typography>
        </Card>
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.25 }}>
        <Typography variant="h3">分析流程</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
          共 {module.analyses.length} 项，其中 {availableCount} 项可用
        </Typography>
      </Stack>

      <AnalysisCardGrid module={module} />

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 3, mb: 1.25 }}>
        <HistoryIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Typography variant="h3">最近任务</Typography>
      </Stack>

      {analyses.length === 0 ? (
        <Card variant="outlined" sx={{ p: 1 }}>
          <EmptyState
            compact
            title={
              module.tracksRuns
                ? module.status === 'available'
                  ? '还没有分析记录'
                  : '模块尚未开放，暂无任务'
                : '这个模块不产生任务记录'
            }
            description={
              module.tracksRuns
                ? module.status === 'available'
                  ? '从「数据导入与质控」开始：导入表达矩阵与分组表，校验通过后即可运行差异分析。'
                  : '模块开放后，这里的任务会与转录组模块一样按时间倒序展示。'
                : '选一张图直接出图，改参数就重画，结果不写进项目 —— 所以这里不会有任务列表。'
            }
            actionLabel={
              module.tracksRuns && module.status === 'available' ? '去导入数据' : undefined
            }
            onAction={
              module.tracksRuns && module.status === 'available' ? () => navigate(dataPath) : undefined
            }
          />
        </Card>
      ) : (
        <Stack spacing={1}>
          {analyses
            .slice()
            .reverse()
            .slice(0, 5)
            .map((analysis) => (
              // 用 CardActionArea 而不是给 Card 挂 onClick：前者渲染成真正的 <button>，
              // 键盘可以 Tab 聚焦 + Enter 触发，读屏也会念出「按钮」。只挂 onClick 的 div
              // 对键盘用户等于死链。
              <Card key={analysis.id} variant="outlined">
                <CardActionArea
                  onClick={() => navigate(routes.result(module.id, analysis.id))}
                  sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 2 }}
                >
                  <Box sx={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                    <Typography variant="body1" sx={{ fontWeight: 600, fontSize: 13 }}>
                      {analysis.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                      {formatDateTime(analysis.createdAt)} · 耗时 {formatDuration(analysis.durationMs)} · 显著基因{' '}
                      {analysis.stats.upCount + analysis.stats.downCount}
                    </Typography>
                  </Box>
                  <Chip size="small" label="查看结果" variant="outlined" sx={{ height: 22, fontSize: 11 }} />
                </CardActionArea>
              </Card>
            ))}
        </Stack>
      )}
    </Box>
  )
}
