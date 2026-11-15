/**
 * 时序转录组分析页。
 *
 * ## 两条路的成熟度不同，界面必须说实话
 *
 * | 模式 | 状态 |
 * | --- | --- |
 * | 单序列（SAM 时序） | **可用**：选矩阵 → 确认样本映射 → 运行 → 结果表 + 自选基因曲线 |
 * | 两组 × 时间（ck vs dt） | 待接入：只给输入规格，不给可点的按钮 |
 *
 * 模块卡片（`modules.ts`）的 status 仍是 `planned` —— 一半能用不等于模块可用；
 * 页头徽标写「单序列可用 · 两组待接入」，比笼统的「可用」诚实。
 *
 * ## 面板顺序照着用户的操作顺序排
 *
 * 选文件 → 立刻出「样本名/组/时间点/重复」预览（解析错的行标红让他改）
 * → 设参数 → 运行 → 结果。
 * 把「样本预览」放在参数之前，是因为**时间点解析错，后面所有数字都是错的**；
 * 而这一步不用起 R，几十毫秒就能给出来。
 *
 * ## 阈值与重跑的区别（界面上必须写清）
 *
 * | 改什么 | 要重跑吗 |
 * | --- | --- |
 * | FDR、\|Score(d)\| | **不用**：R 返回全基因表（每个基因自己的 q 与 d），界面本地过滤 |
 * | log2、最少表达样本数、置换次数 | 要：它们改变了检验本身 |
 *
 * 不写清这一点，用户每改一次阈值就会白等两三分钟。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import DownloadIcon from '@mui/icons-material/Download'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import TimelineIcon from '@mui/icons-material/Timeline'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ErrorAlert, toUiError, type UiError } from '../components/common/ErrorAlert'
import { FigureImage, pickSavePath } from '../components/common/FigureImage'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { IPC } from '@shared/ipc'
import type {
  TsCurvesResult,
  TsInspectResult,
  TsMoaninCurvesResult,
  TsMoaninResult,
  TsParseRule,
  TsRunResult,
  TsSampleMeta
} from '@shared/types/timeseries'
import { call } from '../utils/ipc'

type Mode = 'single' | 'twoGroup'

const RULE_OPTIONS: { value: TsParseRule; label: string; hint: string }[] = [
  {
    value: 'group-time-rep',
    label: '组_时间重复',
    hint: '样本名形如 S_IR09_W_B1 → 组 W、时间 B、重复 1'
  },
  {
    value: 'time-rep',
    label: '时间重复',
    hint: '样本名形如 sample_A1 → 时间 A、重复 1（没有组）'
  },
  {
    value: 'genotype-treatment',
    label: '基因型_处理',
    hint: '样本名形如 S_IR09_D_A1 → 组 IR09_D、时间 A、重复 1（两种基因型 × 两种处理时用这条）'
  }
]

/**
 * 组名合法性：只允许 `[A-Za-z0-9_.]`，长度 1–40。
 *
 * moanin 用 `make.names()` 校验 Group levels，`IR09-D` 会直接报
 * "The levels must by syntactically valid names in R"；而 `-` 还是我们的对比分隔符。
 * 放在模块顶层而不是组件里：常量不需要进 useMemo 的依赖数组。
 */
const GROUP_NAME_RE = /^[A-Za-z0-9_.]{1,40}$/

/** 结果表最多渲染多少行（全量在 csv 里；界面滚动两万行会卡） */
const MAX_TABLE_ROWS = 300

export function TimeSeriesPage(): JSX.Element {
  const [mode, setMode] = useState<Mode>('single')
  const [error, setError] = useState<UiError | null>(null)

  /* ---------------- 文件与样本映射 ---------------- */
  const [path, setPath] = useState('')
  const [rule, setRule] = useState<TsParseRule>('group-time-rep')
  const [inspecting, setInspecting] = useState(false)
  const [inspect, setInspect] = useState<TsInspectResult | null>(null)
  /** 可编辑的样本映射（用户在预览表里改的 time / group） */
  const [samples, setSamples] = useState<TsSampleMeta[]>([])
  /**
   * 组名批量映射：解析出来的组名 → 客户要的写法（IR09-D → IR109DT）。
   *
   * 只改标签，不动矩阵；映射后的名字用于**对比名与结果标签**。
   * 按文件路径存 localStorage：客户下次打开同一文件不用重填。
   */
  const [groupMap, setGroupMap] = useState<Record<string, string>>({})
  const [mapOpen, setMapOpen] = useState(false)
  /** 解析出来的原始组名（映射面板左侧的清单，不随映射变化） */
  const baseGroups = useMemo(
    () => Array.from(new Set(inspect?.samples.map((x) => x.group) ?? [])).filter(Boolean).sort(),
    [inspect]
  )
  /** 映射冲突：两个组映射成同一个名字时必须报错，不能静默合并 */
  const mapConflict = useMemo(() => {
    const seen = new Map<string, string[]>()
    for (const g of baseGroups) {
      const target = (groupMap[g] ?? g).trim()
      if (!target) continue
      seen.set(target, [...(seen.get(target) ?? []), g])
    }
    return Array.from(seen.entries()).filter(([, list]) => list.length > 1)
  }, [baseGroups, groupMap])

  /**
   * 组名合法性：只允许 `[A-Za-z0-9_.]`，长度 1–40。
   *
   * 为什么必须挡在界面：moanin 用 `make.names()` 校验 Group levels，
   * `IR09-D` 这类含连字符的名字会直接报
   * "The levels must by syntactically valid names in R"；
   * 而且 `-` 还是我们对比例分符（`<组1>-<组2>`），`IR09-D-IR09-W` 会被拆成 4 段。
   * 让用户在点「开始分析」之前就看到红字，比跑完 20 秒再报错好得多。
   */
  const invalidGroups = useMemo(() => {
    const bad: { base: string; name: string }[] = []
    for (const g of baseGroups) {
      const name = (groupMap[g] ?? g).trim()
      if (!name) continue
      if (!GROUP_NAME_RE.test(name)) bad.push({ base: g, name })
    }
    return bad
  }, [baseGroups, groupMap])

  /* ---------------- 参数 ---------------- */
  const [useLog2, setUseLog2] = useState(true)
  const [minSamplesExpr, setMinSamplesExpr] = useState('3')
  const [nperm, setNperm] = useState('200')

  /* ---------------- 运行 ---------------- */
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [result, setResult] = useState<TsRunResult | null>(null)
  /** 事件过滤开关：runId 由主进程生成，调用返回前拿不到，只能靠这个标志 */
  const busyRef = useRef(false)

  /* ---------------- 阈值（只过滤，不重跑） ---------------- */
  const [fdr, setFdr] = useState('0.05')
  const [absD, setAbsD] = useState('2')

  /* ---------------- 曲线 ---------------- */
  const [geneText, setGeneText] = useState('')
  const [curvesBusy, setCurvesBusy] = useState(false)
  const [curves, setCurves] = useState<TsCurvesResult | null>(null)
  /** 用户填的基因数（>24 时用来提示「只画了前 24 个」） */
  const [curveTruncated, setCurveTruncated] = useState(0)

  useIpcEvent(IPC.event.analysisProgress, (payload) => {
    if (!busyRef.current) return
    setProgress({ pct: payload.pct, msg: payload.msg ?? '' })
  })
  useIpcEvent(IPC.event.analysisLog, (payload) => {
    if (!busyRef.current) return
    setLogs((prev) => [...prev, payload.line].slice(-3))
  })

  const inspectFile = useCallback(async (file: string, nextRule: TsParseRule) => {
    setInspecting(true)
    setError(null)
    try {
      const res = await call(window.deg.timeseries.inspectMatrix({ path: file, rule: nextRule }))
      setInspect(res)
      setSamples(res.samples)
      // 同一个文件 + 同一条规则，之前改过的组名映射直接恢复
      try {
        const saved = window.localStorage.getItem(`deg:ts:groupMap:${nextRule}:${file}`)
        setGroupMap(saved ? (JSON.parse(saved) as Record<string, string>) : {})
      } catch {
        setGroupMap({})
      }
      setResult(null)
      setCurves(null)
    } catch (err) {
      setError(toUiError(err))
      setInspect(null)
      setSamples([])
    } finally {
      setInspecting(false)
    }
  }, [])

  const pickFile = useCallback(async () => {
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '表达矩阵（tab 分隔）', extensions: ['txt', 'tsv', 'tab', 'csv'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const file = picked[0]
      if (!file) return
      setPath(file)
      await inspectFile(file, rule)
    } catch (err) {
      setError(toUiError(err))
    }
  }, [rule, inspectFile])

  const changeRule = useCallback(
    (next: TsParseRule) => {
      setRule(next)
      if (path) void inspectFile(path, next)
    },
    [path, inspectFile]
  )

  const patchSample = useCallback((name: string, field: 'group' | 'time', value: string) => {
    setSamples((prev) =>
      prev.map((s) =>
        s.name === name
          ? { ...s, [field]: value, ok: field === 'time' ? value.trim() !== '' : s.ok }
          : s
      )
    )
  }, [])

  const unresolved = samples.filter((s) => !s.time.trim())
  const canRun =
    Boolean(path) &&
    samples.length > 0 &&
    unresolved.length === 0 &&
    !running &&
    mapConflict.length === 0 &&
    invalidGroups.length === 0

  const patchGroupMap = useCallback(
    (base: string, next: string) => {
      setGroupMap((prev) => {
        const merged = { ...prev, [base]: next }
        try {
          if (path) {
            window.localStorage.setItem(
              `deg:ts:groupMap:${rule}:${path}`,
              JSON.stringify(merged)
            )
          }
        } catch {
          // localStorage 不可用（隐私模式）就算了，不阻断分析
        }
        return merged
      })
    },
    [path, rule]
  )

  const runAnalysis = useCallback(async () => {
    if (!path || samples.length === 0) return
    setRunning(true)
    busyRef.current = true
    setError(null)
    setLogs([])
    setProgress({ pct: 0, msg: '准备中' })
    try {
      const res = await call(
        window.deg.timeseries.run({
          path,
          samples: samples.map((s) => ({
            name: s.name,
            group: s.group,
            time: s.time,
            rep: s.rep
          })),
          log2: useLog2,
          minSamplesExpr: Number(minSamplesExpr) || 3,
          nperm: Number(nperm) || 200,
          fdr: Number(fdr) || 0.05,
          absD: Number(absD) || 2
        })
      )
      setResult(res)
      setCurves(null)
    } catch (err) {
      setError(toUiError(err))
    } finally {
      busyRef.current = false
      setRunning(false)
    }
  }, [path, samples, useLog2, minSamplesExpr, nperm, fdr, absD])

  /* ---------------- 阈值过滤（本地，不重跑） ---------------- */
  const fdrNum = Number(fdr) || 0.05
  const absDNum = Number(absD) || 2
  const filtered = useMemo(() => {
    if (!result) return []
    return result.rows.filter((r) => r.qValue / 100 <= fdrNum && Math.abs(r.scoreD) >= absDNum)
  }, [result, fdrNum, absDNum])
  const nUp = filtered.filter((r) => r.direction === 'up').length
  const nDown = filtered.length - nUp

  /**
   * q 值的**分辨率上限** = 100 / nperm。
   *
   * nperm=200 时是 0.5%：q=0 只代表「200 次置换里没有一次超过」，**不代表 0.01%**。
   * 之前把 q=0 显示成 `<0.01%` 是过度精确 —— 客户会以为 FDR 是万分之一，
   * 那与「没超过置换分辨率」是两种完全不同的确定性。
   */
  const npermUsed = result?.summary.nperm ?? (Number(nperm) || 200)
  const qResolution = 100 / Math.max(1, npermUsed)
  const fmtQ = (q: number): string =>
    q === 0 ? `<${qResolution < 1 ? qResolution.toFixed(1) : Math.round(qResolution)}%` : `${q.toPrecision(2)}%`

  /** 全部基因 / 显著基因的 Score(d) 范围分开说，否则「显著基因 d 只有 5.79」会被误读 */
  const dRangeText = useMemo(() => {
    if (!result) return '—'
    const fmt = (arr: number[]): string =>
      arr.length === 2 && Number.isFinite(arr[0]) ? `${arr[0].toFixed(2)} ~ ${arr[1].toFixed(2)}` : '—'
    const sigD = filtered.map((r) => r.scoreD)
    const sigRange = sigD.length > 0 ? [Math.min(...sigD), Math.max(...sigD)] : []
    return `全部 ${fmt(result.summary.dRange)} · 显著 ${sigRange.length ? fmt(sigRange) : '—'}`
  }, [result, filtered])

  /** 置换次数说明：越大 q 越精细；用上次实测耗时线性外推一个估计（不保证精确，只作取舍参考） */
  const npermHint = useMemo(() => {
    const base = result ? result.summary.durationMs / 1000 : 0
    if (base > 0) {
      const est = (base / Math.max(1, result?.summary.nperm ?? 200)) * 1000
      // helperText 只有一行宽，长句会被挤成两行贴到卡片边上；完整说明放在 q 值那行备注里
      return `1000 次约 ${est.toFixed(0)} s`
    }
    return '越大 q 越精细'
  }, [result])

  const download = useCallback(
    async (which: 'all' | 'sig', format: 'csv' | 'xlsx') => {
      if (!result) return
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName:
              which === 'sig'
                ? `timecourse_significant_q${Math.round(fdrNum * 1000) / 10}_d${absDNum}.${format}`
                : `timecourse_all_genes.${format}`,
            filters:
              format === 'csv'
                ? [{ name: 'CSV 表格', extensions: ['csv'] }]
                : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.timeseries.exportTable({ tsId: result.tsId, outPath, which, format }))
      } catch (err) {
        setError(toUiError(err))
      }
    },
    [result, fdrNum, absDNum]
  )

  const drawCurves = useCallback(async () => {
    if (!result) return
    const genes = Array.from(
      new Set(
        geneText
          .split(/[\s,;，；]+/)
          .map((g) => g.trim())
          .filter((g) => g.length > 0)
      )
    )
    if (genes.length === 0) {
      setError({
        message: '还没有填基因。',
        suggestion: '在输入框里粘贴基因名再点「画曲线」；换行 / 逗号 / 空格分隔都行，例如 LOC_Os03g54160 Os03g46040。',
        detail: ''
      })
      return
    }
    // 一张图最多 24 个基因（再多 facet 就看不清了）。超了**不报错**：
    // 客户脚本里那批是 42 个，直接拒绝等于让他自己数着切；这里取前 24 个并明确告知。
    const MAX_CURVE_GENES = 24
    const useGenes = genes.slice(0, MAX_CURVE_GENES)
    setCurveTruncated(genes.length > MAX_CURVE_GENES ? genes.length : 0)

    setCurvesBusy(true)
    busyRef.current = true
    setError(null)
    try {
      const res = await call(window.deg.timeseries.curves({ tsId: result.tsId, genes: useGenes }))
      setCurves(res)
    } catch (err) {
      setError(toUiError(err))
    } finally {
      busyRef.current = false
      setCurvesBusy(false)
    }
  }, [result, geneText])

  /**
   * 「选文件 + 样本预览」卡片：单序列与两组共用同一份。
   *
   * 之所以提出来：两种模式解析样本的规则一模一样，复制一份迟早会不一致
   * （改了一边忘了另一边），而「时间点解析错，后面所有数字都是错的」。
   */
  const pickerCard = (
    <>
      {/* ---------------- 1. 选文件 + 样本预览 ---------------- */}
        <Card variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12, mb: 0.75 }}>
            1. 选择表达矩阵
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ flexWrap: 'wrap', rowGap: 0.75 }}
          >
            <Button
              size="small"
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={() => void pickFile()}
            >
              选择文件
            </Button>
            <TextField
              select
              size="small"
              label="命名规则"
              value={rule}
              onChange={(e) => changeRule(e.target.value as TsParseRule)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ width: 190, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            >
              {RULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </TextField>
            {inspecting && <CircularProgress size={14} />}
            <Typography
              variant="body2"
              sx={{ fontSize: 10.5, fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}
            >
              {path || '尚未选择文件（tab 分隔的 .txt / .tsv；UTF-16 与 UTF-8 都能读）'}
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10, mt: 0.5 }}>
            当前规则：{RULE_OPTIONS.find((o) => o.value === rule)?.hint}
          </Typography>

          {inspect && (
            <>
              <Divider sx={{ my: 1.25 }} />
              <Stack direction="row" spacing={2} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
                {[
                  { label: '编码', value: inspect.encoding },
                  {
                    label: '基因数',
                    // 空行提示不能省：用户会拿这个数去和自己的表对账，
                    // 相差 1 就会怀疑「分析丢了一个基因」
                    value:
                      inspect.ignoredRows > 0
                        ? `${inspect.nGenes.toLocaleString()}（已忽略 ${inspect.ignoredRows} 行空行）`
                        : inspect.nGenes.toLocaleString()
                  },
                  { label: '样本数', value: String(inspect.nSamples) },
                  { label: '时间点', value: inspect.times.join(' / ') || '—' },
                  { label: '分组', value: inspect.groups.join(' / ') || '（无）' }
                ].map((item) => (
                  <Box key={item.label}>
                    <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                      {item.label}
                    </Typography>
                    <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{item.value}</Typography>
                  </Box>
                ))}
              </Stack>

              {unresolved.length > 0 && (
                <Alert severity="warning" sx={{ mb: 1, fontSize: 11 }}>
                  有 <b>{unresolved.length}</b> 个样本没解析出时间点（下表标红）。
                  请直接在下表里补，或换一个「命名规则」。
                </Alert>
              )}

              <TableContainer sx={{ maxHeight: 260 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontSize: 11 }}>样本名</TableCell>
                      <TableCell sx={{ fontSize: 11, width: 110 }}>组</TableCell>
                      <TableCell sx={{ fontSize: 11, width: 110 }}>时间点</TableCell>
                      <TableCell sx={{ fontSize: 11, width: 90 }}>重复</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {samples.map((s) => (
                      <TableRow key={s.name} hover>
                        <TableCell sx={{ fontSize: 11, fontFamily: 'monospace' }}>
                          {s.name}
                        </TableCell>
                        <TableCell>
                          <TextField
                            size="small"
                            value={s.group}
                            onChange={(e) => patchSample(s.name, 'group', e.target.value)}
                            inputProps={{ style: { fontSize: 11 } }}
                            sx={{ '& .MuiInputBase-root': { height: 26 } }}
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            size="small"
                            value={s.time}
                            onChange={(e) => patchSample(s.name, 'time', e.target.value)}
                            error={!s.time.trim()}
                            inputProps={{ style: { fontSize: 11 } }}
                            sx={{ '& .MuiInputBase-root': { height: 26 } }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>
                          {s.rep || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {/*
                组名批量映射：解析出来是 `IR09-D`，客户要 `IR109DT`。
                  只改**标签**，矩阵一个值都不动；映射后的名字用于对比名与结果标签。
                  冲突（两个组映射成同一个名字）必须挡住，静默合并会让两组的数据混在一起。
                */}
                {mode === 'twoGroup' && baseGroups.length > 0 && (
                  <Box
                    sx={{
                      mt: 1.25,
                      p: 1,
                      border: '1px dashed',
                      borderColor: mapConflict.length > 0 ? 'warning.main' : 'divider',
                      borderRadius: 1
                    }}
                  >
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => setMapOpen((v) => !v)}
                      sx={{ fontSize: 11, p: 0.25, minWidth: 0 }}
                    >
                      {mapOpen ? '▾' : '▸'} 组名映射（可选，{baseGroups.length} 个组）
                    </Button>
                    <Typography sx={{ fontSize: 10, color: 'text.disabled', mt: 0.25 }}>
                      只改标签、不动矩阵；改完对比名会立刻跟着变
                    </Typography>

                    {mapOpen && (
                      <Stack spacing={0.75} sx={{ mt: 0.75 }}>
                        {baseGroups.map((g) => (
                          <Stack key={g} direction="row" spacing={1} alignItems="center">
                            <Typography
                              sx={{ fontSize: 11, fontFamily: 'monospace', width: 90, flex: '0 0 auto' }}
                            >
                              {g}
                            </Typography>
                            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>→</Typography>
                            <TextField
                              size="small"
                              value={groupMap[g] ?? ''}
                              placeholder={g}
                              onChange={(e) => patchGroupMap(g, e.target.value)}
                              error={!GROUP_NAME_RE.test((groupMap[g] ?? g).trim())}
                              sx={{ width: 180, '& .MuiInputBase-root': { height: 26, fontSize: 11 } }}
                            />
                            {!GROUP_NAME_RE.test((groupMap[g] ?? g).trim()) && (
                              <Typography sx={{ fontSize: 10, color: 'error.main' }}>
                                不能含 “-” 或空格（R 的因子水平要求合法名字，且 “-” 是对比分隔符）
                              </Typography>
                            )}
                          </Stack>
                        ))}
                        {invalidGroups.length > 0 && (
                          <Alert severity="error" sx={{ fontSize: 11 }}>
                            组名不合法：
                            {invalidGroups.map((x) => `“${x.name}”`).join('、')}。
                            R 的因子水平要求合法名字（只允许字母、数字、下划线、点），
                            且 “-” 是对比分隔符 —— 请改成 <code>IR09_D</code> 或{' '}
                            <code>IR109DT</code> 这类写法。
                          </Alert>
                        )}
                        {mapConflict.length > 0 && (
                          <Alert severity="error" sx={{ fontSize: 11 }}>
                            组名冲突：
                            {mapConflict
                              .map(([target, list]) => `${list.join(' / ')} 都被映射成「${target}」`)
                              .join('；')}
                            。两个组合并成一个会让数据混在一起，请改成不同的名字。
                          </Alert>
                        )}
                      </Stack>
                    )}
                  </Box>
                )}
              </>
            )}
          </Card>
    </>
  )

  return (
    <Box sx={{ p: 2, height: '100%', overflowY: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="h3">时序转录组分析</Typography>
        <Chip
          size="small"
          label="单序列（SAM）· 两组（moanin）"
          variant="outlined"
          sx={{ fontSize: 10.5, height: 20 }}
        />
      </Stack>

      {/* ---------------- 选模式 ---------------- */}
      <Box
        sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.25, mb: 1.5 }}
      >
        <Card
          variant="outlined"
          onClick={() => setMode('single')}
          sx={{
            p: 1.5,
            cursor: 'pointer',
            borderColor: mode === 'single' ? 'primary.main' : 'divider',
            backgroundColor: mode === 'single' ? 'rgba(53,126,92,0.03)' : '#fff'
          }}
        >
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12.5 }}>
              时序差异分析（单序列）
            </Typography>
            <Chip size="small" label="可用" color="success" sx={{ fontSize: 9.5, height: 18 }} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
            SAM 时序检验（One class timecourse）：逐基因 q 值与 |Score(d)| 双阈值，
            直接对「表达随时间的走势」打分。
          </Typography>
        </Card>

        <Card
          variant="outlined"
          onClick={() => setMode('twoGroup')}
          sx={{
            p: 1.5,
            cursor: 'pointer',
            borderColor: mode === 'twoGroup' ? 'primary.main' : 'divider',
            backgroundColor: mode === 'twoGroup' ? 'rgba(53,126,92,0.02)' : '#fafafa'
          }}
        >
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12.5 }}>
              两组多时间点（ck vs dt）
            </Typography>
            <Chip size="small" label="可用" color="success" sx={{ fontSize: 9.5, height: 18 }} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
            moanin 样条模型：每组各拟合一条时间曲线，检验两组曲线是否不同
            （时间 × 处理 交互）。错峰时间点、每组重复数不等都能用。
          </Typography>
        </Card>
      </Box>

      {error && <ErrorAlert error={error} />}

      {mode === 'twoGroup' ? (
        <Stack spacing={1.5}>
          {pickerCard}
          <MoaninPanel
            path={path}
            samples={samples.map((x) => ({
              ...x,
              group: (groupMap[x.group] ?? x.group).trim() || x.group
            }))}
            blocked={mapConflict.length > 0 || invalidGroups.length > 0}
            progress={progress}
            logs={logs}
            beginRun={() => {
              busyRef.current = true
            }}
            endRun={() => {
              busyRef.current = false
            }}
            onError={setError}
          />
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          {pickerCard}


          {/* ---------------- 2. 参数 ---------------- */}
          <Card variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12, mb: 0.75 }}>
              2. 参数
            </Typography>
            <Stack
              direction="row"
              spacing={2}
              alignItems="flex-start"
              sx={{ flexWrap: 'wrap', rowGap: 1 }}
            >
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={useLog2}
                    onChange={(e) => setUseLog2(e.target.checked)}
                  />
                }
                label={<Typography sx={{ fontSize: 11 }}>log2(x + 0.01)</Typography>}
                sx={{ mr: 0 }}
              />
              <TextField
                size="small"
                label="最少表达样本数"
                value={minSamplesExpr}
                onChange={(e) => setMinSamplesExpr(e.target.value)}
                helperText="表达 > 1 的样本数下限"
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                sx={{ width: 150, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
              />
              <TextField
                size="small"
                label="置换次数"
                value={nperm}
                onChange={(e) => setNperm(e.target.value)}
                helperText={npermHint}
                title="置换次数决定 q 值的分辨率（上限 = 100/nperm）。越大越精细，但耗时成比例增加。"
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                sx={{ width: 150, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
              />
              <Button
                size="small"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={!canRun}
                onClick={() => void runAnalysis()}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {running ? '正在分析…' : '开始分析'}
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.75 }}>
              这三项改变的是<b>检验本身</b>，改动后需要重新运行（实测约 2 秒，SAM 要做 200
              次置换）。结果出来之后调 FDR 与 |Score(d)| <b>不需要重跑</b>。
            </Typography>

            {running && (
              <Box sx={{ mt: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={progress?.pct ?? 0}
                  sx={{ height: 6, borderRadius: 1 }}
                />
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
                  {progress?.msg || '处理中'}（{Math.round(progress?.pct ?? 0)}%）
                </Typography>
                {logs.length > 0 && (
                  <Box
                    component="pre"
                    sx={{
                      mt: 0.75,
                      mb: 0,
                      p: 0.75,
                      maxHeight: 70,
                      overflow: 'hidden',
                      bgcolor: 'grey.50',
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      fontSize: 10,
                      lineHeight: 1.5,
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {logs.join('\n')}
                  </Box>
                )}
              </Box>
            )}
          </Card>

          {/* ---------------- 3. 结果 ---------------- */}
          {result && (
            <Card variant="outlined" sx={{ p: 1.5 }}>
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={{ mb: 1 }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
                  3. 结果
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<DownloadIcon />}
                    onClick={() => void download('sig', 'csv')}
                  >
                    显著基因 (csv)
                  </Button>
                  <Button size="small" variant="outlined" onClick={() => void download('sig', 'xlsx')}>
                    Excel
                  </Button>
                  <Button size="small" variant="text" onClick={() => void download('all', 'csv')}>
                    全部基因 (csv)
                  </Button>
                </Stack>
              </Stack>

              <Stack direction="row" spacing={2.5} sx={{ mb: 1.25, flexWrap: 'wrap', rowGap: 0.75 }}>
                {[
                  { label: '参与检验', value: result.summary.nGenes.toLocaleString() },
                  { label: '耗时', value: `${(result.summary.durationMs / 1000).toFixed(1)} s` },
                  { label: '时间点', value: result.summary.times.join('/') },
                  {
                    label: '样本 / 重复序列',
                    value: `${result.summary.nSamples} / ${result.summary.nSeries}`
                  },
                  { label: 'Score(d) 范围（全部 / 显著）', value: dRangeText }
                ].map((item) => (
                  <Box key={item.label}>
                    <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                      {item.label}
                    </Typography>
                    <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{item.value}</Typography>
                  </Box>
                ))}
              </Stack>

              <Alert severity="info" sx={{ mb: 1.25, fontSize: 11 }}>
                改下面两个阈值<b>只过滤表格</b>，不会重跑 SAM（结果里每个基因都带自己的 q 与
                Score(d)）。
              </Alert>

              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                <TextField
                  size="small"
                  label="q-value ≤"
                  value={fdr}
                  onChange={(e) => setFdr(e.target.value)}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  sx={{ width: 120, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                />
                <TextField
                  size="small"
                  label="|Score(d)| ≥"
                  value={absD}
                  onChange={(e) => setAbsD(e.target.value)}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  sx={{ width: 130, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                />
                <Typography sx={{ fontSize: 12 }}>
                  当前阈值下 <b>{filtered.length.toLocaleString()}</b> 个基因
                  <Box component="span" sx={{ color: 'text.secondary', ml: 0.75 }}>
                    （上调 {nUp} / 下调 {nDown}）
                  </Box>
                </Typography>
              </Stack>

              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mb: 0.75 }}>
                置换次数 {npermUsed}，q 值的分辨率上限为 {qResolution < 1 ? qResolution.toFixed(1) : Math.round(qResolution)}%
                （即「在 {npermUsed} 次置换里没有一次超过」）。需要更精细的 q 值，
                把上面的「置换次数」调到 1000 —— 代价是运行时间成比例增加。
                原始数值见表格的 <code>q_raw</code> 列与导出的 csv。
              </Typography>

              <TableContainer sx={{ maxHeight: 340 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {[
                        'gene',
                        '方向',
                        'Score(d)',
                        'q-value (%)',
                        'q_raw',
                        'Numerator(r)',
                        'Denominator(s+s0)'
                      ].map((h) => (
                        <TableCell
                          key={h}
                          sx={{ fontSize: 11 }}
                          align={h === 'gene' || h === '方向' ? 'left' : 'right'}
                        >
                          {h}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filtered.slice(0, MAX_TABLE_ROWS).map((r) => (
                      <TableRow key={`${r.gene}-${r.direction}`} hover>
                        <TableCell sx={{ fontSize: 11, fontFamily: 'monospace' }}>{r.gene}</TableCell>
                        <TableCell sx={{ fontSize: 11 }}>
                          <Chip
                            size="small"
                            label={r.direction === 'up' ? '上调' : '下调'}
                            color={r.direction === 'up' ? 'error' : 'info'}
                            variant="outlined"
                            sx={{ height: 17, fontSize: 9.5 }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {r.scoreD.toFixed(3)}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {/*
                            q 是百分数（SAM 的口径）。置换次数有限时 q 会正好是 0，
                            直接显示「0.00」看起来像没算出来，写成 <0.01% 更诚实。
                          */}
                          {fmtQ(r.qValue)}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          <Box component="span" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                            {r.qValue}
                          </Box>
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {r.numerator.toFixed(3)}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {r.denominator.toFixed(3)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filtered.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} sx={{ fontSize: 11, color: 'text.secondary' }}>
                          当前阈值下没有基因。放宽 q 或 |Score(d)| 试试。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              {filtered.length > MAX_TABLE_ROWS && (
                <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10, mt: 0.5 }}>
                  只显示前 {MAX_TABLE_ROWS} 行（共 {filtered.length.toLocaleString()} 行）；
                  完整表格请用上面的「显著基因 (csv)」导出。
                </Typography>
              )}

              {/* ---------------- 4. 曲线 ---------------- */}
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12, mb: 0.5 }}>
                4. 自选基因曲线
              </Typography>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <TextField
                  size="small"
                  multiline
                  minRows={2}
                  maxRows={6}
                  fullWidth
                  placeholder={
                    '粘贴基因名，换行 / 逗号 / 空格分隔都行，例如：LOC_Os03g54160 Os03g46040\n' +
                    '（写成 Os03g54160 也可以，会自动补 LOC_ 前缀去匹配）'
                  }
                  value={geneText}
                  onChange={(e) => setGeneText(e.target.value)}
                  disabled={curvesBusy}
                  inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
                />
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<TimelineIcon />}
                  disabled={curvesBusy || geneText.trim().length === 0}
                  onClick={() => void drawCurves()}
                  sx={{ whiteSpace: 'nowrap', flex: '0 0 auto' }}
                >
                  {curvesBusy ? '正在出图…' : '画曲线'}
                </Button>
              </Stack>

              {curves && (
                <Box sx={{ mt: 1.25 }}>
                  {curveTruncated > 0 && (
                    <Alert severity="info" sx={{ mb: 1, fontSize: 11 }}>
                      一次最多画 24 个基因，已取<b>前 24 个</b>（你填了 {curveTruncated} 个）。
                      其余请分批画 —— 再多 facet 在图上也看不清。
                    </Alert>
                  )}
                  {curves.missingGenes.length > 0 && (
                    <Alert severity="warning" sx={{ mb: 1, fontSize: 11 }}>
                      <b>名字找不到</b>：{curves.missingGenes.join('、')}
                      —— 数据里没有这些名字。常见原因：拼写不一致，或 ID 体系不同
                      （矩阵里是 <code>LOC_Os03g54160</code> 这类，你写了别的形式）。
                    </Alert>
                  )}
                  {curves.notSignificant.length > 0 && (
                    <Alert severity="info" sx={{ mb: 1, fontSize: 11 }}>
                      <b>存在但未过当前阈值</b>：{curves.notSignificant.join('、')}
                      —— 曲线已画出，但它没有通过 q ≤ {Math.round(fdrNum * 100)}% / |Score(d)| ≥{' '}
                      {absDNum}。想让它们进显著表，把上面的阈值放宽。
                    </Alert>
                  )}
                  {curves.plots.map((p) =>
                    p.dataUrl ? (
                      <Box key={p.id}>
                        <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                          {p.caption}
                        </Typography>
                        <FigureImage
                          src={p.dataUrl}
                          alt={p.caption}
                          file={p.file}
                          onExport={async (format) => {
                            const outPath = await pickSavePath(
                              `${result.tsId}-curves.${format}`,
                              format
                            )
                            if (!outPath) return
                            await call(
                              window.deg.timeseries.exportPlot({
                                tsId: result.tsId,
                                file: p.file,
                                format,
                                outPath
                              })
                            )
                          }}
                        />
                      </Box>
                    ) : (
                      <Typography key={p.id} sx={{ fontSize: 11, color: 'text.disabled' }}>
                        图未生成
                      </Typography>
                    )
                  )}
                </Box>
              )}
            </Card>
          )}
        </Stack>
      )}
    </Box>
  )
}

/**
 * 两组 × 时间（moanin）：参数 + 结果。
 *
 * ## 为什么单独一个组件
 *
 * 参数有 6 个、结果有 4 个分区（差异表 / 火山图 / 样条图 / 聚类）。
 * 全部塞进页面组件会让那个 700 行的 return 变成 1100 行，
 * 而且这些状态只属于这个模式 —— 放在这里，切回单序列时不互相干扰。
 *
 * ## df 的界面约束
 *
 * `df` 上限 = 时间点数 − 2。df = nTime−1 时样条基饱和、所有 q 变成 NA，
 * moanin 不报错，界面会显示「0 个显著基因」——用户会以为两组没差异。
 * 所以这里**直接禁用运行**并把原因写在输入框下面（R 侧再挡一次）。
 */
interface MoaninPanelProps {
  path: string
  /** 已应用组名映射的样本（组名即最终对比名里用的名字） */
  samples: TsSampleMeta[]
  /** 组名映射有冲突时禁止运行（否则两组数据会被当成一组） */
  blocked: boolean
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
}

function MoaninPanel({
  path,
  samples,
  blocked,
  progress,
  logs,
  beginRun,
  endRun,
  onError
}: MoaninPanelProps): JSX.Element {
  const groups = useMemo(
    () => Array.from(new Set(samples.map((s) => s.group).filter((g) => g.trim().length > 0))).sort(),
    [samples]
  )
  const times = useMemo(
    () => Array.from(new Set(samples.map((s) => s.time).filter((t) => t.trim().length > 0))),
    [samples]
  )
  /**
   * 所有组的两两组合（**无序对**）。方向单独存，见 `flipped`。
   *
   * 为什么不是直接生成 12 个有序对比（4 组时有 12 个）：列表太长，用户要在里面
   * 挑 4 个容易眼花。这里保持 6 个配对 + 每对一个 ⇄ 翻转按钮，
   * 客户脚本里「ZS97DT-IR109DT」这种反方向也能精确表达。
   */
  const pairs = useMemo(() => {
    const out: { key: string; a: string; b: string }[] = []
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        out.push({ key: `${groups[i]}|${groups[j]}`, a: groups[i], b: groups[j] })
      }
    }
    return out
  }, [groups])

  const maxDf = Math.max(2, times.length - 2)

  /**
   * 组间时间点不平衡检测。
   *
   * 判据：某组的 min(Timepoint) > 全局 min(Timepoint)。
   * 命中的组在首个时间点上是**模型外推**（不是观测），曲线起点要打折扣看。
   * 全部组都从同一时间点开始时一个字都不显示 —— 否则这条提示会变成噪声。
   */
  const timeOrder = useMemo(() => {
    const uniq = Array.from(new Set(times))
    const nums = uniq.map((t) => {
      const d = t.replace(/[^0-9.]/g, '')
      return d === '' ? Number.NaN : Number(d)
    })
    if (uniq.length > 0 && nums.every((n) => Number.isFinite(n))) {
      return uniq.slice().sort((a, b) => nums[uniq.indexOf(a)] - nums[uniq.indexOf(b)])
    }
    return uniq.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  }, [times])

  const unbalanced = useMemo(() => {
    if (timeOrder.length === 0 || groups.length === 0) return []
    const idxOf = (t: string): number => timeOrder.indexOf(t)
    const minOf = new Map<string, number>()
    for (const sm of samples) {
      if (!groups.includes(sm.group)) continue
      const i = idxOf(sm.time)
      if (i < 0) continue
      const cur = minOf.get(sm.group)
      if (cur === undefined || i < cur) minOf.set(sm.group, i)
    }
    if (minOf.size === 0) return []
    const globalMin = Math.min(...Array.from(minOf.values()))
    return Array.from(minOf.entries())
      .filter(([, i]) => i > globalMin)
      .map(([g, i]) => ({ group: g, first: timeOrder[i] }))
  }, [samples, groups, timeOrder])

  const [df, setDf] = useState('4')
  const [varianceCutoff, setVarianceCutoff] = useState('0.5')
  const [nClusters, setNClusters] = useState('8')
  const [fdr, setFdr] = useState('0.05')
  const [lfcCutoff, setLfcCutoff] = useState('2')
  /** 选中的配对 key（空数组 = 全选，跟组变化自动跟着走） */
  const [selectedPairs, setSelectedPairs] = useState<string[]>([])
  /** 配对 key → 是否翻转方向（true = b-a） */
  const [flipped, setFlipped] = useState<Record<string, boolean>>({})

  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TsMoaninResult | null>(null)
  const [tab, setTab] = useState(0)

  /* ---- 自选基因曲线（复用主分析存下的 model，不重跑拟合） ---- */
  const [curveText, setCurveText] = useState('')
  const [curveBusy, setCurveBusy] = useState(false)
  const [curves, setCurves] = useState<TsMoaninCurvesResult | null>(null)

  // 差异表过滤（**本地**：阈值已在 R 里用于筛基因与聚类，改这里只影响表格显示）
  const [fContrast, setFContrast] = useState('')
  const [fOnlySelected, setFOnlySelected] = useState(true)
  const [fQ, setFQ] = useState('0.05')
  const [fLfc, setFLfc] = useState('2')

  const contrastOf = useCallback(
    (p: { key: string; a: string; b: string }): string =>
      flipped[p.key] ? `${p.b}-${p.a}` : `${p.a}-${p.b}`,
    [flipped]
  )
  // 组变了（用户改「组」列）时，旧 key 会失效 → 自动回到「全选、不翻转」
  const validSelected = selectedPairs.filter((k) => pairs.some((p) => p.key === k))
  const selectedKeys = validSelected.length > 0 ? validSelected : pairs.map((p) => p.key)
  const pickedContrasts = pairs.filter((p) => selectedKeys.includes(p.key)).map(contrastOf)

  const dfNum = Number(df)
  const dfInvalid = !Number.isFinite(dfNum) || dfNum < 2 || dfNum > maxDf
  const unresolved = samples.filter((s) => !s.time.trim())
  const canRun =
    Boolean(path) &&
    !blocked &&
    samples.length >= 6 &&
    unresolved.length === 0 &&
    groups.length >= 2 &&
    times.length >= 4 &&
    !dfInvalid &&
    !running

  const run = useCallback(async () => {
    if (!path) return
    setRunning(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.timeseries.runMoanin({
          path,
          samples: samples.map((s) => ({
            name: s.name,
            group: s.group,
            time: s.time,
            rep: s.rep
          })),
          degreesOfFreedom: dfNum,
          varianceCutoff: Number(varianceCutoff) || 0.5,
          contrasts: pickedContrasts,
          nClusters: Number(nClusters) || 8,
          fdr: Number(fdr) || 0.05,
          lfcCutoff: Number(lfcCutoff) || 2
        })
      )
      setResult(res)
      setFContrast(res.summary.contrasts[0] ?? '')
      setTab(0)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setRunning(false)
    }
  }, [path, samples, dfNum, varianceCutoff, pickedContrasts, nClusters, fdr, lfcCutoff, beginRun, endRun, onError])

  /**
   * 画自选基因曲线。
   *
   * 走的是主分析存下来的 `moanin_bundle.rds`：不重跑 20 秒的拟合，
   * 只是把 moanin 的样条图重画这几个基因（实测 1 秒）。
   */
  const drawCurves = useCallback(async () => {
    if (!result) return
    const genes = Array.from(
      new Set(
        curveText
          .split(/[\s,;，；]+/)
          .map((g) => g.trim())
          .filter((g) => g.length > 0)
      )
    )
    if (genes.length === 0) {
      onError({
        message: '还没有填基因。',
        suggestion: '在输入框里粘贴基因名；换行 / 逗号 / 空格分隔都行。',
        detail: ''
      })
      return
    }
    setCurveBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(window.deg.timeseries.moaninCurves({ tsId: result.tsId, genes }))
      setCurves(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setCurveBusy(false)
    }
  }, [result, curveText, beginRun, endRun, onError])

  const download = useCallback(
    async (which: 'moanin_all' | 'moanin_sig', format: 'csv' | 'xlsx') => {
      if (!result) return
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `${which === 'moanin_sig' ? 'moanin_selected' : 'moanin_all_genes'}.${format}`,
            filters:
              format === 'csv'
                ? [{ name: 'CSV 表格', extensions: ['csv'] }]
                : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.timeseries.exportTable({ tsId: result.tsId, outPath, which, format }))
      } catch (err) {
        onError(toUiError(err))
      }
    },
    [result, onError]
  )

  const fQNum = Number(fQ) || 0.05
  const fLfcNum = Number(fLfc) || 2
  const rows = useMemo(() => {
    if (!result) return []
    return result.rows.filter((r) => {
      if (fContrast && r.contrast !== fContrast) return false
      if (fOnlySelected && !r.selected) return false
      if (Number.isFinite(r.fisherQ) && r.fisherQ > fQNum) return false
      if (r.lfcMax < fLfcNum) return false
      return true
    })
  }, [result, fContrast, fOnlySelected, fQNum, fLfcNum])

  const clusterRows = useMemo(() => {
    if (!result) return []
    const byCluster = new Map<number, string[]>()
    for (const r of result.rows) {
      if (r.cluster == null) continue
      const list = byCluster.get(r.cluster) ?? []
      list.push(r.gene)
      byCluster.set(r.cluster, list)
    }
    return Array.from(byCluster.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([cluster, genes]) => ({ cluster, genes }))
  }, [result])

  return (
    <>
      {/* ---------------- 参数 ---------------- */}
      <Card variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12, mb: 0.75 }}>
          2. 参数（moanin 样条模型）
        </Typography>

        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <TextField
            size="small"
            label="degrees_of_freedom"
            value={df}
            onChange={(e) => setDf(e.target.value)}
            error={dfInvalid}
            helperText={`范围 2 ~ ${maxDf}（时间点 ${times.length} 个）`}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ width: 180, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="MAD 分位阈值"
            value={varianceCutoff}
            onChange={(e) => setVarianceCutoff(e.target.value)}
            helperText="0.5 = 保留方差前 50%"
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ width: 150, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="聚类数"
            value={nClusters}
            onChange={(e) => setNClusters(e.target.value)}
            helperText="2 ~ 12，seed 固定 42"
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ width: 140, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="Fisher q <"
            value={fdr}
            onChange={(e) => setFdr(e.target.value)}
            helperText="筛基因用"
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ width: 120, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="|lfc_max| >"
            value={lfcCutoff}
            onChange={(e) => setLfcCutoff(e.target.value)}
            helperText="筛基因用"
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ width: 120, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={!canRun}
            onClick={() => void run()}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {running ? '正在分析…' : '开始分析'}
          </Button>
        </Stack>

        {/* 对比勾选 */}
        <Box sx={{ mt: 1.25 }}>
          <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
            对比（默认全选；⇄ 可翻转方向，如 A-B ⇄ B-A）
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            {pairs.length === 0 && (
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                需要先在预览表里填出至少 2 个组
              </Typography>
            )}
            {pairs.map((p) => {
              const checked = selectedKeys.includes(p.key)
              return (
                <Stack key={p.key} direction="row" alignItems="center" spacing={0.25}>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={checked}
                        onChange={(e) =>
                          setSelectedPairs(
                            e.target.checked
                              ? Array.from(new Set([...selectedKeys, p.key]))
                              : selectedKeys.filter((k) => k !== p.key)
                          )
                        }
                      />
                    }
                    label={
                      <Typography sx={{ fontSize: 11, fontFamily: 'monospace' }}>
                        {contrastOf(p)}
                      </Typography>
                    }
                    sx={{ mr: 0 }}
                  />
                  {/*
                    ⇄ = 翻转方向。客户脚本里有两个是「后减前」（ZS97DT-IR109DT），
                    只按 levels 顺序生成一个方向就表达不了。统计上两者只是 lfc 取负，
                    但标签与符号要对得上，否则用户做表时对不上论文。
                  */}
                  <Tooltip title="翻转方向（A−B ⇄ B−A）">
                    <IconButton
                      size="small"
                      onClick={() =>
                        setFlipped((prev) => ({ ...prev, [p.key]: !prev[p.key] }))
                      }
                      sx={{ p: 0.25 }}
                    >
                      <SwapHorizIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              )
            })}
          </Stack>
        </Box>

        {dfInvalid && (
          <Alert severity="warning" sx={{ mt: 1, fontSize: 11 }}>
            <b>degrees_of_freedom 超出范围</b>：当前 {times.length} 个时间点，只能取 2 ~ {maxDf}。
            df ≥ {times.length - 1} 时样条基饱和、残差自由度被吃光，<b>所有 q 值会变成 NA</b> ——
            moanin 不会报错，界面会显示「0 个显著基因」，看起来像两组没差异。
          </Alert>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.75 }}>
          这些参数都参与<b>建模或筛基因</b>，改动后需要重新运行。实测：2 组 39 样本约 7 秒、
          4 组 78 样本约 20~30 秒（每个对比都要单独出图）。结果出来后在「差异表」里改筛选条件<b>不会重跑</b>。
        </Typography>

        {running && (
          <Box sx={{ mt: 1 }}>
            <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
              {progress?.msg || '处理中'}（{Math.round(progress?.pct ?? 0)}%）
            </Typography>
            {logs.length > 0 && (
              <Box
                component="pre"
                sx={{
                  mt: 0.5, mb: 0, p: 0.75, maxHeight: 60, overflow: 'hidden',
                  bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider',
                  borderRadius: 1, fontSize: 10, lineHeight: 1.5, fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {logs.join('\n')}
              </Box>
            )}
          </Box>
        )}
      </Card>

      {/* ---------------- 结果 ---------------- */}
      {result && (
        <Card variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
              3. 结果
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={() => void download('moanin_sig', 'csv')}>
                选中基因 (csv)
              </Button>
              <Button size="small" variant="outlined" onClick={() => void download('moanin_sig', 'xlsx')}>
                Excel
              </Button>
              <Button size="small" variant="text" onClick={() => void download('moanin_all', 'csv')}>
                全部 (csv)
              </Button>
              {/*
                一次拿到该次运行的全部 PDF：客户投稿要的是「每个对比的火山/样条 + 聚类」一整批，
                一张一张点不现实。
              */}
              <Button
                size="small"
                variant="outlined"
                onClick={async () => {
                  const outDir = await call(window.deg.system.pickDir())
                  if (!outDir) return
                  try {
                    const res = await call(
                      window.deg.timeseries.exportAllPlots({
                        tsId: result.tsId,
                        outDir,
                        files: result.plots.map((x) => x.file).filter(Boolean)
                      })
                    )
                    if (res.skipped.length > 0) {
                      onError({
                        message: `已导出 ${res.count} 张，另有 ${res.skipped.length} 张没有 PDF`,
                        suggestion: '这些图是旧版本生成的（当时只写 PNG）。重跑该分析即可产出矢量 PDF。',
                        detail: res.skipped.join(', ')
                      })
                    }
                  } catch (err) {
                    onError(toUiError(err))
                  }
                }}
                sx={{ whiteSpace: 'nowrap' }}
              >
                导出全部图
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={2.2} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
            {[
              {
                label: '基因数（原始 → rowMeans>0 → MAD）',
                value: `${result.summary.nGenesRaw.toLocaleString()} → ${result.summary.nGenesNonZero.toLocaleString()} → ${result.summary.nGenesFiltered.toLocaleString()}`
              },
              { label: 'df / 上限', value: `${result.summary.degreesOfFreedom} / ${result.summary.maxDegreesOfFreedom}` },
              { label: '时间点 / 样本', value: `${result.summary.nTime} / ${result.summary.nSamples}` },
              {
                label: 'q<0.05 / q<0.01',
                value: result.summary.qCounts
                  .map((q) => `${q.contrast}: ${q.q05.toLocaleString()} / ${q.q01.toLocaleString()}`)
                  .join('；')
              },
              { label: '筛出基因 / 聚类', value: `${result.summary.nSelected.toLocaleString()} / ${result.summary.nClusters} 簇` },
              { label: '耗时', value: `${(result.summary.durationMs / 1000).toFixed(1)} s` }
            ].map((item) => (
              <Box key={item.label}>
                <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{item.label}</Typography>
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{item.value}</Typography>
              </Box>
            ))}
          </Stack>

          {/*
            对比选择器放在页签**之上**：差异表、火山图、样条图都跟着它走。
            4 组时客户要的是 4 个对比各自的图，堆在一起没法看。
          */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
            <TextField
              select
              size="small"
              label="当前对比"
              value={fContrast}
              onChange={(e) => setFContrast(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ width: 220, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            >
              {result.summary.contrasts.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </TextField>
            <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
              Fisher 合并 + 聚类使用<b>已勾选的 {result.summary.contrasts.length} 个对比</b>：
              <Box component="span" sx={{ fontFamily: 'monospace' }}>
                {result.summary.contrasts.join('、')}
              </Box>
            </Typography>
          </Stack>

          {unbalanced.length > 0 && (
            <Typography
              sx={{ fontSize: 10.5, color: 'text.secondary', mb: 1, lineHeight: 1.6 }}
            >
              ⓘ{' '}
              <Box component="span" sx={{ fontWeight: 600 }}>
                {unbalanced.map((u) => u.group).join('、')}
              </Box>{' '}
              缺少时间点 {timeOrder[0]}（这些组最早的时间点是{' '}
              {unbalanced.map((u) => u.first).join('、')}），它们在 {timeOrder[0]} 处的曲线值为
              <b>模型外推</b>，不是观测值。
            </Typography>
          )}

          <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ minHeight: 32, mb: 1 }}>
            <Tab label="差异表" sx={{ minHeight: 32, fontSize: 11.5 }} />
            <Tab label="火山图" sx={{ minHeight: 32, fontSize: 11.5 }} />
            <Tab label="样条曲线" sx={{ minHeight: 32, fontSize: 11.5 }} />
            <Tab label="聚类" sx={{ minHeight: 32, fontSize: 11.5 }} />
            <Tab label="自选基因曲线" sx={{ minHeight: 32, fontSize: 11.5 }} />
          </Tabs>

          {tab === 0 && (
            <>
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}>
                <TextField
                  size="small"
                  label="Fisher q ≤"
                  value={fQ}
                  onChange={(e) => setFQ(e.target.value)}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  sx={{ width: 120, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                />
                <TextField
                  size="small"
                  label="|lfc_max| ≥"
                  value={fLfc}
                  onChange={(e) => setFLfc(e.target.value)}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  sx={{ width: 120, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={fOnlySelected}
                      onChange={(e) => setFOnlySelected(e.target.checked)}
                    />
                  }
                  label={<Typography sx={{ fontSize: 11 }}>只看通过阈值的</Typography>}
                  sx={{ mr: 0 }}
                />
                <Typography sx={{ fontSize: 12 }}>
                  显示 <b>{rows.length.toLocaleString()}</b> 行
                </Typography>
              </Stack>

              <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10, mb: 0.5 }}>
                lfc 的五种口径：<code>lfc(timecourse)</code> 带方向（火山图用）；
                <code>sum</code> 会正负抵消；<code>max</code>/<code>min</code> <b>非负、无方向</b>，
                不能当有符号 logFC 用。
              </Typography>

              <TableContainer sx={{ maxHeight: 360 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['gene', 'stat', 'p', 'q', 'lfc(timecourse)', 'sum', 'max', 'min', 'cluster'].map((h) => (
                        <TableCell key={h} sx={{ fontSize: 10.5 }} align={h === 'gene' ? 'left' : 'right'}>
                          {h}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.slice(0, MAX_TABLE_ROWS).map((r) => (
                      <TableRow key={`${r.gene}-${r.contrast}`} hover>
                        <TableCell sx={{ fontSize: 11, fontFamily: 'monospace' }}>{r.gene}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.stat.toFixed(2)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.pval.toExponential(1)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {Number.isFinite(r.qval) ? r.qval.toPrecision(2) : 'NA'}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.lfcTimecourse.toFixed(2)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.lfcSum.toFixed(2)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.lfcMax.toFixed(2)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">{r.lfcMin.toFixed(2)}</TableCell>
                        <TableCell sx={{ fontSize: 11 }} align="right">
                          {r.cluster == null ? '—' : r.cluster}
                        </TableCell>
                      </TableRow>
                    ))}
                    {rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} sx={{ fontSize: 11, color: 'text.secondary' }}>
                          当前筛选下没有基因。放宽 q 或 |lfc_max| 试试。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              {rows.length > MAX_TABLE_ROWS && (
                <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10, mt: 0.5 }}>
                  只显示前 {MAX_TABLE_ROWS} 行（共 {rows.length.toLocaleString()} 行）；完整表请导出 csv。
                </Typography>
              )}
            </>
          )}

          {(tab === 1 || tab === 2 || tab === 3 || tab === 4) && (
            <Stack spacing={1.25}>
              {result.plots
                .filter((pl) =>
                  tab === 3
                    ? pl.id.startsWith('cluster')
                    : pl.contrast === fContrast &&
                      (tab === 1 ? pl.id === 'volcano' : pl.id.startsWith('splines'))
                )
                .map((pl) => (
                  <Box key={pl.id}>
                    <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                      {pl.caption}
                    </Typography>
                    {pl.dataUrl ? (
                      <FigureImage
                        src={pl.dataUrl}
                        alt={pl.caption}
                        file={pl.file}
                        onExport={async (format) => {
                          const outPath = await pickSavePath(
                            `${result.tsId}-${pl.file.replace(/\.png$/, '')}.${format}`,
                            format
                          )
                          if (!outPath) return
                          await call(
                            window.deg.timeseries.exportPlot({
                              tsId: result.tsId,
                              file: pl.file,
                              format,
                              outPath
                            })
                          )
                        }}
                      />
                    ) : (
                      <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>图未生成</Typography>
                    )}
                  </Box>
                ))}
              {tab === 4 && (
                <>
                  <Stack direction="row" spacing={1.5} alignItems="flex-start">
                    <TextField
                      size="small"
                      multiline
                      minRows={2}
                      maxRows={6}
                      fullWidth
                      placeholder={
                        '粘贴基因名，换行 / 逗号 / 空格分隔都行，例如：LOC_Os03g54160 Os03g46040\n' +
                        '（写成 Os03g54160 也可以，会自动补 LOC_ 前缀去匹配）'
                      }
                      value={curveText}
                      onChange={(e) => setCurveText(e.target.value)}
                      disabled={curveBusy}
                      inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<TimelineIcon />}
                      disabled={curveBusy || curveText.trim().length === 0}
                      onClick={() => void drawCurves()}
                      sx={{ whiteSpace: 'nowrap', flex: '0 0 auto' }}
                    >
                      {curveBusy ? '正在出图…' : '画曲线'}
                    </Button>
                  </Stack>
                  <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                    每个基因一格，每组一条拟合样条 + 该组的实际观测点。
                    不需要重跑分析（复用已保存的模型，约 1 秒）。
                  </Typography>

                  {curves && curves.missingGenes.length > 0 && (
                    <Alert severity="warning" sx={{ fontSize: 11 }}>
                      <b>名字找不到</b>：{curves.missingGenes.join('、')}
                      —— 数据里没有这些名字。常见原因：拼写不一致，或 ID 体系不同。
                    </Alert>
                  )}
                  {curves && curves.notSignificant.length > 0 && (
                    <Alert severity="info" sx={{ fontSize: 11 }}>
                      <b>存在但未过当前阈值</b>：{curves.notSignificant.join('、')}
                      —— 曲线已画出，但它们没有通过当前的 Fisher q / |lfc_max| 阈值。
                      想让它们进显著表，把参数区的阈值放宽后重跑。
                    </Alert>
                  )}
                  {curves?.plots.map((pl) =>
                    pl.dataUrl ? (
                      <Box key={pl.id}>
                        <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                          {pl.caption}
                        </Typography>
                        <FigureImage
                          src={pl.dataUrl}
                          alt={pl.caption}
                          file={pl.file}
                          onExport={async (format) => {
                            const outPath = await pickSavePath(
                              `${curves.tsId}-curves.${format}`,
                              format
                            )
                            if (!outPath) return
                            await call(
                              window.deg.timeseries.exportPlot({
                                tsId: curves.tsId,
                                file: pl.file,
                                format,
                                outPath
                              })
                            )
                          }}
                        />
                      </Box>
                    ) : null
                  )}
                </>
              )}

              {tab === 3 && clusterRows.length > 0 && (
                <>
                  <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                    各簇基因数：{clusterRows.map((c) => `${c.cluster}(${c.genes.length})`).join(' / ')}
                  </Typography>
                  <TableContainer sx={{ maxHeight: 220 }}>
                    <Table size="small" stickyHeader>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontSize: 11, width: 80 }}>cluster</TableCell>
                          <TableCell sx={{ fontSize: 11, width: 80 }} align="right">基因数</TableCell>
                          <TableCell sx={{ fontSize: 11 }}>基因（前 20 个）</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {clusterRows.map((c) => (
                          <TableRow key={c.cluster} hover>
                            <TableCell sx={{ fontSize: 11 }}>{c.cluster}</TableCell>
                            <TableCell sx={{ fontSize: 11 }} align="right">{c.genes.length}</TableCell>
                            <TableCell sx={{ fontSize: 10, fontFamily: 'monospace' }}>
                              {c.genes.slice(0, 20).join(', ')}
                              {c.genes.length > 20 ? ` … +${c.genes.length - 20}` : ''}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </>
              )}
            </Stack>
          )}
        </Card>
      )}
    </>
  )
}
