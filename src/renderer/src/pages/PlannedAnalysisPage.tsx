/**
 * 分析占位页（规划中 / 后端就绪但 UI 待接入）。
 *
 * 客户明确要求：规划中的分析不能只弹 toast，必须有页面说明「它会输出什么」。
 * 这决定了用户要不要等这个版本 —— 一句「敬请期待」是没信息量的。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useNavigate, useParams } from 'react-router-dom'
import { findAnalysis, findModule } from '@shared/modules'
import { routes } from '@shared/routes'
import { EmptyState } from '../components/common/EmptyState'
import { StatusBadge } from '../components/common/StatusBadge'
import { iconFor } from '../components/common/IconByKey'

export function PlannedAnalysisPage(): JSX.Element {
  const { omicsId, analysisId } = useParams<{ omicsId: string; analysisId: string }>()
  const navigate = useNavigate()
  const module = findModule(omicsId ?? '')
  const analysis = findAnalysis(omicsId ?? '', analysisId ?? '')

  if (!module || !analysis) {
    return (
      <Box sx={{ p: 4 }}>
        <EmptyState
          title="分析不存在"
          description={`找不到「${omicsId ?? ''} / ${analysisId ?? ''}」对应的分析条目。`}
          actionLabel="返回工作台"
          onAction={() => navigate(routes.workspace)}
        />
      </Box>
    )
  }

  const Icon = iconFor(analysis.icon)
  const planned = analysis.status === 'planned'

  return (
    <Box sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(routes.module(module.id))} sx={{ mb: 2 }}>
        返回{module.name}模块
      </Button>

      <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 2.5 }}>
        <Box
          sx={{
            width: 42,
            height: 42,
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: planned ? '#EDF2EE' : 'rgba(53,126,92,0.10)',
            color: planned ? 'text.disabled' : 'primary.main',
            flex: '0 0 auto'
          }}
        >
          <Icon sx={{ fontSize: 22 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="h1" sx={{ fontSize: 20 }}>
              {analysis.name}
            </Typography>
            <StatusBadge status={analysis.status} size="medium" />
          </Stack>
          <Typography variant="body1" color="text.secondary">
            {module.name} · {analysis.description}
          </Typography>
        </Box>
      </Stack>

      <Card variant="outlined" sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="h3" sx={{ mb: 1 }}>
          {planned ? '该分析将在后续版本提供' : '本页 UI 将在下一批次接入'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.85 }}>
          {analysis.note ??
            '该分析已列入产品路线。下面的输出清单是它交付时的形态，可用于评估是否满足你的分析需求。'}
        </Typography>
        {!planned && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="后端已就绪，前端页面待接入"
            sx={{ mt: 1.25, height: 22, fontSize: 11 }}
          />
        )}
      </Card>

      <Card variant="outlined" sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="h3" sx={{ mb: 1.25 }}>
          该分析会输出什么
        </Typography>
        <Stack spacing={1}>
          {(analysis.outputs ?? []).map((output, index) => (
            <Stack key={output} direction="row" spacing={1.25} alignItems="flex-start">
              <Box
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  backgroundColor: 'rgba(53,126,92,0.10)',
                  color: 'primary.main',
                  fontSize: 10.5,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: '0 0 auto',
                  mt: '2px'
                }}
              >
                {index + 1}
              </Box>
              <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
                {output}
              </Typography>
            </Stack>
          ))}
          {(analysis.outputs ?? []).length === 0 && (
            <Typography variant="body2" color="text.secondary">
              输出清单待补充。
            </Typography>
          )}
        </Stack>
      </Card>

      <Card variant="outlined" sx={{ p: 2.5, backgroundColor: '#FAFBFD' }}>
        <Typography variant="h3" sx={{ mb: 1 }}>
          输入要求
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.8 }}>
          {analysis.input}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25, fontSize: 11.5 }}>
          需要先完成前置步骤（数据导入与质控）。转录组模块的差异表达分析当前即可运行。
        </Typography>
        {module.status === 'available' && (
          <Button size="small" variant="outlined" sx={{ mt: 1.5 }} onClick={() => navigate(routes.data(module.id))}>
            去准备数据
          </Button>
        )}
      </Card>
    </Box>
  )
}
