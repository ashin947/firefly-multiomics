/**
 * 重复基因聚合策略对话框 —— **数据正确性的关口**。
 *
 * 为什么必须强制选择：
 *  表达矩阵的 rownames 不允许重复，R 会直接报错；如果软件「自作聪明」地
 *  取均值或直接丢弃，用户会在完全不知情的情况下得到一份被篡改的数据。
 *  所以这里不给默认值、不允许跳过，必须由用户明确选择 4 种策略之一。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import type { DuplicateGeneChoice, DuplicateStrategy } from '@shared/types/dataset'

/** 4 种策略的中文解释（顺序固定：均值/求和/最大/第一条） */
export const STRATEGY_DESCRIPTIONS: Record<DuplicateStrategy, string> = {
  mean: '取均值：把重复行的表达量按样本求平均。最稳妥的默认选择，适合同名探针映射到同一基因。',
  sum: '求和：把重复行的表达量相加。适合同一基因被拆成多个转录本/外显子分别定量的矩阵。',
  max: '保留最大表达：取各样本中表达量最大的那一行。适合「只关心该基因是否高表达」的场景。',
  first: '保留第一条：只保留首次出现的那一行，其余丢弃。适合重复行是明显冗余的导出错误。'
}

interface DuplicateStrategyDialogProps {
  open: boolean
  choice: DuplicateGeneChoice
  /** 用户确认后回调（传入所选策略） */
  onConfirm: (strategy: DuplicateStrategy) => void
  onCancel: () => void
  submitting?: boolean
}

export function DuplicateStrategyDialog({
  open,
  choice,
  onConfirm,
  onCancel,
  submitting = false
}: DuplicateStrategyDialogProps): JSX.Element {
  const [strategy, setStrategy] = useState<DuplicateStrategy | null>(null)

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pb: 1 }}>
        发现 {choice.totalDuplicateGenes} 个重复基因名
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, lineHeight: 1.7 }}>
          重复基因名会让分析无法进行（基因不能作为重复的行名）。请选择一种合并方式，
          <strong>软件不会替你决定</strong>。
        </Typography>

        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`${choice.totalDuplicateGenes} 个重名`} />
          <Chip size="small" label={`涉及 ${choice.affectedRows} 行`} />
          {choice.names.slice(0, 3).map((item) => (
            <Chip key={item.name} size="small" variant="outlined" label={`${item.name} ×${item.count}`} sx={{ fontFamily: 'monospace' }} />
          ))}
          {choice.names.length > 3 && (
            <Chip size="small" variant="outlined" label={`等 ${choice.names.length} 个`} />
          )}
        </Stack>

        <RadioGroup value={strategy ?? ''} onChange={(event) => setStrategy(event.target.value as DuplicateStrategy)}>
          <Stack spacing={1}>
            {choice.strategies.map((option) => (
              <Box
                key={option.value}
                sx={{
                  px: 1.5,
                  py: 0.75,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: strategy === option.value ? 'primary.main' : 'divider',
                  backgroundColor: strategy === option.value ? 'rgba(53,126,92,0.04)' : '#FFFFFF'
                }}
              >
                <FormControlLabel
                  value={option.value}
                  control={<Radio size="small" />}
                  label={
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {option.label}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, lineHeight: 1.6 }}>
                        {STRATEGY_DESCRIPTIONS[option.value]}
                      </Typography>
                    </Box>
                  }
                  sx={{ m: 0, alignItems: 'flex-start', '& .MuiRadio-root': { pt: 0.25 } }}
                />
              </Box>
            ))}
          </Stack>
        </RadioGroup>

        {!strategy && (
          <Typography variant="body2" sx={{ mt: 1.25, fontSize: 11.5, color: 'warning.dark' }}>
            请先选择一个合并方式，否则无法继续。
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button size="small" onClick={onCancel} disabled={submitting}>
          取消导入
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!strategy || submitting}
          onClick={() => {
            if (strategy) onConfirm(strategy)
          }}
        >
          {submitting ? '处理中…' : '确认并继续'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
