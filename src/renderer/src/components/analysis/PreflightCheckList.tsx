/**
 * 运行前预检清单。
 *
 * ★ 清单内容由主进程 `deg:analysis:preflight` 产出，本组件**不做任何判定**。
 *   历史实现里前端自己算一遍 5 项规则，与主进程 preflight 是两份实现 ——
 *   一旦漂移就会出现「清单全绿、点开始分析却报错」，这是最难向用户解释的状态。
 *   现在规则只有一份（`AnalysisRunner.collect`），这里只负责画。
 *
 * 空清单（还没拿到预检结果）时显示占位，而不是画一个「全绿」的假象。
 */
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { PreflightItem, PreflightLevel } from '@shared/types/analysis'

const LEVEL_ICON: Record<PreflightLevel, JSX.Element> = {
  ok: <CheckCircleOutlineIcon sx={{ fontSize: 15, color: 'success.main' }} />,
  warn: <WarningAmberIcon sx={{ fontSize: 15, color: 'warning.main' }} />,
  error: <ErrorOutlineIcon sx={{ fontSize: 15, color: 'error.main' }} />
}

interface PreflightCheckListProps {
  items: PreflightItem[]
  /** 预检进行中（参数刚改过，结果还在路上） */
  busy?: boolean
}

export function PreflightCheckList({ items, busy = false }: PreflightCheckListProps): JSX.Element {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, lineHeight: 1.7 }}>
        {busy ? '正在检查运行条件…' : '尚未取得预检结果。'}
      </Typography>
    )
  }

  return (
    <Stack spacing={0.75} sx={{ opacity: busy ? 0.55 : 1, transition: 'opacity .15s ease' }}>
      {items.map((item) => (
        <Stack key={item.id} direction="row" spacing={1} alignItems="flex-start">
          <Box sx={{ pt: '2px' }}>{LEVEL_ICON[item.level]}</Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body2"
              sx={{
                fontSize: 12,
                fontWeight: 600,
                color: item.level === 'error' ? 'error.main' : item.level === 'warn' ? 'warning.dark' : 'text.primary'
              }}
            >
              {item.label}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>
              {item.detail}
            </Typography>
          </Box>
        </Stack>
      ))}
    </Stack>
  )
}
