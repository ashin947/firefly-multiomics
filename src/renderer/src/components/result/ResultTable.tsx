/**
 * 结果表（9 字段，与 R 输出列一一对应）。
 *
 * 性能取舍：一次性渲染 5000 行 DOM 会让首屏明显卡顿，因此这里限制
 * 「最多渲染 800 行」并在表尾注明 —— 用户仍可通过搜索/仅显示显著定位到具体基因。
 * 真正的虚拟滚动（TanStack virtual）在下一批次接入，届时只需替换本组件内部实现，
 * 调用方接口不变。
 */
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import { DataTable, type Column } from '../common/DataTable'
import { basisOf, classify } from '../../utils/threshold'
import { formatLogFC, formatNumber, formatPValue } from '../../utils/formatting'

/** 单页最多渲染行数（超过时提示用搜索/筛选） */
export const MAX_RENDER_ROWS = 800

interface ResultTableProps {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
  hoveredGene?: string | null
  onHoverGene?: (geneId: string | null) => void
  onRowClick?: (row: DEResultRow) => void
  maxHeight?: number
}

const REGULATION_LABEL: Record<'up' | 'down' | 'ns', { text: string; color: string }> = {
  up: { text: '上调', color: '#B3261E' },
  down: { text: '下调', color: '#245C42' },
  ns: { text: '不显著', color: '#8C97A5' }
}

export function ResultTable({
  rows,
  thresholds,
  hoveredGene = null,
  onHoverGene,
  onRowClick,
  maxHeight = 420
}: ResultTableProps): JSX.Element {
  const displayRows = rows.length > MAX_RENDER_ROWS ? rows.slice(0, MAX_RENDER_ROWS) : rows

  const columns: Column<DEResultRow>[] = [
    {
      id: 'gene',
      label: '基因',
      width: 160,
      render: (row) => (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
            {row.geneName ?? row.geneId}
          </Typography>
          {row.geneName && row.geneName !== row.geneId && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10 }}>
              {row.geneId}
            </Typography>
          )}
        </Box>
      )
    },
    {
      id: 'logFC',
      label: 'logFC',
      align: 'right',
      width: 80,
      render: (row) => {
        const cls = classify(row, thresholds) // SYNC: isSignificant 唯一实现
        const color = cls === 'up' ? '#B3261E' : cls === 'down' ? '#245C42' : 'text.secondary'
        return (
          <Typography variant="body2" sx={{ fontSize: 12, color, fontWeight: cls === 'ns' ? 400 : 600 }}>
            {formatLogFC(row.logFC)}
          </Typography>
        )
      }
    },
    { id: 'aveExpr', label: '平均表达', align: 'right', width: 90, render: (row) => formatNumber(row.aveExpr, 2) },
    { id: 't', label: 't 值', align: 'right', width: 78, render: (row) => formatNumber(row.t, 2) },
    /*
     * 两列 p 值都显示（用户对照着看有用），但**只有当前判定依据那一列会加粗**。
     * 加粗条件里带 `isBasis`，否则切到「原始 P 值」后 FDR 列还照着 0.05 加粗，
     * 界面会同时高亮两列、且有一列是错的。
     */
    {
      id: 'pValue',
      label: 'P 值',
      align: 'right',
      width: 92,
      render: (row) => {
        const isBasis = basisOf(thresholds) === 'pValue'
        const highlighted = isBasis && Number.isFinite(row.pValue) && row.pValue < thresholds.fdr
        return (
          <Typography variant="body2" sx={{ fontSize: 12, fontWeight: highlighted ? 600 : 400 }}>
            {formatPValue(row.pValue)}
          </Typography>
        )
      }
    },
    {
      id: 'adjPValue',
      label: 'FDR',
      align: 'right',
      width: 92,
      render: (row) => {
        const isBasis = basisOf(thresholds) === 'adjPValue'
        const highlighted = isBasis && Number.isFinite(row.adjPValue) && row.adjPValue < thresholds.fdr
        return (
          <Typography variant="body2" sx={{ fontSize: 12, fontWeight: highlighted ? 600 : 400 }}>
            {formatPValue(row.adjPValue)}
          </Typography>
        )
      }
    },
    {
      id: 'regulation',
      label: '显著性',
      align: 'center',
      width: 84,
      render: (row) => {
        const cls = classify(row, thresholds) // SYNC: isSignificant 唯一实现
        const meta = REGULATION_LABEL[cls]
        return (
          <Typography variant="body2" sx={{ fontSize: 11, fontWeight: 600, color: meta.color }}>
            {meta.text}
          </Typography>
        )
      }
    }
  ]

  return (
    <Box>
      <DataTable
        columns={columns}
        rows={displayRows}
        getRowKey={(row) => row.geneId}
        maxHeight={maxHeight}
        dense
        onRowClick={onRowClick}
        onRowHover={(row) => onHoverGene?.(row ? row.geneId : null)}
        highlightedKey={hoveredGene}
        emptyText="当前筛选条件下没有基因"
      />
      {rows.length > MAX_RENDER_ROWS && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, fontSize: 10.5 }}>
          为保证滚动流畅，表格仅渲染前 {MAX_RENDER_ROWS} 行（按 P 值升序）。用搜索或「仅显示显著」定位具体基因。
        </Typography>
      )}
    </Box>
  )
}
