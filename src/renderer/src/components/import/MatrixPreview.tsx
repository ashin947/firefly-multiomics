/**
 * 矩阵预览（前 100 行）。
 *
 * 列数可能很多（几十个样本），因此表格必须横向滚动且首列（基因 ID）固定 ——
 * 否则用户向右看样本时会忘记自己在看哪个基因。
 */
import Box from '@mui/material/Box'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'

interface MatrixPreviewProps {
  preview: { columns: string[]; rows: (string | number)[][] }
  maxHeight?: number
}

export function MatrixPreview({ preview, maxHeight = 320 }: MatrixPreviewProps): JSX.Element {
  if (preview.columns.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        暂无可预览的数据。
      </Typography>
    )
  }

  return (
    <Box>
      <TableContainer
        sx={{ maxHeight, border: '1px solid', borderColor: 'divider', borderRadius: 1.5, backgroundColor: '#FFFFFF' }}
      >
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {preview.columns.map((column, index) => (
                <TableCell
                  key={column}
                  sx={{
                    fontSize: 11,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    backgroundColor: '#F7F9FC',
                    color: 'text.secondary',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    py: 0.6,
                    // 首列（基因 ID）在横向滚动时保持可见
                    position: 'sticky',
                    left: index === 0 ? 0 : undefined,
                    zIndex: index === 0 ? 3 : 2
                  }}
                >
                  {column}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {preview.rows.map((row, rowIndex) => (
              <TableRow key={rowIndex} hover>
                {row.map((cell, cellIndex) => (
                  <TableCell
                    key={`${rowIndex}-${cellIndex}`}
                    sx={{
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      py: 0.35,
                      position: cellIndex === 0 ? 'sticky' : undefined,
                      left: cellIndex === 0 ? 0 : undefined,
                      backgroundColor: cellIndex === 0 ? '#FFFFFF' : undefined,
                      fontWeight: cellIndex === 0 ? 600 : 400,
                      zIndex: cellIndex === 0 ? 1 : 0
                    }}
                  >
                    {typeof cell === 'number' ? cell.toLocaleString() : cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, fontSize: 11 }}>
        预览前 {preview.rows.length} 行 / 共 {preview.columns.length} 列（含基因 ID 列）
      </Typography>
    </Box>
  )
}
