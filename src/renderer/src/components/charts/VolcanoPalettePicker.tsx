/**
 * 火山图配色选择器：预设 + 自定义三色。
 *
 * 为什么预设要分「Nature 系」：这个产品的用户在投 SCI 期刊，期刊对配色的
 * 隐性审美好恶是真实存在的 —— 红蓝在 Nature 系稿件里最不容易被审稿人挑刺，
 * 而 ggplot 默认的彩虹色几乎必被要求改。所以把 NPG 的经典色板直接做成预设，
 * 省掉用户「自己配一个能过审的颜色」这一步。
 *
 * 自定义三个通道（下调 / 不显著 / 上调）而不是给一个取色器：火山图的语义就是
 * 三分类，用户要改的永远是「上调那个红偏暗了」，不是「随便挑个色」。
 */
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useMemo } from 'react'
import type { VolcanoColors } from './VolcanoChart'
import { paletteLabel, paletteOf, resolveVolcanoPresets, usePlotTheme } from './plotTheme'

/** 「自定义」在 Select 里的值（不可能是真实配色名） */
export const CUSTOM_PALETTE = '__custom__'

interface PalettePickerProps {
  /** 当前选中的预设名，或 CUSTOM_PALETTE */
  value: string
  onChange: (name: string) => void
  /** 自定义三色（选自定义时生效） */
  colors: VolcanoColors
  onColorsChange: (colors: VolcanoColors) => void
  disabled?: boolean
}

interface ColorFieldProps {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

function ColorField({ label, hint, value, onChange, disabled }: ColorFieldProps): JSX.Element {
  return (
    <Tooltip title={hint} placement="top" arrow>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25 }}>
        <Typography variant="body2" sx={{ fontSize: 10.5, color: 'text.secondary' }}>
          {label}
        </Typography>
        <Box
          component="input"
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          sx={{
            width: 34,
            height: 24,
            p: 0,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 0.75,
            cursor: disabled ? 'not-allowed' : 'pointer',
            backgroundColor: 'transparent',
            // 原生 color input 的内边距在 Chromium 里是 2px 白边，去掉才和按钮同高
            '&::-webkit-color-swatch-wrapper': { p: 0 },
            '&::-webkit-color-swatch': { border: 'none', borderRadius: '2px' }
          }}
        />
      </Box>
    </Tooltip>
  )
}

export function VolcanoPalettePicker({
  value,
  onChange,
  colors,
  onColorsChange,
  disabled = false
}: PalettePickerProps): JSX.Element {
  const theme = usePlotTheme()
  const presets = useMemo(() => resolveVolcanoPresets(theme), [theme])
  const isCustom = value === CUSTOM_PALETTE

  // 选中预设时，色块显示该预设的实际颜色，让用户在选之前就知道长什么样
  const preview = isCustom ? colors : previewOf(theme, value)

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <TextField
        select
        size="small"
        label="配色"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        SelectProps={{ native: true }}
        sx={{ width: 148, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
        InputLabelProps={{ shrink: true, sx: { fontSize: 12 } }}
      >
        {presets.map((name) => (
          <option key={name} value={name}>
            {paletteLabel(name)}
          </option>
        ))}
        <option value={CUSTOM_PALETTE}>自定义…</option>
      </TextField>

      <Stack direction="row" spacing={0.75} alignItems="center">
        <ColorField
          label="下调"
          hint={isCustom ? '下调基因点的颜色' : '切换到「自定义」后可改'}
          value={preview.down}
          disabled={disabled || !isCustom}
          onChange={(next) => onColorsChange({ ...colors, down: next })}
        />
        <ColorField
          label="不显著"
          hint={isCustom ? '不显著基因点的颜色' : '切换到「自定义」后可改'}
          value={preview.ns}
          disabled={disabled || !isCustom}
          onChange={(next) => onColorsChange({ ...colors, ns: next })}
        />
        <ColorField
          label="上调"
          hint={isCustom ? '上调基因点的颜色' : '切换到「自定义」后可改'}
          value={preview.up}
          disabled={disabled || !isCustom}
          onChange={(next) => onColorsChange({ ...colors, up: next })}
        />
      </Stack>
    </Stack>
  )
}

/** 预设名 → 三色预览 */
function previewOf(theme: Parameters<typeof paletteOf>[0], name: string): VolcanoColors {
  const palette = paletteOf(theme, name)
  return {
    down: palette[0] ?? '#2166AC',
    ns: palette[1] ?? '#B0B7C3',
    up: palette[2] ?? '#B2182B'
  }
}
