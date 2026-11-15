/**
 * 二次确认对话框（取消运行、关闭项目、清除 R 路径等破坏性操作）。
 *
 * 统一走这个组件而不是各自写 Dialog：文案结构一致（标题 / 说明 / 后果），
 * 用户不会在「取消分析」时看到一个没有后果说明的裸确认框。
 */
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import type { ReactNode } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 说明正文（可以是多段） */
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除/取消运行）用红色确认按钮 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '返回',
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div" sx={{ fontSize: 13, lineHeight: 1.75 }}>
          {description}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button size="small" variant="contained" color={danger ? 'error' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
