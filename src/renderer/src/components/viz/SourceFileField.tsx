/**
 * 「选一个数据文件」的输入控件，选完立刻只读探测一次。
 *
 * ## 为什么要连着探测
 *
 * 绘图模块的三张图都要求「文件 → 选列 → 出图」。如果只是把路径显示出来、
 * 让用户手填列名，写错一个字符就是一张空白图或者一条看不懂的 R 报错。
 * 选完文件马上读出列名/基因名，后面的下拉框才有东西可选，
 * 用户也能从前 3 行预览里肉眼确认「这个文件读对了」。
 *
 * ## 探测失败要当场显示
 *
 * 选了一个二进制文件、一个空文件、或者一个 500MB 的矩阵时，探测会失败或超限。
 * 这种错误必须挂在这个控件上（而不是等出图时才报），否则用户会以为是绘图参数的问题。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useCallback, useState } from 'react'
import type { VizInspectResult } from '@shared/types/viz'
import { call, normalizeError } from '../../utils/ipc'

interface SourceFileFieldProps {
  label: string
  /** 当前路径（空串表示还没选） */
  value: string
  onChange: (path: string, info: VizInspectResult | null) => void
  /** 文件选择器的扩展名过滤 */
  extensions?: string[]
  /** 选完之后的一句话说明（例如「含 120 个样本」） */
  hint?: string
}

const DEFAULT_EXTENSIONS = ['csv', 'tsv', 'txt', 'xls', 'xlsx']

export function SourceFileField({
  label,
  value,
  onChange,
  extensions = DEFAULT_EXTENSIONS,
  hint
}: SourceFileFieldProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(async () => {
    setError(null)
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '表格文件', extensions },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const path = picked[0]
      if (!path) return
      setBusy(true)
      const info = await call(window.deg.viz.inspectSource({ filePath: path }))
      // 探测成功才替换路径：探测失败时保留上一个可用文件，
      // 否则用户选错一次就把已经配好的状态清空了
      onChange(path, info)
    } catch (err) {
      setError(normalizeError(err).message)
    } finally {
      setBusy(false)
    }
  }, [extensions, onChange])

  const fileName = value ? value.split(/[\\/]/).pop() : ''

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="small"
          variant="outlined"
          onClick={() => void pick()}
          disabled={busy}
          sx={{ height: 32, whiteSpace: 'nowrap' }}
          startIcon={busy ? <CircularProgress size={12} /> : undefined}
        >
          {value ? '重新选择' : label}
        </Button>
        <Typography
          variant="body2"
          color={value ? 'text.primary' : 'text.disabled'}
          sx={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={value}
        >
          {fileName || '未选择文件'}
        </Typography>
      </Stack>
      {hint && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.25 }}>
          {hint}
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 0.75, fontSize: 11 }}>
          {error}
        </Alert>
      )}
    </Box>
  )
}
