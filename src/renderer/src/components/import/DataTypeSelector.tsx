/**
 * 数据类型选择（counts / 已归一化）。
 *
 * 联动提示是这个组件的重点：选「已归一化」时 DESeq2 将不可用（它要求整数 counts），
 * 必须当场告诉用户，而不是等他在分析配置页发现方法被置灰。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { DATA_TYPES, DATA_TYPE_LABELS } from '@shared/constants'
import type { DataType } from '@shared/types/project'

interface DataTypeSelectorProps {
  value: DataType
  onChange: (value: DataType) => void
  disabled?: boolean
}

const DESCRIPTIONS: Record<DataType, string> = {
  counts: '原始测序 read counts（非负整数）。可用 limma-voom 或 DESeq2。',
  normalized: '已归一化的 log2 表达值（可含小数）。只能用 limma 线性模型，DESeq2 不可选。'
}

export function DataTypeSelector({ value, onChange, disabled = false }: DataTypeSelectorProps): JSX.Element {
  return (
    <Box>
      <RadioGroup
        value={value}
        onChange={(event) => onChange(event.target.value as DataType)}
        row={false}
      >
        <Stack spacing={1}>
          {DATA_TYPES.map((type) => (
            <Box
              key={type}
              sx={{
                px: 1.5,
                py: 1,
                borderRadius: 1.5,
                border: '1px solid',
                borderColor: value === type ? 'primary.main' : 'divider',
                backgroundColor: value === type ? 'rgba(53,126,92,0.04)' : '#FFFFFF',
                opacity: disabled ? 0.6 : 1
              }}
            >
              <FormControlLabel
                value={type}
                disabled={disabled}
                control={<Radio size="small" />}
                label={
                  <Box>
                    <Typography variant="body1" sx={{ fontWeight: 600, fontSize: 13 }}>
                      {DATA_TYPE_LABELS[type]}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, lineHeight: 1.6 }}>
                      {DESCRIPTIONS[type]}
                    </Typography>
                  </Box>
                }
                sx={{ m: 0, alignItems: 'flex-start', '& .MuiRadio-root': { pt: 0.25 } }}
              />
            </Box>
          ))}
        </Stack>
      </RadioGroup>

      {value === 'normalized' && (
        <Alert severity="info" sx={{ mt: 1.25, py: 0.25 }}>
          已选择「已归一化」：分析配置页的 <strong>DESeq2</strong> 卡片会置灰（它要求整数 counts），
          请使用 limma 线性模型。
        </Alert>
      )}
    </Box>
  )
}
