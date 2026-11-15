/**
 * 阈值滑块（logFC 0–4 / FDR 0–0.2）。
 *
 * 性能：拖动时每秒可能触发上百次 onChange，直接写 store 会让结果表（5000 行）
 * 与图表跟着重渲染。这里用 requestAnimationFrame 节流到「每帧最多一次」，
 * 既保证视觉跟手（60fps），又把重算次数压到最小。
 *
 * 语义提示固定写在下方：「logFC ≥ X 且 FDR < Y」——
 * 把 `>=` 与 `<` 的差异直接摆在用户面前，避免与 QA 的边界值理解不一致。
 */
import Box from '@mui/material/Box'
import InputAdornment from '@mui/material/InputAdornment'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useRef } from 'react'
import { useThresholdStore } from '../../store/thresholdStore'

/** rAF 节流：同一帧内多次调用只提交最后一次 */
function useRafCommit(commit: (value: number) => void): (value: number) => void {
  const frameRef = useRef<number | null>(null)
  const latestRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  return useCallback(
    (value: number) => {
      latestRef.current = value
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        commit(latestRef.current)
      })
    },
    [commit]
  )
}

interface ThresholdSliderProps {
  disabled?: boolean
}

export function ThresholdSlider({ disabled = false }: ThresholdSliderProps): JSX.Element {
  const logFC = useThresholdStore((s) => s.logFC)
  const fdr = useThresholdStore((s) => s.fdr)
  const basis = useThresholdStore((s) => s.basis)
  const setLogFC = useThresholdStore((s) => s.setLogFC)
  const setFdr = useThresholdStore((s) => s.setFdr)
  const setBasis = useThresholdStore((s) => s.setBasis)
  const reset = useThresholdStore((s) => s.reset)
  const pLabel = basis === 'pValue' ? 'P 值' : 'FDR'

  const commitLogFC = useRafCommit(setLogFC)
  const commitFdr = useRafCommit(setFdr)

  return (
    <Stack spacing={1.75} sx={{ width: '100%' }}>
      {/*
        ★ 判定依据放在最上面，因为它决定下面两个阈值的含义、也决定火山图纵轴画什么。
        以前纵轴固定 -log10(P)、判定却用 FDR，用户会看到「虚线以上的点没判为显著」——
        图上的一切必须来自同一列，这张图才能拿去写文章。
      */}
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
          显著性依据
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          fullWidth
          value={basis}
          disabled={disabled}
          onChange={(_, value) => {
            if (value) setBasis(value)
          }}
          sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="adjPValue">校正 P 值（FDR）</ToggleButton>
          <ToggleButton value="pValue">原始 P 值</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5, lineHeight: 1.5 }}>
          火山图纵轴、着色与结果表高亮均按此列计算
        </Typography>
      </Box>

      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            logFC 阈值
          </Typography>
          <TextField
            size="small"
            type="number"
            value={logFC}
            disabled={disabled}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) setLogFC(next)
            }}
            inputProps={{ min: 0, max: 4, step: 0.1, style: { fontSize: 12, padding: '4px 6px' } }}
            sx={{ width: 86 }}
            InputProps={{ startAdornment: <InputAdornment position="start">≥</InputAdornment> }}
          />
        </Stack>
        <Slider
          size="small"
          value={logFC}
          min={0}
          max={4}
          step={0.1}
          disabled={disabled}
          onChange={(_, value) => commitLogFC(Array.isArray(value) ? value[0] : value)}
          marks={[
            { value: 0, label: '0' },
            { value: 1, label: '1.0' },
            { value: 2, label: '2.0' },
            { value: 4, label: '4.0' }
          ]}
          sx={{ '& .MuiSlider-markLabel': { fontSize: 10 } }}
        />
      </Box>

      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {pLabel === 'FDR' ? 'FDR 阈值' : 'P 值阈值'}
          </Typography>
          <TextField
            size="small"
            type="number"
            value={fdr}
            disabled={disabled}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) setFdr(next)
            }}
            inputProps={{ min: 0, max: 0.2, step: 0.005, style: { fontSize: 12, padding: '4px 6px' } }}
            sx={{ width: 86 }}
            InputProps={{ startAdornment: <InputAdornment position="start">&lt;</InputAdornment> }}
          />
        </Stack>
        <Slider
          size="small"
          value={fdr}
          min={0}
          max={0.2}
          step={0.005}
          disabled={disabled}
          onChange={(_, value) => commitFdr(Array.isArray(value) ? value[0] : value)}
          marks={[
            { value: 0, label: '0' },
            { value: 0.05, label: '0.05' },
            { value: 0.1, label: '0.10' },
            { value: 0.2, label: '0.20' }
          ]}
          sx={{ '& .MuiSlider-markLabel': { fontSize: 10 } }}
        />
      </Box>

      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
          显著 = logFC ≥ {logFC.toFixed(1)} 且 {pLabel} &lt; {fdr.toFixed(3)}
        </Typography>
        <Typography
          component="button"
          onClick={reset}
          sx={{
            border: 'none',
            background: 'none',
            color: 'primary.main',
            cursor: 'pointer',
            fontSize: 11,
            textDecoration: 'underline',
            p: 0
          }}
        >
          恢复默认
        </Typography>
      </Stack>
    </Stack>
  )
}
