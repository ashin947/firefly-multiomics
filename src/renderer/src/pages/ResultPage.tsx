/**
 * 结果总览页（S4）：统计卡 + 火山图 + 结果表，阈值实时联动。
 *
 * 关键实现约束（§6.7 / PRD R-15）：
 *  - 结果一次性全量进内存，阈值变化**纯前端重算**，绝不重跑 R；
 *  - 统计卡、表格筛选、火山图着色三处调用同一个 `classify`（唯一实现），
 *    因此「火山图显著点数 == 表格行数」在数学上必然相等；
 *  - 阈值独立 store（拖滑块只重渲染真正读阈值的组件）。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { findModule } from '@shared/modules'
import { DEFAULT_OMICS_ID, LATEST_RUN, routes } from '@shared/routes'
import { ResultTable } from '../components/result/ResultTable'
import { ResultToolbar, type ExportScope } from '../components/result/ResultToolbar'
import { DEImportDialog } from '../components/result/DEImportDialog'
import { PlotExportDialog, type ExportFormat } from '../components/result/PlotExportDialog'
import { HeatmapPanel } from '../components/result/HeatmapPanel'
import { StatCards } from '../components/result/StatCards'
import type { DEResultRow } from '@shared/types/analysis'
import type { ExportSize } from '../components/charts/ChartHost'
import { presetColors, type VolcanoColors } from '../components/charts/VolcanoChart'
import { GgplotVolcanoPreview } from '../components/charts/GgplotVolcanoPreview'
import { CUSTOM_PALETTE, VolcanoPalettePicker } from '../components/charts/VolcanoPalettePicker'
import { paletteOf, usePlotTheme } from '../components/charts/plotTheme'
import { ThresholdSlider } from '../components/common/ThresholdSlider'
import { EmptyState } from '../components/common/EmptyState'
import { ErrorBanner } from '../components/common/ErrorBanner'
import { useThresholdFilter } from '../hooks/useThresholdFilter'
import { useAnalysisStore } from '../store/analysisStore'
import { useAppStore } from '../store/appStore'
import { useProjectStore } from '../store/projectStore'
import { usePlotDataStore } from '../store/plotDataStore'
import { call, normalizeError } from '../utils/ipc'
import { filterByThreshold } from '../utils/threshold'
import { formatDuration } from '../utils/formatting'

export function ResultPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID, runId = LATEST_RUN } = useParams<{ omicsId: string; runId: string }>()
  const moduleName = findModule(omicsId)?.name ?? '模块'
  const mock = useAppStore((s) => s.info?.mock === true)
  const meta = useProjectStore((s) => s.meta)
  const analysisRows = useAnalysisStore((s) => s.rows)
  const external = usePlotDataStore((s) => s.external)
  const clearExternal = usePlotDataStore((s) => s.clearExternal)
  /**
   * 页面渲染用哪份数据。
   *
   * ★ 外部导入优先，但**只影响这一个页面的显示**：
   *   `analysisRows` 本身、项目里的 de.csv、project.json 全都不动，点「切回分析结果」
   *   即完全恢复。这样「别人给的表想画个图」和「自己跑的分析」各自成立，互不污染。
   */
  const rows = external?.rows ?? analysisRows
  const snapshot = useAnalysisStore((s) => s.snapshot)
  const loadingResult = useAnalysisStore((s) => s.loadingResult)
  const error = useAnalysisStore((s) => s.error)
  const loadResult = useAnalysisStore((s) => s.loadResult)
  const loadMockResult = useAnalysisStore((s) => s.loadMockResult)
  const hoveredGene = useAnalysisStore((s) => s.hoveredGene)
  const setHoveredGene = useAnalysisStore((s) => s.setHoveredGene)

  const [search, setSearch] = useState('')
  const [onlySignificant, setOnlySignificant] = useState(false)
  const [toast, setToast] = useState<{ text: string; level: 'success' | 'error' } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const setExternal = usePlotDataStore((s) => s.setExternal)

  /**
   * 外部表导入完成。
   *
   * 抽成回调是必须的：**空状态分支和正常分支都要渲染同一个对话框**。
   * 之前只在正常分支渲染，导致「没跑过分析的用户点导入按钮毫无反应」——
   * 而那恰恰是最需要这个功能的人。
   */
  const handleImported = useCallback(
    (payload: { rows: DEResultRow[]; label: string; warnings: string[] }) => {
      setExternal(payload)
      setToast({
        text:
          payload.warnings.length > 0
            ? `已载入 ${payload.rows.length.toLocaleString()} 行。注意：${payload.warnings[0]}`
            : `已载入 ${payload.rows.length.toLocaleString()} 行，仅用于绘图。`,
        level: 'success'
      })
    },
    [setExternal]
  )

  /*
   * 阈值与统计放在下载/导出之前：`handleExport` 要用
   * `filterByThreshold(rows, thresholds, true)` 与界面同一判据筛行。
   *
   * ★ thresholds **只用 hook 返回的这一份**，页面不再自己拼一个。
   *   曾经验发生过：页面自己拼的带 basis、hook 里的不带 → 统计卡按 FDR 算、
   *   火山图按 P 值画，数字和图对不上。同一份数据只允许有一个阈值对象。
   */
  const { counts, thresholds } = useThresholdFilter(rows)

  // ---- 火山图配色 ----------------------------------------------------------
  const theme = usePlotTheme()
  const [paletteName, setPaletteName] = useState('red-blue')
  const [customColors, setCustomColors] = useState<VolcanoColors>({
    down: '#2166AC',
    ns: '#B0B7C3',
    up: '#B2182B'
  })
  // 切换预设时，把该预设的三色吸进 customColors：否则用户点「自定义」后
  // 色块会从红蓝突变成一组与刚才看到的不相干的颜色。
  const handlePaletteChange = useCallback(
    (name: string) => {
      if (name === CUSTOM_PALETTE) {
        const current = paletteOf(theme, paletteName)
        setCustomColors({
          down: current[0] ?? '#2166AC',
          ns: current[1] ?? '#B0B7C3',
          up: current[2] ?? '#B2182B'
        })
      }
      setPaletteName(name)
    },
    [theme, paletteName]
  )

  /**
   * 导出给 R 的三色。
   *
   * R 那边不认「配色名」，只认具体色值 —— 把「预设名 → 三色」的解析放在前端，
   * 保证导出的颜色和屏幕上选的是同一组（自定义时直接用用户调的色）。
   */
  const exportColors = useMemo(() => {
    if (paletteName === CUSTOM_PALETTE) return customColors
    return presetColors(paletteOf(theme, paletteName))
  }, [paletteName, customColors, theme])

  // ---- 下载 / 导出 ---------------------------------------------------------
  const [busy, setBusy] = useState<{ image: boolean; table: boolean }>({ image: false, table: false })
  const [exportOpen, setExportOpen] = useState(false)

  /*
   * 导出走 **R / ggplot2**（ARCHITECTURE §4.5 的分工：预览 ECharts、导出 R）。
   *
   * 为什么不再前端生成图片：前端 ECharts 出的是「数据可视化」，而投稿要的是
   * 「出版级排版」—— theme_bw 黑框、精确 pt 字号、真矢量 PDF。这些 ggplot2 更专业，
   * 而且 R 侧同一份脚本还能被将来的批量导出复用。
   *
   * 传给 R 的是**当前屏幕上这批行**：外部导入表没有项目文件，只能这样走。
   */
  const handleDownloadImage = useCallback(
    async (format: ExportFormat, size: ExportSize) => {
      if (!rows || rows.length === 0) {
        setToast({ text: '当前没有可导出的火山图。', level: 'error' })
        return
      }
      setBusy((prev) => ({ ...prev, image: true }))
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const baseName = `volcano-${snapshot?.label ?? 'de'}-${stamp}`.replace(/[\\/:*?"<>|]/g, '-')
        const outPath = await call(
          window.deg.system.saveFile(
            format === 'png'
              ? { defaultName: `${baseName}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] }
              : { defaultName: `${baseName}.pdf`, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] }
          )
        )
        // 用户在对话框点了取消 —— 这不是错误，静默返回
        if (!outPath) return

        const saved = await call(
          window.deg.plot.export({
            outPath,
            format,
            widthIn: size.widthIn,
            heightIn: size.heightIn,
            dpi: size.dpi,
            // 阈值带 basis：导出的判定口径必须和屏幕上一模一样
            thresholds,
            colors: exportColors,
            rows
          })
        )
        setToast({
          text: `已保存：${saved.outPath}（上调 ${saved.counts.up} / 下调 ${saved.counts.down}）`,
          level: 'success'
        })
      } catch (err) {
        setToast({ text: normalizeError(err).message, level: 'error' })
      } finally {
        setBusy((prev) => ({ ...prev, image: false }))
      }
    },
    [snapshot, rows, thresholds, exportColors]
  )

  const handleExport = useCallback(
    async (scope: ExportScope) => {
      if (!rows || rows.length === 0) return
      // ★ 用与统计卡、火山图同一个判据筛行（filterByThreshold → classify），
      //   否则「界面写 75 行、导出的 CSV 里 118 行」，用户会拿去当结论用。
      const data = scope === 'significant' ? filterByThreshold(rows, thresholds, true) : rows
      if (data.length === 0) {
        setToast({ text: '当前阈值下没有差异基因，可放宽阈值后再导出。', level: 'error' })
        return
      }
      setBusy((prev) => ({ ...prev, table: true }))
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const suffix = scope === 'significant' ? 'significant' : 'all'
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `DEG-${suffix}-${stamp}.csv`,
            filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
          })
        )
        if (!outPath) return
        await call(
          window.deg.export.table({
            kind: 'de',
            format: 'csv',
            // DEResultRow[] → 主进程按固定列顺序格式化，这里只做形状转换
            rows: data as unknown as Record<string, unknown>[],
            outPath
          })
        )
        setToast({ text: `已导出 ${data.length.toLocaleString()} 行到：${outPath}`, level: 'success' })
      } catch (err) {
        setToast({ text: normalizeError(err).message, level: 'error' })
      } finally {
        setBusy((prev) => ({ ...prev, table: false }))
      }
    },
    [rows, thresholds]
  )

  // 进入页面时确保有数据：演示模式造数据，否则加载路径里指定的那次分析。
  // `runId === latest` 表示「当前活动分析」，否则按真实 runId 精确加载 ——
  // 这样从「最近任务」点历史结果不会看到上一次的行数据。
  const loadedRunRef = useRef<string | null>(null)
  useEffect(() => {
    if (mock) {
      if (!analysisRows || analysisRows.length === 0) loadMockResult()
      return
    }
    const target =
      runId === LATEST_RUN
        ? meta?.activeAnalysisId ?? meta?.analyses[meta.analyses.length - 1]?.id
        : runId
    if (!target) return
    if (loadedRunRef.current === target) return
    loadedRunRef.current = target
    void loadResult(target)
  }, [mock, runId, meta, analysisRows, loadMockResult, loadResult])

  // 表格可见行：先按显著性，再按搜索词（搜索只匹配基因名/ID）
  const visibleRows = useMemo(() => {
    if (!rows) return []
    const base = onlySignificant ? filterByThreshold(rows, thresholds, true) : rows
    const keyword = search.trim().toLowerCase()
    if (!keyword) return base
    return base.filter(
      (row) =>
        (row.geneName ?? '').toLowerCase().includes(keyword) || row.geneId.toLowerCase().includes(keyword)
    )
  }, [rows, thresholds, onlySignificant, search])

  if (!rows || rows.length === 0) {
    return (
      <Box sx={{ p: 4 }}>
        {error ? (
          <ErrorBanner error={error} />
        ) : (
          <>
            <EmptyState
              title={loadingResult ? '正在加载结果…' : '还没有差异分析结果'}
              description="先运行一次差异表达分析，结果会在这里展示：统计卡、火山图与 9 字段结果表。"
              actionLabel="去配置分析"
              onAction={() => navigate(routes.analysis(omicsId, 'de'))}
            />
            {/*
              第二条路径：用户手上已经有别的工具算好的差异表（GEO / 公司报告 / 文献附表），
              只想画个火山图。以前这种用户在这个页面是死路 —— 必须先跑一遍分析才看得到图。
              这里给一个等价入口，且明确写着「不影响分析结果」。
            */}
            {!loadingResult && (
              <>
                <Stack alignItems="center" sx={{ mt: -1 }}>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={<TableChartOutlinedIcon sx={{ fontSize: 15 }} />}
                    onClick={() => setImportOpen(true)}
                  >
                    已有差异结果表？直接导入来画图
                  </Button>
                </Stack>
                {/* 对话框必须在这里也渲染：没跑过分析的用户正是最需要它的人 */}
                <DEImportDialog
                  open={importOpen}
                  onClose={() => setImportOpen(false)}
                  onImported={handleImported}
                />
              </>
            )}
          </>
        )}
      </Box>
    )
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1360, mx: 'auto' }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(routes.module(omicsId))} sx={{ mb: 1.5 }}>
        返回{moduleName}模块
      </Button>

      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
            差异分析结果
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body1" color="text.secondary">
              {external ? external.label : snapshot?.label ?? '差异分析'}
            </Typography>
            {/*
              数据来源必须一眼可见。用户切到外部表之后很容易忘了当前看的不是自己跑的
              分析结果 —— 这个 chip 就是那个提醒，同时给一条回到分析结果的路。
            */}
            {external ? (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label="外部表格（仅绘图）"
                onDelete={clearExternal}
                sx={{ height: 20, fontSize: 10.5 }}
              />
            ) : (
              snapshot && (
                <>
                  <Chip size="small" variant="outlined" label={`耗时 ${formatDuration(snapshot.durationMs)}`} sx={{ height: 20, fontSize: 10.5 }} />
                  <Chip size="small" variant="outlined" label={`方法 ${snapshot.method}`} sx={{ height: 20, fontSize: 10.5 }} />
                </>
              )
            )}
            {mock && <Chip size="small" color="warning" variant="outlined" label="演示数据" sx={{ height: 20, fontSize: 10.5 }} />}
          </Stack>
        </Box>
        <Button size="small" variant="outlined" onClick={() => navigate(routes.analysis(omicsId, 'de'))}>
          重新分析
        </Button>
      </Stack>

      <Box sx={{ mb: 2 }}>
        <StatCards counts={counts} thresholds={thresholds} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 2, mb: 2 }}>
        <Card variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
            spacing={1}
            sx={{ px: 0.5, mb: 0.75 }}
          >
            <Stack direction="row" spacing={1.5} alignItems="baseline">
              <Typography variant="h3">火山图</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                上调 {counts.up.toLocaleString()} · 下调 {counts.down.toLocaleString()} · 不显著{' '}
                {counts.ns.toLocaleString()}
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              <Tooltip title="导入别的工具算好的差异表来画图；不会影响项目里的分析结果">
                <span>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={<TableChartOutlinedIcon sx={{ fontSize: 15 }} />}
                    onClick={() => setImportOpen(true)}
                    sx={{ height: 32, whiteSpace: 'nowrap' }}
                  >
                    导入表格
                  </Button>
                </span>
              </Tooltip>
              <VolcanoPalettePicker
                value={paletteName}
                onChange={handlePaletteChange}
                colors={customColors}
                onColorsChange={setCustomColors}
                disabled={busy.image}
              />
              <Tooltip title="导出当前配色与阈值下的火山图">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ImageOutlinedIcon sx={{ fontSize: 15 }} />}
                    disabled={busy.image}
                    onClick={() => setExportOpen(true)}
                    sx={{ height: 32, whiteSpace: 'nowrap' }}
                  >
                    {busy.image ? '导出中…' : '下载图片'}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Stack>

          {/*
            预览走 R/ggplot2（与导出同一个脚本），所以它是一张静态图：
            没有 hover 联动，改阈值后要等约 1 秒重绘。
            代价换来的是一一「屏幕上看到的就是导出的样子」。
          */}
          <GgplotVolcanoPreview
            rows={rows}
            thresholds={thresholds}
            colors={exportColors}
            height={360}
          />
        </Card>

        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h3" sx={{ mb: 1.5 }}>
            阈值设置
          </Typography>
          <ThresholdSlider />
          <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.75 }}>
              阈值调整只影响显示与着色，不会重新运行分析。表格、统计卡与火山图使用同一个判定函数。
            </Typography>
          </Box>
        </Card>
      </Box>

      {/* 热图：与火山图并列的第二张图，参数与数据源都自包含在组件里 */}
      <HeatmapPanel rows={rows} thresholds={thresholds} />

      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h3" sx={{ mb: 1 }}>
          结果表
        </Typography>
        <ResultToolbar
          search={search}
          onSearch={setSearch}
          onlySignificant={onlySignificant}
          onOnlySignificant={setOnlySignificant}
          visibleCount={visibleRows.length}
          totalCount={rows.length}
          significantCount={counts.up + counts.down}
          onExport={(scope) => void handleExport(scope)}
          exportDisabled={!rows || rows.length === 0}
          exporting={busy.table}
        />
        <ResultTable
          rows={visibleRows}
          thresholds={thresholds}
          hoveredGene={hoveredGene}
          onHoverGene={(geneId) => setHoveredGene(geneId)}
          maxHeight={400}
        />
      </Card>

      <DEImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={handleImported} />

      <PlotExportDialog
        open={exportOpen}
        busy={busy.image}
        onClose={() => setExportOpen(false)}
        onConfirm={(format, size) => {
          setExportOpen(false)
          void handleDownloadImage(format, size)
        }}
      />

      {/*
        下载/导出的反馈。用 Snackbar 而不是对话框：保存成功是个「知道了」级别的信息，
        弹模态框会打断用户继续调阈值。失败也用同一条通道，但换成 error 配色 ——
        两条路径都不要静默，否则用户点了「下载图片」没反应会以为软件卡死。
      */}
      <Snackbar
        open={toast !== null}
        autoHideDuration={toast?.level === 'success' ? 4000 : 8000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.level ?? 'success'} variant="filled" onClose={() => setToast(null)} sx={{ fontSize: 12.5 }}>
          {toast?.text}
        </Alert>
      </Snackbar>
    </Box>
  )
}
