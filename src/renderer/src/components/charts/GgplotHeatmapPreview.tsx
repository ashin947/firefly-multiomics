/**
 * 热图预览（R / pheatmap 渲染的静态图）。
 *
 * 与 `GgplotVolcanoPreview` 同一套路：调主进程起 R、拿 dataURL、`<img>` 显示。
 * 之所以不抽成一个泛型组件：两者的「请求参数」结构完全不同（热图多十几个配置项），
 * 抽出来的通用层会变成一堆 `Record<string, unknown>`，反而更难读。重复的只有
 * 防抖 + 加载态这二十行，代价可接受。
 */
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, useState } from 'react'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import type { HeatmapPlotConfig } from '@shared/types/ipc-contract'
import { call, normalizeError } from '../../utils/ipc'

interface GgplotHeatmapPreviewProps {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
  config: HeatmapPlotConfig
  height?: number
  debounceMs?: number
  /** 外部想强制刷新时改这个值（例如点了「重新绘制」） */
  refreshKey?: number
}

export function GgplotHeatmapPreview({
  rows,
  thresholds,
  config,
  height = 460,
  debounceMs = 700,
  refreshKey = 0
}: GgplotHeatmapPreviewProps): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const seqRef = useRef(0)
  /** 容器尺寸（英寸），让图 1:1 显示，字号才是真实字号（同火山图） */
  const [size, setSize] = useState({ widthIn: 6.2, heightIn: 4.6 })

  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    // 防御：jsdom / 极老的内核没有 ResizeObserver。缺这个 API 时图应该退回
    // 「用初始尺寸」，而不是让整个页面抛 ReferenceError 白屏。
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width < 50) return
      setSize({
        widthIn: Math.round((rect.width / 96) * 100) / 100,
        heightIn: Math.round((rect.height / 96) * 100) / 100
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (rows.length === 0) {
      setDataUrl(null)
      setError(null)
      return undefined
    }

    const seq = (seqRef.current += 1)
    const timer = setTimeout(() => {
      setLoading(true)
      void (async () => {
        try {
          const result = await call(
            window.deg.plot.previewHeatmap({
              rows: rows as DEResultRow[],
              thresholds,
              ...config,
              widthIn: size.widthIn,
              heightIn: size.heightIn
            })
          )
          if (seqRef.current !== seq) return
          setDataUrl(result.dataUrl ?? null)
          setError(null)
        } catch (err) {
          if (seqRef.current !== seq) return
          // 失败保留上一张图，用户仍能看出大致效果
          setError(normalizeError(err).message)
        } finally {
          if (seqRef.current === seq) setLoading(false)
        }
      })()
    }, debounceMs)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config 是对象，逐字段列出过于冗长；用 refreshKey 兜住手动刷新
  }, [rows, thresholds, config, size.widthIn, size.heightIn, debounceMs, refreshKey])

  return (
    <Box ref={boxRef} sx={{ position: 'relative', width: '100%', height, overflow: 'hidden' }}>
      {dataUrl ? (
        <Box
          component="img"
          src={dataUrl}
          alt="热图预览"
          sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.disabled',
            fontSize: 12,
            px: 2,
            textAlign: 'center'
          }}
        >
          {rows.length === 0 ? '没有可绘制的差异结果' : '正在用 R 渲染热图…'}
        </Box>
      )}

      {loading && dataUrl && (
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1,
            py: 0.25,
            borderRadius: 1,
            backgroundColor: 'rgba(255,255,255,0.9)',
            border: '1px solid',
            borderColor: 'divider'
          }}
        >
          <CircularProgress size={11} />
          <Typography variant="body2" sx={{ fontSize: 10.5, color: 'text.secondary' }}>
            正在重绘…
          </Typography>
        </Box>
      )}

      {error && (
        <Box
          sx={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            px: 1,
            py: 0.5,
            borderRadius: 1,
            backgroundColor: 'error.main',
            color: 'error.contrastText'
          }}
        >
          <Typography variant="body2" sx={{ fontSize: 10.5 }}>
            {error}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
