/**
 * 数据问题清单（PRD §8.3 的 13 条规则都产出 Issue，这里统一呈现）。
 *
 * 每条必须给三样东西：定位、人话文案、建议动作。
 * 「定位」是 PRD 特别强调的精度要求（例如「第 4 列 S03 第 128 行为 NA_1」），
 * 所以这里把 locator 拼成一句可读的定位语，而不是把 JSON 丢给用户看。
 */
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import type { Issue, IssueLevel } from '@shared/types/dataset'

const LEVEL_META: Record<IssueLevel, { label: string; color: string; bg: string; border: string; dot: string }> = {
  error: { label: '错误', color: '#B3261E', bg: '#FDECEA', border: '#F5C2C0', dot: '#C62828' },
  warning: { label: '警告', color: '#8A5300', bg: '#FFF6E5', border: '#F3DCA8', dot: '#ED6C02' },
  info: { label: '提示', color: '#4A5563', bg: '#F4F6F9', border: '#E1E6ED', dot: '#8C97A5' }
}

/** 把 locator 拼成人话定位 */
export function formatLocator(issue: Issue): string | null {
  const locator = issue.locator
  if (!locator) return null
  const parts: string[] = []
  if (typeof locator.row === 'number') parts.push(`第 ${locator.row} 行`)
  if (locator.column) parts.push(`第 ${locator.column} 列`)
  if (locator.sample) parts.push(`样本 ${locator.sample}`)
  if (locator.gene) parts.push(`基因 ${locator.gene}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

interface IssueListProps {
  issues: readonly Issue[]
  /** 无问题时的文案（默认「未发现问题」） */
  emptyText?: string
  maxHeight?: number
}

export function IssueList({ issues, emptyText = '未发现问题，可以继续。', maxHeight = 320 }: IssueListProps): JSX.Element {
  if (issues.length === 0) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'success.main', py: 1.5 }}>
        <CheckCircleOutlineIcon fontSize="small" />
        <Typography variant="body2">{emptyText}</Typography>
      </Stack>
    )
  }

  const counts = {
    error: issues.filter((i) => i.level === 'error').length,
    warning: issues.filter((i) => i.level === 'warning').length,
    info: issues.filter((i) => i.level === 'info').length
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        {counts.error > 0 && <Chip size="small" label={`${counts.error} 个错误`} sx={{ backgroundColor: LEVEL_META.error.bg, color: LEVEL_META.error.color }} />}
        {counts.warning > 0 && <Chip size="small" label={`${counts.warning} 个警告`} sx={{ backgroundColor: LEVEL_META.warning.bg, color: LEVEL_META.warning.color }} />}
        {counts.info > 0 && <Chip size="small" label={`${counts.info} 条提示`} sx={{ backgroundColor: LEVEL_META.info.bg, color: LEVEL_META.info.color }} />}
      </Stack>

      <Stack spacing={1} sx={{ maxHeight, overflowY: 'auto', pr: 0.5 }}>
        {issues.map((issue, index) => {
          const meta = LEVEL_META[issue.level]
          const locator = formatLocator(issue)
          return (
            <Box
              key={`${issue.code}-${index}`}
              sx={{
                p: 1.25,
                borderRadius: 1.5,
                border: `1px solid ${meta.border}`,
                backgroundColor: meta.bg
              }}
            >
              <Stack direction="row" spacing={0.75} alignItems="flex-start">
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: meta.dot,
                    mt: '6px',
                    flex: '0 0 auto'
                  }}
                />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" sx={{ fontWeight: 600, color: meta.color }}>
                      {meta.label}
                    </Typography>
                    {locator && (
                      <Typography variant="body2" sx={{ color: meta.color, opacity: 0.85 }}>
                        {locator}
                      </Typography>
                    )}
                    {typeof issue.count === 'number' && issue.count > 1 && (
                      <Chip size="small" label={`共 ${issue.count} 处`} sx={{ height: 18, fontSize: 10 }} />
                    )}
                  </Stack>
                  <Typography variant="body2" sx={{ mt: 0.25, lineHeight: 1.65, color: '#2B3038' }}>
                    {issue.message}
                  </Typography>
                  {issue.suggestion && (
                    <Typography variant="body2" sx={{ mt: 0.25, color: 'text.secondary', lineHeight: 1.6 }}>
                      建议：{issue.suggestion}
                    </Typography>
                  )}
                </Box>
              </Stack>
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}
