/**
 * 对比组选择 + 交换。
 *
 * 最容易做错的细节（客户特别点名）：交换后那句语义提示必须跟着变 ——
 * 「logFC > 0 表示在 Tumor 中上调」⇄ 「在 Normal 中上调」。
 * 用户看反了方向，整篇结论都是错的，所以这行文案用高亮底色强调。
 */
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

interface ContrastSelectorProps {
  groups: Record<string, string[]>
  groupColumn: string
  numerator: string
  denominator: string
  onChange: (numerator: string, denominator: string) => void
  onSwap: () => void
  disabled?: boolean
}

export function ContrastSelector({
  groups,
  groupColumn,
  numerator,
  denominator,
  onChange,
  onSwap,
  disabled = false
}: ContrastSelectorProps): JSX.Element {
  const groupNames = Object.keys(groups)

  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="分组列"
          value={groupColumn}
          disabled
          sx={{ width: 120 }}
          helperText="来自分组表"
        />
        <TextField
          size="small"
          select
          label="实验组（分子）"
          value={numerator}
          onChange={(event) => onChange(event.target.value, denominator)}
          disabled={disabled || groupNames.length === 0}
          sx={{ width: 168 }}
        >
          {groupNames.map((name) => (
            <MenuItem key={name} value={name} disabled={name === denominator}>
              {name}（{groups[name]?.length ?? 0} 例）
            </MenuItem>
          ))}
        </TextField>

        <Button
          size="small"
          variant="outlined"
          startIcon={<SwapHorizIcon />}
          onClick={onSwap}
          disabled={disabled || !numerator || !denominator}
          sx={{ mb: 2.25 }}
        >
          交换
        </Button>

        <TextField
          size="small"
          select
          label="对照组（分母）"
          value={denominator}
          onChange={(event) => onChange(numerator, event.target.value)}
          disabled={disabled || groupNames.length === 0}
          sx={{ width: 168 }}
        >
          {groupNames.map((name) => (
            <MenuItem key={name} value={name} disabled={name === numerator}>
              {name}（{groups[name]?.length ?? 0} 例）
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {numerator && denominator && (
        <Box
          sx={{
            mt: 1.25,
            px: 1.5,
            py: 1,
            borderRadius: 1.5,
            backgroundColor: '#EEF4FF',
            border: '1px solid #D6E4FF'
          }}
        >
          <Typography variant="body2" sx={{ fontSize: 12, color: '#245C42', fontWeight: 500 }}>
            当前对比：<strong>{numerator}</strong> vs <strong>{denominator}</strong> ｜ logFC &gt; 0 表示在{' '}
            <strong>{numerator}</strong> 中上调，logFC &lt; 0 表示在 <strong>{numerator}</strong> 中下调
          </Typography>
        </Box>
      )}

      {numerator && denominator && numerator === denominator && (
        <Typography variant="body2" sx={{ mt: 0.75, fontSize: 11.5, color: 'error.main' }}>
          实验组与对照组不能相同。
        </Typography>
      )}
    </Box>
  )
}
