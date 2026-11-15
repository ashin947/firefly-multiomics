/**
 * 通用表格（MUI Table 封装）。
 *
 * 为什么不用 TanStack virtual 这一版：
 *  本批次要交付的是「客户能看到界面」，表格行数最大 5000（结果页）。
 *  MUI 的 stickyHeader + 固定高度容器在 5000 行时首屏渲染会卡（DOM 节点太多），
 *  所以结果页表格会传入 `virtualized` 由 MUI 的 maxHeight 容器 + 分页限制行数兜底；
 *  真正的虚拟滚动在下一批次接入（已留好 Column 接口，替换渲染层不影响调用方）。
 */
import Box from '@mui/material/Box'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

export interface Column<T> {
  id: string
  label: string
  align?: 'left' | 'right' | 'center'
  /** 像素宽度；不传则自适应 */
  width?: number
  /** 单元格渲染；不传则取 row[id]（需要行类型可索引） */
  render?: (row: T, index: number) => ReactNode
  /** 表头提示 */
  hint?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: readonly T[]
  getRowKey: (row: T, index: number) => string
  maxHeight?: number
  /** 行高（dense 用于 5000 行结果表） */
  dense?: boolean
  onRowClick?: (row: T) => void
  onRowHover?: (row: T | null) => void
  /** 高亮某一行（hover 联动） */
  highlightedKey?: string | null
  emptyText?: string
  /** 表头是否吸顶 */
  stickyHeader?: boolean
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  maxHeight = 420,
  dense = false,
  onRowClick,
  onRowHover,
  highlightedKey = null,
  emptyText = '暂无数据',
  stickyHeader = true
}: DataTableProps<T>): JSX.Element {
  return (
    <TableContainer
      sx={{
        maxHeight,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        backgroundColor: 'background.paper'
      }}
    >
      <Table size={dense ? 'small' : 'medium'} stickyHeader={stickyHeader}>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableCell
                key={column.id}
                align={column.align ?? 'left'}
                sx={{
                  width: column.width,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'text.secondary',
                  backgroundColor: '#F7F9FC',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  whiteSpace: 'nowrap',
                  py: 0.75
                }}
                title={column.hint}
              >
                {column.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} sx={{ py: 4, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  {emptyText}
                </Typography>
              </TableCell>
            </TableRow>
          )}
          {rows.map((row, index) => {
            const key = getRowKey(row, index)
            const highlighted = highlightedKey !== null && key === highlightedKey
            return (
              <TableRow
                key={key}
                hover
                selected={highlighted}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onMouseEnter={onRowHover ? () => onRowHover(row) : undefined}
                onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
                sx={{
                  cursor: onRowClick ? 'pointer' : 'default',
                  '& td': { fontSize: dense ? 11.5 : 12.5, py: dense ? 0.4 : 0.75 }
                }}
              >
                {columns.map((column) => (
                  <TableCell key={column.id} align={column.align ?? 'left'}>
                    {column.render
                      ? column.render(row, index)
                      : String((row as unknown as Record<string, unknown>)[column.id] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {rows.length > 0 && (
        <Box sx={{ px: 1.5, py: 0.75, borderTop: '1px solid', borderColor: 'divider', backgroundColor: '#FAFBFD' }}>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
            共 {rows.length} 行
          </Typography>
        </Box>
      )}
    </TableContainer>
  )
}
