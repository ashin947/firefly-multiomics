/**
 * 结果统计卡（上调 / 下调 / 不显著）。
 *
 * 三个数字必须与表格行数、火山图点数严格一致 —— 因此它们全部来自
 * `useThresholdFilter` 的同一份计数，组件内不做任何二次过滤。
 */
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { ThresholdState } from '@shared/types/analysis'
import type { ThresholdCounts } from '../../utils/threshold'

interface StatCardsProps {
  counts: ThresholdCounts
  thresholds: ThresholdState
}

interface CardSpec {
  key: 'up' | 'down' | 'ns'
  label: string
  color: string
  bg: string
  hint: string
}

const CARDS: CardSpec[] = [
  { key: 'up', label: '上调基因', color: '#B3261E', bg: '#FDECEA', hint: 'logFC > 0' },
  { key: 'down', label: '下调基因', color: '#245C42', bg: '#EEF4FF', hint: 'logFC < 0' },
  { key: 'ns', label: '不显著', color: '#5A6472', bg: '#F4F6F9', hint: '未达阈值' }
]

export function StatCards({ counts, thresholds }: StatCardsProps): JSX.Element {
  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5 }}>
        {CARDS.map((card) => (
          <Card key={card.key} variant="outlined" sx={{ p: 1.75, borderColor: 'divider' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
              {card.label}
            </Typography>
            <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 0.25 }}>
              <Typography sx={{ fontSize: 26, fontWeight: 700, color: card.color, lineHeight: 1.2 }}>
                {counts[card.key].toLocaleString()}
              </Typography>
              <Typography variant="body2" sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                {card.hint}
              </Typography>
            </Stack>
            <Box sx={{ mt: 0.75, height: 3, borderRadius: 2, backgroundColor: card.bg }}>
              <Box
                sx={{
                  height: 3,
                  borderRadius: 2,
                  backgroundColor: card.color,
                  width: `${counts.total > 0 ? (counts[card.key] / counts.total) * 100 : 0}%`,
                  transition: 'width .18s ease'
                }}
              />
            </Box>
          </Card>
        ))}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, fontSize: 10.5 }}>
        共 {counts.total.toLocaleString()} 个基因通过过滤 ｜ 当前阈值 logFC ≥ {thresholds.logFC.toFixed(1)} 且 FDR &lt;{' '}
        {thresholds.fdr.toFixed(3)}
      </Typography>
    </Box>
  )
}
