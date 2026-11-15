/**
 * 火山图预览（R / ggplot2 渲染的静态图）。
 *
 * ## 为什么预览要跑 R
 *
 * 客户要求「示意图和导出的图一样」。这在 ECharts 上做不到：网格样式、字号、
 * 图例排布都是两套实现，无论怎么调参都有肉眼可见的差别 —— 预览和成品不一致，
 * 用户就没法在导出前判断图好不好看。
 *
 * 所以预览也调 `plot.preview`，和导出**共用同一个 R 脚本**，只在 dpi 上不同。
 *
 * ## 代价与对策
 *
 * 每次刷新要起一个 R 进程（约 1~2 秒），比 ECharts 的「毫秒级重绘」慢得多。对策：
 *  1. **防抖**：依赖变化后等 `debounceMs` 才真正请求。拖阈值滑块时依赖连续变化，
 *     计时器不断被重置 —— 效果就是「松手才重绘」。
 *  2. **保留旧图**：请求期间继续显示上一张图 + 一个「正在重绘」角标，
 *     而不是清空成白屏（白屏闪一下比慢更难受）。
 *  3. **失败不清图**：R 出错时显示错误条，但上一张图留着，用户仍能看出图在表达什么。
 *
 * ## 失去的能力
 *
 * 静态图没有 hover 联动（鼠标移到点上显示基因名）。这是换成 R 渲染的必然代价，
 * 由客户在「图与导出一致」和「图上交互」之间选择了前者。
 */
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, useState } from 'react'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import type { VolcanoColors } from './VolcanoChart'
import { call, normalizeError } from '../../utils/ipc'

interface GgplotVolcanoPreviewProps {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
  colors: VolcanoColors
  height?: number
  /** 依赖变化后等多久才请求（毫秒） */
  debounceMs?: number
  /**
   * 手动指定预览图的物理尺寸（英寸）。一般不需要给 —— 组件会测容器。
   *
   * ★ 为什么必须按容器尺寸出图，而不是固定 8×5：
   *   ggplot 的字号是**物理单位（pt）**，出图 8 英寸宽、屏幕上只有 564px 时，
   *   9pt 的字会被压成约 4px，图例和刻度根本读不清（实测就是这样）。
   *   让「1 英寸 = 96 CSS px」——即物理尺寸 = 容器尺寸 / 96——图就 1:1 显示，
   *   屏幕上看到的字号就是它实际打印出来的字号。
   */
  widthIn?: number
  heightIn?: number
}

export function GgplotVolcanoPreview({
  rows,
  thresholds,
  colors,
  height = 360,
  debounceMs = 700,
  widthIn: widthInProp,
  heightIn: heightInProp
}: GgplotVolcanoPreviewProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 实测的容器尺寸（英寸），初值给一个常见值，挂载后立刻校正 */
  const [size, setSize] = useState({ widthIn: widthInProp ?? 5.8, heightIn: heightInProp ?? 3.7 })

  useEffect(() => {
    if (widthInProp && heightInProp) return undefined
    const el = boxRef.current
    if (!el) return undefined
    // 防御：jsdom / 极老的内核没有 ResizeObserver。缺这个 API 时图应该退回
    // 「用初始尺寸」，而不是让整个页面抛 ReferenceError 白屏。
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width < 50) return
      // 96 CSS px = 1 英寸，见上面 props 注释
      setSize({
        widthIn: widthInProp ?? Math.round((rect.width / 96) * 100) / 100,
        heightIn: heightInProp ?? Math.round((rect.height / 96) * 100) / 100
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [widthInProp, heightInProp])

  const widthIn = widthInProp ?? size.widthIn
  const heightIn = heightInProp ?? size.heightIn
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 只认最后一次请求的结果（用户可能连续改三次，前两次的响应要丢掉） */
  const seqRef = useRef(0)

  useEffect(() => {
    if (rows.length === 0) {
      setDataUrl(null)
      setError(null)
      return undefined
    }

    const seq = (seqRef.current += 1)
    // ★ loading 在**真正发起请求时**才置 true，不在依赖变化时置 ——
    //   否则拖滑块期间一直是转圈，看起来像卡死
    const timer = setTimeout(() => {
      setLoading(true)
      void (async () => {
        try {
          const result = await call(
            window.deg.plot.preview({
              // 传普通数组：只读数组不能直接过 structured clone 的类型约束
              rows: rows as DEResultRow[],
              thresholds,
              colors,
              widthIn,
              heightIn
            })
          )
          if (seqRef.current !== seq) return // 已有更新的请求，丢弃这次结果
          setDataUrl(result.dataUrl)
          setError(null)
        } catch (err) {
          if (seqRef.current !== seq) return
          // 失败不清图：留着上一张，用户至少还能看到大致效果
          setError(normalizeError(err).message)
        } finally {
          if (seqRef.current === seq) setLoading(false)
        }
      })()
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [rows, thresholds, colors, debounceMs, widthIn, heightIn])

  return (
    <Box ref={boxRef} sx={{ position: 'relative', width: '100%', height, overflow: 'hidden' }}>
      {dataUrl ? (
        <Box
          component="img"
          src={dataUrl}
          alt="火山图预览"
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
            fontSize: 12
          }}
        >
          {rows.length === 0 ? '没有可绘制的差异结果' : '正在用 R 渲染…'}
        </Box>
      )}

      {/* 重绘中：角标而不是遮罩，旧图仍然可见 */}
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
            预览失败：{error}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
