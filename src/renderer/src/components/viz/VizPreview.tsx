/**
 * 绘图模块的预览组件（R / ggplot2 / VennDiagram / survminer 渲染的静态图）。
 *
 * ## 为什么预览也跑 R，而不是前端画个近似的
 *
 * 与火山图同一个理由，但这里更严重：Venn 的椭圆排布、survminer 的 risk table
 * 布局都没有前端等价实现。用别的东西拼一个「差不多」的预览，等于让用户
 * 看着 A 图决定要不要导出 B 图。
 *
 * ## 尺寸按容器实测，不写死
 *
 * ggplot 的字号是物理单位（pt）。出图 9 英寸宽、屏幕上只有 600px 时，
 * 9pt 的字会被压成 6px。让「1 英寸 = 96 CSS px」（物理尺寸 = 容器 px / 96），
 * 屏幕上看到的字号就是打印出来的字号，预览才真的有参考价值。
 *
 * ## 请求由调用方构建
 *
 * 三张图的参数结构完全不同（Venn 是基因集合，小提琴是文件 + 基因，
 * 生存曲线是文件 + ggsurvplot 开关）。组件不猜，只负责「量尺寸 → 请求 →
 * 显示」，由 `build` 返回 `null` 表示条件还不满足（例如还没选文件）。
 */
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, useState } from 'react'
import type { VizPlotSpec, VizRenderRequest, VizRenderResult } from '@shared/types/viz'
import { call, normalizeError } from '../../utils/ipc'

export interface VizPreviewSize {
  widthIn: number
  heightIn: number
}

interface VizPreviewProps {
  /**
   * 用实测尺寸构建请求；返回 null = 条件不足，不发请求（显示 `emptyHint`）。
   *
   * 放在 ref 里调用，因此它**不需要**是稳定引用；重绘由 `deps` 驱动。
   */
  build: (size: VizPreviewSize) => VizPlotSpec | null
  /** 依赖变化即重绘（通常是所有会影响出图的参数） */
  deps: readonly unknown[]
  height?: number
  emptyHint?: string
  /** 依赖变化后等多久才请求（毫秒） */
  debounceMs?: number
  /**
   * 出图成功后回调完整结果（含 `summary`）。
   *
   * Venn 需要它：图上的数字点不了（静态图没有命中测试），但 R 已经把
   * 「每个交集区域里有哪些基因」算好了，界面据此渲染一张可展开的交集表。
   * 没有这个回调，那些数据就烂在 IPC 返回值里了。
   */
  onResult?: (result: VizRenderResult) => void
}

export function VizPreview({
  build,
  deps,
  height = 420,
  emptyHint = '配置完成后自动出图',
  debounceMs = 600,
  onResult
}: VizPreviewProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const buildRef = useRef(build)
  buildRef.current = build
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  const [size, setSize] = useState<VizPreviewSize>({ widthIn: 6, heightIn: 4.2 })
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    // jsdom / 老内核没有 ResizeObserver：退回初始尺寸，不能让页面抛错白屏
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width < 50 || rect.height < 50) return
      setSize({
        widthIn: Math.round((rect.width / 96) * 100) / 100,
        heightIn: Math.round((rect.height / 96) * 100) / 100
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const request = buildRef.current(size)
    setTouched(true)
    if (!request) {
      setDataUrl(null)
      setError(null)
      setLoading(false)
      return undefined
    }

    const seq = (seqRef.current += 1)
    // loading 在真正发请求时才置 true：依赖连续变化期间一直转圈会像卡死
    const timer = setTimeout(() => {
      setLoading(true)
      void (async () => {
        try {
          const result = await call(
            window.deg.viz.render({ ...request, widthIn: size.widthIn, heightIn: size.heightIn } as VizRenderRequest)
          )
          if (seqRef.current !== seq) return
          if (!result.dataUrl) {
            setError('R 没有返回图像数据。')
            return
          }
          setDataUrl(result.dataUrl)
          setError(null)
          onResultRef.current?.(result)
        } catch (err) {
          if (seqRef.current !== seq) return
          // 失败不清图：留着上一张，用户至少知道刚才那张长什么样
          setError(normalizeError(err).message)
        } finally {
          if (seqRef.current === seq) setLoading(false)
        }
      })()
    }, debounceMs)

    return () => clearTimeout(timer)
    // build 通过 ref 读取，不放进依赖；重绘由 deps 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.widthIn, size.heightIn, debounceMs, ...deps])

  return (
    <Box ref={boxRef} sx={{ position: 'relative', width: '100%', height, overflow: 'hidden' }}>
      {dataUrl ? (
        <Box
          component="img"
          src={dataUrl}
          alt="绘图预览"
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
            textAlign: 'center',
            px: 3
          }}
        >
          {touched && loading ? '正在用 R 渲染…' : emptyHint}
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
            出图失败：{error}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
