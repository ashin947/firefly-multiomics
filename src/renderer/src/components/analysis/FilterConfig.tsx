/**
 * 低表达过滤配置。
 *
 * 三种状态互斥，必须做成联动而不是三个独立开关：
 *   ① 不过滤（keepAllGenes）
 *   ② 自动过滤（edgeR::filterByExpr，按分组自动定阈值）
 *   ③ 自定义（表达量 ≥ X 且在 ≥ Y% 样本中检出）
 * 如果让用户同时勾上「不过滤」和「自定义」，后端就只能猜意图。
 */
import Box from '@mui/material/Box'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { DEConfig } from '@shared/types/analysis'

interface FilterConfigProps {
  filter: DEConfig['filter']
  keepAllGenes: boolean
  onChange: (patch: { filter?: DEConfig['filter']; keepAllGenes?: boolean }) => void
  disabled?: boolean
}

export function FilterConfig({ filter, keepAllGenes, onChange, disabled = false }: FilterConfigProps): JSX.Element {
  return (
    <Box>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={!keepAllGenes}
            disabled={disabled}
            onChange={(event) => onChange({ keepAllGenes: !event.target.checked })}
          />
        }
        label={
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              启用低表达基因过滤
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
              关闭后将保留全部基因（检验功效会下降，多重校正更严格）
            </Typography>
          </Box>
        }
        sx={{ m: 0, mb: 1.5, alignItems: 'flex-start', '& .MuiSwitch-root': { mt: -0.5 } }}
      />

      <Box sx={{ pl: 0.5, opacity: keepAllGenes ? 0.45 : 1, pointerEvents: keepAllGenes ? 'none' : 'auto' }}>
        <RadioGroup
          value={filter.mode}
          onChange={(event) =>
            onChange({ filter: { ...filter, mode: event.target.value as DEConfig['filter']['mode'] } })
          }
        >
          <FormControlLabel
            value="filterByExpr"
            disabled={disabled}
            control={<Radio size="small" />}
            label={
              <Typography variant="body2" sx={{ fontSize: 12 }}>
                自动过滤（edgeR::filterByExpr，按分组与文库大小自动定阈值）— 推荐
              </Typography>
            }
            sx={{ mb: 0.5 }}
          />
          <FormControlLabel
            value="custom"
            disabled={disabled}
            control={<Radio size="small" />}
            label={
              <Typography variant="body2" sx={{ fontSize: 12 }}>
                自定义阈值
              </Typography>
            }
          />
        </RadioGroup>

        {filter.mode === 'custom' && (
          <Stack direction="row" spacing={1.5} sx={{ mt: 1, pl: 4 }}>
            <TextField
              size="small"
              type="number"
              label="表达量 ≥"
              value={filter.minCount ?? 10}
              disabled={disabled}
              onChange={(event) =>
                onChange({ filter: { ...filter, minCount: Number(event.target.value) || 0 } })
              }
              sx={{ width: 120 }}
            />
            <TextField
              size="small"
              type="number"
              label="在 ≥ % 样本中检出"
              value={filter.minSamplesPct ?? 30}
              disabled={disabled}
              onChange={(event) =>
                onChange({ filter: { ...filter, minSamplesPct: Number(event.target.value) || 0 } })
              }
              sx={{ width: 150 }}
            />
          </Stack>
        )}
      </Box>

      <TextField
        size="small"
        select
        label="多重检验校正"
        value="BH"
        disabled
        sx={{ mt: 1.5, width: 180 }}
        helperText="第一版固定 BH（Benjamini-Hochberg）"
      >
        <MenuItem value="BH">BH</MenuItem>
      </TextField>
    </Box>
  )
}
