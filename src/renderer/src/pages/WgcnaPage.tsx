/**
 * WGCNA 页面。
 *
 * ## 为什么必须是两段
 *
 * 客户实验室的流程是「先算软阈值（soft threshold, β）→ 看拟合曲线 → 自己挑 β →
 * 再建网络」。软阈值选错，整个网络就失去无标度拓扑特性，后面所有模块都不可信 ——
 * 这不是能替用户决定的参数，所以第一段只做到 `pickSoftThreshold` 为止。
 *
 * 另一个更现实的原因：第二段（TOM + 层次聚类）在上万基因时要跑几分钟到十几分钟。
 * 合成一次调用的话，用户改一个「最小模块基因数」就得连 TOM 一起重算；而 TOM 与
 * minModuleSize / mergeHeight 完全无关。分开之后第二段带 TOM 缓存，调模块粒度只花几秒。
 *
 * ## 为什么结果要写进 URL
 *
 * 一次 WGCNA 动辄几分钟，用户切去别处看一眼再回来、或者手滑刷新，
 * 如果结果全在组件 state 里就白算了。所以跑完把 `?wgcnaId=` 写进地址，
 * 挂载时用 `loadResult` 从磁盘把两段结果恢复出来。
 *
 * ## 布局
 *
 * 与 GseaPage 保持一致：左侧配置面板、右侧结果区。第二段的参数编辑区
 * **放在第一段结果的下方**（右侧），因为 β 的可选值来自第一段算出来的拟合表 ——
 * 用户是「看着图挑 β」，参数必须紧挨着图。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CheckIcon from '@mui/icons-material/Check'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormLabel from '@mui/material/FormLabel'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import DownloadIcon from '@mui/icons-material/Download'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { STAGE_LABELS, type Stage } from '@shared/constants'
import { IPC } from '@shared/ipc'
import type {
  WgcnaHeatmapPalette,
  WgcnaNetworkResult,
  WgcnaPlot,
  WgcnaPlotFormat,
  WgcnaPrepareResult,
  WgcnaTableId,
  WgcnaTransform,
  WgcnaVarianceFilter
} from '@shared/types/wgcna'
import { WGCNA_HEATMAP_PALETTES } from '@shared/types/wgcna'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { call } from '../utils/ipc'
import { ErrorAlert, toUiError, type UiError } from '../components/common/ErrorAlert'

/**
 * WGCNA 的模块名就是颜色名。绝大多数能直接当 CSS 颜色用，
 * 但 `skyblue3` / `plum1` / `grey60` 这类 R 侧的编号色名不是合法 CSS 值 ——
 * 浏览器会静默忽略，圆点变成透明，用户就分不清哪个 chip 是哪个模块。
 * 所以这里显式给出 hex；认不出的（自定义模块色）退回中性灰。
 */
const MODULE_COLORS: Record<string, string> = {
  turquoise: '#40E0D0',
  blue: '#0000FF',
  brown: '#A52A2A',
  yellow: '#FFFF00',
  green: '#00FF00',
  red: '#FF0000',
  black: '#000000',
  pink: '#FFC0CB',
  magenta: '#FF00FF',
  purple: '#A020F0',
  greenyellow: '#ADFF2F',
  tan: '#D2B48C',
  salmon: '#FA8072',
  cyan: '#00FFFF',
  midnightblue: '#191970',
  lightcyan: '#E0FFFF',
  grey60: '#9E9E9E',
  lightgreen: '#90EE90',
  lightyellow: '#FFFFE0',
  royalblue: '#4169E1',
  darkred: '#8B0000',
  darkgreen: '#006400',
  darkturquoise: '#00CED1',
  darkgrey: '#A9A9A9',
  orange: '#FFA500',
  darkorange: '#FF8C00',
  white: '#FFFFFF',
  skyblue: '#87CEEB',
  saddlebrown: '#8B4513',
  steelblue: '#4682B4',
  paleturquoise: '#AFEEEE',
  violet: '#EE82EE',
  darkolivegreen: '#556B2F',
  darkmagenta: '#8B008B',
  sienna3: '#CD6839',
  yellowgreen: '#9ACD32',
  skyblue3: '#6CA6CD',
  plum1: '#FFBBFF',
  orangered4: '#CD3700',
  mediumpurple3: '#8968CD',
  lightsteelblue1: '#CAE1FF',
  lightcyan1: '#D1FFFF',
  grey: '#808080'
}

/** 模块色名 → CSS 颜色（认不出退回 #999，至少还能看到一个点） */
function moduleColor(name: string): string {
  return MODULE_COLORS[name] ?? '#999'
}

/**
 * 这个模块色上该用深色字还是浅色字。
 *
 * 模块名就是颜色名，yellow / white / lightyellow 这些浅色底上用白字等于看不见。
 * 按相对亮度算，阈值 150 是经验值（yellow #FFFF00 的亮度约 226，turquoise #40E0D0 约 201，
 * blue #0000FF 只有 29）—— 只有真的浅到底色才切深色字。
 */
function needsDarkText(name: string): boolean {
  const hex = moduleColor(name).replace('#', '')
  if (hex.length !== 6) return false
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150
}

const VARIANCE_OPTIONS: { value: WgcnaVarianceFilter; label: string; hint: string }[] = [
  {
    value: 'top25',
    label: '前 25% 高方差基因（top25）',
    hint: '基因最少、跑得最快；先摸清数据结构时用它试跑'
  },
  {
    value: 'top50',
    label: '前 50% 高方差基因（top50，客户脚本默认）',
    hint: '速度与模块完整性之间最平衡的一档'
  },
  {
    value: 'all',
    label: '全部基因（all）',
    hint: '最完整，但 TOM 的计算量与内存占用随基因数平方增长'
  }
]

const TRANSFORM_OPTIONS: { value: WgcnaTransform; label: string }[] = [
  { value: 'auto', label: '自动判断（auto，默认）' },
  { value: 'log2', label: '强制 log2(x+1)' },
  { value: 'none', label: '不做变换（none）' }
]

const TRANSFORM_HINT =
  'auto：最大值 > 50 认为是原始 counts 并做 log2(x+1)；否则认为已是 log 尺度、不再变换（客户原脚本会无条件再 log 一次）'

/** 第一段的 3 张质控图，按「先看离群、再看拟合」的阅读顺序固定排列 */
const PREPARE_PLOT_ORDER = ['sampleTree', 'scaleIndependence', 'meanConnectivity']

/** 第二段的结果表，顺序与导出菜单一致 */
const TABLE_ORDER: { id: WgcnaTableId; label: string }[] = [
  { id: 'powers', label: '软阈值拟合表（powers）' },
  { id: 'genes', label: '基因-模块归属表（genes）' },
  { id: 'modules', label: '模块大小表（modules）' },
  { id: 'traits', label: '模块-性状相关表（traits）' },
  { id: 'eigengenes', label: '模块特征向量表（eigengenes）' }
]

/** 默认值集中在这里，避免散落在 JSX 里 */
/** 超过这个基因数就提示 TOM 的内存开销（约 10000² × 8 字节 ≈ 800 MB 起） */
const TOM_HEAVY_GENES = 10000

const DEFAULTS = {
  minModuleSize: 100,
  minModuleSizeMin: 10,
  minModuleSizeMax: 5000,
  mergeHeight: 0.25,
  /** WGCNA 的经验门槛：signed R² 首次 ≥ 0.85 的最小 power */
  fitThreshold: 0.85
}

interface FileFieldProps {
  label: string
  value: string
  onChange: (path: string) => void
  extensions: string[]
  hint?: string
  disabled?: boolean
  /** 传了就渲染「不使用」清除按钮（性状表这类可选输入） */
  onClear?: () => void
  clearLabel?: string
}

/**
 * 只调 `system.pickFile` 的选文件控件。
 *
 * 不复用 `SourceFileField`：那个组件选完会紧接着调 `viz.inspectSource` 探测列名，
 * 而 WGCNA 没有探测通道（矩阵动辄上万行，预读一遍纯属浪费）。
 */
function FileField({
  label,
  value,
  onChange,
  extensions,
  hint,
  disabled = false,
  onClear,
  clearLabel = '清除'
}: FileFieldProps): JSX.Element {
  const pick = useCallback(async () => {
    try {
      const paths = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '表格文件', extensions },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const path = paths[0]
      if (path) onChange(path)
    } catch {
      // 用户取消或对话框异常：静默即可，不需要在面板上堆一条错误
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
          disabled={disabled}
          sx={{ height: 32, whiteSpace: 'nowrap' }}
        >
          {value ? '重新选择' : label}
        </Button>
        {onClear && value && (
          <Button size="small" onClick={onClear} disabled={disabled} sx={{ fontSize: 10.5, minWidth: 0 }}>
            {clearLabel}
          </Button>
        )}
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
    </Box>
  )
}

interface PlotCardProps {
  plot: WgcnaPlot
  /**
   * 给了就显示右上角导出按钮（第一段的图在第二段之前也能导）。
   * 回调带 anchor 是因为要在这个按钮下面弹「PNG / PDF」菜单 ——
   * 两种格式是两个文件，不能让用户靠改后缀去猜。
   */
  onExport?: (anchor: HTMLElement) => void
  action?: ReactNode
}

/** 一张诊断图：标题 + 图 + 中文 caption。图缺失时降级成一行说明，不整页失败 */
function PlotCard({ plot, onExport, action }: PlotCardProps): JSX.Element {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#fff'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 1, py: 0.5, backgroundColor: 'grey.50', gap: 0.5 }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 11.5 }}>
          {plot.title}
        </Typography>
        {onExport && (
          <Tooltip title={plot.hasPdf ? '导出这张图（PNG / PDF 矢量）' : '导出这张图（PNG）'}>
            <IconButton
              size="small"
              onClick={(e) => onExport(e.currentTarget)}
              aria-label={`导出 ${plot.title}`}
            >
              <DownloadIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {plot.dataUrl ? (
        <Box
          component="img"
          src={plot.dataUrl}
          alt={plot.title}
          sx={{ width: '100%', display: 'block', backgroundColor: '#fff' }}
        />
      ) : (
        <Box sx={{ px: 1.25, py: 2, color: 'text.disabled' }}>
          <Typography variant="body2" sx={{ fontSize: 10.5 }}>
            这张图没有生成（R 侧绘图失败，不影响其它结果）
          </Typography>
        </Box>
      )}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ px: 1, py: 0.75, fontSize: 10.5, lineHeight: 1.45 }}
      >
        {plot.caption}
      </Typography>
      {action}
    </Box>
  )
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function fmtP(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v < 1e-4) return v.toExponential(2)
  return v.toFixed(4)
}

/** 一个小统计卡（第一段顶部四连） */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.25, py: 0.75, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="body2" color="text.disabled" sx={{ fontSize: 9.5 }}>
          {hint}
        </Typography>
      )}
    </Box>
  )
}

export function WgcnaPage(): JSX.Element {
  // ---- 第一段配置 ----
  const [matrixPath, setMatrixPath] = useState('')
  const [traitPath, setTraitPath] = useState('')
  const [varianceFilter, setVarianceFilter] = useState<WgcnaVarianceFilter>('top50')
  const [transform, setTransform] = useState<WgcnaTransform>('auto')
  const [cutHeight, setCutHeight] = useState('')

  // ---- 第一段状态 ----
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<UiError | null>(null)
  const [prepare, setPrepare] = useState<WgcnaPrepareResult | null>(null)

  // ---- 第二段配置 ----
  const [softPower, setSoftPower] = useState<number | ''>('')
  const [minModuleSize, setMinModuleSize] = useState(String(DEFAULTS.minModuleSize))
  const [mergeHeight, setMergeHeight] = useState(DEFAULTS.mergeHeight)
  const [paletteId, setPaletteId] = useState<WgcnaHeatmapPalette>('blueWhiteRed')
  const [profileModule, setProfileModule] = useState('')

  // ---- 第二段状态 ----
  const [networking, setNetworking] = useState(false)
  const [networkError, setNetworkError] = useState<UiError | null>(null)
  const [network, setNetwork] = useState<WgcnaNetworkResult | null>(null)

  // ---- 进度 / 日志 / 杂项 ----
  const [progress, setProgress] = useState<{ stage: Stage; pct: number; msg?: string } | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [restoring, setRestoring] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  /**
   * 单张图导出菜单（PNG / PDF）。
   * 存的是「哪张图 + 菜单挂在哪个图标下面」：两种格式对应两个不同文件，
   * 必须先问清格式再弹保存框，不能靠用户改后缀。
   */
  const [plotMenu, setPlotMenu] = useState<{ anchor: HTMLElement; plot: WgcnaPlot } | null>(null)

  /**
   * 模块基因面板的状态。
   *
   * 基因列表**按需拉**（点模块才请求一次），不跟 network 结果一起返回：
   * 上万基因的数组会让每次「改合并高度重跑」都多传几十 KB JSON，而多数时候
   * 用户只想看模块大小，并不看具体基因。
   */
  const [activeModule, setActiveModule] = useState('')
  const [moduleGenes, setModuleGenes] = useState<{ module: string; genes: string[] } | null>(null)
  const [moduleGeneBusy, setModuleGeneBusy] = useState(false)
  const [moduleGeneFilter, setModuleGeneFilter] = useState('')
  const [moduleGeneMenu, setModuleGeneMenu] = useState<HTMLElement | null>(null)
  const [exportingAll, setExportingAll] = useState(false)

  const [searchParams, setSearchParams] = useSearchParams()

  /** 当前这次运行的 id：进度/日志事件靠它过滤（同一时刻可能有别的分析在跑） */
  const wgcnaId = prepare?.wgcnaId ?? network?.wgcnaId ?? ''
  /**
   * 已经在本页算出来的 id。
   * 我们自己把 id 写进 URL 后，恢复用的 effect 会再次触发 —— 没有这个标记的话，
   * 「刚跑完」会立刻被「从磁盘读回空快照」覆盖，用户看到结果闪一下消失。
   */
  const knownIdRef = useRef<string | null>(null)

  // ---- 事件订阅：卸载时必须取消，否则 HMR 会把监听器越挂越多 ----
  useIpcEvent(IPC.event.analysisProgress, (payload) => {
    if (!wgcnaId || payload.runId !== wgcnaId) return
    setProgress({ stage: payload.stage, pct: payload.pct, msg: payload.msg })
  })
  useIpcEvent(IPC.event.analysisLog, (payload) => {
    if (!wgcnaId || payload.runId !== wgcnaId) return
    // 只留最后 3 行：这框的作用是「证明没卡死」，滚动历史日志会把它撑得很难看
    setLogs((prev) => [...prev, payload.line].slice(-3))
  })

  // ---- 会话恢复：?wgcnaId= 存在时从磁盘把两段结果读回来 ----
  const restoreId = searchParams.get('wgcnaId')
  useEffect(() => {
    if (!restoreId) return
    if (knownIdRef.current === restoreId) return

    let cancelled = false
    setRestoring(true)
    void (async () => {
      try {
        const res = await call(window.deg.wgcna.loadResult({ wgcnaId: restoreId }))
        if (cancelled) return
        if (res.prepare) {
          setPrepare(res.prepare)
          const powers = Array.isArray(res.prepare.powers) ? res.prepare.powers : []
          setSoftPower(
            typeof res.prepare.recommendedPower === 'number'
              ? res.prepare.recommendedPower
              : (powers[0]?.power ?? '')
          )
        }
        if (res.network) setNetwork(res.network)
      } catch (err) {
        if (!cancelled) setPrepareError(toUiError(err))
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [restoreId])

  const canPrepare = Boolean(matrixPath)

  // `auto` 由 R 侧判断，这里不做任何推断 —— 前端猜一次、R 再猜一次，两者不一致时最难查
  const parsedCutHeight = useMemo(() => {
    const raw = cutHeight.trim()
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }, [cutHeight])

  const runPrepare = useCallback(async () => {
    if (!matrixPath) return
    setPreparing(true)
    setPrepareError(null)
    setNetworkError(null)
    setNotice(null)
    setProgress(null)
    setLogs([])
    // 重跑第一段等于换了一份数据，旧的网络结果不再对应任何东西，必须清掉
    setNetwork(null)
    try {
      const res = await call(
        window.deg.wgcna.prepare({
          matrixPath,
          traitPath: traitPath || undefined,
          varianceFilter,
          transform,
          sampleCutHeight: parsedCutHeight,
          minSamples: 8
        })
      )
      setPrepare(res)
      knownIdRef.current = res.wgcnaId
      const powers = Array.isArray(res.powers) ? res.powers : []
      setSoftPower(typeof res.recommendedPower === 'number' ? res.recommendedPower : (powers[0]?.power ?? ''))
      setProfileModule('')
      // 新的 wgcnaId 意味着新的基因集，旧面板的基因必须清掉 ——
      // 留着会让人以为「这批基因属于新网络」，实际上模块边界已经变了
      setActiveModule('')
      setModuleGenes(null)
      setSearchParams({ wgcnaId: res.wgcnaId })
    } catch (err) {
      setPrepareError(toUiError(err))
      setPrepare(null)
    } finally {
      setPreparing(false)
    }
  }, [matrixPath, traitPath, varianceFilter, transform, parsedCutHeight, setSearchParams])

  const runNetwork = useCallback(
    async (which?: string) => {
      if (!prepare || softPower === '') return
      const minSize = Math.min(
        DEFAULTS.minModuleSizeMax,
        Math.max(DEFAULTS.minModuleSizeMin, Math.round(Number(minModuleSize) || DEFAULTS.minModuleSize))
      )
      setNetworking(true)
      setNetworkError(null)
      setNotice(null)
      setProgress(null)
      setLogs([])
      try {
        const res = await call(
          window.deg.wgcna.network({
            wgcnaId: prepare.wgcnaId,
            softPower: Number(softPower),
            minModuleSize: minSize,
            mergeHeight,
            heatmapPalette: paletteId,
            profileModule: which || undefined
          })
        )
        setNetwork(res)
        knownIdRef.current = res.wgcnaId
        setProfileModule(which ?? '')
        // 重切模块后同名颜色的基因集合会变（turquoise 可能多了/少了几百个），
        // 旧列表留在屏幕上就是错的数据
        setActiveModule('')
        setModuleGenes(null)
        setSearchParams({ wgcnaId: res.wgcnaId })
      } catch (err) {
        setNetworkError(toUiError(err))
      } finally {
        setNetworking(false)
      }
    },
    [prepare, softPower, minModuleSize, mergeHeight, paletteId, setSearchParams]
  )

  /** 导出单张图：R 早就画好了，这里只是把它复制到用户选的位置 */
  /**
   * 导出单张诊断图。
   *
   * 为什么让用户先选格式、而不是靠保存框的扩展名猜：
   * PNG 与 PDF 是**两个不同的文件**（R 用两个设备分别画的），不是同一张图换个后缀。
   * 按后缀猜的话，用户手动把 ".png" 改成 ".pdf" 就会拿到一个其实是 png 的文件，
   * 投稿时才发现放大是马赛克 —— 这种坑宁可多点一步也不要踩。
   */
  const exportOne = useCallback(
    async (plot: WgcnaPlot, format: WgcnaPlotFormat) => {
      if (!wgcnaId) return
      setPlotMenu(null)
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `wgcna-${plot.id}-${stamp}.${format}`,
            filters:
              format === 'pdf'
                ? [{ name: 'PDF 矢量图', extensions: ['pdf'] }]
                : [{ name: 'PNG 图片', extensions: ['png'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.wgcna.exportPlot({ wgcnaId, plotId: plot.id, outPath, format }))
        setNotice(
          format === 'pdf'
            ? `已导出矢量 PDF（可在 Illustrator / AI 排版里无损缩放）：${outPath}`
            : `已导出 PNG：${outPath}`
        )
      } catch (err) {
        setPrepareError(toUiError(err))
      }
    },
    [wgcnaId]
  )

  /** 一次导出全部诊断图：选一个目录，主进程把 runDir 里的 png 全拷进去 */
  const exportAll = useCallback(async () => {
    if (!wgcnaId) return
    setExportingAll(true)
    setNotice(null)
    try {
      const dir = await call(window.deg.system.pickDir())
      if (!dir) return
      const res = await call(window.deg.wgcna.exportAll({ wgcnaId, dir }))
      const parts = [`PNG ${res.png} 张`, `PDF ${res.pdf} 张`]
      setNotice(
        res.missingPdf > 0
          ? `已导出 ${parts.join('、')} 到：${res.dir}。有 ${res.missingPdf} 张图没有矢量 PDF（这次运行是在支持 PDF 之前跑的），点「② 构建网络」重跑一次即可补齐。`
          : `已导出 ${parts.join('、')} 到：${res.dir}`
      )
    } catch (err) {
      setPrepareError(toUiError(err))
    } finally {
      setExportingAll(false)
    }
  }, [wgcnaId])

  /**
   * 点模块 chip → 拉这个模块的基因。
   *
   * 再点同一个模块就收起（省得面板一直占着地方）；切到别的模块直接换内容，
   * 不清空 —— 加载中保留了上一个模块的列表，比闪成空白好。
   */
  const openModuleGenes = useCallback(
    async (module: string) => {
      if (!wgcnaId) return
      if (activeModule === module && moduleGenes?.module === module) {
        setActiveModule('')
        setModuleGenes(null)
        return
      }
      setActiveModule(module)
      setModuleGeneFilter('')
      setModuleGeneBusy(true)
      try {
        const res = await call(window.deg.wgcna.moduleGenes({ wgcnaId, module }))
        setModuleGenes({ module: res.module, genes: Array.isArray(res.genes) ? res.genes : [] })
      } catch (err) {
        setNetworkError(toUiError(err))
        setActiveModule('')
        setModuleGenes(null)
      } finally {
        setModuleGeneBusy(false)
      }
    },
    [wgcnaId, activeModule, moduleGenes]
  )

  /**
   * 导出模块基因。
   *
   * `module` 为空表示导全部模块（长表 module,gene）—— 一次把整套模块基因带走，
   * 客户做下游富集时经常是「每个模块都跑一遍」，一个一个点太慢。
   */
  const exportModuleGenes = useCallback(
    async (module: string | undefined, format: 'csv' | 'xlsx' | 'txt') => {
      setModuleGeneMenu(null)
      if (!wgcnaId) return
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const base = module ? `wgcna-${module}-genes-${stamp}` : `wgcna-all-modules-genes-${stamp}`
        const filters: Record<string, { name: string; extensions: string[] }[]> = {
          csv: [{ name: 'CSV 表格', extensions: ['csv'] }],
          xlsx: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
          txt: [{ name: '纯文本（一行一个基因）', extensions: ['txt'] }]
        }
        const outPath = await call(
          window.deg.system.saveFile({ defaultName: `${base}.${format}`, filters: filters[format] })
        )
        if (!outPath) return
        const res = await call(
          window.deg.wgcna.exportModuleGenes({ wgcnaId, module, outPath, format })
        )
        setNotice(
          module
            ? `已导出 ${module} 模块的 ${res.genes} 个基因：${res.outPath}`
            : `已导出全部 ${res.genes} 个基因（含模块名）：${res.outPath}`
        )
      } catch (err) {
        setNetworkError(toUiError(err))
      }
    },
    [wgcnaId]
  )

  /** 导出结果表：csv / xlsx 由保存框的扩展名决定，用户不用再选一次格式 */
  const exportTable = useCallback(
    async (table: WgcnaTableId) => {
      setMenuAnchor(null)
      if (!wgcnaId) return
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `wgcna-${table}.csv`,
            filters: [
              { name: 'CSV 表格', extensions: ['csv'] },
              { name: 'Excel 工作簿', extensions: ['xlsx'] }
            ]
          })
        )
        if (!outPath) return
        const format = outPath.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv'
        const res = await call(window.deg.wgcna.exportTable({ wgcnaId, table, outPath, format }))
        setNotice(`已导出 ${res.rows} 行到：${res.outPath}`)
      } catch (err) {
        setPrepareError(toUiError(err))
      }
    },
    [wgcnaId]
  )

  // 运行期拿到的数组字段一律再过一次 Array.isArray：
  // R 的 `jsonlite(auto_unbox = TRUE)` 会把长度为 1 的数组塌成标量，
  // 直接 .map/.join 会让整页崩成白屏。
  const powers = useMemo(() => (Array.isArray(prepare?.powers) ? prepare!.powers : []), [prepare])
  const traits = useMemo(() => (Array.isArray(prepare?.traits) ? prepare!.traits : []), [prepare])
  const preparePlots = useMemo(() => {
    const plots = Array.isArray(prepare?.plots) ? prepare!.plots : []
    const ordered = PREPARE_PLOT_ORDER.map((id) => plots.find((p) => p.id === id)).filter(
      (p): p is WgcnaPlot => Boolean(p)
    )
    // id 对不上（R 侧改了图 id）时至少把已有的图都显示出来，而不是空白
    return ordered.length > 0 ? ordered : plots
  }, [prepare])

  const networkPlots = useMemo(() => (Array.isArray(network?.plots) ? network!.plots : []), [network])
  const modules = useMemo(() => (Array.isArray(network?.modules) ? network!.modules : []), [network])
  const traitRows = useMemo(() => {
    const rows = Array.isArray(network?.traitRows) ? network!.traitRows : []
    // 按 |cor| 降序：用户打开这张表就是为了找「相关最强的模块-性状对」
    return [...rows].sort((a, b) => Math.abs(b.cor) - Math.abs(a.cor))
  }, [network])

  const profilePlot = networkPlots.find((p) => p.id === 'moduleProfile')
  const otherNetworkPlots = networkPlots.filter((p) => p.id !== 'moduleProfile')

  const canNetwork = Boolean(prepare) && softPower !== ''
  /**
   * 第一段重跑时也要锁住第二段：此时 β 与网络结果对不上新数据，
   * 让用户点了只会拿到一条「stage1.rds 不存在」的困惑报错。
   */
  const stage2Locked = networking || preparing

  const progressText = progress
    ? `${STAGE_LABELS[progress.stage] ?? progress.stage} · ${Math.round(progress.pct)}%${
        progress.msg ? ` · ${progress.msg}` : ''
      }`
    : '正在启动 R 进程…'

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 380px) 1fr',
        gap: 2,
        p: 2,
        height: '100%'
      }}
    >
      {/* ---------------- 左侧配置：只有第一段 ---------------- */}
      <Card variant="outlined" sx={{ p: 2, overflowY: 'auto' }}>
        <Typography variant="h3" sx={{ mb: 1.5 }}>
          WGCNA 配置
        </Typography>

        <FileField
          label="表达矩阵"
          value={matrixPath}
          onChange={setMatrixPath}
          extensions={['tsv', 'txt', 'csv']}
          disabled={preparing}
          hint="行=基因（第一列基因 ID），列=样本"
        />

        <Box sx={{ mt: 1.5 }}>
          <FileField
            label="性状表（可选）"
            value={traitPath}
            onChange={setTraitPath}
            extensions={['tsv', 'txt', 'csv']}
            disabled={preparing}
            onClear={() => setTraitPath('')}
            clearLabel="不使用性状表"
            hint="行=样本、列=性状、数值。没有性状表也能建网络，但不会有模块-性状相关热图"
          />
        </Box>

        <Divider sx={{ my: 1.5 }} />

        <FormControl component="fieldset" disabled={preparing} sx={{ width: '100%' }}>
          <FormLabel component="legend" sx={{ fontSize: 11.5, fontWeight: 600, mb: 0.5 }}>
            样本量筛选（方差过滤）
          </FormLabel>
          <RadioGroup
            value={varianceFilter}
            onChange={(e) => setVarianceFilter(e.target.value as WgcnaVarianceFilter)}
          >
            {VARIANCE_OPTIONS.map((opt) => (
              <Box key={opt.value} sx={{ mb: 0.5 }}>
                <FormControlLabel
                  value={opt.value}
                  control={<Radio size="small" sx={{ py: 0.25 }} />}
                  label={<Typography sx={{ fontSize: 11.5 }}>{opt.label}</Typography>}
                  sx={{ alignItems: 'flex-start', m: 0 }}
                />
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ fontSize: 10, ml: 3.5, lineHeight: 1.35 }}
                >
                  {opt.hint}
                </Typography>
              </Box>
            ))}
          </RadioGroup>
        </FormControl>

        {varianceFilter === 'all' && (
          <Alert severity="warning" sx={{ mt: 1, fontSize: 10.5, py: 0.25 }}>
            上万基因的 TOM 计算需要几分钟到十几分钟，且占用大量内存；先用 top25/top50 试跑更稳。
          </Alert>
        )}

        <TextField
          select
          size="small"
          label="数值变换"
          value={transform}
          onChange={(e) => setTransform(e.target.value as WgcnaTransform)}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
          sx={{ mt: 1.5, '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
          helperText={TRANSFORM_HINT}
          FormHelperTextProps={{ sx: { fontSize: 10, lineHeight: 1.35 } }}
          disabled={preparing}
          fullWidth
        >
          {TRANSFORM_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </TextField>

        <TextField
          size="small"
          label="样本离群剔除高度（可选）"
          value={cutHeight}
          onChange={(e) => setCutHeight(e.target.value)}
          InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
          sx={{ mt: 1.5, '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
          helperText="填一个高度值，聚类树上低于该高度的分支会被归为一类，只保留最大的一类；留空 = 保留全部样本"
          FormHelperTextProps={{ sx: { fontSize: 10, lineHeight: 1.35 } }}
          disabled={preparing}
          fullWidth
        />

        <Button
          variant="contained"
          size="small"
          onClick={() => void runPrepare()}
          disabled={!canPrepare || preparing}
          startIcon={preparing ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ mt: 2, fontSize: 12 }}
          fullWidth
        >
          {preparing ? '计算中…（数千基因约十几秒）' : '① 计算软阈值'}
        </Button>

        {!canPrepare && (
          <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10.5, mt: 1 }}>
            需要先选择表达矩阵。
          </Typography>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mt: 1.5, lineHeight: 1.45 }}>
          第一段只做「读矩阵 → 方差过滤 → 软阈值拟合（soft threshold, β）」，不建网络；
          确认 β 后在右侧继续。
        </Typography>
      </Card>

      {/* ---------------- 右侧结果 ---------------- */}
      <Card variant="outlined" sx={{ p: 2, overflowY: 'auto' }}>
        {restoring && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <CircularProgress size={14} />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
              正在恢复上次的 WGCNA 结果…
            </Typography>
          </Stack>
        )}

        {prepareError && <ErrorAlert error={prepareError} />}

        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 1.5, fontSize: 11 }}>
            {notice}
          </Alert>
        )}

        {!prepare && !prepareError && !restoring && (
          <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', color: 'text.disabled' }}>
            <Stack alignItems="center" spacing={1}>
              <Typography variant="body2">选择表达矩阵后点「① 计算软阈值」</Typography>
              <Typography variant="body2" sx={{ fontSize: 10.5 }}>
                先定软阈值 β，再建网络 —— 两步分开是为了让你看清拟合曲线再决定
              </Typography>
            </Stack>
          </Box>
        )}

        {prepare && (
          <Stack spacing={1.75}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h3">第一段：数据与质控</Typography>
              <Chip size="small" label={`${prepare.nGenesUsed} 个基因入网`} sx={{ fontSize: 10.5, height: 20 }} />
              {prepare.recommendedPower != null && (
                <Chip
                  size="small"
                  color="success"
                  variant="outlined"
                  label={`推荐 β = ${prepare.recommendedPower}`}
                  sx={{ fontSize: 10.5, height: 20 }}
                />
              )}
            </Stack>

            {/* 统计卡：四个数字决定「这次分析有没有意义」，必须第一眼看到 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                gap: 1
              }}
            >
              <StatCard label="输入基因数" value={String(prepare.nGenesInput)} />
              <StatCard
                label="方差过滤后基因数"
                value={String(prepare.nGenesUsed)}
                hint={
                  prepare.varianceCutoff > 0 ? `方差阈值 quantile=${fmt(prepare.varianceCutoff, 2)}` : '未做方差过滤'
                }
              />
              <StatCard label="样本数" value={String(prepare.nSamples)} />
              <StatCard
                label="剔除样本数"
                value={String(prepare.nSamplesRemoved)}
                hint={prepare.nSamplesRemoved > 0 ? '已按离群高度剔除' : '未剔除'}
              />
            </Box>

            {/*
              变换这一条是「软件到底动没动我的数据」的唯一凭证。
              客户原脚本无条件再 log 一次，如果这里不写清楚，用户永远对不上自己的旧图。
            */}
            <Alert severity="info" sx={{ fontSize: 11, py: 0.25 }}>
              本次数值变换：
              {prepare.transformUsed === 'log2'
                ? '已做 log2(x+1)'
                : '未变换（输入已是 log 尺度）'}
            </Alert>

            <Box>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  性状列
                </Typography>
                {traits.length > 0 ? (
                  traits.map((t) => (
                    <Chip key={t} size="small" label={t} sx={{ fontSize: 10, height: 18 }} />
                  ))
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                    未提供性状表，跳过模块-性状相关（网络仍可构建）
                  </Typography>
                )}
              </Stack>
              {prepare.unmatchedSamples > 0 && (
                <Alert severity="warning" sx={{ mt: 0.75, fontSize: 10.5, py: 0.25 }}>
                  有 {prepare.unmatchedSamples} 个样本在性状表里找不到，这些样本没有性状数据。
                </Alert>
              )}
            </Box>

            {/* 3 张质控图 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                gap: 1.25
              }}
            >
              {preparePlots.map((plot) => (
                <PlotCard key={plot.id} plot={plot} onExport={(anchor) => setPlotMenu({ anchor, plot })} />
              ))}
            </Box>

            {/* 软阈值拟合表 */}
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                软阈值拟合表（signed R² 越大越接近无标度拓扑）
              </Typography>
              <TableContainer sx={{ maxHeight: 320, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['power', 'signed R²', 'slope', 'mean connectivity', 'median K', 'max K'].map((h) => (
                        <TableCell
                          key={h}
                          sx={{ fontSize: 10.5, fontWeight: 600, py: 0.5, whiteSpace: 'nowrap' }}
                        >
                          {h}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {powers.map((row) => {
                      const hit = row.signedR2 >= DEFAULTS.fitThreshold
                      return (
                        <TableRow
                          key={row.power}
                          // 浅绿底：≥0.85 是选 β 的经验门槛，一眼能扫出来
                          sx={{ backgroundColor: hit ? 'rgba(76,175,80,0.12)' : undefined }}
                        >
                          <TableCell sx={{ fontSize: 11, py: 0.4, fontWeight: hit ? 600 : 400 }}>
                            {row.power}
                          </TableCell>
                          <TableCell sx={{ fontSize: 11, py: 0.4 }}>{fmt(row.signedR2)}</TableCell>
                          <TableCell sx={{ fontSize: 11, py: 0.4 }}>{fmt(row.slope)}</TableCell>
                          <TableCell sx={{ fontSize: 11, py: 0.4 }}>{fmt(row.meanK, 1)}</TableCell>
                          <TableCell sx={{ fontSize: 11, py: 0.4 }}>{fmt(row.medianK, 1)}</TableCell>
                          <TableCell sx={{ fontSize: 11, py: 0.4 }}>{fmt(row.maxK, 1)}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5, lineHeight: 1.45 }}>
                WGCNA 的经验做法：取 signed R² 首次 ≥ 0.85 的最小 power；若曲线始终上不去，
                说明样本量或基因数不足，网络不可信。
              </Typography>
            </Box>

            {/* ---------------- 第二段配置（跟着第一段结果展开） ---------------- */}
            <Divider />
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
              <Typography variant="body1" sx={{ fontWeight: 600, fontSize: 12.5, mb: 1 }}>
                ② 网络构建
              </Typography>

              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1.25} alignItems="flex-start">
                  <TextField
                    select
                    size="small"
                    label="软阈值 β（soft threshold）"
                    value={softPower === '' ? '' : String(softPower)}
                    onChange={(e) => setSoftPower(e.target.value === '' ? '' : Number(e.target.value))}
                    SelectProps={{ native: true }}
                    InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                    sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, minWidth: 200 }}
                    disabled={stage2Locked}
                  >
                    {powers.map((p) => (
                      <option key={p.power} value={p.power}>
                        {p.power}
                        {p.power === prepare.recommendedPower ? '（推荐）' : ''}
                      </option>
                    ))}
                  </TextField>

                  <TextField
                    size="small"
                    label="最小模块基因数"
                    value={minModuleSize}
                    onChange={(e) => setMinModuleSize(e.target.value)}
                    InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                    inputProps={{ min: DEFAULTS.minModuleSizeMin, max: DEFAULTS.minModuleSizeMax, step: 10 }}
                    sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, width: 150 }}
                    disabled={stage2Locked}
                  />
                </Stack>

                {prepare.recommendedPower == null && (
                  <Alert severity="warning" sx={{ fontSize: 10.5, py: 0.25 }}>
                    没有 power 能让 signed R² ≥ 0.85，这个数据集可能不适合 WGCNA。
                  </Alert>
                )}

                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10 }}>
                  客户脚本默认 100。调小会切出更多小模块，调大模块更少更稳。
                </Typography>

                <Box>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body2" sx={{ fontSize: 11, width: 110 }}>
                      模块合并高度
                    </Typography>
                    <Slider
                      size="small"
                      value={mergeHeight}
                      onChange={(_, v) => setMergeHeight(Array.isArray(v) ? v[0] : v)}
                      min={0}
                      max={1}
                      step={0.05}
                      valueLabelDisplay="auto"
                      disabled={stage2Locked}
                      sx={{ maxWidth: 220 }}
                    />
                    <Typography variant="body2" sx={{ fontSize: 11, fontWeight: 600 }}>
                      {mergeHeight.toFixed(2)}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mt: 0.25 }}>
                    模块特征向量聚类树上，相似度高于该阈值的模块会被合并。客户脚本用 0.25。
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" sx={{ fontSize: 11, fontWeight: 600, mb: 0.5 }}>
                    模块-性状热图配色
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    {WGCNA_HEATMAP_PALETTES.map((p) => {
                      const active = paletteId === p.id
                      return (
                        <Box
                          key={p.id}
                          role="button"
                          tabIndex={0}
                          aria-pressed={active}
                          onClick={() => {
                            if (!stage2Locked) setPaletteId(p.id)
                          }}
                          onKeyDown={(e) => {
                            if (stage2Locked) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setPaletteId(p.id)
                            }
                          }}
                          sx={{
                            p: 0.75,
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: active ? 'primary.main' : 'divider',
                            backgroundColor: active ? 'rgba(53,126,92,0.05)' : '#fff',
                            cursor: stage2Locked ? 'not-allowed' : 'pointer',
                            opacity: stage2Locked ? 0.6 : 1
                          }}
                        >
                          <Box
                            sx={{
                              height: 10,
                              borderRadius: 0.5,
                              border: '1px solid rgba(0,0,0,0.06)',
                              background: `linear-gradient(to right, ${p.stops[0]}, ${p.stops[1]}, ${p.stops[2]})`
                            }}
                          />
                          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5 }}>
                            <Typography
                              variant="body2"
                              sx={{ fontSize: 10.5, fontWeight: active ? 600 : 500, lineHeight: 1.3 }}
                            >
                              {p.label}
                            </Typography>
                            {active && <CheckIcon sx={{ fontSize: 12, color: 'primary.main' }} />}
                          </Stack>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ fontSize: 9.5, lineHeight: 1.35, mt: 0.25 }}
                          >
                            {p.hint}
                          </Typography>
                        </Box>
                      )
                    })}
                  </Box>
                </Box>

                {/*
                  入网基因上万时的内存提醒。
                  TOM 是 n×n 稠密矩阵，8 字节一个数：1.2 万基因 ≈ 1.2 GB，
                  再叠加 adjacency 与 dissTOM 的峰值能到 3~4 GB。客户的真实数据
                  经常是「全部基因」（上万），不提前说清楚就是跑到一半内存爆掉。
                  只提醒、不拦截 —— 选多少基因是用户对自己机器的判断。
                */}
                {prepare.nGenesUsed > TOM_HEAVY_GENES && (
                  <Alert severity="warning" sx={{ fontSize: 10.5, py: 0.25 }}>
                    {prepare.nGenesUsed} 个基因入网：TOM 矩阵约{' '}
                    {((prepare.nGenesUsed ** 2 * 8) / 1024 ** 3).toFixed(1)} GB 内存，预计十几分钟以上。
                    只想先看模块结构的话，回第一步改成「前 25% 高方差基因」更稳。
                  </Alert>
                )}

                <Button
                  variant="contained"
                  size="small"
                  onClick={() => void runNetwork()}
                  disabled={!canNetwork || stage2Locked}
                  sx={{ fontSize: 12, alignSelf: 'flex-start' }}
                >
                  {networking ? '构建中…' : '② 构建网络'}
                </Button>

                {/* 一次几分钟的任务没有进度条，用户会以为死机 */}
                {networking && (
                  <Box>
                    <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
                      {progressText}
                    </Typography>
                    {logs.length > 0 && (
                      <Box
                        component="pre"
                        sx={{
                          mt: 0.75,
                          mb: 0,
                          p: 0.75,
                          maxHeight: 66,
                          overflow: 'hidden',
                          backgroundColor: 'grey.50',
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          fontSize: 9.5,
                          lineHeight: 1.5,
                          fontFamily: 'Consolas, "Courier New", monospace',
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {logs.join('\n')}
                      </Box>
                    )}
                  </Box>
                )}
              </Stack>
            </Box>

            {networkError && <ErrorAlert error={networkError} />}

            {/* ---------------- 第二段结果 ---------------- */}
            {network && (
              <>
                <Divider />
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="h3">第二段：网络构建结果</Typography>
                  <Chip size="small" label={`${network.geneCount} 个基因`} sx={{ fontSize: 10.5, height: 20 }} />
                  <Chip size="small" label={`${modules.length} 个模块`} sx={{ fontSize: 10.5, height: 20 }} />
                  {network.tomCached && (
                    <Chip
                      size="small"
                      color="success"
                      variant="outlined"
                      label="TOM 复用缓存"
                      sx={{ fontSize: 10.5, height: 20 }}
                    />
                  )}
                </Stack>

                {network.tomCached && (
                  <Alert severity="success" sx={{ fontSize: 10.5, py: 0.25 }}>
                    本次复用了 TOM 缓存：只改模块粒度 / 合并高度 / 配色时，几秒就能出结果。
                  </Alert>
                )}

                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void exportAll()}
                    disabled={exportingAll}
                    startIcon={exportingAll ? <CircularProgress size={12} /> : undefined}
                    sx={{ fontSize: 11 }}
                  >
                    导出全部诊断图
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={(e) => setMenuAnchor(e.currentTarget)}
                    sx={{ fontSize: 11 }}
                  >
                    导出结果表
                  </Button>
                  <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                    {TABLE_ORDER.map((t) => {
                      const info = (Array.isArray(network.tables) ? network.tables : []).find((x) => x.id === t.id)
                      return (
                        <MenuItem key={t.id} onClick={() => void exportTable(t.id)} sx={{ fontSize: 11.5 }}>
                          {t.label}
                          {info ? ` ${info.rows} 行` : ''}
                        </MenuItem>
                      )
                    })}
                  </Menu>
                </Stack>

                {/* 9 张诊断图：2 列网格，窄屏 1 列 */}
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 1.25
                  }}
                >
                  {otherNetworkPlots.map((plot) => (
                    <PlotCard key={plot.id} plot={plot} onExport={(anchor) => setPlotMenu({ anchor, plot })} />
                  ))}
                </Box>

                {profilePlot && (
                  <Box>
                    <PlotCard plot={profilePlot} onExport={(anchor) => setPlotMenu({ anchor, plot: profilePlot })} />
                    {/* 换一个模块看表达模式：唯一入口，选中即重跑（TOM 有缓存，几秒） */}
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
                      <Typography variant="body2" sx={{ fontSize: 10.5 }}>
                        换一个模块看表达模式
                      </Typography>
                      <TextField
                        select
                        size="small"
                        value={profileModule}
                        onChange={(e) => {
                          setProfileModule(e.target.value)
                          void runNetwork(e.target.value)
                        }}
                        SelectProps={{ native: true }}
                        sx={{ '& .MuiInputBase-root': { height: 28, fontSize: 11 }, width: 180 }}
                        disabled={stage2Locked}
                      >
                        <option value="">默认（基因数最多的模块）</option>
                        {modules.map((m) => (
                          <option key={m.module} value={m.module}>
                            {m.module}（{m.genes} 个基因）
                          </option>
                        ))}
                      </TextField>
                      {networking && <CircularProgress size={12} />}
                    </Stack>
                  </Box>
                )}

                {/* 模块大小 */}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                    模块大小（共 {modules.length} 个模块，grey 不计入）
                  </Typography>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                    {modules.map((m) => (
                      <Chip
                        key={m.module}
                        size="small"
                        // 选中态用模块自身的颜色填充：一堆同色描边 chip 里
                        // 光靠边框变粗根本看不出选的是哪个
                        variant={activeModule === m.module ? 'filled' : 'outlined'}
                        onClick={() => void openModuleGenes(m.module)}
                        label={`${m.module} · ${m.genes}`}
                        icon={
                          <Box
                            component="span"
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              backgroundColor: moduleColor(m.module),
                              border: '1px solid rgba(0,0,0,0.15)'
                            }}
                          />
                        }
                        sx={{
                          fontSize: 10,
                          height: 22,
                          cursor: 'pointer',
                          backgroundColor:
                            activeModule === m.module ? moduleColor(m.module) : undefined,
                          color:
                            activeModule === m.module && needsDarkText(m.module)
                              ? 'rgba(0,0,0,0.87)'
                              : undefined
                        }}
                      />
                    ))}
                    {modules.length > 0 && (
                      <Button
                        size="small"
                        sx={{ fontSize: 10, height: 22, minWidth: 0, ml: 0.5 }}
                        onClick={(e) => setModuleGeneMenu(e.currentTarget)}
                      >
                        导出模块基因
                      </Button>
                    )}
                    {modules.length === 0 && (
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                        没有切出模块：多半是 minModuleSize 相对基因数太大，或该数据集不适合 WGCNA。
                      </Typography>
                    )}
                  </Stack>

                  {/* 模块基因面板：点上面的色块展开 */}
                  {activeModule && (
                    <Box
                      sx={{
                        mt: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        p: 1
                      }}
                    >
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                        <Box
                          component="span"
                          sx={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            backgroundColor: moduleColor(activeModule),
                            border: '1px solid rgba(0,0,0,0.15)'
                          }}
                        />
                        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 11 }}>
                          {activeModule} 模块
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                          {moduleGenes?.module === activeModule
                            ? `${moduleGenes.genes.length} 个基因`
                            : '加载中…'}
                        </Typography>
                        <Box sx={{ flex: 1 }} />
                        <Button
                          size="small"
                          sx={{ fontSize: 10, minWidth: 0 }}
                          disabled={!moduleGenes || moduleGenes.module !== activeModule}
                          onClick={() => {
                            const genes = moduleGenes?.genes ?? []
                            if (genes.length === 0) return
                            void navigator.clipboard
                              .writeText(genes.join('\n'))
                              .then(() => setNotice(`已复制 ${genes.length} 个基因到剪贴板`))
                              .catch(() => setPrepareError({ message: '复制失败：浏览器拒绝了剪贴板权限。', suggestion: '请改用「导出」，格式选纯文本。', detail: '' }))
                          }}
                        >
                          复制全部
                        </Button>
                        <Button
                          size="small"
                          sx={{ fontSize: 10, minWidth: 0 }}
                          disabled={!moduleGenes || moduleGenes.module !== activeModule}
                          onClick={() => void exportModuleGenes(activeModule, 'txt')}
                        >
                          导出列表
                        </Button>
                      </Stack>

                      {moduleGeneBusy && <LinearProgress sx={{ height: 3, borderRadius: 1 }} />}

                      {moduleGenes?.module === activeModule && (
                        <>
                          <TextField
                            size="small"
                            placeholder="在基因名里过滤…"
                            value={moduleGeneFilter}
                            onChange={(e) => setModuleGeneFilter(e.target.value)}
                            sx={{ mt: 0.5, '& .MuiInputBase-root': { height: 26, fontSize: 11 } }}
                            fullWidth
                          />
                          {(() => {
                            const filtered = moduleGeneFilter
                              ? moduleGenes.genes.filter((g) =>
                                  g.toLowerCase().includes(moduleGeneFilter.toLowerCase())
                                )
                              : moduleGenes.genes
                            const shown = filtered.slice(0, 300)
                            return (
                              <>
                                <Box
                                  sx={{
                                    mt: 0.5,
                                    maxHeight: 150,
                                    overflow: 'auto',
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                                    gap: 0.25,
                                    p: 0.5,
                                    backgroundColor: 'grey.50',
                                    borderRadius: 1
                                  }}
                                >
                                  {shown.map((g) => (
                                    <Typography
                                      key={g}
                                      variant="body2"
                                      sx={{ fontSize: 10, fontFamily: 'monospace', lineHeight: 1.5 }}
                                    >
                                      {g}
                                    </Typography>
                                  ))}
                                  {shown.length === 0 && (
                                    <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10 }}>
                                      没有匹配的基因
                                    </Typography>
                                  )}
                                </Box>
                                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 9.5, mt: 0.25 }}>
                                  {filtered.length > shown.length
                                    ? `共 ${filtered.length} 个，此处只显示前 ${shown.length} 个（导出/复制拿到的是全部）`
                                    : `共 ${filtered.length} 个`}
                                </Typography>
                              </>
                            )
                          })()}
                        </>
                      )}
                    </Box>
                  )}
                </Box>

                {/* 模块-性状相关表 */}
                {traitRows.length > 0 && (
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                      模块-性状相关（按 |相关| 降序；FDR &lt; 0.05 加粗）
                    </Typography>
                    <TableContainer
                      sx={{ maxHeight: 340, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
                    >
                      <Table size="small" stickyHeader>
                        <TableHead>
                          <TableRow>
                            {['模块', '性状', 'cor', 'p 值', 'FDR'].map((h) => (
                              <TableCell key={h} sx={{ fontSize: 10.5, fontWeight: 600, py: 0.5 }}>
                                {h}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {traitRows.slice(0, 100).map((row) => {
                            const strong = row.fdr < 0.05
                            return (
                              <TableRow key={`${row.module}-${row.trait}`}>
                                <TableCell
                                  sx={{ fontSize: 11, py: 0.35, fontWeight: strong ? 700 : 400 }}
                                >
                                  <Stack direction="row" spacing={0.5} alignItems="center">
                                    <Box
                                      sx={{
                                        width: 8,
                                        height: 8,
                                        borderRadius: '50%',
                                        backgroundColor: moduleColor(row.module),
                                        border: '1px solid rgba(0,0,0,0.15)'
                                      }}
                                    />
                                    <span>{row.module}</span>
                                  </Stack>
                                </TableCell>
                                <TableCell sx={{ fontSize: 11, py: 0.35, fontWeight: strong ? 700 : 400 }}>
                                  {row.trait}
                                </TableCell>
                                <TableCell sx={{ fontSize: 11, py: 0.35, fontWeight: strong ? 700 : 400 }}>
                                  {fmt(row.cor)}
                                </TableCell>
                                <TableCell sx={{ fontSize: 11, py: 0.35, fontWeight: strong ? 700 : 400 }}>
                                  {fmtP(row.pvalue)}
                                </TableCell>
                                <TableCell sx={{ fontSize: 11, py: 0.35, fontWeight: strong ? 700 : 400 }}>
                                  {fmtP(row.fdr)}
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                    {traitRows.length > 100 && (
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mt: 0.5 }}>
                        共 {traitRows.length} 行，此处只显示相关最强的 100 行；完整结果请导出。
                      </Typography>
                    )}
                  </Box>
                )}
              </>
            )}
          </Stack>
        )}
      </Card>

      {/*
        单张图的导出格式菜单。挂在整个页面最外层而不是某张卡片里：
        第一段的 3 张图和第二段的 9 张图共用这一个菜单。
      */}
      <Menu
        anchorEl={plotMenu?.anchor ?? null}
        open={Boolean(plotMenu)}
        onClose={() => setPlotMenu(null)}
      >
        <MenuItem
          dense
          sx={{ fontSize: 11.5 }}
          onClick={() => {
            if (plotMenu) void exportOne(plotMenu.plot, 'png')
          }}
        >
          PNG 位图（贴 PPT / 快速预览）
        </MenuItem>
        <MenuItem
          dense
          disabled={plotMenu ? !plotMenu.plot.hasPdf : true}
          sx={{ fontSize: 11.5 }}
          onClick={() => {
            if (plotMenu) void exportOne(plotMenu.plot, 'pdf')
          }}
        >
          PDF 矢量图（投稿排版，可无损放大）
        </MenuItem>
        {plotMenu && !plotMenu.plot.hasPdf && (
          <Box sx={{ px: 2, pb: 1, maxWidth: 260 }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.4 }}>
              这次运行没有矢量 PDF（在支持 PDF 之前跑的）。点「② 构建网络」重跑一次即可补齐。
            </Typography>
          </Box>
        )}
      </Menu>

      {/*
        模块基因导出菜单。三类格式对应三种真实去处：
        txt 贴富集工具、csv 回 Excel 筛、xlsx 给不写代码的同事。
        「全部模块」放在下面 —— 下游要每个模块各跑一次富集时，一次导完比点十次省事。
      */}
      <Menu
        anchorEl={moduleGeneMenu}
        open={Boolean(moduleGeneMenu)}
        onClose={() => setModuleGeneMenu(null)}
      >
        <MenuItem
          dense
          sx={{ fontSize: 11.5 }}
          disabled={!activeModule}
          onClick={() => void exportModuleGenes(activeModule, 'txt')}
        >
          {activeModule ? `${activeModule} 模块 · 基因列表（txt）` : '先点一个模块'}
        </MenuItem>
        <MenuItem
          dense
          sx={{ fontSize: 11.5 }}
          disabled={!activeModule}
          onClick={() => void exportModuleGenes(activeModule, 'csv')}
        >
          {activeModule ? `${activeModule} 模块 · CSV` : '先点一个模块'}
        </MenuItem>
        <MenuItem dense sx={{ fontSize: 11.5 }} onClick={() => void exportModuleGenes(undefined, 'csv')}>
          全部模块 · CSV（module,gene 两列）
        </MenuItem>
        <MenuItem dense sx={{ fontSize: 11.5 }} onClick={() => void exportModuleGenes(undefined, 'xlsx')}>
          全部模块 · Excel
        </MenuItem>
      </Menu>
    </Box>
  )
}
