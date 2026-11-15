/**
 * 「独立页面尚未接入」占位页（作图 / 富集深链的落地页）。
 *
 * 存在的意义：`/module/transcriptome/plot/latest` 这类深链必须有页面，
 * 否则用户点到历史链接会看到 404 或白屏。
 * 这里明确说明「页面还没做 + 现在能用什么替代」，而不是假装功能存在，
 * 也不做「弹个 toast 就当处理过了」—— 客户明确要求要有页面。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useNavigate, useParams } from 'react-router-dom'
import { findModule } from '@shared/modules'
import { routes } from '@shared/routes'

interface NotYetPageProps {
  kind: 'plot' | 'enrich'
}

interface NotYetMeta {
  title: string
  /** 这个页面将来会有什么 */
  desc: string
  /** 现在能拿什么替代 */
  alternative: string
  /** 后端是否已就绪（决定徽标文案，避免让用户以为完全没做） */
  backendReady: boolean
}

const META: Record<NotYetPageProps['kind'], NotYetMeta> = {
  plot: {
    title: '独立作图页尚未接入',
    desc: '交互式作图页（热图 / PCA / 箱线图 / R 导出 300dpi PNG 与矢量 PDF）将在下一批次交付。',
    alternative: '火山图已经可以在「结果总览」里查看：阈值滑块拖动时，着色、统计卡与表格同步变化。',
    backendReady: false
  },
  enrich: {
    title: '富集分析页尚未接入',
    desc: 'GO / KEGG ORA 的前端页面与气泡图 / 条形图将在下一批次交付；R 侧富集脚本与注册表扩展点已就绪。',
    alternative: '当前可以先完成差异分析，在结果总览中勾选「只看显著」得到基因列表 —— 它就是富集分析的输入。',
    backendReady: true
  }
}

export function NotYetPage({ kind }: NotYetPageProps): JSX.Element {
  const navigate = useNavigate()
  const { omicsId } = useParams<{ omicsId: string }>()
  const module = findModule(omicsId ?? '')
  const meta = META[kind]
  const backTarget = omicsId ? routes.module(omicsId) : routes.workspace

  return (
    <Box sx={{ p: 3, maxWidth: 820, mx: 'auto' }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(backTarget)} sx={{ mb: 2 }}>
        返回{module?.name ?? '模块'}
      </Button>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        <Typography variant="h1" sx={{ fontSize: 20 }}>
          {meta.title}
        </Typography>
        <Chip size="small" variant="outlined" label="下一批次" />
        {meta.backendReady && (
          <Chip size="small" color="warning" variant="outlined" label="后端已就绪，前端页面待接入" />
        )}
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2.5 }}>
        {meta.desc}
      </Typography>

      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 1 }}>
          现在可以做什么
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.8 }}>
          {meta.alternative}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button
            size="small"
            variant="contained"
            onClick={() => navigate(omicsId ? routes.result(omicsId) : routes.workspace)}
          >
            查看结果总览
          </Button>
          <Button size="small" variant="outlined" onClick={() => navigate(backTarget)}>
            返回模块首页
          </Button>
        </Stack>
      </Card>
    </Box>
  )
}
