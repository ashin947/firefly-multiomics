/**
 * 路由级错误兜底。
 *
 * ## 为什么需要它
 *
 * 客户点了一次 Venn 的交集行，页面直接变成一屏红字堆栈
 * （`TypeError: item.genes.join is not a function`）—— 整个应用不可用，
 * 只能重开。那条 bug 本身已经修了，但**一个字段的形状问题不该让整屏白**：
 * 只要渲染期抛一次异常，用户当前看到的东西、填了一半的参数全没了。
 *
 * 这个组件挂在根路由的 `errorElement` 上：子路由里任何未捕获的渲染异常
 * 都会被这里接住，显示「哪一步出错了 + 可以怎么办」，其余功能仍然可用。
 *
 * ## 为什么不做得更花哨
 *
 * 故意只给三样东西：错误信息原文（排障唯一线索）、返回工作台、重试。
 * 不加「自动上报」「一键修复」之类的承诺 —— 这类页面最忌讳说一套做不到的事，
 * 用户会照着提示做然后发现没用。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import { useNavigate, useRouteError } from 'react-router-dom'
import { routes } from '@shared/routes'

function describe(error: unknown): { title: string; detail: string } {
  if (error instanceof Error) {
    return { title: '页面渲染时出错', detail: `${error.name}: ${error.message}` }
  }
  if (typeof error === 'string') return { title: '页面渲染时出错', detail: error }
  try {
    return { title: '页面渲染时出错', detail: JSON.stringify(error) }
  } catch {
    return { title: '页面渲染时出错', detail: String(error) }
  }
}

export function RouteErrorBoundary(): JSX.Element {
  const error = useRouteError()
  const navigate = useNavigate()
  const { title, detail } = describe(error)

  return (
    <Box sx={{ p: 4, maxWidth: 760, mx: 'auto' }}>
      <Card variant="outlined" sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1.5 }}>
          <ErrorOutlineIcon sx={{ fontSize: 22, color: 'warning.main' }} />
          <Typography variant="h1" sx={{ fontSize: 20 }}>
            {title}
          </Typography>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, lineHeight: 1.8 }}>
          当前页面没能渲染出来。<strong>数据没有丢</strong> —— 项目文件在磁盘上，重试或回到工作台重新进入即可。
        </Typography>

        <Box
          component="pre"
          sx={{
            m: 0,
            mb: 2,
            p: 1.5,
            borderRadius: 1,
            backgroundColor: 'action.hover',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'text.secondary'
          }}
        >
          {detail}
        </Box>

        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" onClick={() => window.location.reload()}>
            重试
          </Button>
          <Button size="small" onClick={() => navigate(routes.workspace)}>
            返回工作台
          </Button>
        </Stack>

        <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10.5, mt: 2 }}>
          如果反复出现，请把上面这段信息发给开发者。
        </Typography>
      </Card>
    </Box>
  )
}
