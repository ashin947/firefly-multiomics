/**
 * 图片导出设置（格式 + 物理尺寸 + 分辨率）。
 *
 * ## 为什么必须让用户选尺寸
 *
 * 科研出图的尺寸不是"看着差不多就行"：
 *  - 期刊单栏图通常 3.5 英寸宽、双栏 7 英寸；
 *  - 投稿系统会检查「图片宽度 ≥ 某英寸 且 ≥ 300 dpi」，不达标直接退稿；
 *  - 同一张图放 PPT 和放论文，需要的物理尺寸完全不同。
 *
 * 所以导出必须按**物理尺寸 + dpi** 来，而不是"把屏幕上的图截下来"。
 * PNG 走离屏 canvas 按目标像素重渲染，PDF 走离屏 SVG 按目标尺寸排版。
 *
 * ## 为什么给预设
 *
 * 让用户自己算「3.5 英寸 @ 300dpi = 1050 像素」既没必要也容易错。
 * 三个预设覆盖绝大多数场景，同时保留手动输入。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'
import type { ExportSize } from '../charts/ChartHost'
import { usePlotTheme } from '../charts/plotTheme'

export type ExportFormat = 'png' | 'pdf'

/** 常用版式（英寸），按国内期刊/学位论文的常见要求给 */
const PRESETS: { label: string; widthIn: number; heightIn: number }[] = [
  { label: '单栏 3.5×2.5', widthIn: 3.5, heightIn: 2.5 },
  { label: '双栏 7×4.5', widthIn: 7, heightIn: 4.5 },
  { label: '整页 7.5×9', widthIn: 7.5, heightIn: 9 }
]

interface PlotExportDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (format: ExportFormat, size: ExportSize) => void
  /** 导出进行中：锁住按钮，避免连点产生多个保存对话框 */
  busy?: boolean
}

export function PlotExportDialog({ open, onClose, onConfirm, busy = false }: PlotExportDialogProps): JSX.Element {
  const theme = usePlotTheme()
  const [format, setFormat] = useState<ExportFormat>('png')
  const [widthIn, setWidthIn] = useState(theme.defaults.widthIn)
  const [heightIn, setHeightIn] = useState(theme.defaults.heightIn)
  const [dpi, setDpi] = useState(theme.defaults.dpi)

  // 每次打开都用主题里的默认值重置：上一次调成 7.5×9 不该影响下一次随手导出
  useEffect(() => {
    if (!open) return
    setFormat('png')
    setWidthIn(theme.defaults.widthIn)
    setHeightIn(theme.defaults.heightIn)
    setDpi(theme.defaults.dpi)
  }, [open, theme.defaults.widthIn, theme.defaults.heightIn, theme.defaults.dpi])

  const pxWidth = Math.round(widthIn * dpi)
  const pxHeight = Math.round(heightIn * dpi)
  const invalid = !Number.isFinite(widthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || heightIn <= 0

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 16, pb: 1 }}>导出图片</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              格式
            </Typography>
            <RadioGroup
              row
              value={format}
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              <FormControlLabel
                value="png"
                control={<Radio size="small" />}
                label={<Typography variant="body2" sx={{ fontSize: 12 }}>PNG 位图</Typography>}
              />
              <FormControlLabel
                value="pdf"
                control={<Radio size="small" />}
                label={<Typography variant="body2" sx={{ fontSize: 12 }}>PDF 矢量图</Typography>}
              />
            </RadioGroup>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mt: 0.25 }}>
              {format === 'pdf'
                ? '矢量，放大不失真，适合投稿与印刷'
                : '位图，适合插入 PPT / Word，按下方 dpi 输出'}
            </Typography>
          </Box>

          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              常用尺寸
            </Typography>
            <ToggleButtonGroup size="small" exclusive sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}>
              {PRESETS.map((preset) => (
                <ToggleButton
                  key={preset.label}
                  value={preset.label}
                  selected={widthIn === preset.widthIn && heightIn === preset.heightIn}
                  onClick={() => {
                    setWidthIn(preset.widthIn)
                    setHeightIn(preset.heightIn)
                  }}
                >
                  {preset.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              type="number"
              label="宽度（英寸）"
              value={widthIn}
              onChange={(event) => setWidthIn(Number(event.target.value))}
              inputProps={{ min: 1, max: 20, step: 0.1, style: { fontSize: 12 } }}
              InputLabelProps={{ sx: { fontSize: 11 } }}
              fullWidth
            />
            <TextField
              size="small"
              type="number"
              label="高度（英寸）"
              value={heightIn}
              onChange={(event) => setHeightIn(Number(event.target.value))}
              inputProps={{ min: 1, max: 20, step: 0.1, style: { fontSize: 12 } }}
              InputLabelProps={{ sx: { fontSize: 11 } }}
              fullWidth
            />
          </Stack>

          <TextField
            size="small"
            type="number"
            label="分辨率 dpi"
            value={dpi}
            disabled={format === 'pdf'}
            onChange={(event) => setDpi(Number(event.target.value))}
            inputProps={{ min: 72, max: 1200, step: 50, style: { fontSize: 12 } }}
            InputLabelProps={{ sx: { fontSize: 11 } }}
            helperText={format === 'pdf' ? 'PDF 是矢量，与 dpi 无关' : '期刊通常要求 ≥300'}
            FormHelperTextProps={{ sx: { fontSize: 10.5, mx: 0 } }}
          />

          <Box sx={{ px: 1.25, py: 1, backgroundColor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
              {format === 'png'
                ? `输出约 ${pxWidth.toLocaleString()} × ${pxHeight.toLocaleString()} 像素（${widthIn} × ${heightIn} 英寸 @ ${dpi} dpi）`
                : `页面 ${widthIn} × ${heightIn} 英寸，内容为矢量，可无限放大`}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button size="small" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={invalid || busy}
          onClick={() => onConfirm(format, { widthIn, heightIn, dpi })}
        >
          {busy ? '导出中…' : '选择保存位置'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
