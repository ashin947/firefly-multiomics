/**
 * 运行态遮罩（全屏对话框）。
 *
 * 三个要求来自 PRD S7：
 *  ① 阶段化进度 + 已用时间 / 预估剩余；
 *  ② 取消按钮**二次确认**（误点会让跑了 20 分钟的任务白费）；
 *  ③ 取消不是失败 —— 取消后只提示「已取消」，不弹错误横幅。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'
import type { Stage } from '@shared/constants'
import type { AnalysisLogEvent } from '@shared/types/ipc-contract'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ErrorBanner } from '../common/ErrorBanner'
import type { AppError } from '@shared/errors'
import { formatElapsed } from '../../utils/formatting'
import { LogPanel } from './LogPanel'
import { StageProgress } from './StageProgress'
import type { RunPhase } from '../../store/analysisStore'

interface RunOverlayProps {
  open: boolean
  phase: RunPhase
  stages: Stage[]
  currentStage: Stage
  doneStages: Stage[]
  pct: number
  /** 当前阶段的细粒度说明（R 的 progress.msg 原文） */
  stageMessage?: string | null
  logs: AnalysisLogEvent[]
  startedAt: number | null
  finishedAt: number | null
  error: AppError | null
  onCancel: () => void
  onClose: () => void
  /** 成功时「查看结果」 */
  onViewResult?: () => void
  /** 是否演示模式（提示数据为假） */
  mock?: boolean
}

export function RunOverlay({
  open,
  phase,
  stages,
  currentStage,
  doneStages,
  pct,
  stageMessage = null,
  logs,
  startedAt,
  finishedAt,
  error,
  onCancel,
  onClose,
  onViewResult,
  mock = false
}: RunOverlayProps): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [confirmCancel, setConfirmCancel] = useState(false)

  // 跑表：运行中每秒刷新一次已用时间
  useEffect(() => {
    if (phase !== 'running') return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const elapsedMs = startedAt ? (finishedAt ?? now) - startedAt : 0
  // 预估剩余：pct 很小时不给估算（否则会出现「剩余 99 分钟」的吓人数字）
  const estimatedRemainingMs =
    phase === 'running' && pct >= 8 && pct < 100 ? Math.max(0, (elapsedMs / pct) * (100 - pct)) : null

  const title =
    phase === 'running'
      ? '正在运行差异分析'
      : phase === 'success'
        ? '分析完成'
        : phase === 'cancelled'
          ? '已取消'
          : phase === 'failed'
            ? '分析失败'
            : '分析'

  return (
    <>
      <Dialog open={open} maxWidth="md" fullWidth onClose={phase === 'running' ? undefined : onClose}>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pb: 1 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <span>{title}</span>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
              已用 {formatElapsed(elapsedMs)}
              {estimatedRemainingMs !== null ? ` · 预计剩余 ${formatElapsed(estimatedRemainingMs)}` : ''}
            </Typography>
          </Stack>
        </DialogTitle>

        <DialogContent dividers>
          {mock && (
            <Box sx={{ mb: 1.5, px: 1.25, py: 0.75, borderRadius: 1.5, backgroundColor: '#FFF6E5', border: '1px solid #F3DCA8' }}>
              <Typography variant="body2" sx={{ fontSize: 11.5, color: '#8A5300' }}>
                演示模式：进度与日志为模拟输出，未调用 R。
              </Typography>
            </Box>
          )}

          <StageProgress
            stages={stages}
            current={currentStage}
            pct={pct}
            doneStages={doneStages}
            message={stageMessage}
          />

          {phase === 'failed' && error && (
            <Box sx={{ mt: 1.5 }}>
              <ErrorBanner error={error} />
            </Box>
          )}

          {phase === 'cancelled' && (
            <Box sx={{ mt: 1.5, px: 1.25, py: 1, borderRadius: 1.5, backgroundColor: '#F4F6F9', border: '1px solid #E1E6ED' }}>
              <Typography variant="body2" sx={{ fontSize: 12, color: 'text.secondary' }}>
                运行已取消，R 进程已结束。你可以修改参数后重新运行。
              </Typography>
            </Box>
          )}

          <Box sx={{ mt: 1.75 }}>
            <LogPanel logs={logs} maxHeight={280} />
          </Box>
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
          {phase === 'running' && (
            <Button size="small" color="error" variant="outlined" onClick={() => setConfirmCancel(true)}>
              取消运行
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          {phase === 'success' && onViewResult && (
            <Button size="small" variant="contained" onClick={onViewResult}>
              查看结果
            </Button>
          )}
          {phase !== 'running' && (
            <Button size="small" onClick={onClose}>
              关闭
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirmCancel}
        danger
        title="确认取消正在运行的分析？"
        description={
          <>
            取消后 R 进程会被立即终止，已计算的部分结果将丢弃，需要重新运行。
            <br />
            如果只是参数填错，建议等待本次运行结束后再调整。
          </>
        }
        confirmLabel="取消运行"
        cancelLabel="继续等待"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false)
          onCancel()
        }}
      />
    </>
  )
}
