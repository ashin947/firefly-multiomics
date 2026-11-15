/**
 * 基因 ID 面板：自动识别的类型 + 手工指定列 + 转换入口。
 *
 * 识别结果要给出「依据」而不是一个孤零零的标签 —— 用户看到 SYMBOL 会问
 * 「你怎么知道的」，所以旁边列出前 5 个 ID 让他自己判断。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { GeneIdType } from '@shared/types/dataset'

const TYPE_LABELS: Record<GeneIdType, string> = {
  SYMBOL: '基因符号（SYMBOL）',
  ENSEMBL: 'Ensembl ID',
  ENTREZ: 'Entrez ID',
  UNKNOWN: '未识别'
}

const TYPE_HINTS: Record<GeneIdType, string> = {
  SYMBOL: '形如 TP53 / EGFR 的字母组合',
  ENSEMBL: '形如 ENSG00000141510 的编号',
  ENTREZ: '纯数字编号',
  UNKNOWN: '未能自动识别，请确认基因 ID 列是否正确'
}

interface GeneIdPanelProps {
  geneIdType: GeneIdType
  geneIdColumn: string
  geneIdSample: string[]
  /** 可选的列名（矩阵表头） */
  columns: string[]
  onSelectColumn: (column: string) => void
  onResolve?: () => void
  resolving?: boolean
  disabled?: boolean
}

export function GeneIdPanel({
  geneIdType,
  geneIdColumn,
  geneIdSample,
  columns,
  onSelectColumn,
  onResolve,
  resolving = false,
  disabled = false
}: GeneIdPanelProps): JSX.Element {
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          基因 ID 类型
        </Typography>
        <Chip
          size="small"
          label={TYPE_LABELS[geneIdType]}
          color={geneIdType === 'UNKNOWN' ? 'warning' : 'primary'}
          variant="outlined"
          sx={{ height: 20, fontSize: 11 }}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.25 }}>
        识别依据：{TYPE_HINTS[geneIdType]}
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        {geneIdSample.slice(0, 5).map((id) => (
          <Chip key={id} size="small" label={id} sx={{ height: 20, fontSize: 10.5, fontFamily: 'monospace' }} />
        ))}
        {geneIdSample.length === 0 && (
          <Typography variant="body2" color="text.disabled" sx={{ fontSize: 11 }}>
            暂无示例
          </Typography>
        )}
      </Stack>

      <Stack direction="row" spacing={1.25} alignItems="flex-end">
        <TextField
          select
          size="small"
          label="基因 ID 所在列"
          value={geneIdColumn}
          onChange={(event) => onSelectColumn(event.target.value)}
          disabled={disabled}
          sx={{ minWidth: 200 }}
        >
          {columns.map((column) => (
            <MenuItem key={column} value={column}>
              {column}
            </MenuItem>
          ))}
        </TextField>
        {onResolve && (
          <Button size="small" variant="outlined" onClick={onResolve} disabled={disabled || resolving}>
            {resolving ? '转换中…' : '转换为基因符号'}
          </Button>
        )}
      </Stack>

      {geneIdType === 'UNKNOWN' && (
        <Typography variant="body2" sx={{ mt: 1, fontSize: 11.5, color: 'warning.dark' }}>
          未识别出基因 ID 类型：仍可继续分析，但基因名映射与富集分析可能无法使用。
        </Typography>
      )}
    </Box>
  )
}
