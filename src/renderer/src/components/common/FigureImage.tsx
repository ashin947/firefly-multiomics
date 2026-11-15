/**
 * 一张 R 生成的图 + 右上角导出工具条（PNG / PDF）。
 *
 * ## 为什么单独一个组件
 *
 * 单细胞页有 9 处、时序页有 2 处 `component="img"`。每处都复制一遍
 * 「图片 + 两个导出按钮 + busy 状态」既啰嗦又容易漏。
 *
 * ## 为什么导出的是「复制 R 已生成的文件」
 *
 * 图是 R 画好落在 runDir 里的（png + 同名 pdf 一起写），复制那份就够了。
 * 在 JS 里重新渲染会把 R 的画图逻辑复刻一遍，样式必然不一致。
 * 真正「选尺寸/dpi 重渲染」的是 DE 模块的 PlotExportDialog，那是另一套场景。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import { useState } from 'react'
import { call } from '../../utils/ipc'

export interface FigureImageProps {
  /** data:image/png;base64,... */
  src: string
  alt: string
  /** runDir 里的 PNG 文件名（导出时按它复制；没有就不显示导出按钮） */
  file?: string
  /** 导出实现：由调用方决定是 scrna 还是 timeseries 通道 */
  onExport?: (format: 'png' | 'pdf') => Promise<void>
  maxWidth?: number
}

export function FigureImage({
  src,
  alt,
  file,
  onExport,
  maxWidth = 900
}: FigureImageProps): JSX.Element {
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null)
  /** 导出失败的自解释提示：图没生成 / 没有 PDF 版本都在这里，不静默 */
  const [errMsg, setErrMsg] = useState('')

  const run = async (format: 'png' | 'pdf'): Promise<void> => {
    if (!onExport) return
    setBusy(format)
    try {
      await onExport(format)
    } catch (err) {
      // 图没生成 / 没有 PDF（旧版本跑的）都在这里：给一句人话，不要静默失败
      const anyErr = err as { message?: string; detail?: { suggestion?: string } }
      setErrMsg(anyErr?.message || '导出失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <Box
        component="img"
        src={src}
        alt={alt}
        sx={{
          width: '100%',
          maxWidth,
          display: 'block',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1
        }}
      />
      {onExport && file && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            bgcolor: 'rgba(255,255,255,0.88)',
            borderRadius: 1,
            px: 0.5,
            py: 0.25
          }}
        >
          {busy ? (
            <CircularProgress size={14} />
          ) : (
            <>
              <Button
                size="small"
                variant="text"
                sx={{ fontSize: 10, minWidth: 0, py: 0.1, px: 0.5 }}
                onClick={() => void run('pdf')}
                title="导出矢量 PDF（投稿用）"
              >
                PDF
              </Button>
              <Button
                size="small"
                variant="text"
                sx={{ fontSize: 10, minWidth: 0, py: 0.1, px: 0.5 }}
                onClick={() => void run('png')}
                title="导出 PNG（位图）"
              >
                PNG
              </Button>
            </>
          )}
        </Stack>
      )}

      <Snackbar
        open={Boolean(errMsg)}
        autoHideDuration={6000}
        onClose={() => setErrMsg('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" onClose={() => setErrMsg('')} sx={{ fontSize: 12 }}>
          {errMsg}
        </Alert>
      </Snackbar>
    </Box>
  )
}

/** 供调用方复用：弹出保存对话框拿路径（取消返回 null） */
export async function pickSavePath(
  defaultName: string,
  format: 'png' | 'pdf'
): Promise<string | null> {
  const outPath = await call(
    window.deg.system.saveFile({
      defaultName,
      filters:
        format === 'pdf'
          ? [{ name: 'PDF 矢量图', extensions: ['pdf'] }]
          : [{ name: 'PNG 图片', extensions: ['png'] }]
    })
  )
  return outPath || null
}
