/**
 * 运行日志面板。
 *
 * 两个必须做对的细节：
 *  ① 自动滚底，但**用户手动上滚时要停止自动滚动** —— 否则用户想回看某行日志，
 *     新日志一来就把他拽回底部，这是日志面板最经典的可用性问题；
 *  ② 支持复制全文（技术支持最需要的东西）。
 */
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, useState } from 'react'
import type { AnalysisLogEvent } from '@shared/types/ipc-contract'

const LEVEL_COLORS: Record<AnalysisLogEvent['level'], string> = {
  debug: '#8C97A5',
  info: '#2B3038',
  warn: '#B26A00',
  error: '#B3261E',
  raw: '#5A6472'
}

interface LogPanelProps {
  logs: AnalysisLogEvent[]
  maxHeight?: number
  /** 是否显示复制按钮 */
  showCopy?: boolean
}

export function LogPanel({ logs, maxHeight = 260, showCopy = true }: LogPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)

  // 用户滚离底部超过 24px 就认为「他在看历史日志」，停止自动滚动
  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setAutoScroll(distanceToBottom < 24)
  }

  useEffect(() => {
    if (!autoScroll) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logs, autoScroll])

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(logs.map((l) => l.line).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默（用户仍可手动选择文本）
    }
  }

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 600, color: 'text.secondary' }}>
          运行日志（{logs.length} 行）
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {!autoScroll && (
            <Button
              size="small"
              sx={{ fontSize: 10.5, minWidth: 0 }}
              onClick={() => {
                setAutoScroll(true)
                const el = containerRef.current
                if (el) el.scrollTop = el.scrollHeight
              }}
            >
              回到最新
            </Button>
          )}
          {showCopy && (
            <Button size="small" startIcon={<ContentCopyIcon sx={{ fontSize: 13 }} />} onClick={() => void copyAll()} sx={{ fontSize: 10.5 }}>
              {copied ? '已复制' : '复制全文'}
            </Button>
          )}
        </Stack>
      </Stack>

      <Box
        ref={containerRef}
        onScroll={handleScroll}
        sx={{
          maxHeight,
          overflowY: 'auto',
          p: 1.25,
          borderRadius: 1.5,
          backgroundColor: '#0F1720',
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: 11,
          lineHeight: 1.65
        }}
      >
        {logs.length === 0 && (
          <Typography sx={{ color: '#7A8797', fontSize: 11, fontFamily: 'inherit' }}>等待 R 进程输出…</Typography>
        )}
        {logs.map((log, index) => (
          <Box
            key={`${log.ts}-${index}`}
            sx={{ color: LEVEL_COLORS[log.level] ?? '#C7D0DA', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {log.line}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
