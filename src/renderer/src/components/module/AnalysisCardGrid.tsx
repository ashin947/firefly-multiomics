/**
 * 分析流程卡片网格（三个模块共用一套组件）。
 *
 * 两条产品约束：
 *  1. 规划中的分析**必须留在网格里**（客户要看到产品路线），只置灰 + 灰徽标；
 *  2. 点击规划中的卡片要进占位页，不能只弹 toast —— 用户需要知道「它会输出什么」，
 *     这决定了他们要不要等这个版本。
 */
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { useNavigate } from 'react-router-dom'
import type { AnalysisEntry, ModuleDef } from '@shared/modules'
import { routes } from '@shared/routes'
import { StatusBadge } from '../common/StatusBadge'
import { iconFor } from '../common/IconByKey'

interface AnalysisCardGridProps {
  module: ModuleDef
}

function AnalysisCard({ moduleId, analysis }: { moduleId: string; analysis: AnalysisEntry }): JSX.Element {
  const navigate = useNavigate()
  const Icon = iconFor(analysis.icon)
  const available = analysis.status === 'available'
  // 没有显式 route 的条目（规划中 / 后端就绪但 UI 待接入）统一落到分析入口，
  // 由 AnalysisEntryPage 分派到占位页 —— 绝不出现「点了没反应」的卡片。
  const target = analysis.route ?? routes.analysis(moduleId, analysis.id)

  return (
    <Card
      variant="outlined"
      sx={{
        position: 'relative',
        borderColor: available ? '#D3E7DB' : '#E2EAE4',
        backgroundColor: available ? '#FFFFFF' : '#FAFBFC',
        transition: 'all .16s ease',
        '&:hover': {
          borderColor: available ? 'primary.main' : '#C9D2DE',
          boxShadow: available ? '0 4px 14px rgba(53,126,92,0.10)' : '0 2px 8px rgba(0,0,0,0.04)',
          transform: 'translateY(-1px)'
        }
      }}
    >
      <CardActionArea onClick={() => navigate(target)} sx={{ p: 2, height: '100%', display: 'block' }}>
        <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: available ? 'rgba(53,126,92,0.10)' : '#EDF2EE',
              color: available ? 'primary.main' : 'text.disabled',
              flex: '0 0 auto'
            }}
          >
            <Icon sx={{ fontSize: 18 }} />
          </Box>
          <StatusBadge status={analysis.status} />
        </Stack>

        <Typography
          variant="body1"
          sx={{ mt: 1.25, fontWeight: 600, fontSize: 13.5, color: available ? 'text.primary' : 'text.secondary' }}
        >
          {analysis.name}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.5, fontSize: 11.5, lineHeight: 1.6, minHeight: 36 }}
        >
          {analysis.description}
        </Typography>

        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 1.25 }}>
          <Typography variant="body2" sx={{ fontSize: 10.5, color: 'text.disabled' }}>
            输入：{analysis.input}
          </Typography>
          <ArrowForwardIcon sx={{ fontSize: 14, color: available ? 'primary.main' : 'text.disabled' }} />
        </Stack>
      </CardActionArea>
    </Card>
  )
}

export function AnalysisCardGrid({ module }: AnalysisCardGridProps): JSX.Element {
  return (
    <Box
      sx={{
        display: 'grid',
        // 3 列（响应式）：minmax 下限 300px 保证 1440 宽度下正好 3 列，
        // 窗口变窄时自动降到 2 列 / 1 列，不会把卡片挤成一条竖线。
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 1.75
      }}
    >
      {module.analyses.map((analysis) => (
        <AnalysisCard key={analysis.id} moduleId={module.id} analysis={analysis} />
      ))}
    </Box>
  )
}
