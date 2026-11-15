/**
 * 单细胞分析流程页（向导式，9 步）。
 *
 * ## 为什么是「左侧步骤栏 + 右侧当前步」而不是九个子页面
 *
 * 这九步是**线性依赖**的：没有对象就没有质控，没有聚类就没有 marker。
 * 拆成九个路由会让用户可以直接跳到第 5 步，然后看到一个「请先聚类」的空页面。
 * 用一个页面 + 一个步骤栏，「现在在哪一步、下一步是什么、哪些还没接入」一眼可见。
 *
 * ## 当前只开放第 1 步
 *
 * 内核只做了「数据导入与对象构建」，其余八步一律灰显并标「待接入」。
 * 这不是保守 —— 标成可用但点进去报错，比明说「还没做」更消耗信任。
 *
 * ## 进度与日志
 *
 * 构建对象要读两份 40 MB 的 mtx，几十秒到几分钟。期间主进程通过
 * `analysisProgress` / `analysisLog` 推事件；因为 `scrnaId` 由主进程在调用时
 * 才生成，这里**按「当前是否正在导入」过滤**，而不是按 runId 匹配
 * （按 runId 过滤会导致一条事件都收不到）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DownloadIcon from '@mui/icons-material/Download'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type {
  ScrnaAnnotatePreviewResult,
  ScrnaCustomPlotsResult,
  ScrnaGeneQueryResult,
  ScrnaAnnotateResult,
  ScrnaFilterResult,
  ScrnaEmbedResult,
  ScrnaImportObjectResult,
  ScrnaImportResult,
  ScrnaInspectResult,
  ScrnaMarkerRow,
  ScrnaMarkersResult,
  ScrnaPrepResult,
  ScrnaQcResult,
  ScrnaQcThresholds,
  ScrnaScanResult,
  ScrnaSingleRResult
} from '@shared/types/scrna'
import { SCRNA_OVERLAP_WARN } from '@shared/types/scrna'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { IPC } from '@shared/ipc'
import { call } from '../utils/ipc'
import { ErrorAlert, toUiError, type UiError } from '../components/common/ErrorAlert'
import { FigureImage } from '../components/common/FigureImage'
import { useScrnaExport } from '../hooks/useScrnaExport'

/** 九步流水线。`ready` 是「内核是否已接」，与「用户能不能点」是同一件事 */
const STEPS = [
  { id: 1, name: '数据导入与对象构建', ready: true, hint: '读取 10x 矩阵，合并成一个 Seurat 对象' },
  { id: 2, name: '质控与过滤', ready: true, hint: '线粒体比例 / 基因数 / UMI 数' },
  { id: 3, name: '标准化 · PCA · 批次', ready: false, hint: 'Normalize / 高变基因 / harmony' },
  { id: 4, name: '聚类 · UMAP · tSNE', ready: false, hint: 'FindClusters + 降维可视化' },
  { id: 5, name: 'Marker 基因', ready: false, hint: '各簇差异基因与簇特异标记' },
  { id: 6, name: '细胞注释', ready: true, hint: '人工填表 / 导入注释表 / SingleR（人鼠）' },
  { id: 7, name: '下游分析', ready: false, hint: '亚群差异 / 拟时序 / 细胞通讯' },
  { id: 8, name: '细胞类型富集', ready: false, hint: 'GO / KEGG（复用富集模块）' },
  { id: 9, name: 'Pseudobulk', ready: false, hint: '按样本聚合后做批量差异' }
] as const

export function ScRnaPipelinePage(): JSX.Element {
  /** 导出当前 run 的图（导入步骤等页面级位置用） */
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()

  const [activeStep, setActiveStep] = useState<number>(1)
  const [rootDir, setRootDir] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<ScrnaScanResult | null>(null)
  /** dir → 是否勾选（用 dir 做键而不是 name：name 可编辑，勾选状态不能跟着改） */
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  /** dir → 用户确认后的样本名 */
  const [names, setNames] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [result, setResult] = useState<ScrnaImportResult | null>(null)
  /**
   * ★ 存的是 UiError{message, suggestion, detail}，不是纯字符串。
   *   只取 message 会把「去设置点重新检测 / 清空自定义 R 路径」这句丢掉 ——
   *   客户这次卡在「missing R packages: Seurat」正是因为这个：
   *   屏幕上只说缺包，不说他在用 D://R-4.3.2 而不是内置 R。
   */
  const [error, setError] = useState<UiError | null>(null)
  /**
   * 进度状态**必须绑到 scrnaId 上**。
   *
   * 只用 `Boolean(prepResult)` 判「第 4 步能不能点」会出事：用户在第 1 步重新构建对象后
   * 会得到一个新的 scrnaId，后续步骤的对象还在**旧 runDir** 里，但旧 state 还在，
   * 于是界面放行了第 4 步 —— 点进去读的却是上个对象的结果。
   * 所以这里记的是「哪个 scrnaId 完成了第 2 步」。
   */
  const [filteredDoneFor, setFilteredDoneFor] = useState<string | null>(null)
  const [prepResult, setPrepResult] = useState<ScrnaPrepResult | null>(null)
  /** 重新构建对象后，后续步骤的结果被作废 —— 用来在步骤栏挂「需重跑」 */
  const [invalidated, setInvalidated] = useState(false)
  /** 第 4 步是针对哪个 scrnaId 跑完的（第 5 步的解锁依据） */
  const [embedDoneFor, setEmbedDoneFor] = useState<string | null>(null)
  /**
   * 从外部 rds 开始的上下文（第 4/5/6 步入口）。
   *
   * 有它的时候**没有第 1 步的 result**，但后续步骤照样要能跑 ——
   * 所以统一用 `activeScrnaId`（= result.scrnaId ?? external.scrnaId），
   * 而不是到处判 `result`。
   */
  const [externalRun, setExternalRun] = useState<{
    scrnaId: string
    importedAs: string
    importedAt: string
    sourcePath: string
    targetStep: number
  } | null>(null)

  const activeScrnaId = result?.scrnaId ?? externalRun?.scrnaId ?? null
  /** 导出当前 run 的图（导入步骤等页面级位置用） */
  const exportPlot = useScrnaExport(activeScrnaId)
  /** markXxx 这类稳定回调要用它，不能闭包 result */
  const activeScrnaIdRef = useRef<string | null>(null)
  activeScrnaIdRef.current = activeScrnaId
  /**
   * 第 5 步「自选基因」的草稿 —— **放在页面级**，不放 StepMarkers 内部。
   *
   * 原因：导入外部对象后 `activeScrnaId` 变化 → `<StepMarkers key={scrnaId}>` 重挂载 →
   * 子组件 state 归零。用户「先填了 42 个基因、再点导入」的顺序完全正常，
   * 而填充内容会被这次重挂载吞掉（实测：界面显示 14 个基因，主进程收到 0 个）。
   * 提到页面级后，重挂载只重建 UI，草稿还在。
   */
  const [dotGenesDraft, setDotGenesDraft] = useState('')
  /** 第 6 步「簇 → 细胞类型」的草稿，同理（重挂载不能把用户填了一半的表清空） */
  const [celltypeDraft, setCelltypeDraft] = useState<Record<string, string>>({})
  /** 重新构建对象后的显式提示（可关闭） */
  const [reimportNotice, setReimportNotice] = useState(false)
  const [exporting, setExporting] = useState(false)

  /**
   * 事件过滤开关：scrnaId 由主进程在调用时生成，调用返回前拿不到，
   * 所以「是否本轮的日志」只能靠这个标志，而不是 runId 匹配。
   */
  const busyRef = useRef(false)
  /** 最新一次 import 结果（供 markFilteredDone 这类稳定回调读取，不必进 deps） */
  const importResultRef = useRef<ScrnaImportResult | null>(null)

  // 这两个开关要传给 StepQc 做 useCallback 的依赖，必须是稳定引用
  /** 第 2 步完成：记下是哪一次 scrnaId 完成的 */
  /**
   * 「从 rds 继续」导入成功：把上下文切到这个新 run。
   *
   * 要清掉一切与旧对象相关的进度（它们是另一个 scrnaId 的），并记下
   * 来源文件与目标步骤，界面据此把前面的步骤标成「已跳过」。
   */
  const handleObjectImported = useCallback((r: ScrnaImportObjectResult) => {
    setResult(null)
    importResultRef.current = null
    setFilteredDoneFor(null)
    setPrepResult(null)
    setEmbedDoneFor(null)
    setInvalidated(false)
    setReimportNotice(false)
    setExternalRun({
      scrnaId: r.scrnaId,
      importedAs: r.importedAs,
      importedAt: r.importedAt,
      sourcePath: r.summary.path,
      targetStep: r.summary.targetStep
    })
    setActiveStep(r.summary.targetStep)
  }, [])

  const markEmbedDone = useCallback(() => {
    setEmbedDoneFor(activeScrnaIdRef.current)
  }, [])

  const markFilteredDone = useCallback(() => {
    setFilteredDoneFor(activeScrnaIdRef.current)
  }, [])

  const beginRun = useCallback(() => {
    busyRef.current = true
  }, [])
  const endRun = useCallback(() => {
    busyRef.current = false
  }, [])

  useIpcEvent(IPC.event.analysisProgress, (payload) => {
    if (!busyRef.current) return
    setProgress({ pct: payload.pct, msg: payload.msg ?? '' })
  })
  useIpcEvent(IPC.event.analysisLog, (payload) => {
    if (!busyRef.current) return
    // 只留最后 3 行：这个框的作用是「证明没卡死」，滚动历史会把它撑得很难看
    setLogs((prev) => [...prev, payload.line].slice(-3))
  })

  const pickRootDir = useCallback(async () => {
    try {
      const dir = await call(window.deg.system.pickDir())
      if (!dir) return
      setRootDir(dir)
      // 换目录后旧的扫描结果与对象都不再属于这个目录
      setScan(null)
      setPicked({})
      setNames({})
      setResult(null)
      importResultRef.current = null
      setError(null)
    } catch (err) {
      setError(toUiError(err))
    }
  }, [])

  const doScan = useCallback(async () => {
    if (!rootDir) return
    setScanning(true)
    setError(null)
    setResult(null)
    try {
      const res = await call(window.deg.scrna.scanDir({ rootDir }))
      setScan(res)
      // 默认全选 + 名字取目录名（用户可改）
      const nextPicked: Record<string, boolean> = {}
      const nextNames: Record<string, string> = {}
      for (const s of res.samples) {
        nextPicked[s.dir] = true
        nextNames[s.dir] = s.name
      }
      setPicked(nextPicked)
      setNames(nextNames)
    } catch (err) {
      setError(toUiError(err))
      setScan(null)
    } finally {
      setScanning(false)
    }
  }, [rootDir])

  const selectedSamples = useMemo(() => {
    if (!scan) return []
    return scan.samples
      .filter((s) => picked[s.dir])
      .map((s) => ({ name: (names[s.dir] ?? s.name).trim(), dir: s.dir }))
  }, [scan, picked, names])

  const canBuild =
    selectedSamples.length > 0 &&
    selectedSamples.every((s) => s.name.length > 0) &&
    new Set(selectedSamples.map((s) => s.name)).size === selectedSamples.length

  const doImport = useCallback(async () => {
    if (!canBuild || !rootDir) return
    setImporting(true)
    busyRef.current = true
    setError(null)
    setResult(null)
    setProgress({ pct: 0, msg: '准备中' })
    setLogs([])
    try {
      const res = await call(
        window.deg.scrna.import({ rootDir, samples: selectedSamples })
      )
      /*
       * ★ 重新构建对象 = 新 scrnaId = 后续步骤的对象还留在**旧 runDir** 里，已经作废。
       *
       * 必须显式清掉：否则旧 state 还在，步骤栏会继续放行第 3/4 步，用户点进去
       * 读到的是上一个对象的结果 —— 而且没有任何提示。
       * 注意只在**真的重新构建**时清；单纯切回第 1 步什么都没动，不能清（那是另一个 bug）。
       */
      const previousId = importResultRef.current?.scrnaId ?? null
      if (previousId && previousId !== res.scrnaId) {
        const hadProgress = Boolean(filteredDoneFor) || Boolean(prepResult) || Boolean(embedDoneFor)
        setFilteredDoneFor(null)
        setPrepResult(null)
        setEmbedDoneFor(null)
        if (hadProgress) {
          setInvalidated(true)
          setReimportNotice(true)
        }
      }
      importResultRef.current = res
      setResult(res)
    } catch (err) {
      setError(toUiError(err))
    } finally {
      busyRef.current = false
      setImporting(false)
    }
  }, [canBuild, rootDir, selectedSamples, filteredDoneFor, prepResult, embedDoneFor])

  const downloadObject = useCallback(async () => {
    if (!result) return
    setExporting(true)
    try {
      const outPath = await call(
        window.deg.system.saveFile({
          defaultName: 'obj_step1.rds',
          filters: [{ name: 'R 对象文件', extensions: ['rds'] }]
        })
      )
      if (!outPath) return
      await call(
        window.deg.scrna.exportObject({ scrnaId: result.scrnaId, outPath })
      )
    } catch (err) {
      setError(toUiError(err))
    } finally {
      setExporting(false)
    }
  }, [result])

  return (
    <Box sx={{ p: 3, maxWidth: 1440, mx: 'auto' }}>
      <Button
        size="small"
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(routes.module(omicsId))}
        sx={{ mb: 1.5 }}
      >
        返回模块
      </Button>

      <Box sx={{ mb: 2 }}>
        <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
          单细胞分析流程
        </Typography>
        <Typography variant="body1" color="text.secondary">
          {/* 这句话必须跟着已接入的步骤走：写死「第 1 步」会在做完第 2 步后立刻过期，
              用户看到自己正用着的功能被标成「未接入」，会怀疑是不是点错了 */}
          九步流水线 · 当前已接入第 6 步（导入 → 质控 → 标准化 → 聚类 → Marker → 细胞注释）
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '264px minmax(0, 1fr)', gap: 2 }}>
        {/* ---------------- 左：步骤栏 ---------------- */}
        <Card variant="outlined" sx={{ p: 1, height: 'fit-content' }}>
          <Typography variant="body2" sx={{ px: 1, py: 0.75, fontWeight: 600, fontSize: 11.5 }}>
            分析步骤
          </Typography>
          <Stack spacing={0.5}>
            {STEPS.map((step) => {
              /*
                第 2 步的解锁条件是「第 1 步已经跑出对象」——
                没有对象就无法质控，提前放开只会让人点进一个必然报错的页面。
                （其余步骤仍是静态 planned。）
              */
              // 外部导入时，目标步骤之前的步骤是「跳过」，不是「需重跑」
              const skipped = externalRun ? step.id < externalRun.targetStep : false
              const ready =
                step.id === 1 ||
                // 第 2 步：有第 1 步的对象才能做（外部从 4 开始时它被跳过）
                (step.id === 2 && Boolean(result)) ||
                // 第 3 步：第 2 步必须**针对当前这个 scrnaId** 跑过
                (step.id === 3 && Boolean(activeScrnaId) && filteredDoneFor === activeScrnaId) ||
                // 第 4/5/6 步**永远可进入**：面板里那个「从 rds 继续」入口必须先能看到，
                // 否则「直接从第 4 步开始」这条路根本没入口（鸡生蛋）。
                // 进去后如果还没有输入对象，运行按钮是禁用的，并写明原因。
                // 第 6 步也一样：注释只能在有 clusters 的对象上做，但那对象也可能来自导入。
                step.id === 4 ||
                step.id === 5 ||
                step.id === 6
              // 作废过、且当前没就绪 → 标「需重跑」，避免用户以为「点了没反应」
              // 只标 2-4 步：5-9 步本来就是「待接入」，标成「需重跑」会让人以为它们跑过
              // 只标 2-4 步：5-9 步本来就是「待接入」，标成「需重跑」会让人以为它们跑过
              const needsRerun =
                invalidated && !ready && step.id >= 2 && step.id <= 6 && !skipped
              const active = step.id === activeStep
              return (
                <Box
                  key={step.id}
                  onClick={() => {
                    // 只有已接入的步骤能切；其余点不动（不是禁用样式但无反应）
                    if (ready) setActiveStep(step.id)
                  }}
                  sx={{
                    px: 1,
                    py: 0.75,
                    borderRadius: 1,
                    cursor: ready ? 'pointer' : 'not-allowed',
                    bgcolor: active ? 'action.selected' : 'transparent',
                    color: ready ? 'text.primary' : 'text.disabled',
                    '&:hover': ready ? { bgcolor: active ? 'action.selected' : 'action.hover' } : {}
                  }}
                >
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        fontSize: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: ready ? 'primary.main' : 'action.disabledBackground',
                        color: ready ? 'primary.contrastText' : 'text.disabled',
                        flex: '0 0 auto'
                      }}
                    >
                      {step.id}
                    </Box>
                    <Typography sx={{ fontSize: 11.5, lineHeight: 1.35, flex: 1 }}>
                      {step.name}
                    </Typography>
                    {skipped ? (
                      <Chip
                        size="small"
                        label="已跳过"
                        sx={{ height: 16, fontSize: 9.5, '& .MuiChip-label': { px: 0.6 } }}
                      />
                    ) : needsRerun ? (
                      <Chip
                        size="small"
                        color="warning"
                        label="需重跑"
                        sx={{ height: 16, fontSize: 9.5, '& .MuiChip-label': { px: 0.6 } }}
                      />
                    ) : (
                      // 「待接入」= 内核还没做；「待前置」= 已接入、只是前面的步骤还没跑。
                      // 两者原来都显示「待接入」，于是在第 1 步时第 2/3 步明明是已实现的，
                      // 却被标成「没做」—— 用户会以为功能缺失。
                      !ready && (
                        <Chip
                          size="small"
                          label={step.ready ? '待前置' : '待接入'}
                          sx={{ height: 16, fontSize: 9.5, '& .MuiChip-label': { px: 0.6 } }}
                        />
                      )
                    )}
                  </Stack>
                </Box>
              )
            })}
          </Stack>
        </Card>

        {/* ---------------- 右：当前步骤 ---------------- */}
        <Box>
          {/*
            重新构建对象后的**显式**提示。
            没有这句，用户只会看到第 3、4 步变灰/「需重跑」，不知道为什么 ——
            而这正是「换了个新对象、旧结果全废」这件事唯一该被说出来的地方。
          */}
          {externalRun && (
            <Alert severity="info" sx={{ mb: 2, fontSize: 11.5 }}>
              本步骤的输入来自外部对象 <code>{externalRun.sourcePath.split(/[\\/]/).pop()}</code>
              （导入于 {new Date(externalRun.importedAt).toLocaleString()}），
              第 1-{externalRun.targetStep - 1} 步未在本工具中运行。
            </Alert>
          )}
          {reimportNotice && (
            <Alert
              severity="warning"
              onClose={() => setReimportNotice(false)}
              sx={{ mb: 2, fontSize: 11.5 }}
            >
              已重新构建对象（新的一次运行）：后续 2-4 步的结果来自上一个对象，已作废，
              需要按顺序重新运行。
            </Alert>
          )}
          {/*
            ★ 错误提示必须是**页面级**的，不能塞在某一步的面板里。
              原来它挂在第 1 步的面板内（`display:none` 的容器里），于是在第 5 步
              导入 rds 失败时，屏幕上什么都不会出现 —— 日志里明明有
              「找不到对象'hasClusters'」，用户看到的却是「点了没反应」。
          */}
          {error && <ErrorAlert error={error} />}
          {/*
            ★ 四个步骤**保持挂载**，用 display 切换显隐。
              条件挂载（`activeStep === N && <Step/>`）会在切步骤时卸载组件，
              内部的 QC 预览结果、过滤结果、聚类图全部销毁 —— 用户看到的就是
              「跑到第 4 步回第 1 步，后面就回不去了，得重跑」。
              代价是 4 步的 base64 图同时在内存里（几 MB），换来的是切步骤不丢结果。
          */}
          <Box sx={{ display: activeStep === 1 ? 'block' : 'none' }}>
            <Stack spacing={2}>
              <Card variant="outlined" sx={{ p: 2 }}>
                <Typography variant="h3" sx={{ mb: 1 }}>
                  1. 选择数据目录并扫描样本
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
                  支持 CellRanger v2（genes.tsv）与 v3（features.tsv）；目录可以嵌套在
                  <code> sample/outs/filtered_feature_bc_matrix </code>
                  里，扫描会自动下钻。扫描只读文件名，不读矩阵。
                </Typography>

                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<FolderOpenIcon />}
                    onClick={() => void pickRootDir()}
                  >
                    选择目录
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={!rootDir || scanning}
                    onClick={() => void doScan()}
                  >
                    {scanning ? '扫描中…' : '扫描样本'}
                  </Button>
                  {scanning && <CircularProgress size={16} />}
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}
                  >
                    {rootDir || '尚未选择目录'}
                  </Typography>
                </Stack>

                {scan && (
                  <>
                    <Typography variant="body2" sx={{ fontSize: 11.5, mb: 0.75 }}>
                      共扫描 <strong>{scan.scannedDirs}</strong> 个目录，找到{' '}
                      <strong>{scan.samples.length}</strong> 个样本
                      <span style={{ color: '#888' }}>
                        （耗时 {Math.max(1, Math.round(scan.elapsedMs))} ms）
                      </span>
                    </Typography>

                    {scan.samples.length === 0 ? (
                      <Alert severity="warning" sx={{ fontSize: 12 }}>
                        这个目录下没有找到 10x 矩阵。需要同时包含
                        <code> matrix.mtx(.gz) </code>、<code> barcodes.tsv(.gz) </code>、
                        <code> genes.tsv(.gz) </code> 或 <code> features.tsv(.gz) </code>。
                      </Alert>
                    ) : (
                      <TableContainer>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ fontSize: 11, width: 40 }} />
                              <TableCell sx={{ fontSize: 11 }}>样本名（可改，即 orig.ident）</TableCell>
                              <TableCell sx={{ fontSize: 11 }}>版本</TableCell>
                              <TableCell sx={{ fontSize: 11 }}>目录</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {scan.samples.map((s) => (
                              <TableRow key={s.dir} hover>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Checkbox
                                    size="small"
                                    checked={picked[s.dir] ?? false}
                                    onChange={(e) =>
                                      setPicked((prev) => ({ ...prev, [s.dir]: e.target.checked }))
                                    }
                                  />
                                </TableCell>
                                <TableCell sx={{ py: 0.5 }}>
                                  <TextField
                                    size="small"
                                    value={names[s.dir] ?? s.name}
                                    onChange={(e) =>
                                      setNames((prev) => ({ ...prev, [s.dir]: e.target.value }))
                                    }
                                    inputProps={{ style: { fontSize: 11.5 } }}
                                    sx={{ '& .MuiInputBase-root': { height: 28 }, width: 180 }}
                                  />
                                </TableCell>
                                {/*
                                  三件套文件名并进这一格的 tooltip，而不是单开一列。
                                  单开一列在 1080 宽下会把表格挤出横向滚动条，
                                  而 `matrix.mtx.gz / barcodes.tsv.gz / genes.tsv.gz`
                                  这三件事其实**几乎不变** —— 用户真正要看的是
                                  「v2 还是 v3」和「到底读的是哪个目录」。
                                */}
                                <TableCell
                                  title={`${s.files.matrix} / ${s.files.barcodes} / ${s.files.features}`}
                                  sx={{ fontSize: 11 }}
                                >
                                  <Chip
                                    size="small"
                                    label={s.layout === 'v3' ? 'v3 features' : 'v2 genes'}
                                    sx={{ height: 18, fontSize: 10 }}
                                  />
                                </TableCell>
                                {/*
                                  路径用「省略号 + title 悬浮」而不是 wordBreak: break-all。
                                  break-all 会把 `GSE313726_RAW\MD` 拆成
                                  `GSE313726_R` / `AW\MD` 这种断在词中间的多行，
                                  表格被撑得很高而且更难读。
                                */}
                                <TableCell
                                  title={s.dir}
                                  sx={{
                                    fontSize: 10.5,
                                    color: 'text.secondary',
                                    fontFamily: 'monospace',
                                    maxWidth: 320,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}
                                >
                                  {s.dir}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                  </>
                )}
              </Card>

              {scan && scan.samples.length > 0 && (
                <Card variant="outlined" sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1 }}>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!canBuild || importing}
                      onClick={() => void doImport()}
                    >
                      {importing ? '正在构建…' : '构建对象'}
                    </Button>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                      已选 {selectedSamples.length} / {scan.samples.length} 个样本 ·
                      固定参数 min.cells = 3、min.features = 100（客户指定，不可调）
                    </Typography>
                  </Stack>

                  {!canBuild && selectedSamples.length > 0 && (
                    <Alert severity="info" sx={{ fontSize: 12, mb: 1 }}>
                      样本名不能为空，也不能重名 —— 它会成为下游所有分组的名字。
                    </Alert>
                  )}

                  {importing && (
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
              )}

              {result && (
                <Card variant="outlined" sx={{ p: 2 }}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ mb: 1 }}
                  >
                    <Typography variant="h3">构建完成</Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<DownloadIcon />}
                      disabled={exporting}
                      onClick={() => void downloadObject()}
                    >
                      {exporting ? '导出中…' : '下载当前对象 (rds)'}
                    </Button>
                  </Stack>

                  <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
                    {[
                      { label: '样本数', value: result.nSamples },
                      { label: '细胞数', value: result.nCells.toLocaleString() },
                      { label: '基因数', value: result.nGenes.toLocaleString() },
                      {
                        label: '被过滤细胞',
                        value:
                          result.filteredByMinFeatures == null
                            ? '—'
                            : result.filteredByMinFeatures.toLocaleString()
                      }
                    ].map((item) => (
                      <Box key={item.label}>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                          {item.label}
                        </Typography>
                        <Typography sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>
                          {item.value}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>

                  {/*
                    基因重叠率 < 0.5 时标红：merge 会「成功」，但样本间几乎不共享基因，
                    后面聚类一定按样本劈开、而且不会有任何一步报错。所以在这里就说出来。
                  */}
                  {result.sampleOverlap.some((o) => o.overlap < SCRNA_OVERLAP_WARN) && (
                    <Alert severity="warning" sx={{ mb: 1.5, fontSize: 11.5 }}>
                      样本间基因重叠过低：
                      {result.sampleOverlap
                        .filter((o) => o.overlap < SCRNA_OVERLAP_WARN)
                        .map((o) => `${o.a} × ${o.b} ${(o.overlap * 100).toFixed(1)}%`)
                        .join('；')}
                      。这通常说明各样本用了不同的注释版本 —— 合并会成功，但下游聚类会按样本分开。
                    </Alert>
                  )}

                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
                    被过滤细胞 {result.filteredByMinFeatures ?? '—'} = 读入细胞数 − 合并后细胞数。
                    这批数据是 GEO 的 filtered 矩阵（已滤过空液滴），所以常见为 0；换 raw 矩阵才会明显大于 0。
                  </Typography>

                  <Divider sx={{ mb: 1.5 }} />

                  <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 2 }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 600, mb: 0.5 }}>
                        每样本细胞数
                      </Typography>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ fontSize: 11 }}>样本</TableCell>
                            <TableCell sx={{ fontSize: 11 }} align="right">细胞数</TableCell>
                            <TableCell sx={{ fontSize: 11 }} align="right">中位基因数</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {result.perSample.map((row) => (
                            <TableRow key={row.sample} hover>
                              <TableCell sx={{ fontSize: 11.5 }}>{row.sample}</TableCell>
                              <TableCell sx={{ fontSize: 11.5 }} align="right">
                                {row.cells.toLocaleString()}
                              </TableCell>
                              <TableCell sx={{ fontSize: 11.5 }} align="right">
                                {row.genesMedian.toLocaleString()}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.75 }}>
                        对象已保存到 <code>results/scrna/{result.scrnaId}/obj_step1.rds</code>
                        ，耗时 {(result.durationMs / 1000).toFixed(1)} s
                      </Typography>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setActiveStep(2)}
                        sx={{ mt: 0.5, fontSize: 11 }}
                      >
                        下一步：质控与过滤 →
                      </Button>
                    </Box>

                    <Box>
                      {result.plotDataUrl ? (
                        <FigureImage
                          src={result.plotDataUrl}
                          alt="每样本细胞数"
                          file="p02_cells_per_sample.png"
                          onExport={exportPlot('p02_cells_per_sample.png')}
                        />
                      ) : (
                        <Box
                          sx={{
                            height: 200,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'text.disabled',
                            fontSize: 11.5,
                            border: '1px dashed',
                            borderColor: 'divider',
                            borderRadius: 1
                          }}
                        >
                          图未生成（不影响对象本身）
                        </Box>
                      )}
                    </Box>
                  </Box>
                </Card>
              )}
            </Stack>
          </Box>

          {activeScrnaId && (
            <Box sx={{ display: activeStep === 2 ? 'block' : 'none' }}>
              <StepQc
                key={activeScrnaId}
                scrnaId={activeScrnaId}
                progress={progress}
                logs={logs}
                beginRun={beginRun}
                endRun={endRun}
                onError={setError}
                onDone={markFilteredDone}
              />
            </Box>
          )}

          {activeScrnaId && (
            <Box sx={{ display: activeStep === 3 ? 'block' : 'none' }}>
              <StepPrep
                key={activeScrnaId}
                scrnaId={activeScrnaId}
                progress={progress}
                logs={logs}
                beginRun={beginRun}
                endRun={endRun}
                onError={setError}
                onResult={setPrepResult}
                saved={prepResult}
                onNext={() => setActiveStep(4)}
              />
            </Box>
          )}

          {/* 4/5 步永远挂载：面板里的「从 rds 继续」入口必须先能看到 */}
          <Box sx={{ display: activeStep === 4 ? 'block' : 'none' }}>
            <StepEmbed
              key={activeScrnaId ?? 'none'}
              scrnaId={activeScrnaId ?? ''}
              defaultDims={prepResult?.nPcs ?? 30}
              activeReduction={prepResult?.activeReduction ?? 'pca'}
              progress={progress}
              logs={logs}
              beginRun={beginRun}
              endRun={endRun}
              onError={setError}
              onDone={markEmbedDone}
              onImported={handleObjectImported}
            />
          </Box>

          <Box sx={{ display: activeStep === 5 ? 'block' : 'none' }}>
            <StepMarkers
              key={activeScrnaId ?? 'none'}
              scrnaId={activeScrnaId ?? ''}
              progress={progress}
              logs={logs}
              beginRun={beginRun}
              endRun={endRun}
              onError={setError}
              onImported={handleObjectImported}
              onNext={() => setActiveStep(6)}
              dotText={dotGenesDraft}
              onDotTextChange={setDotGenesDraft}
            />
          </Box>

          <Box sx={{ display: activeStep === 6 ? 'block' : 'none' }}>
            <StepAnnotate
              key={activeScrnaId ?? 'none'}
              scrnaId={activeScrnaId ?? ''}
              progress={progress}
              logs={logs}
              beginRun={beginRun}
              endRun={endRun}
              onError={setError}
              onImported={handleObjectImported}
              celltypes={celltypeDraft}
              onCelltypesChange={setCelltypeDraft}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ *
 * 第 2 步：质控与过滤
 * ------------------------------------------------------------------ */

/** 阈值输入：空串 = null（不启用这条），不是「用默认值」 */
function parseThreshold(value: string): number | null {
  const t = value.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** mt 阈值必须是 0~1 的小数；超出范围视为填错（不是"更宽松"） */
function isMtOutOfRange(value: string): boolean {
  const n = parseThreshold(value)
  return n !== null && (n < 0 || n > 1)
}

interface StepQcProps {
  scrnaId: string
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
  /** 过滤成功后通知父组件：第 3 步可以解锁了 */
  onDone: () => void
}

/**
 * 段 A（预览）与段 B（应用）放在同一个面板里，是因为客户的使用顺序是
 * 「看图 → 改阈值 → 再看图 → 满意了才应用」。做成两个页面会让他来回跳。
 *
 * ★ 改阈值后**必须重新预览**：阈值线在图上，不重跑看到的还是旧线。
 *   按钮文案与旁边的说明都写了这一点。
 */
function StepQc({
  scrnaId,
  progress,
  logs,
  beginRun,
  endRun,
  onError,
  onDone
}: StepQcProps): JSX.Element {
  /** 导出本步骤的图（png / pdf）——复制 R 已生成的那份 */
  const exportPlot = useScrnaExport(scrnaId)
  const [minFeature, setMinFeature] = useState('200')
  const [minCount, setMinCount] = useState('500')
  const [maxMt, setMaxMt] = useState('0.2')
  // mt 单位防呆：0~1 的小数（0.2 = 20%）。填 20 会被后端拦下，但报错看不出原因，
  // 所以在界面上就标红并禁用按钮，把话说明白。
  const mtNum = parseThreshold(maxMt)
  const mtInvalid = isMtOutOfRange(maxMt)

  const [qcBusy, setQcBusy] = useState(false)
  const [qc, setQc] = useState<ScrnaQcResult | null>(null)
  const [filterBusy, setFilterBusy] = useState(false)
  const [filtered, setFiltered] = useState<ScrnaFilterResult | null>(null)
  const [downloading, setDownloading] = useState(false)

  /**
   * 阈值每次都在回调里现算：`{...}` 字面量每次渲染都是新对象，
   * 若提到外面再放进 deps，useCallback 等于每次都重建，反而没有意义。
   */
  const readThresholds = useCallback(
    (): ScrnaQcThresholds => ({
      minFeature: parseThreshold(minFeature),
      minCount: parseThreshold(minCount),
      maxMt: parseThreshold(maxMt)
    }),
    [minFeature, minCount, maxMt]
  )

  const runQc = useCallback(async () => {
    setQcBusy(true)
    beginRun()
    onError(null)
    try {
      // 改阈值后旧的前后对比就失效了 —— 一并清掉，避免用户照着过期结果去应用
      setFiltered(null)
      const res = await call(window.deg.scrna.qc({ scrnaId, thresholds: readThresholds() }))
      setQc(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setQcBusy(false)
    }
  }, [scrnaId, readThresholds, beginRun, endRun, onError])

  const runFilter = useCallback(async () => {
    setFilterBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(window.deg.scrna.filter({ scrnaId, thresholds: readThresholds() }))
      setFiltered(res)
      onDone()
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setFilterBusy(false)
    }
  }, [scrnaId, readThresholds, beginRun, endRun, onError, onDone])

  const download = useCallback(
    async (kind: 'rds' | 'csv') => {
      setDownloading(true)
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: kind === 'rds' ? 'obj_step2.rds' : 'qc_summary.csv',
            filters:
              kind === 'rds'
                ? [{ name: 'R 对象文件', extensions: ['rds'] }]
                : [{ name: 'CSV 表格', extensions: ['csv'] }]
          })
        )
        if (!outPath) return
        if (kind === 'rds') {
          // ★ 必须指明是第几步的对象，否则拿到的是 obj_step1（见 ScrnaObjectFile 的注释）
          await call(window.deg.scrna.exportObject({ scrnaId, outPath, file: 'obj_step2' }))
        } else {
          await call(window.deg.scrna.exportSummary({ scrnaId, outPath }))
        }
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setDownloading(false)
      }
    },
    [scrnaId, onError]
  )

  const busy = qcBusy || filterBusy

  return (
    <Stack spacing={2}>
      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 0.5 }}>
          2. 质控与过滤
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
          先看分布、再定阈值。预览**不会删任何细胞**；看过之后再点「应用过滤」。
        </Typography>

        <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            label="最少基因数 nFeature >"
            value={minFeature}
            onChange={(e) => setMinFeature(e.target.value)}
            helperText="照你的脚本：nFeature_RNA > 200"
            sx={{ width: 190, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="最少 UMI 数 nCount >"
            value={minCount}
            onChange={(e) => setMinCount(e.target.value)}
            helperText="照你的脚本：nCount_RNA > 500"
            sx={{ width: 190, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          {/*
            mt 的单位是这个页面最容易填错的地方：percent.mt 本身是 0–100 的百分数，
            而这里要求填 0–1 的小数（0.2 = 20%）。客户口头说的也是「0.2」。
            所以：① 输入框下面实时把小数换算成百分数显示；② 填 >1 直接标红并拦住按钮，
            否则填 20 会被当成 2000%，一个细胞都滤不掉，而且看起来只是「阈值有点宽」。
          */}
          <TextField
            size="small"
            label="线粒体比例 mt <"
            value={maxMt}
            onChange={(e) => setMaxMt(e.target.value)}
            error={mtInvalid}
            helperText={
              mtInvalid
                ? '请填 0~1 的小数：0.2 表示 20%。填 20 会被当成 2000%，等于不过滤'
                : `你的脚本里没有这条，本软件新增 · ${
                    mtNum === null ? '留空 = 不按这条过滤' : `0.2 表示 20%，当前 = ${(mtNum * 100).toFixed(0)}%`
                  }`
            }
            sx={{ width: 210, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={busy || mtInvalid}
            onClick={() => void runQc()}
          >
            {qcBusy ? '正在计算…' : '① 预览分布'}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !qc || mtInvalid}
            onClick={() => void runFilter()}
          >
            {filterBusy ? '正在过滤…' : '② 应用过滤'}
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
            改阈值后请重新「① 预览分布」，图上的阈值线才会更新
          </Typography>
        </Stack>

        {busy && (
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

      {qc && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
            <Typography variant="h3">QC 分布</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
              {qc.nCells.toLocaleString()} 细胞 · {qc.nGenes.toLocaleString()} 基因 · 耗时{' '}
              {(qc.durationMs / 1000).toFixed(1)} s
            </Typography>
          </Stack>

          {qc.mtGeneCount === 0 ? (
            <Alert severity="info" sx={{ mb: 1.5, fontSize: 11.5 }}>
              这组数据的基因名里找不到线粒体基因（<code>^mt-</code> 不区分大小写），
              所以没有线粒体比例图，mt 过滤会跳过。
            </Alert>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1.5 }}>
              线粒体基因 {qc.mtGeneCount} 个（如 {qc.mtExamples.join('、')}）
            </Typography>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
            {qc.plots.map((p) => (
              <Box key={p.id}>
                {p.dataUrl ? (
                  <FigureImage src={p.dataUrl} alt={p.caption} file={p.file} onExport={exportPlot(p.file)} />
                ) : (
                  <Box sx={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 11, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                    图未生成
                  </Box>
                )}
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mt: 0.25 }}>
                  {p.caption}
                </Typography>
              </Box>
            ))}
          </Box>

          <TableContainer sx={{ mt: 1.5 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['样本', '细胞数', '中位基因', '中位 UMI', '中位 MT%', '过基因', '过 UMI', '过 MT', '全过'].map((h) => (
                    <TableCell key={h} sx={{ fontSize: 11 }} align={h === '样本' ? 'left' : 'right'}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {qc.qcSummary.map((row) => (
                  <TableRow key={row.sample} hover>
                    <TableCell sx={{ fontSize: 11.5 }}>{row.sample}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.cells.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.medianFeature.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.medianCount.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">
                      {row.medianMt == null ? '—' : row.medianMt.toFixed(2)}
                    </TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.passFeature.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.passCount.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.passMt.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11.5, fontWeight: 600 }} align="right">{row.passAll.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {filtered && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h3">过滤结果</Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading}
                onClick={() => void download('csv')}
              >
                下载统计表
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading}
                onClick={() => void download('rds')}
              >
                下载当前对象 (rds)
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
            {[
              { label: '过滤前', value: filtered.cellsBefore.toLocaleString() },
              { label: '过滤后', value: filtered.cellsAfter.toLocaleString() },
              { label: '移除', value: `${filtered.removed.toLocaleString()}（${filtered.removedPct}%）` }
            ].map((item) => (
              <Box key={item.label}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</Typography>
              </Box>
            ))}
          </Stack>

          {filtered.emptySamples.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1.5, fontSize: 11.5 }}>
              这些样本在过滤后细胞数为 0，已从对象中移除：{filtered.emptySamples.join('、')}
            </Alert>
          )}
          {!filtered.mtFilterApplied && (
            <Alert severity="info" sx={{ mb: 1.5, fontSize: 11.5 }}>
              设置了线粒体比例上限，但数据里没有 mt 基因 → 这条过滤已跳过。
            </Alert>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 2 }}>
            <Box>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: 11 }}>样本</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">过滤前</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">过滤后</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.perSample.map((row) => (
                    <TableRow key={row.sample} hover>
                      <TableCell sx={{ fontSize: 11.5 }}>{row.sample}</TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.before.toLocaleString()}</TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.after.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Box>
              {filtered.plotDataUrl ? (
                <FigureImage src={filtered.plotDataUrl} alt="过滤前后细胞数" file="p05_filter_before_after.png" onExport={exportPlot('p05_filter_before_after.png')} />
              ) : (
                <Box sx={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 11, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                  图未生成
                </Box>
              )}
            </Box>
          </Box>
        </Card>
      )}
    </Stack>
  )
}

/* ------------------------------------------------------------------ *
 * 第 3 步：标准化 · PCA · 批次校正
 * ------------------------------------------------------------------ */

interface StepPrepProps {
  scrnaId: string
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
  onResult: (r: ScrnaPrepResult) => void
  /** 已算出的结果（切走再切回来时不必重跑几分钟） */
  saved: ScrnaPrepResult | null
  onNext: () => void
}

/**
 * 这一步耗时最长（2.6 万细胞实测 88 s，其中 harmony 39 s），所以进度条与日志尾行
 * 必须真的在动 —— 否则用户会以为软件卡死。
 *
 * ★ 单样本时 harmony 会被跳过，`activeReduction` = "pca"。这是**正常结果**，
 *   不是错误：要照常展示 PCA 那几张图，只额外说明「已跳过批次校正」。
 */
function StepPrep({
  scrnaId,
  progress,
  logs,
  beginRun,
  endRun,
  onError,
  onResult,
  saved,
  onNext
}: StepPrepProps): JSX.Element {
  /** 导出本步骤的图（png / pdf）——复制 R 已生成的那份 */
  const exportPlot = useScrnaExport(scrnaId)
  const [nFeatures, setNFeatures] = useState('2000')
  const [nPcs, setNPcs] = useState('30')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScrnaPrepResult | null>(saved)
  const [downloading, setDownloading] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.prep({
          scrnaId,
          nFeatures: Number(nFeatures) || 2000,
          nPcs: Number(nPcs) || 30
        })
      )
      setResult(res)
      onResult(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setBusy(false)
    }
  }, [scrnaId, nFeatures, nPcs, beginRun, endRun, onError, onResult])

  const download = useCallback(async () => {
    setDownloading(true)
    try {
      const outPath = await call(
        window.deg.system.saveFile({
          defaultName: 'obj_step3.rds',
          filters: [{ name: 'R 对象文件', extensions: ['rds'] }]
        })
      )
      if (!outPath) return
      await call(window.deg.scrna.exportObject({ scrnaId, outPath, file: 'obj_step3' }))
    } catch (err) {
      onError(toUiError(err))
    } finally {
      setDownloading(false)
    }
  }, [scrnaId, onError])

  return (
    <Stack spacing={2}>
      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 0.5 }}>
          3. 标准化 · PCA · 批次校正
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
          NormalizeData（LogNormalize，scale.factor = 10000）→ 高变基因（vst）→ ScaleData →
          RunPCA → harmony 批次校正。两个样本及以上才会做 harmony。
        </Typography>

        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            label="高变基因数"
            value={nFeatures}
            onChange={(e) => setNFeatures(e.target.value)}
            helperText="照你的脚本：nfeatures = 2000"
            sx={{ width: 190, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="PCA 维数"
            value={nPcs}
            onChange={(e) => setNPcs(e.target.value)}
            helperText="照你的脚本：npcs = 30"
            sx={{ width: 190, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={busy}
            onClick={() => void run()}
            sx={{ mt: 0.25 }}
          >
            {busy ? '正在计算…' : '运行标准化与降维'}
          </Button>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
          ScaleData 只对高变基因做（全部基因的稠密矩阵约 5.6 GB，会撑爆内存）；
          PCA 与 harmony 都只用高变基因，结果不受影响。后续若要用非高变基因画热图需重新 ScaleData。
        </Typography>

        {busy && (
          <Box sx={{ mt: 1 }}>
            <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
              {progress?.msg || '处理中'}（{Math.round(progress?.pct ?? 0)}%）
            </Typography>
            {logs.length > 0 && (
              <Box
                component="pre"
                sx={{
                  mt: 0.75, mb: 0, p: 0.75, maxHeight: 70, overflow: 'hidden',
                  bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider',
                  borderRadius: 1, fontSize: 10, lineHeight: 1.5,
                  fontFamily: 'monospace', whiteSpace: 'pre-wrap'
                }}
              >
                {logs.join('\n')}
              </Box>
            )}
          </Box>
        )}
      </Card>

      {result && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h3">降维与批次校正</Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading}
                onClick={() => void download()}
              >
                下载当前对象 (rds)
              </Button>
              <Button size="small" variant="text" onClick={onNext} sx={{ fontSize: 11 }}>
                下一步：聚类 →
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
            {[
              { label: '高变基因', value: result.nHVG.toLocaleString() },
              { label: 'PCA 维数', value: String(result.nPcs) },
              { label: '细胞数', value: result.nCells.toLocaleString() },
              { label: '样本数', value: String(result.nSamples) }
            ].map((item) => (
              <Box key={item.label}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</Typography>
              </Box>
            ))}
          </Stack>

          {result.harmonyApplied ? (
            <Alert severity="success" sx={{ mb: 1.5, fontSize: 11.5 }}>
              已用 harmony 做批次校正（{result.harmonySeconds.toFixed(1)} s）。下游统一使用
              <code> {result.activeReduction} </code> 这个降维结果。
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 1.5, fontSize: 11.5 }}>
              仅 1 个样本，已跳过批次校正（harmony）。下游统一使用
              <code> {result.activeReduction} </code> 这个降维结果。
            </Alert>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
            {result.plots.map((p) => (
              <Box key={p.id}>
                {p.dataUrl ? (
                <FigureImage
                  src={p.dataUrl}
                  alt={p.caption}
                  file={p.file}
                  onExport={exportPlot(p.file)}
                />
                ) : (
                  <Box sx={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 11, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                    图未生成
                  </Box>
                )}
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, mt: 0.25 }}>
                  {p.caption}
                </Typography>
              </Box>
            ))}
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 1 }}>
            ElbowPlot：拐点之后方差贡献趋平，30 维通常够用。对象已保存到{' '}
            <code>results/scrna/{result.scrnaId}/obj_step3.rds</code>，总耗时{' '}
            {(result.durationMs / 1000).toFixed(1)} s。
          </Typography>
        </Card>
      )}
    </Stack>
  )
}

/* ------------------------------------------------------------------ *
 * 第 4 步：聚类 · UMAP · tSNE
 * ------------------------------------------------------------------ */

interface StepEmbedProps {
  scrnaId: string
  /** 第 3 步实际用的 PCA 维数（显示用，也可改） */
  defaultDims: number
  /** 第 3 步的 activeReduction（只用于界面提示，R 侧仍从对象自己读） */
  activeReduction: 'harmony' | 'pca'
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
  /** 算完通知父组件：第 5 步可以解锁 */
  onDone: () => void
  /** 「从 rds 继续」导入成功后交给父组件切换上下文 */
  onImported: (r: ScrnaImportObjectResult) => void
}

function StepEmbed({
  scrnaId,
  defaultDims,
  activeReduction,
  progress,
  logs,
  beginRun,
  endRun,
  onError,
  onDone,
  onImported
}: StepEmbedProps): JSX.Element {
  /** 导出本步骤的图（png / pdf）——复制 R 已生成的那份 */
  const exportPlot = useScrnaExport(scrnaId)
  const [resolution, setResolution] = useState('0.25')
  const [dims, setDims] = useState(String(defaultDims))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScrnaEmbedResult | null>(null)
  const [plotId, setPlotId] = useState('')
  const [downloading, setDownloading] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.embed({
          scrnaId,
          resolution: Number(resolution) || 0.25,
          dims: Number(dims) || defaultDims
        })
      )
      setResult(res)
      // 默认展示带 cluster 标签的那张 —— 用户最想看的就是分群结果
      setPlotId(res.plots.find((p) => p.id === 'umap_clusters')?.id ?? res.plots[0]?.id ?? '')
      onDone()
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setBusy(false)
    }
  }, [scrnaId, resolution, dims, defaultDims, beginRun, endRun, onError, onDone])

  const download = useCallback(
    async (kind: 'rds' | 'csv') => {
      setDownloading(true)
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: kind === 'rds' ? 'obj_step4.rds' : 'cluster_summary.csv',
            filters:
              kind === 'rds'
                ? [{ name: 'R 对象文件', extensions: ['rds'] }]
                : [{ name: 'CSV 表格', extensions: ['csv'] }]
          })
        )
        if (!outPath) return
        if (kind === 'rds') {
          await call(window.deg.scrna.exportObject({ scrnaId, outPath, file: 'obj_step4' }))
        } else {
          await call(
            window.deg.scrna.exportSummary({ scrnaId, outPath, file: 'cluster_summary' })
          )
        }
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setDownloading(false)
      }
    },
    [scrnaId, onError]
  )

  const current = result?.plots.find((p) => p.id === plotId) ?? result?.plots[0] ?? null

  return (
    <Stack spacing={2}>
      <ImportObjectPanel step={4} onImported={onImported} onError={onError} />
      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 0.5 }}>
          4. 聚类 · UMAP · tSNE
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
          FindNeighbors → FindClusters → RunUMAP → RunTSNE，都用
          <code> {activeReduction} </code> 的前若干维。聚类列名固定为 <code>clusters</code>。
        </Typography>

        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            label="聚类分辨率 resolution"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            helperText="客户定 0.25：0.1 偏粗、0.5 偏细"
            sx={{ width: 210, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="PCA 维数 dims"
            value={dims}
            onChange={(e) => setDims(e.target.value)}
            helperText={`沿用第 3 步的 1:${defaultDims}`}
            sx={{ width: 190, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={busy || !scrnaId}
            onClick={() => void run()}
            sx={{ mt: 0.25 }}
          >
            {busy ? '正在计算…' : '运行聚类与降维'}
          </Button>
        </Stack>

        {!scrnaId && (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
            还没有可用的输入对象：请先完成第 3 步，或用上面的「从 rds 继续」导入一个。
          </Typography>
        )}

        {busy && (
          <Box sx={{ mt: 1 }}>
            <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
              {progress?.msg || '处理中'}（{Math.round(progress?.pct ?? 0)}%）
              {(progress?.pct ?? 0) >= 60 && (progress?.pct ?? 0) < 100
                ? ' · tSNE 较慢，约 3~5 分钟'
                : ''}
            </Typography>
            {logs.length > 0 && (
              <Box
                component="pre"
                sx={{
                  mt: 0.75, mb: 0, p: 0.75, maxHeight: 70, overflow: 'hidden',
                  bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider',
                  borderRadius: 1, fontSize: 10, lineHeight: 1.5,
                  fontFamily: 'monospace', whiteSpace: 'pre-wrap'
                }}
              >
                {logs.join('\n')}
              </Box>
            )}
          </Box>
        )}
      </Card>

      {result && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h3">聚类与降维结果</Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" startIcon={<DownloadIcon />} disabled={downloading} onClick={() => void download('csv')}>
                下载 cluster 汇总
              </Button>
              <Button size="small" variant="outlined" startIcon={<DownloadIcon />} disabled={downloading} onClick={() => void download('rds')}>
                下载当前对象 (rds)
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
            {[
              { label: 'cluster 数', value: String(result.nClusters) },
              { label: '细胞数', value: result.nCells.toLocaleString() },
              { label: 'resolution', value: String(result.resolution) },
              { label: 'UMAP', value: `${result.umapSeconds.toFixed(1)} s` },
              { label: 'tSNE', value: `${result.tsneSeconds.toFixed(1)} s` }
            ].map((item) => (
              <Box key={item.label}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</Typography>
              </Box>
            ))}
          </Stack>

          {/*
            6 张图纵向堆起来会拉得很长，客户明确要求「图多了用下拉菜单看」：
            一个 Select 选图 + 单张大图。
          */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
            <TextField
              select
              size="small"
              label="选择图"
              value={plotId}
              onChange={(e) => setPlotId(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ width: 380, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            >
              {result.plots.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.caption}
                </option>
              ))}
            </TextField>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
              共 {result.plots.length} 张；用下拉切换
            </Typography>
          </Stack>

          {current?.dataUrl ? (
            <FigureImage
                  src={current.dataUrl}
                  alt={current.caption}
                  file={current?.file ?? ''}
                  onExport={current?.file ? exportPlot(current.file) : undefined}
                />
          ) : (
            <Box sx={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 11, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
              图未生成
            </Box>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
            {current?.caption} · 对象已保存到 <code>results/scrna/{result.scrnaId}/obj_step4.rds</code>，
            总耗时 {(result.durationMs / 1000).toFixed(1)} s
          </Typography>

          <TableContainer sx={{ mt: 1.5, maxHeight: 260 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 11 }}>cluster</TableCell>
                  <TableCell sx={{ fontSize: 11 }} align="right">细胞数</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>各样本细胞数</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {result.perCluster.map((row) => (
                  <TableRow key={row.cluster} hover>
                    <TableCell sx={{ fontSize: 11.5 }}>{row.cluster}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{row.cells.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>
                      {row.perSample.map((ps) => `${ps.sample} ${ps.cells.toLocaleString()}`).join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
    </Stack>
  )
}

/* ------------------------------------------------------------------ *
 * 第 5 步：Marker 基因
 * ------------------------------------------------------------------ */

/**
 * 基因诊断：**「不存在」和「存在但几乎不表达」必须分开说**。
 *
 * 这两件事对用户的含义完全不同：
 *   · 不存在 → 名字打错了 / 物种或 ID 体系不对（换名字能解决）
 *   · 存在但稀疏 → 数据本身不支持（这个基因在这批细胞里就是不怎么表达，
 *     该换一个 marker，而不是继续折腾拼写）
 * 合成一句「部分基因无效」等于什么都没说。
 */
function GeneDiagnostics({
  missing,
  stats
}: {
  missing: string[]
  stats: { gene: string; pctExpressing: number }[]
}): JSX.Element {
  const nearlyOff = stats.filter((g) => g.pctExpressing < 0.1)
  const sparse = stats.filter((g) => g.pctExpressing >= 0.1 && g.pctExpressing < 0.5)
  const list = (arr: { gene: string }[]): string =>
    `${arr
      .slice(0, 6)
      .map((g) => g.gene)
      .join('、')}${arr.length > 6 ? ` 等 ${arr.length} 个` : ''}`
  /**
   * 百分比：<10% 时保留一位小数。
   *
   * 不能一律四舍五入 —— 9.7% 会显示成「10% 细胞表达」，而同一句里又写「超过 90% 是 0」，
   * 用户一眼就看出自相矛盾（实测被指出过）。
   */
  const fmtPct = (v: number): string =>
    v * 100 < 10 ? (v * 100).toFixed(1) : String(Math.round(v * 100))
  return (
    <>
      {missing.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1, fontSize: 11 }}>
          <b>名字找不到（不是表达低）</b>：{list(missing.map((g) => ({ gene: g })))}
          在数据里<b>不存在</b>，已跳过。
          <br />
          原因通常是物种 / ID 体系不对（水稻数据填了人 / 蜗牛基因名，或基因名与 Ensembl ID 混用）。
          请核对拼写或换成本数据的 ID 形式。
        </Alert>
      )}
      {nearlyOff.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1, fontSize: 11 }}>
          <b>存在但几乎不表达</b>：
          {nearlyOff.map((g) => `${g.gene}（${fmtPct(g.pctExpressing)}% 细胞表达）`).join('、')}
          —— 超过 90% 的细胞是 0，小提琴只会剩一条线。
          <br />
          建议换一个 marker 基因查看，或直接看 DotPlot 的点大小/颜色。
        </Alert>
      )}
      {sparse.length > 0 && (
        <Alert severity="info" sx={{ mt: 1, fontSize: 11 }}>
          <b>稀疏表达</b>：
          {sparse.map((g) => `${g.gene}（${fmtPct(g.pctExpressing)}% 细胞表达）`).join('、')}
          —— 小提琴的琴身会缩成竖线，这是稀疏数据的固有形态（Seurat 自带的 VlnPlot 也一样）。
          <br />
          比较各群请以 <b>DotPlot 的圆点大小（检出比例）/ 颜色（均值）</b> 为准；
          小提琴上每簇顶部的 <b>均值点 + 百分比</b> 也能读出差异。
        </Alert>
      )}
    </>
  )
}

/**
 * 把用户粘进来的一坨基因名切成数组。
 *
 * 客户是从表格里复制 42 个基因名过来的，分隔符可能是换行、空格、逗号、制表符，
 * 也可能混着 `\r`（从 Excel 复制）。这里一律按「非基因名字符」切，并去重 ——
 * 让用户为分隔符格式重贴一遍是最没必要的摩擦。
 */
function parseGeneList(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,;，；]+/)
        .map((g) => g.trim())
        .filter((g) => g.length > 0)
    )
  )
}

/**
 * marker 导出文件名：把阈值和日期写进名字。
 *
 * 客户会为了「换个 logFC 再跑一次」导出好几份，文件名如果都叫 `markers.csv`，
 * 下载目录里就只剩 `markers (1).csv`、`markers (2).csv` —— 三天后没人分得清
 * 哪份是 logFC 0.5、哪份是 1.0。所以名字里必须带阈值 + 日期。
 */
function markerExportName(
  kind: 'sig' | 'top10',
  format: 'csv' | 'xlsx',
  logfc: number,
  adjP: number
): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  // 阈值里可能有小数点，文件名允许；但 `0.05` 与 `0.050` 要统一，用 Number 归一
  const threshold = `logFC${Number(logfc)}_padj${Number(adjP)}`
  return kind === 'sig'
    ? `markers_${threshold}_${stamp}.${format}`
    : `markers_top10_${threshold}_${stamp}.${format}`
}

interface StepMarkersProps {
  scrnaId: string
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
  onImported: (r: ScrnaImportObjectResult) => void
  onNext: () => void
  /** 自选基因草稿（页面级 state：重挂载不丢） */
  dotText: string
  onDotTextChange: (value: string) => void
}

/**
 * 第 5 步是**先配置、后计算**：客户明确要求在这里停下来让他设 logFC / adjP。
 * 所以进这一步不触发任何计算，必须点「开始计算 Marker」。
 *
 * 表格的地基是服务端查询（`markersTable`）而不是 summary 里的 top10：
 * 几万行不能全塞进 IPC，而「搜索某个基因」必须在全表上搜。
 */
function StepMarkers({
  scrnaId,
  progress,
  logs,
  beginRun,
  endRun,
  onError,
  onImported,
  onNext,
  dotText,
  onDotTextChange
}: StepMarkersProps): JSX.Element {
  /** 导出本步骤的图（png / pdf）——复制 R 已生成的那份 */
  const exportPlot = useScrnaExport(scrnaId)
  const [logfc, setLogfc] = useState('0.5')
  const [adjP, setAdjP] = useState('0.05')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScrnaMarkersResult | null>(null)
  const [plotId, setPlotId] = useState('')
  /**
   * 自选 DotPlot 的基因文本框的**值由页面级 state 持有**（见父组件 `dotGenesDraft`），
   * 这里只负责展示与回调。理由：导入外部对象会让本组件重挂载，内部 state 会归零，
   * 而用户「先填基因再导入」是很自然的顺序。
   *
   * 为什么是「算了才有图」而不是「点一下出图」：DotPlot 用的是 FindAllMarkers
   * 同一份 `data` 层，趁 R 还热着一次算完，比为了画图再起一次 R（读 200 MB 的
   * rds，40 秒）划算得多 —— 客户的 42 个基因也不值得开第二个进程。
   */
  /** 导入外部对象期间：所有参数输入禁用（导入完成会重挂载，期间改的东西会丢） */
  const [importBusy, setImportBusy] = useState(false)
  const locked = busy || importBusy
  /** 自选基因出图的结果（DotPlot + 小提琴，独立于 FindAllMarkers） */
  const [custom, setCustom] = useState<ScrnaCustomPlotsResult | null>(null)
  const [customBusy, setCustomBusy] = useState(false)

  // 表格：默认看每簇 top10；一旦搜索/选簇/显示全部，就走服务端查询
  const [search, setSearch] = useState('')
  const [cluster, setCluster] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [rows, setRows] = useState<ScrnaMarkerRow[] | null>(null)
  const [matched, setMatched] = useState(0)
  const [querying, setQuerying] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.markers({
          scrnaId,
          logfcThreshold: Number(logfc) || 0.5,
          adjPvalFilter: Number(adjP) || 0.05
        })
      )
      setResult(res)
      setPlotId(res.plots[0]?.id ?? '')
      setRows(null)
      setSearch('')
      setCluster('')
      setShowAll(false)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setBusy(false)
    }
  }, [scrnaId, logfc, adjP, beginRun, endRun, onError])

  /**
   * 自选基因出图：一次调用出两张（DotPlot + 小提琴）。
   *
   * 不走 `markers`：那要把 FindAllMarkers 重跑四分钟，而这两张图只依赖 `data` 层。
   * 基因全部不存在时 R 侧会 E_DATA_EMPTY（两张都不画），错误直接弹到页面级提示。
   */
  const drawCustom = useCallback(async () => {
    const genes = parseGeneList(dotText)
    if (!scrnaId || genes.length === 0) return
    setCustomBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(window.deg.scrna.customPlots({ scrnaId, genes }))
      setCustom(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setCustomBusy(false)
    }
  }, [scrnaId, dotText, beginRun, endRun, onError])

  const queryTable = useCallback(
    async (opts: { search: string; cluster: string; showAll: boolean }) => {
      if (!opts.search && !opts.cluster && !opts.showAll) {
        setRows(null) // 回到「每簇 top10」视图
        return
      }
      setQuerying(true)
      try {
        const res = await call(
          window.deg.scrna.markersTable({
            scrnaId,
            cluster: opts.cluster || undefined,
            search: opts.search || undefined,
            limit: 500,
            offset: 0
          })
        )
        setRows(res.rows)
        setMatched(res.matched)
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setQuerying(false)
      }
    },
    [scrnaId, onError]
  )

  // 搜索/过滤变化后 300ms 再查，避免每敲一个字符打一次 IPC
  useEffect(() => {
    if (!result) return undefined
    const t = setTimeout(() => void queryTable({ search, cluster, showAll }), 300)
    return () => clearTimeout(t)
  }, [search, cluster, showAll, result, queryTable])

  const download = useCallback(
    async (kind: 'sig' | 'top10' | 'rds', format: 'csv' | 'xlsx' = 'csv') => {
      setDownloading(true)
      try {
        if (kind === 'rds') {
          const outPath = await call(
            window.deg.system.saveFile({
              defaultName: 'obj_step5.rds',
              filters: [{ name: 'R 对象文件', extensions: ['rds'] }]
            })
          )
          if (!outPath) return
          await call(window.deg.scrna.exportObject({ scrnaId, outPath, file: 'obj_step5' }))
          return
        }
        // 文件名里带阈值 + 日期：同一次分析会为不同阈值导出好几份，默认名重复就没法分辨
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: markerExportName(
              kind,
              format,
              Number(result?.logfcThreshold ?? logfc) || 0.5,
              Number(result?.adjPvalFilter ?? adjP) || 0.05
            ),
            filters:
              format === 'csv'
                ? [{ name: 'CSV 表格', extensions: ['csv'] }]
                : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.scrna.exportMarkers({ scrnaId, outPath, table: kind, format }))
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setDownloading(false)
      }
    },
    [scrnaId, onError, result, logfc, adjP]
  )

  const current = result?.plots.find((p) => p.id === plotId) ?? result?.plots[0] ?? null

  return (
    <Stack spacing={2}>
      <ImportObjectPanel
        step={5}
        onImported={onImported}
        onError={onError}
        onImportingChange={setImportBusy}
      />
      {importBusy && (
        <Alert severity="info" sx={{ fontSize: 11 }}>
          正在导入对象（约 10 秒）：这段时间参数不可编辑。已经填好的基因与阈值都会保留，
          导入完成后直接点「开始计算 Marker」即可。
        </Alert>
      )}
      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 0.5 }}>
          5. Marker 基因
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
          FindAllMarkers（only.pos = FALSE，双层筛选：先 logfc.threshold 参与计算，再按
          |avg_log2FC| 与 p_val_adj 过一遍）。设好参数后点开始计算。
        </Typography>

        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            label="logFC 阈值"
            value={logfc}
            onChange={(e) => setLogfc(e.target.value)}
            disabled={locked}
            helperText="照你的脚本：logFCfilter = 0.5"
            sx={{ width: 200, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="adjP 阈值"
            value={adjP}
            onChange={(e) => setAdjP(e.target.value)}
            disabled={locked}
            helperText="照你的脚本：adjPvalFilter = 0.05"
            sx={{ width: 200, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <TextField
            size="small"
            label="min.pct"
            value="0.25"
            InputProps={{ readOnly: true }}
            helperText="客户脚本里写死 0.25，不可调"
            sx={{ width: 180, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0.5 } }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={locked || !scrnaId}
            onClick={() => void run()}
            // 不换行：旁边 min.pct 的说明文字一长，按钮会被压成两行（截图里发现的）
            sx={{ mt: 0.25, whiteSpace: 'nowrap', flex: '0 0 auto' }}
          >
            {busy ? '正在计算…' : '开始计算 Marker'}
          </Button>
        </Stack>

        {/*
          自选基因：**独立的一次出图调用**，不跟 FindAllMarkers 绑在一起。
          客户的原话是「输入基因 → 按一下 → 出两张图」，所以这里是一个「出图」按钮，
          换一组基因只需 20 秒，不必重跑四分钟的差异分析。
        */}
        <Box sx={{ p: 1.25, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography sx={{ fontSize: 11.5, fontWeight: 600 }}>
              自选基因（一次出两张：DotPlot + 小提琴）
            </Typography>
            <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
              两张图的颜色 = 细胞群颜色，与 UMAP 同一套
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              multiline
              minRows={3}
              maxRows={8}
              fullWidth
              /*
                客户第一次用很可能直接把脚本里那 42 个基因粘进来 —— 那是**蜗牛**的基因名
                （Claudin / NOS1 这类），而当前数据是水稻 `Os01g…`，一个都匹配不上。
                所以提示写在 placeholder 里（多行 textarea 会换行显示，不会被截断），
                并且把「这批数据是什么物种」直接说出来，不让他猜。
              */
              placeholder={
                '粘贴基因名，一行一个（空格 / 逗号分隔也行）。\n' +
                '注意：这批数据是水稻 Os01g…；如果你脚本里那批 Claudin / NOS1 是蜗牛的基因名，' +
                '在水稻数据里一个也找不到，那类名字只适合用在人 / 小鼠数据上。'
              }
              value={dotText}
              onChange={(e) => onDotTextChange(e.target.value)}
              disabled={locked}
              inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
            />
            <Stack spacing={0.5} sx={{ flex: '0 0 auto' }}>
              <Button
                size="small"
                variant="contained"
                sx={{ fontSize: 10.5, whiteSpace: 'nowrap' }}
                disabled={locked || !scrnaId || parseGeneList(dotText).length === 0}
                onClick={() => void drawCustom()}
              >
                {customBusy ? '正在出图…' : '出图'}
              </Button>
              <Button
                size="small"
                variant="outlined"
                sx={{ fontSize: 10.5, whiteSpace: 'nowrap' }}
                disabled={!result || locked}
                title={result ? '把每簇 top10 的基因一起填进来' : '先算一次 Marker，才有 top10 可用'}
                onClick={() => {
                  if (!result) return
                  const genes = Array.from(
                    new Set(result.perCluster.flatMap((c) => c.top10.map((t) => t.gene)))
                  )
                  onDotTextChange(genes.join(' '))
                }}
              >
                用各簇 top10 填充
              </Button>
              <Button
                size="small"
                variant="text"
                sx={{ fontSize: 10.5 }}
                disabled={!dotText || locked}
                onClick={() => onDotTextChange('')}
              >
                清空
              </Button>
            </Stack>
          </Stack>
          <Typography sx={{ fontSize: 10, color: 'text.disabled', mt: 0.5 }}>
            当前 {parseGeneList(dotText).length} 个基因
            {parseGeneList(dotText).length > 60 ? '（超过 60 个图会很宽，建议只挑关注的）' : ''}
            {!scrnaId && ' · 还没有对象：先算 Marker 或用上面的「从 rds 继续」导入'}
          </Typography>

          {customBusy && (
            <Box sx={{ mt: 1 }}>
              <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
                正在出图（约 20 秒）…（{Math.round(progress?.pct ?? 0)}%）
              </Typography>
            </Box>
          )}

          {custom && (
            <GeneDiagnostics missing={custom.missingGenes} stats={custom.geneStats} />
          )}

          {custom && custom.plots.length > 0 && (
            <Stack spacing={1.25} sx={{ mt: 1.25 }}>
              {custom.plots.map((p) => (
                <Box key={p.id}>
                  <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                    {p.caption}
                  </Typography>
                  {p.dataUrl ? (
                    <FigureImage
                      src={p.dataUrl}
                      alt={p.caption}
                      file={p.file}
                      onExport={p.file ? exportPlot(p.file) : undefined}
                    />
                  ) : (
                    <Box
                      sx={{
                        height: 120,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'text.disabled',
                        fontSize: 11,
                        border: '1px dashed',
                        borderColor: 'divider',
                        borderRadius: 1
                      }}
                    >
                      图未生成
                    </Box>
                  )}
                </Box>
              ))}
              <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                耗时 {(custom.durationMs / 1000).toFixed(1)} s · {custom.nCells.toLocaleString()} 细胞 ·{' '}
                {custom.nGroups} 个细胞群
              </Typography>
            </Stack>
          )}
        </Box>

        {busy && (
          <Box sx={{ mt: 1 }}>
            <LinearProgress variant="determinate" value={progress?.pct ?? 0} sx={{ height: 6, borderRadius: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
              {progress?.msg || '处理中'}（{Math.round(progress?.pct ?? 0)}%）
              {/FindAllMarkers/.test(progress?.msg ?? '') ? ' · 这一步可能要 3~10 分钟' : ''}
            </Typography>
            {logs.length > 0 && (
              <Box
                component="pre"
                sx={{
                  mt: 0.75, mb: 0, p: 0.75, maxHeight: 70, overflow: 'hidden',
                  bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider',
                  borderRadius: 1, fontSize: 10, lineHeight: 1.5,
                  fontFamily: 'monospace', whiteSpace: 'pre-wrap'
                }}
              >
                {logs.join('\n')}
              </Box>
            )}
          </Box>
        )}
      </Card>

      {result && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h3">Marker 结果</Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" startIcon={<DownloadIcon />} disabled={downloading} onClick={() => void download('sig', 'csv')}>
                全部 marker (csv)
              </Button>
              <Button size="small" variant="outlined" disabled={downloading} onClick={() => void download('sig', 'xlsx')}>
                Excel
              </Button>
              <Button size="small" variant="outlined" disabled={downloading} onClick={() => void download('top10', 'csv')}>
                top10 (csv)
              </Button>
              <Button size="small" variant="outlined" startIcon={<DownloadIcon />} disabled={downloading} onClick={() => void download('rds')}>
                下载对象 (rds)
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
            {[
              { label: 'cluster 数', value: String(result.nClusters) },
              { label: '显著 marker', value: result.sigMarkers.toLocaleString() },
              { label: 'FindAllMarkers 原始行', value: result.totalMarkers.toLocaleString() },
              { label: 'FindAllMarkers 耗时', value: `${result.findSeconds.toFixed(1)} s` },
              { label: '总耗时', value: `${(result.durationMs / 1000).toFixed(1)} s` }
            ].map((item) => (
              <Box key={item.label}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</Typography>
              </Box>
            ))}
          </Stack>

          {result.sigMarkers === 0 && (
            <Alert severity="warning" sx={{ mb: 1.5, fontSize: 11.5 }}>
              当前阈值下没有显著 marker（logFC &gt; {result.logfcThreshold} 且 padj &lt;{' '}
              {result.adjPvalFilter}）。建议放宽 logFC 或 FDR 后重算。
            </Alert>
          )}

          {result.plots.length > 0 && (
            <>
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                <TextField
                  select
                  size="small"
                  label="选择图"
                  value={plotId}
                  onChange={(e) => setPlotId(e.target.value)}
                  SelectProps={{ native: true }}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  sx={{ width: 420, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
                >
                  {result.plots.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.caption}
                    </option>
                  ))}
                </TextField>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  共 {result.plots.length} 张
                </Typography>
              </Stack>
              {current?.dataUrl ? (
                <FigureImage
                  src={current.dataUrl}
                  alt={current.caption}
                  file={current?.file ?? ''}
                  onExport={current?.file ? exportPlot(current.file) : undefined}
                />
              ) : (
                <Box sx={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 11, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                  图未生成
                </Box>
              )}
            </>
          )}

          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2, mb: 1 }}>
            <TextField
              size="small"
              placeholder="搜索基因名，如 Os01g0100100"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ width: 260, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            />
            <TextField
              select
              size="small"
              label="cluster"
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ width: 130, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
            >
              <option value="">全部</option>
              {result.clusters.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </TextField>
            <FormControlLabel
              control={<Switch size="small" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />}
              label={<Typography sx={{ fontSize: 11 }}>显示全部（默认只看每簇 top10）</Typography>}
            />
            {querying && <CircularProgress size={14} />}
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
              {rows
                ? `匹配 ${matched.toLocaleString()} 行，显示前 ${rows.length}`
                : `每簇 top10（共 ${result.perCluster.reduce((n, c) => n + c.top10.length, 0)} 行）`}
            </Typography>
          </Stack>

          <TableContainer sx={{ maxHeight: 360 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {['cluster', 'gene', 'avg_log2FC', 'p_val', 'p_val_adj', 'pct.1', 'pct.2'].map((h) => (
                    <TableCell key={h} sx={{ fontSize: 11 }} align={h === 'cluster' || h === 'gene' ? 'left' : 'right'}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {(rows ??
                  result.perCluster.flatMap((c) =>
                    c.top10.map((t) => ({
                      cluster: c.cluster,
                      gene: t.gene,
                      avgLog2FC: t.avgLog2FC,
                      pval: NaN,
                      pvalAdj: t.pvalAdj,
                      pct1: t.pct1,
                      pct2: t.pct2
                    }))
                  )
                ).map((r, i) => (
                  <TableRow key={`${r.cluster}-${r.gene}-${i}`} hover>
                    <TableCell sx={{ fontSize: 11.5 }}>{r.cluster}</TableCell>
                    <TableCell sx={{ fontSize: 11.5, fontFamily: 'monospace' }}>{r.gene}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{r.avgLog2FC.toFixed(3)}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">
                      {Number.isFinite(r.pval) ? r.pval.toExponential(2) : '—'}
                    </TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{r.pvalAdj.toExponential(2)}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{r.pct1.toFixed(2)}</TableCell>
                    <TableCell sx={{ fontSize: 11.5 }} align="right">{r.pct2.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
            <Button size="small" variant="outlined" sx={{ fontSize: 11 }} onClick={onNext}>
              下一步：细胞注释
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
              注释要用的 top10 就是这张表里的（水稻走人工填表 / 导入注释表）
            </Typography>
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

/* ------------------------------------------------------------------ *
 * 「已有中间对象？直接从 rds 继续」—— 第 4/5/6 步共用
 * ------------------------------------------------------------------ */

interface ImportObjectPanelProps {
  step: 4 | 5 | 6
  onImported: (result: ScrnaImportObjectResult) => void
  onError: (e: UiError | null) => void
  /**
   * 导入期间通知外层「别让用户改参数」。
   *
   * 为什么要这个：导入 200 MB 的 rds 要跑一次 R 检查 + 复制文件（约 10 秒），
   * 完成后 `activeScrnaId` 变了 → 步骤组件按 key 重挂载 → **这期间填进子组件 state 的
   * 内容会被清掉**。实测踩过：界面显示「当前 14 个基因」，主进程收到 0 个。
   * 现在的对策是两层：导入期间禁用输入 + 把草稿状态提到页面级（重挂载也不丢）。
   */
  onImportingChange?: (importing: boolean) => void
}

const STEP_INPUT_LABEL: Record<number, string> = {
  4: '第 3 步的对象（需含 pca / harmony 降维）',
  5: '第 4 步的对象（需含 clusters 列）',
  6: '第 5 步的对象（需含 clusters 列）'
}

/**
 * 默认收起：正常流程用不到它，展开会占掉半个屏幕。
 * 但对客户来说这条极有价值 —— 他每次验证不必从第 1 步重跑
 * （导入 45s + QC 20s + 标准化 90s + 聚类 160s + marker 240s）。
 */
function ImportObjectPanel({
  step,
  onImported,
  onError,
  onImportingChange
}: ImportObjectPanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [info, setInfo] = useState<ScrnaInspectResult | null>(null)
  const [importing, setImporting] = useState(false)

  const choose = useCallback(async () => {
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: 'R 对象文件', extensions: ['rds', 'RData', 'rda'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const file = picked[0]
      if (!file) return
      setPath(file)
      setInfo(null)
      onError(null)
      setInspecting(true)
      const res = await call(window.deg.scrna.inspectObject({ path: file, targetStep: step }))
      setInfo(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      setInspecting(false)
    }
  }, [step, onError])

  const apply = useCallback(async () => {
    if (!path) return
    setImporting(true)
    onImportingChange?.(true)
    onError(null)
    try {
      const res = await call(window.deg.scrna.importObject({ path, targetStep: step }))
      onImported(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      setImporting(false)
      onImportingChange?.(false)
    }
  }, [path, step, onImported, onError, onImportingChange])

  const missingText = (info?.missing ?? [])
    .map((m) => (m.includes('dim reduction') ? '降维结果（pca / harmony）' : m.includes('clusters') ? '聚类结果（clusters 列）' : m))
    .join('、')

  return (
    <Card variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'grey.50' }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ cursor: 'pointer' }}
        onClick={() => setOpen((v) => !v)}
      >
        <Typography sx={{ fontSize: 11 }}>{open ? '▾' : '▸'}</Typography>
        <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 600 }}>
          已有中间对象？直接从 rds 继续（跳过前面几步）
        </Typography>
      </Stack>

      {open && (
        <Box sx={{ mt: 1.25 }}>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
            本步骤需要的输入：{STEP_INPUT_LABEL[step]}。选完文件会先检查，不合格会直接告诉你缺什么。
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button size="small" variant="outlined" startIcon={<FolderOpenIcon />} onClick={() => void choose()}>
              {path ? '换一个 .rds' : '选择 .rds'}
            </Button>
            {inspecting && <CircularProgress size={14} />}
            {info && (
              <Button
                size="small"
                variant="contained"
                disabled={!info.ok || importing}
                onClick={() => void apply()}
              >
                {importing ? '导入中…' : '用这个对象继续'}
              </Button>
            )}
          </Stack>

          {path && (
            <Typography variant="body2" sx={{ mt: 0.75, fontSize: 10.5, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {path}
            </Typography>
          )}

          {info && (
            <Box sx={{ mt: 0.75 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                {info.nCells.toLocaleString()} 细胞 · {info.nGenes.toLocaleString()} 基因 ·
                降维 [{info.reductions.join(', ') || '无'}] · clusters{' '}
                {info.hasClusters ? `有（${info.clusterColumn}）` : '无'} ·
                物种猜测 {info.strain}
              </Typography>
              {!info.ok && (
                <Typography variant="body2" sx={{ fontSize: 10.5, color: 'error.main', mt: 0.5 }}>
                  不能作为本步骤的输入：缺少 {missingText}。
                  {step === 4 ? '请从第 3 步开始做。' : '请从第 4 步开始。'}
                </Typography>
              )}
              {info.ok && info.message !== 'ok' && (
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
                  提示：{info.message}
                </Typography>
              )}
            </Box>
          )}
        </Box>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * 第 6 步：细胞注释
 * ------------------------------------------------------------------ */

interface StepAnnotateProps {
  scrnaId: string
  progress: { pct: number; msg: string } | null
  logs: string[]
  beginRun: () => void
  endRun: () => void
  onError: (e: UiError | null) => void
  onImported: (r: ScrnaImportObjectResult) => void
  /** cluster → 细胞类型草稿（页面级 state：导入触发的重挂载不丢） */
  celltypes: Record<string, string>
  onCelltypesChange: (updater: (prev: Record<string, string>) => Record<string, string>) => void
}

/**
 * 第 6 步有两条路，默认是 A：
 *
 *   A. **人工注释**（客户这批走这条）：表格里逐簇填细胞类型，或导入他现成的
 *      `07.clusterAnn.txt`（两列、制表符、无表头）。水稻不能用 SingleR，
 *      因为 SingleR 只有人和鼠的参考集。
 *   B. **SingleR 自动**（人/鼠）：**只出建议**，回填到同一张表里，用户改完再应用。
 *
 * ## 为什么预览不起 R
 *
 * 表格要的是「簇 / 细胞数 / top10」，这三样第 5 步已经落盘了
 * （`cluster_summary.csv` + `markers_top10.csv`）。为了拼一张填表去读 200 MB 的
 * rds 是让用户白等 40 秒 —— 而填表这件事用户可能改五遍。
 *
 * ## 为什么应用时只传表格、不传文件路径
 *
 * R 侧「文件优先于 assignments」。如果两个都传，用户在表格里改过的值会被文件覆盖，
 * 表现为「改了没生效」。所以导入文件只用来**回填表格**，真正的落地值永远是表格。
 */
function StepAnnotate({
  scrnaId,
  progress,
  logs,
  beginRun,
  endRun,
  onError,
  onImported,
  celltypes,
  onCelltypesChange
}: StepAnnotateProps): JSX.Element {
  /** 导出本步骤的图（png / pdf）——复制 R 已生成的那份 */
  const exportPlot = useScrnaExport(scrnaId)
  const [preview, setPreview] = useState<ScrnaAnnotatePreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  /** 表格内容（受控，空串 = 用 cluster_N）：值在页面级，见 props 注释 */
  const [importBusy, setImportBusy] = useState(false)
  const [annotationFile, setAnnotationFile] = useState('')
  const [diff, setDiff] = useState<{ missing: string[]; extra: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  /** 计算中或导入中：两种情况都不允许改输入（导入完成会重挂载，改了会丢） */
  const locked = busy || importBusy
  const [result, setResult] = useState<ScrnaAnnotateResult | null>(null)
  const [plotId, setPlotId] = useState('')
  const [downloading, setDownloading] = useState(false)

  // ---- 基因查询（注释之后的三张图）----
  const [gqText, setGqText] = useState('')
  const [gqGroupBy, setGqGroupBy] = useState<'celltype' | 'clusters'>('celltype')
  const [gqSplit, setGqSplit] = useState('')
  const [gqBusy, setGqBusy] = useState(false)
  const [gq, setGq] = useState<ScrnaGeneQueryResult | null>(null)

  // ---- SingleR（人/鼠）----
  const [srOpen, setSrOpen] = useState(false)
  const [refRds, setRefRds] = useState('')
  const [labelColumn, setLabelColumn] = useState('')
  const [srBusy, setSrBusy] = useState(false)
  const [sr, setSr] = useState<ScrnaSingleRResult | null>(null)

  const loadPreview = useCallback(
    async (file?: string) => {
      if (!scrnaId) return
      setLoading(true)
      onError(null)
      try {
        const res = await call(
          window.deg.scrna.annotatePreview({
            scrnaId,
            annotationFile: file && file !== '' ? file : undefined
          })
        )
        setPreview(res)
        // 保留用户已输入的值：重新读一次预览不该把填了一半的表清空
        onCelltypesChange((prev) => {
          const next: Record<string, string> = {}
          for (const r of res.rows) next[r.cluster] = r.celltype || prev[r.cluster] || ''
          return next
        })
        setDiff(res.diff.missing.length > 0 || res.diff.extra.length > 0 ? res.diff : null)
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setLoading(false)
      }
    },
    [scrnaId, onError, onCelltypesChange]
  )

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const pickAnnotation = useCallback(async () => {
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '注释表（两列：cluster / celltype）', extensions: ['txt', 'tsv', 'csv'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const file = picked[0]
      if (!file) return
      setAnnotationFile(file)
      await loadPreview(file)
    } catch (err) {
      onError(toUiError(err))
    }
  }, [loadPreview, onError])

  const downloadTemplate = useCallback(async () => {
    setDownloading(true)
    onError(null)
    try {
      const outPath = await call(
        window.deg.system.saveFile({
          defaultName: 'clusterAnn.txt',
          filters: [{ name: '注释表（两列、制表符）', extensions: ['txt'] }]
        })
      )
      if (!outPath) return
      await call(window.deg.scrna.exportTemplate({ scrnaId, outPath }))
    } catch (err) {
      onError(toUiError(err))
    } finally {
      setDownloading(false)
    }
  }, [scrnaId, onError])

  const apply = useCallback(async () => {
    if (!preview) return
    setBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.annotate({
          scrnaId,
          assignments: preview.rows.map((r) => ({
            cluster: r.cluster,
            celltype: (celltypes[r.cluster] ?? '').trim()
          }))
        })
      )
      setResult(res)
      setPlotId(res.plots[0]?.id ?? '')
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setBusy(false)
    }
  }, [preview, celltypes, scrnaId, beginRun, endRun, onError])

  const downloadOutput = useCallback(
    async (kind: 'csv' | 'rds') => {
      setDownloading(true)
      onError(null)
      try {
        if (kind === 'rds') {
          const outPath = await call(
            window.deg.system.saveFile({
              defaultName: 'obj_step6.rds',
              filters: [{ name: 'R 对象文件', extensions: ['rds'] }]
            })
          )
          if (!outPath) return
          await call(window.deg.scrna.exportObject({ scrnaId, outPath, file: 'obj_step6' }))
        } else {
          const outPath = await call(
            window.deg.system.saveFile({
              defaultName: 'celltype_annotation.csv',
              filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
            })
          )
          if (!outPath) return
          await call(
            window.deg.scrna.exportSummary({ scrnaId, outPath, file: 'celltype_annotation' })
          )
        }
      } catch (err) {
        onError(toUiError(err))
      } finally {
        setDownloading(false)
      }
    },
    [scrnaId, onError]
  )

  /**
   * 基因查询：一次调用出三张图（FeaturePlot / 小提琴 / DotPlot）。
   *
   * 分组配色由 R 侧决定，界面只用返回的 palette 画图例 —— 颜色只有一份来源，
   * 否则「注释前的簇色」和「注释后的类型色」会各算一套，用户第一眼就发现对不上。
   */
  const runGeneQuery = useCallback(async () => {
    const genes = parseGeneList(gqText)
    if (!scrnaId || genes.length === 0) return
    setGqBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.geneQuery({ scrnaId, genes, groupBy: gqGroupBy, splitBy: gqSplit })
      )
      setGq(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setGqBusy(false)
    }
  }, [scrnaId, gqText, gqGroupBy, gqSplit, beginRun, endRun, onError])

  // ---- SingleR ----
  const pickRef = useCallback(async () => {
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            { name: '参考集对象', extensions: ['rds', 'RData', 'rda'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      const file = picked[0]
      if (!file) return
      setRefRds(file)
      setSr(null)
    } catch (err) {
      onError(toUiError(err))
    }
  }, [onError])

  const runSingleR = useCallback(async () => {
    setSrBusy(true)
    beginRun()
    onError(null)
    try {
      const res = await call(
        window.deg.scrna.singleRPreview({
          scrnaId,
          refRds,
          labelColumn: labelColumn.trim() || undefined
        })
      )
      setSr(res)
    } catch (err) {
      onError(toUiError(err))
    } finally {
      endRun()
      setSrBusy(false)
    }
  }, [scrnaId, refRds, labelColumn, beginRun, endRun, onError])

  /** 把 SingleR 的建议回填进表格；低置信度（pruned 为 NA）的簇不覆盖 */
  const adoptSingleR = useCallback(
    (all: boolean, cluster?: string) => {
      if (!sr) return
      onCelltypesChange((prev) => {
        const next = { ...prev }
        for (const s of sr.suggestions) {
          if (!all && s.cluster !== cluster) continue
          const low = s.pruned === '' || s.pruned === 'NA' || s.pruned === 'NaN'
          if (low) continue
          next[s.cluster] = s.celltype
        }
        return next
      })
    },
    [sr, onCelltypesChange]
  )

  const openLink = useCallback(
    async (url: string) => {
      try {
        await call(window.deg.system.openExternal({ url }))
      } catch (err) {
        onError(toUiError(err))
      }
    },
    [onError]
  )

  const current = result?.plots.find((p) => p.id === plotId) ?? result?.plots[0] ?? null
  const filled = preview ? preview.rows.filter((r) => (celltypes[r.cluster] ?? '').trim() !== '').length : 0
  const lowConfidence = sr
    ? sr.suggestions.filter((s) => s.pruned === '' || s.pruned === 'NA' || s.pruned === 'NaN').length
    : 0

  return (
    <Stack spacing={2}>
      <ImportObjectPanel
        step={6}
        onImported={onImported}
        onError={onError}
        onImportingChange={setImportBusy}
      />
      {importBusy && (
        <Alert severity="info" sx={{ fontSize: 11 }}>
          正在导入对象（约 10 秒）：这段时间表格不可编辑。已经填好的细胞类型会保留。
        </Alert>
      )}

      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 0.5 }}>
          6. 细胞注释
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
          给每个簇起一个细胞类型名。留空的簇会用 <code>cluster_编号</code> 占位
          （不报错，但下游图例里就是这个名字）。两个簇填同一个名字 = 合并成一类。
        </Typography>

        {!scrnaId && (
          <Alert severity="info" sx={{ fontSize: 11.5 }}>
            还没有可注释的对象。请先完成「Marker 基因」，或在下面展开「从 rds 继续」
            直接导入一份第 5 步的 <code>obj_step5.rds</code>。
          </Alert>
        )}

        {scrnaId && (
          <>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading || loading || locked}
                onClick={() => void downloadTemplate()}
              >
                导出注释模板
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<FolderOpenIcon />}
                disabled={loading || locked}
                onClick={() => void pickAnnotation()}
              >
                导入注释表
              </Button>
              <Button
                size="small"
                variant="text"
                sx={{ fontSize: 10.5 }}
                disabled={loading || locked}
                onClick={() => void loadPreview()}
              >
                重新读取
              </Button>
              {loading && <CircularProgress size={14} />}
              {annotationFile && (
                <Typography sx={{ fontSize: 10.5, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {annotationFile.split(/[\\/]/).pop()}
                </Typography>
              )}
            </Stack>

            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
              模板是两列、制表符、无表头（cluster + 空 celltype），和你们的
              <code> 07.clusterAnn.txt </code> 同一种格式 —— 填完直接能互相回填。
              导入也接受带表头或逗号分隔。
            </Typography>

            {diff && (
              <Alert severity="warning" sx={{ mb: 1.25, fontSize: 11 }}>
                注释表和对象对不上的地方（不阻断，你可以在表格里补）：
                {diff.missing.length > 0 && (
                  <>
                    <br />
                    对象里有、表里没有的簇：{diff.missing.join('、')}
                  </>
                )}
                {diff.extra.length > 0 && (
                  <>
                    <br />
                    表里有、对象里没有的簇：{diff.extra.join('、')}
                  </>
                )}
              </Alert>
            )}

            {preview ? (
              <>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="body2" sx={{ fontSize: 11 }}>
                    共 <strong>{preview.rows.length}</strong> 个簇，已填{' '}
                    <strong>{filled}</strong> 个
                  </Typography>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<PlayArrowIcon />}
                    disabled={locked || filled === 0}
                    onClick={() => void apply()}
                  >
                    {busy ? '正在应用…' : '应用注释'}
                  </Button>
                  {filled === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                      至少填一个细胞类型才能应用
                    </Typography>
                  )}
                </Stack>

                {busy && (
                  <Box sx={{ mb: 1.25 }}>
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
                          mt: 0.75, mb: 0, p: 0.75, maxHeight: 70, overflow: 'hidden',
                          bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider',
                          borderRadius: 1, fontSize: 10, lineHeight: 1.5,
                          fontFamily: 'monospace', whiteSpace: 'pre-wrap'
                        }}
                      >
                        {logs.join('\n')}
                      </Box>
                    )}
                  </Box>
                )}

                <TableContainer sx={{ maxHeight: 420 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontSize: 11, width: 70 }}>cluster</TableCell>
                        <TableCell sx={{ fontSize: 11, width: 90 }} align="right">
                          细胞数
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }}>top10 marker（判断细胞类型的依据）</TableCell>
                        <TableCell sx={{ fontSize: 11, width: 220 }}>细胞类型</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {preview.rows.map((row) => (
                        <TableRow key={row.cluster} hover>
                          <TableCell sx={{ fontSize: 11.5 }}>{row.cluster}</TableCell>
                          <TableCell sx={{ fontSize: 11.5 }} align="right">
                            {row.cells.toLocaleString()}
                          </TableCell>
                          <TableCell sx={{ fontSize: 10.5, fontFamily: 'monospace', color: 'text.secondary' }}>
                            {row.top10.map((t) => t.gene).join(' · ') || '（没有 marker 表，先跑第 5 步）'}
                          </TableCell>
                          <TableCell sx={{ py: 0.5 }}>
                            <TextField
                              size="small"
                              fullWidth
                              placeholder={`cluster_${row.cluster}`}
                              value={celltypes[row.cluster] ?? ''}
                              onChange={(e) =>
                                onCelltypesChange((prev) => ({
                                  ...prev,
                                  [row.cluster]: e.target.value
                                }))
                              }
                              disabled={locked}
                              inputProps={{ style: { fontSize: 11.5 } }}
                              sx={{ '& .MuiInputBase-root': { height: 28 } }}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            ) : (
              !loading && (
                <Alert severity="warning" sx={{ fontSize: 11.5 }}>
                  读不到聚类结果。这一步需要第 4 步的 <code>cluster_summary.csv</code> 或第 5 步的
                  <code> markers_top10.csv</code>。
                </Alert>
              )
            )}
          </>
        )}
      </Card>

      {/* ---------------- B. SingleR（人/鼠） ---------------- */}
      {scrnaId && (
        <Card variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ cursor: 'pointer' }}
            onClick={() => setSrOpen((v) => !v)}
          >
            <Typography sx={{ fontSize: 11 }}>{srOpen ? '▾' : '▸'}</Typography>
            <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 600 }}>
              B. SingleR 自动注释（仅人 / 鼠）
            </Typography>
            <Chip
              size="small"
              label="需要自备参考集"
              sx={{ height: 16, fontSize: 9.5, '& .MuiChip-label': { px: 0.6 } }}
            />
          </Stack>

          {srOpen && (
            <Box sx={{ mt: 1.25 }}>
              <Alert severity="info" sx={{ mb: 1.25, fontSize: 11 }}>
                水稻没有 SingleR 参考集（celldex 只有人 / 鼠），这批数据请用上面的
                「A. 人工注释」。人 / 鼠数据可以在这里跑：SingleR 按 <strong>簇</strong> 注释，
                结果只回填到上面的表格，你确认 / 改名后再点「应用注释」—— 不会直接写进对象。
              </Alert>

              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1 }}>
                参考集需要自备 <code>.rds</code>（celldex 的数据集在 R 里
                <code> saveRDS() </code> 存一下即可）。本软件不打包 celldex：它在 Windows /
                R 4.3 上没有二进制包，源码编译在客户机器上大概率失败。
                下载与说明：
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1.25, flexWrap: 'wrap' }}>
                <Button size="small" variant="text" sx={{ fontSize: 10.5 }} onClick={() => void openLink('https://bioconductor.org/packages/celldex/')}>
                  打开 celldex 页面
                </Button>
                <Button size="small" variant="text" sx={{ fontSize: 10.5 }} onClick={() => void openLink('https://bioconductor.org/packages/SingleR/')}>
                  打开 SingleR 页面
                </Button>
                <Button
                  size="small"
                  variant="text"
                  sx={{ fontSize: 10.5 }}
                  onClick={() => void openLink('https://bioconductor.org/help/workflows/simpleSingleCell/')}
                >
                  官方流程文档
                </Button>
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<FolderOpenIcon />}
                  disabled={locked}
                  onClick={() => void pickRef()}
                >
                  {refRds ? '换一个参考集' : '选择参考集 .rds'}
                </Button>
                <TextField
                  size="small"
                  label="标签列（可留空）"
                  placeholder="label.main"
                  value={labelColumn}
                  onChange={(e) => setLabelColumn(e.target.value)}
                  disabled={locked}
                  helperText="留空时自动找 label.main → label.fine"
                  sx={{ width: 200, '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
                  FormHelperTextProps={{ sx: { fontSize: 9.5, mx: 0.5 } }}
                />
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<PlayArrowIcon />}
                  disabled={!refRds || srBusy || locked}
                  onClick={() => void runSingleR()}
                >
                  {srBusy ? '正在运行…' : '运行 SingleR'}
                </Button>
                {srBusy && <CircularProgress size={14} />}
              </Stack>
              {refRds && (
                <Typography sx={{ fontSize: 10, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {refRds}
                </Typography>
              )}

              {sr && (
                <Box sx={{ mt: 1.25 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
                    <Typography variant="body2" sx={{ fontSize: 11 }}>
                      标签来源 <strong>{sr.refLabel}</strong> · {sr.nClusters} 个簇 · 耗时{' '}
                      {sr.singleRSeconds.toFixed(1)} s
                      {lowConfidence > 0 ? ` · ${lowConfidence} 个簇低置信度（不自动填）` : ''}
                    </Typography>
                    <Button size="small" variant="outlined" sx={{ fontSize: 10.5 }} onClick={() => adoptSingleR(true)}>
                      全部采纳
                    </Button>
                  </Stack>
                  <TableContainer sx={{ maxHeight: 260 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontSize: 11 }}>cluster</TableCell>
                          <TableCell sx={{ fontSize: 11 }}>SingleR 建议</TableCell>
                          <TableCell sx={{ fontSize: 11 }}>pruned</TableCell>
                          <TableCell sx={{ fontSize: 11 }} align="right">score</TableCell>
                          <TableCell sx={{ fontSize: 11, width: 80 }} />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {sr.suggestions.map((s) => (
                          <TableRow key={s.cluster} hover>
                            <TableCell sx={{ fontSize: 11.5 }}>{s.cluster}</TableCell>
                            <TableCell sx={{ fontSize: 11.5 }}>{s.celltype}</TableCell>
                            <TableCell sx={{ fontSize: 11, color: s.pruned === 'NA' ? 'error.main' : 'text.secondary' }}>
                              {s.pruned || '—'}
                            </TableCell>
                            <TableCell sx={{ fontSize: 11 }} align="right">
                              {Number.isFinite(s.score) ? s.score.toFixed(3) : '—'}
                            </TableCell>
                            <TableCell>
                              <Button size="small" sx={{ fontSize: 10 }} onClick={() => adoptSingleR(false, s.cluster)}>
                                采纳
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>
              )}
            </Box>
          )}
        </Card>
      )}

      {/* ---------------- 结果 ---------------- */}
      {result && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h3">注释结果</Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading}
                onClick={() => void downloadOutput('csv')}
              >
                注释表 (csv)
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={downloading}
                onClick={() => void downloadOutput('rds')}
              >
                下载对象 (rds)
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={3} sx={{ mb: 1.5 }}>
            {[
              { label: '细胞数', value: result.nCells.toLocaleString() },
              { label: '簇数', value: String(result.nClusters) },
              { label: '细胞类型数', value: String(result.nCelltypes) },
              { label: '合并的细胞类型', value: String(result.renamed) },
              { label: '未命名簇', value: String(result.unnamed) },
              { label: '耗时', value: `${(result.durationMs / 1000).toFixed(1)} s` }
            ].map((item) => (
              <Box key={item.label}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>
                  {item.value}
                </Typography>
              </Box>
            ))}
          </Stack>

          {result.celltypePalette.length > 0 && (
            <Box sx={{ mb: 1.5 }}>
              <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                配色（由簇色派生：一个类型取它<b>第一个簇</b>的颜色，所以注释前后对得上）
              </Typography>
              <Stack direction="row" spacing={1.25} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                {result.celltypePalette.map((e) => (
                  <Stack key={e.celltype} direction="row" spacing={0.5} alignItems="center">
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '2px',
                        bgcolor: e.color,
                        border: '1px solid',
                        borderColor: 'divider'
                      }}
                    />
                    <Typography sx={{ fontSize: 10.5 }}>
                      {e.celltype}
                      <Box component="span" sx={{ color: 'text.disabled', ml: 0.4 }}>
                        （簇 {e.fromClusters.join(',') || '—'}）
                      </Box>
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          {result.renamed > 0 && (
            <Alert severity="info" sx={{ mb: 1.5, fontSize: 11.5 }}>
              有 {result.renamed} 个细胞类型是由多个簇合并来的：
              {result.merged
                .map((m) => `${m.celltype} ← ${m.clusters.join(' + ')}`)
                .join('；')}
            </Alert>
          )}

          {result.unnamed > 0 && (
            <Alert severity="warning" sx={{ mb: 1.5, fontSize: 11.5 }}>
              {result.unnamed} 个簇没有命名，已用 <code>cluster_编号</code> 占位。
              下游图例会显示这个名字。
            </Alert>
          )}

          {result.plots.length > 0 && (
            <>
              <TextField
                select
                size="small"
                label="选择图"
                value={plotId}
                onChange={(e) => setPlotId(e.target.value)}
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                sx={{ width: 420, mb: 1, '& .MuiInputBase-root': { height: 32, fontSize: 12 } }}
              >
                {result.plots.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.caption}
                  </option>
                ))}
              </TextField>
              {current?.dataUrl ? (
                <FigureImage
                  src={current.dataUrl}
                  alt={current.caption}
                  file={current?.file ?? ''}
                  onExport={current?.file ? exportPlot(current.file) : undefined}
                />
              ) : (
                <Box
                  sx={{
                    height: 160,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'text.disabled',
                    fontSize: 11,
                    border: '1px dashed',
                    borderColor: 'divider',
                    borderRadius: 1
                  }}
                >
                  图未生成
                </Box>
              )}
            </>
          )}

          <Divider sx={{ my: 1.5 }} />
          <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10.5 }}>
            对象里保留了原有的 <code>clusters</code> 列（第 8/9 步还要按原始簇回溯），
            新增的是 <code>celltype</code> 列。
          </Typography>
        </Card>
      )}

      {/* ---------------- 基因查询（三张图） ---------------- */}
      {result && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h3" sx={{ mb: 0.5 }}>
            基因查询（一个按钮出三张图）
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, mb: 1.5 }}>
            FeaturePlot（空间表达）/ 小提琴（分布）/ DotPlot（比例 + 均值）。
            <b>FeaturePlot 的颜色是表达量高低</b>（浅灰 → 深红），不是细胞群色 ——
            这和 UMAP 的「颜色表示细胞群」不一样，是故意的：只有按表达量上色才看得出谁高谁低。
            另外两张图的颜色 = 分组色（与 UMAP 同一套）；按样本拆分时样本只做分面，不会变色。
          </Typography>

          <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 1 }}>
            <TextField
              size="small"
              multiline
              minRows={3}
              maxRows={8}
              fullWidth
              placeholder={
                '粘贴基因名，一行一个（空格 / 逗号分隔也行），例如：Os01g0100100 Os05g0455500'
              }
              value={gqText}
              onChange={(e) => setGqText(e.target.value)}
              disabled={locked}
              inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
            />
            <Stack spacing={0.75} sx={{ flex: '0 0 auto', width: 190 }}>
              <TextField
                select
                size="small"
                label="分组"
                value={gqGroupBy}
                onChange={(e) => setGqGroupBy(e.target.value as 'celltype' | 'clusters')}
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                disabled={locked}
                sx={{ '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
              >
                <option value="celltype">细胞类型</option>
                <option value="clusters">cluster（簇号）</option>
              </TextField>
              <TextField
                select
                size="small"
                label="拆分"
                value={gqSplit}
                onChange={(e) => setGqSplit(e.target.value)}
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                disabled={locked}
                sx={{ '& .MuiInputBase-root': { height: 30, fontSize: 11.5 } }}
              >
                <option value="">不拆分</option>
                <option value="orig.ident">按样本（orig.ident）</option>
              </TextField>
              <Button
                size="small"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={locked || gqBusy || parseGeneList(gqText).length === 0}
                onClick={() => void runGeneQuery()}
                sx={{ fontSize: 11, whiteSpace: 'nowrap' }}
              >
                {gqBusy ? '正在出图…' : '出图'}
              </Button>
            </Stack>
          </Stack>

          {gqSplit === 'orig.ident' && (
            <Alert severity="info" sx={{ mb: 1, fontSize: 11 }}>
              {preview && preview.samples.length > 3
                ? `共 ${preview.samples.length} 个样本：按样本拆分后每个基因会变成一组分面，图会非常大，建议先看单基因。`
                : '按样本拆分后每个基因会变成一组分面，样本多时图会很大，建议先用一两个基因看效果。'}
            </Alert>
          )}

          {gqBusy && (
            <Box sx={{ mb: 1 }}>
              <LinearProgress
                variant="determinate"
                value={progress?.pct ?? 0}
                sx={{ height: 6, borderRadius: 1 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
                正在出图（三张，约 10~30 秒）…（{Math.round(progress?.pct ?? 0)}%）
              </Typography>
            </Box>
          )}

          {gq && <GeneDiagnostics missing={gq.missingGenes} stats={gq.geneStats} />}

          {gq && gq.plots.length > 0 && (
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.25} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                  分组色（与 UMAP 同一套）：
                </Typography>
                {gq.palette.map((p) => (
                  <Stack key={p.group} direction="row" spacing={0.4} alignItems="center">
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '2px',
                        bgcolor: p.color,
                        border: '1px solid',
                        borderColor: 'divider'
                      }}
                    />
                    <Typography sx={{ fontSize: 10.5 }}>{p.group}</Typography>
                  </Stack>
                ))}
              </Stack>

              {gq.plots.map((p) => (
                <Box key={p.id}>
                  <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: 0.5 }}>
                    {p.caption}
                  </Typography>
                  {p.dataUrl ? (
                    <FigureImage
                      src={p.dataUrl}
                      alt={p.caption}
                      file={p.file}
                      onExport={p.file ? exportPlot(p.file) : undefined}
                    />
                  ) : (
                    <Box
                      sx={{
                        height: 120,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'text.disabled',
                        fontSize: 11,
                        border: '1px dashed',
                        borderColor: 'divider',
                        borderRadius: 1
                      }}
                    >
                      图未生成
                    </Box>
                  )}
                </Box>
              ))}
              <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                耗时 {(gq.durationMs / 1000).toFixed(1)} s · {gq.nCells.toLocaleString()} 细胞 ·{' '}
                {gq.nGroups} 个分组
                {gq.samples.length > 0 ? ` · 拆分样本 ${gq.samples.join(' / ')}` : ''}
              </Typography>
            </Stack>
          )}
        </Card>
      )}
    </Stack>
  )
}
