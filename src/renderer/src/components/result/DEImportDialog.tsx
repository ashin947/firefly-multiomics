/**
 * 导入外部差异结果表（只用于绘图）。
 *
 * ## 两步式交互
 *
 *  ① 选文件 → 主进程探列（列名 + 样例值 + 猜测的角色）
 *  ② 用户确认/修正每列的角色 → 主进程按映射解析成结果行
 *
 * 为什么不是「选完直接导」：外部表的列名没有标准（`logFC` / `log2FoldChange` /
 * `avg_log2FC`…），猜错一列的后果是**图能画出来但横轴是别的量**，
 * 用户看图不会有任何异常感。所以必须让人在导入前看一眼列名和样例。
 *
 * ## 这个对话框不写任何东西
 *
 * 它只调两个只读通道，结果交给 `plotDataStore` 存在内存里。
 * 项目目录、de.csv、project.json 一个字节都不动。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DETableImportResult,
  DETableInspectResult,
  DETableRole
} from '@shared/types/analysis'
import { call, normalizeError } from '../../utils/ipc'

/** 角色选项（顺序即下拉顺序） */
const ROLE_OPTIONS: { value: DETableRole; label: string }[] = [
  { value: 'ignore', label: '忽略' },
  { value: 'geneId', label: '基因 ID' },
  { value: 'geneName', label: '基因名' },
  { value: 'logFC', label: 'logFC（倍数变化）' },
  { value: 'pValue', label: 'P 值' },
  { value: 'adjPValue', label: '校正 P 值（FDR）' },
  { value: 'aveExpr', label: '平均表达量' },
  { value: 't', label: '统计量 t' }
]

export interface ImportedDE {
  rows: DETableImportResult['rows']
  label: string
  warnings: string[]
}

interface DEImportDialogProps {
  open: boolean
  onClose: () => void
  onImported: (payload: ImportedDE) => void
}

export function DEImportDialog({ open, onClose, onImported }: DEImportDialogProps): JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [inspect, setInspect] = useState<DETableInspectResult | null>(null)
  const [roles, setRoles] = useState<Record<string, DETableRole>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每次打开都重置：上一次的列映射对这次的文件毫无意义
  useEffect(() => {
    if (!open) return
    setFilePath(null)
    setInspect(null)
    setRoles({})
    setError(null)
    setBusy(false)
  }, [open])

  const pickFile = useCallback(async () => {
    setError(null)
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '表格文件', extensions: ['csv', 'tsv', 'txt', 'tab', 'xlsx', 'xls'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const file = picked[0]
      if (!file) return

      setBusy(true)
      setFilePath(file)
      const result = await call(window.deg.data.inspectDETable({ filePath: file }))
      setInspect(result)
      setRoles(Object.fromEntries(result.columns.map((c) => [c.name, c.guessedRole])))
    } catch (err) {
      setError(normalizeError(err).message)
      setInspect(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const usedRoles = useMemo(() => {
    const counts = new Map<DETableRole, number>()
    for (const role of Object.values(roles)) {
      if (role === 'ignore') continue
      counts.set(role, (counts.get(role) ?? 0) + 1)
    }
    return counts
  }, [roles])

  const blocker = useMemo(() => {
    if (!inspect) return null
    if (!usedRoles.has('geneId')) return '请把存放基因名/基因 ID 的那一列选为「基因 ID」。'
    if (!usedRoles.has('logFC')) return '请把存放 log2 倍数变化的那一列选为「logFC」。'
    if (!usedRoles.has('pValue') && !usedRoles.has('adjPValue')) {
      return '请至少指定「P 值」或「校正 P 值」一列 —— 火山图的纵轴需要它。'
    }
    const duplicated = [...usedRoles.entries()].filter(([, n]) => n > 1)
    if (duplicated.length > 0) {
      const label = ROLE_OPTIONS.find((o) => o.value === duplicated[0][0])?.label ?? duplicated[0][0]
      return `「${label}」被指定给了多列，请只保留一个。`
    }
    return null
  }, [inspect, usedRoles])

  const confirm = useCallback(async () => {
    if (!inspect || !filePath || blocker) return
    setBusy(true)
    setError(null)
    try {
      const result = await call(
        window.deg.data.importDETable({ filePath, mapping: roles })
      )
      onImported({ rows: result.rows, label: inspect.fileName, warnings: result.warnings })
      onClose()
    } catch (err) {
      setError(normalizeError(err).message)
    } finally {
      setBusy(false)
    }
  }, [inspect, filePath, blocker, roles, onImported, onClose])

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontSize: 16, pb: 1 }}>导入差异结果表（仅用于绘图）</DialogTitle>

      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
          导入的表<strong>只用来画图</strong>，不会写入项目、不会覆盖已有的分析结果。
          关闭这张图或点「切回分析结果」即可完全恢复，下次跑分析照常走原流程。
        </Alert>

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
          <Button variant="outlined" size="small" onClick={() => void pickFile()} disabled={busy}>
            {inspect ? '重新选择文件' : '选择文件'}
          </Button>
          {inspect && (
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" label={inspect.fileName} sx={{ height: 22, fontSize: 11 }} />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                {inspect.rowCount.toLocaleString()} 行 · {inspect.columns.length} 列 · 编码 {inspect.encoding}
              </Typography>
            </Stack>
          )}
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2, fontSize: 12 }}>
            {error}
          </Alert>
        )}

        {inspect && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1 }}>
              下面每一列请指定它是什么。<strong>带 * 的是必需的</strong>，其余可以忽略。
            </Typography>

            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
              {inspect.columns.map((column, index) => {
                const role = roles[column.name] ?? column.guessedRole
                return (
                  <Box
                    key={`${column.name}-${index}`}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(140px, 1.1fr) minmax(180px, 1.6fr) 200px',
                      gap: 1.5,
                      alignItems: 'center',
                      px: 1.5,
                      py: 1,
                      borderBottom: index === inspect.columns.length - 1 ? 'none' : '1px solid',
                      borderColor: 'divider',
                      backgroundColor: role === 'ignore' ? 'transparent' : 'rgba(53,126,92,0.03)'
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{ fontSize: 12, fontWeight: 600, wordBreak: 'break-all' }}
                      title={column.name}
                    >
                      {column.name}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}
                      title={column.samples.join(' | ')}
                    >
                      {column.samples.length > 0 ? column.samples.join(' · ') : '（全部为空）'}
                    </Typography>
                    <TextField
                      select
                      size="small"
                      value={role}
                      onChange={(event) =>
                        setRoles((prev) => ({ ...prev, [column.name]: event.target.value as DETableRole }))
                      }
                      SelectProps={{ native: true }}
                      sx={{ '& .MuiInputBase-root': { height: 30, fontSize: 12 } }}
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </TextField>
                  </Box>
                )
              })}
            </Box>

            {blocker && (
              <Alert severity="warning" sx={{ mt: 2, fontSize: 12 }}>
                {blocker}
              </Alert>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button size="small" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={() => void confirm()}
          disabled={!inspect || Boolean(blocker) || busy}
        >
          {busy ? '处理中…' : '导入并绘图'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
