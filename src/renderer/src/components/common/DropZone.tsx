/**
 * 拖拽上传区。
 *
 * 两个入口都要有：拖拽（快）与点击选择（用户习惯）。
 * 拖拽状态必须给出视觉反馈（hover 高亮 + 边框变实线），否则用户不知道
 * 「这里能放文件」——这是上传组件最容易被忽略的可用性细节。
 */
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import { useCallback, useRef, useState } from 'react'
import { FILE_FILTERS } from '@shared/constants'
import { call } from '../../utils/ipc'

interface DropZoneProps {
  /** 选中的文件绝对路径 */
  onFile: (filePath: string) => void
  title: string
  hint?: string
  /** FILE_FILTERS 的键 */
  filterKey: 'matrix' | 'groups'
  loading?: boolean
  disabled?: boolean
  /** 已选文件名（选完后在框内显示，避免用户不确定选没选上） */
  selectedName?: string | null
}

export function DropZone({
  onFile,
  title,
  hint,
  filterKey,
  loading = false,
  disabled = false,
  selectedName
}: DropZoneProps): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const pick = useCallback(async (): Promise<void> => {
    try {
      const paths = await call(window.deg.system.pickFile({ filters: FILE_FILTERS[filterKey], multi: false }))
      if (paths.length > 0) onFile(paths[0])
    } catch {
      // 用户取消或对话框异常：静默即可，不需要错误提示
    }
  }, [filterKey, onFile])

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      setDragging(false)
      if (disabled) return
      // Electron 里 File.path 才是真实路径（标准 API 拿不到）
      const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined
      const filePath = file?.path
      if (filePath) onFile(filePath)
    },
    [disabled, onFile]
  )

  return (
    <Box
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => {
        if (!disabled && !loading) void pick()
      }}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        minHeight: 148,
        px: 3,
        py: 3,
        borderRadius: 2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: '1px dashed',
        borderColor: dragging ? 'primary.main' : 'divider',
        backgroundColor: dragging ? 'rgba(53,126,92,0.06)' : '#F7FBF8',
        transition: 'all .16s ease',
        opacity: disabled ? 0.6 : 1,
        '&:hover': disabled ? {} : { borderColor: 'primary.main', backgroundColor: 'rgba(53,126,92,0.04)' }
      }}
    >
      <input ref={inputRef} type="file" hidden />
      {loading ? (
        <>
          <CircularProgress size={22} />
          <Typography variant="body2" color="text.secondary">
            正在读取并解析文件…
          </Typography>
        </>
      ) : (
        <>
          <UploadFileIcon sx={{ fontSize: 30, color: selectedName ? 'success.main' : 'text.disabled' }} />
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            {selectedName ?? title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {hint ?? '把文件拖到这里，或点击选择'}
          </Typography>
        </>
      )}
    </Box>
  )
}
