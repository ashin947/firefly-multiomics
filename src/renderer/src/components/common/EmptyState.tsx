/**
 * 空态占位。
 *
 * 桌面软件里空态出现频率很高（首次启动、无最近项目、模块未接入），
 * 一个只有「暂无数据」四个字的空态会让用户以为软件坏了，
 * 因此统一要求：图标 + 一句解释 + 一个可点的下一步。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  /** 紧凑模式（卡片内嵌时用） */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  compact = false
}: EmptyStateProps): JSX.Element {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 1,
        py: compact ? 3 : 6,
        px: 2
      }}
    >
      {icon && <Box sx={{ color: 'text.disabled', display: 'flex', '& svg': { fontSize: compact ? 28 : 40 } }}>{icon}</Box>}
      <Typography variant={compact ? 'body2' : 'body1'} sx={{ fontWeight: 500, color: 'text.secondary' }}>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, lineHeight: 1.7 }}>
          {description}
        </Typography>
      )}
      {actionLabel && onAction && (
        <Button size="small" variant="outlined" onClick={onAction} sx={{ mt: 1 }}>
          {actionLabel}
        </Button>
      )}
    </Box>
  )
}
