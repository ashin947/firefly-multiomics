/**
 * 错误横幅（§11.3：E_R_* / E_KEGG_NETWORK / E_UNKNOWN 的呈现方式）。
 *
 * 必须包含三样东西：中文标题、具体说明、建议动作。
 * 原始 R 日志折叠在「展开原始日志」里 —— 默认展开会让用户被几百行 stderr 吓到，
 * 但完全不给又会让技术支持无从下手。
 */
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import type { AppError } from '@shared/errors'

interface ErrorBannerProps {
  error: AppError
  onRetry?: () => void
  onDismiss?: () => void
}

export function ErrorBanner({ error, onRetry, onDismiss }: ErrorBannerProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = Boolean(error.detail && error.detail.trim().length > 0)

  return (
    <Alert
      severity="error"
      onClose={onDismiss}
      action={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {onRetry && (
            <Typography
              component="button"
              onClick={onRetry}
              sx={{
                border: 'none',
                background: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 12,
                textDecoration: 'underline',
                px: 1
              }}
            >
              重试
            </Typography>
          )}
          {hasDetail && (
            <IconButton
              size="small"
              color="inherit"
              onClick={() => setExpanded((v) => !v)}
              sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}
              aria-label="展开原始日志"
            >
              <ExpandMoreIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      }
    >
      <AlertTitle sx={{ mb: 0.5 }}>{error.title}</AlertTitle>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        {error.message}
      </Typography>
      {error.suggestion && (
        <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 500 }}>
          建议：{error.suggestion}
        </Typography>
      )}
      {hasDetail && (
        <Collapse in={expanded}>
          <Box
            component="pre"
            sx={{
              mt: 1,
              mb: 0,
              p: 1.25,
              maxHeight: 260,
              overflow: 'auto',
              backgroundColor: 'rgba(0,0,0,0.06)',
              borderRadius: 1,
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}
          >
            {error.detail}
          </Box>
        </Collapse>
      )}
    </Alert>
  )
}
