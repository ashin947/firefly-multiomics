/**
 * ECharts 宿主组件：负责 init / setOption / resize / dispose。
 *
 * 为什么要单独一层：
 *  每个图表组件都自己写 init/dispose 必然漏掉其中一步 ——
 *  最常见的是忘记 dispose，切页面后 canvas 泄漏，内存一路涨到几个 G。
 *  这里用 ResizeObserver 跟随容器尺寸（侧栏折叠、窗口缩放都能自适应）。
 */
import Box from '@mui/material/Box'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

interface ChartHostProps {
  option: EChartsOption
  /**
   * 按目标画布尺寸重建 option（导出时用）。
   *
   * ★ 必须提供，否则导出大/小尺寸的图会沿用屏显布局：
   *   边距、图例位置、点大小都是按像素算的，画布从 900px 缩到 336px 时
   *   这些数字不会跟着变 —— 结果就是「图变小了，但留白、图例、点还是原来那么大」，
   *   图例被裁成半截字、点挤成一团（客户实际遇到过）。
   */
  buildOption?: (size: { width: number; height: number }) => EChartsOption
  /** 容器高度（px） */
  height?: number | string
  /** 图表为空时的占位文案 */
  emptyText?: string
  /** 是否有数据（false 时显示占位而不是空白 canvas） */
  hasData?: boolean
  onPointHover?: (name: string | null) => void
}

/** 导出尺寸（物理单位）。CSS 按 96 dpi 排版，再按目标 dpi 放大像素。 */
export interface ExportSize {
  widthIn: number
  heightIn: number
  dpi: number
}

/** 96 是 CSS 像素的标准 dpi —— 排版尺寸按它换算 */
const CSS_DPI = 96

/**
 * 离屏渲染同一份 option。
 *
 * 为什么要离屏而不是改容器大小：容器尺寸由布局决定，临时改它会让页面跳动；
 * 而且导出尺寸（例如 12×8 英寸）通常比屏显大得多，直接在屏上渲染会挤爆布局。
 */
function renderOffscreen(
  option: EChartsOption,
  renderer: 'canvas' | 'svg',
  cssWidth: number,
  cssHeight: number
): { chart: echarts.ECharts; holder: HTMLDivElement } {
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  // 必须在文档里（svg2pdf 要量 bbox），但放到视口外；display:none 会让尺寸为 0
  holder.style.cssText = `position:fixed;left:-100000px;top:0;width:${cssWidth}px;height:${cssHeight}px;pointer-events:none;`
  document.body.appendChild(holder)
  const chart = echarts.init(holder, undefined, { renderer, width: cssWidth, height: cssHeight })
  // 导出不能是动画中间帧
  chart.setOption({ ...option, animation: false }, { notMerge: true })
  return { chart, holder }
}

/** 供父组件拿图（下载图片）用的句柄 */
export interface ChartHostHandle {
  /**
   * 导出 PNG dataURL。
   *
   * 两种模式：
   *  - 不传 `size`：直接抓当前屏显 canvas，`pixelRatio` 决定清晰度（3 ≈ 300dpi 观感）；
   *  - 传 `size`：离屏按 widthIn×heightIn 重新排版，输出**精确到像素**的图。
   *    用户要「8 英寸 300dpi」这种硬指标时只能走这条 —— 屏显容器的宽高比
   *    与用户想要的不一定一致，靠 pixelRatio 缩放改不了宽高比。
   */
  getDataUrl(opts?: {
    pixelRatio?: number
    backgroundColor?: string
    size?: ExportSize
  }): string | null
  /**
   * 导出**矢量** PDF 的 dataURL（投稿用）。
   *
   * 实现方式：另建一个隐藏的 SVG renderer 实例，把同一份 option 再渲染一遍，
   * 再把 SVG 交给 svg2pdf 转成 PDF。为什么不用 canvas 截图塞进 PDF：
   * 那样得到的是位图，期刊要求放大后矢量线条不糊 —— 位图 PDF 只是「PDF 后缀的图片」，
   * 审稿人放到 200% 就能看出来。
   */
  getPdfDataUrl(opts?: { size?: ExportSize }): Promise<string | null>
  /** 是否有可导出的内容 */
  hasChart(): boolean
}

export const ChartHost = forwardRef<ChartHostHandle, ChartHostProps>(function ChartHost(
  { option, buildOption, height = 360, emptyText = '暂无可绘制的数据', hasData = true, onPointHover },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  // 导出要重新渲染一遍，必须有最新的 option（复制一份避免引用被 ECharts 改）
  const optionRef = useRef<EChartsOption>(option)
  optionRef.current = option
  const buildOptionRef = useRef<ChartHostProps['buildOption']>(buildOption)
  buildOptionRef.current = buildOption

  /** 取指定尺寸下该用的 option（有 builder 就重建，否则复用屏显那份） */
  const optionFor = (width: number, heightPx: number): EChartsOption => {
    const builder = buildOptionRef.current
    return builder ? builder({ width, height: heightPx }) : optionRef.current
  }

  useImperativeHandle(
    ref,
    () => ({
      getDataUrl(opts) {
        const background = opts?.backgroundColor ?? '#FFFFFF'

        if (opts?.size) {
          const { widthIn, heightIn, dpi } = opts.size
          // CSS 尺寸按 96dpi 排版 → 再乘 pixelRatio 到目标像素
          const cssWidth = Math.round(widthIn * CSS_DPI)
          const cssHeight = Math.round(heightIn * CSS_DPI)
          const pixelRatio = dpi / CSS_DPI
          let chart: echarts.ECharts | null = null
          let holder: HTMLDivElement | null = null
          try {
            const made = renderOffscreen(optionFor(cssWidth, cssHeight), 'canvas', cssWidth, cssHeight)
            chart = made.chart
            holder = made.holder
            return chart.getDataURL({ type: 'png', pixelRatio, backgroundColor: background })
          } catch {
            return null
          } finally {
            chart?.dispose()
            holder?.remove()
          }
        }

        const chart = chartRef.current
        if (!chart) return null
        return chart.getDataURL({
          type: 'png',
          pixelRatio: opts?.pixelRatio ?? 3,
          backgroundColor: background
        })
      },

      async getPdfDataUrl(opts) {
        const size = opts?.size
        // 不给尺寸时沿用屏显比例（900×420 pt 约等于 12.5×5.8 英寸）
        const widthIn = size?.widthIn ?? 12
        const heightIn = size?.heightIn ?? 6
        const cssWidth = Math.max(320, Math.round(widthIn * CSS_DPI))
        const cssHeight = Math.max(240, Math.round(heightIn * CSS_DPI))
        // PDF 的点是 1/72 英寸
        const ptWidth = widthIn * 72
        const ptHeight = heightIn * 72

        let svgChart: echarts.ECharts | null = null
        let holder: HTMLDivElement | null = null
        try {
          const made = renderOffscreen(optionFor(cssWidth, cssHeight), 'svg', cssWidth, cssHeight)
          svgChart = made.chart
          holder = made.holder
          const svg = holder.querySelector('svg')
          if (!svg) return null

          // 动态加载：jsPDF + svg2pdf 加起来约 400 KB，只在真正导出 PDF 时才拉
          const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')])
          const pdf = new jsPDF({
            orientation: ptWidth >= ptHeight ? 'landscape' : 'portrait',
            unit: 'pt',
            format: [ptWidth, ptHeight],
            compress: true
          })
          pdf.setFillColor(255, 255, 255)
          pdf.rect(0, 0, ptWidth, ptHeight, 'F')
          await pdf.svg(svg as unknown as SVGElement, { x: 0, y: 0, width: ptWidth, height: ptHeight })
          return pdf.output('datauristring')
        } catch {
          return null
        } finally {
          svgChart?.dispose()
          holder?.remove()
        }
      },

      hasChart: () => chartRef.current !== null
    }),
    []
  )

  // 初始化 + 尺寸跟随 + 卸载清理
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const chart = echarts.init(el, undefined, { renderer: 'canvas' })
    chartRef.current = chart

    const observer = new ResizeObserver(() => {
      chart.resize()
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // option 变化：notMerge=false 保留动画状态，lazyUpdate 让高频更新更顺
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  // hover 联动（表格 ↔ 图表）
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onPointHover) return undefined
    const handleOver = (params: unknown): void => {
      const item = params as { data?: unknown }
      const data = Array.isArray(item.data) ? (item.data as unknown[]) : null
      const name = data && typeof data[2] === 'string' ? (data[2] as string) : null
      onPointHover(name)
    }
    const handleOut = (): void => onPointHover(null)
    chart.on('mouseover', handleOver)
    chart.on('mouseout', handleOut)
    return () => {
      chart.off('mouseover', handleOver)
      chart.off('mouseout', handleOut)
    }
  }, [onPointHover])

  return (
    <Box sx={{ position: 'relative', width: '100%', height }}>
      {!hasData && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.disabled',
            fontSize: 12,
            zIndex: 1
          }}
        >
          {emptyText}
        </Box>
      )}
      <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
    </Box>
  )
})
