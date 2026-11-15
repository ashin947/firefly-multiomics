/**
 * 差异基因热图面板（pheatmap）。
 *
 * 自包含：参数状态、预览、导出都在这里，结果页只需要塞一个 `<HeatmapPanel>`。
 * 之所以不塞进结果页主组件：热图的参数有十几个，混进 ResultPage 会让那个
 * 已经 400 多行的文件彻底失控。
 *
 * ## 两条选基因的路径（客户明确要求）
 *
 *  1. **自动 Top N**：按当前阈值筛显著基因，FDR 升序取前 N（默认 40）。
 *     阈值和结果页共用同一个 store —— 上面拖滑块，这里的热图跟着变。
 *  2. **自定义列表**：粘贴基因名/ID，**完全忽略 Top N**。
 *     场景是「文献里这 30 个基因，我想看看它们在我数据里的模式」，
 *     这些基因可能根本不显著，所以不能被 Top N 过滤掉。
 */
import DownloadIcon from '@mui/icons-material/FileDownloadOutlined'
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useCallback, useMemo, useState } from 'react'
import type { DEResultRow, ThresholdState } from '@shared/types/analysis'
import type { HeatmapPlotConfig } from '@shared/types/ipc-contract'
import { GgplotHeatmapPreview } from '../charts/GgplotHeatmapPreview'
import { DEImportDialog } from './DEImportDialog'
import { usePlotDataStore } from '../../store/plotDataStore'
import { PlotExportDialog, type ExportFormat } from './PlotExportDialog'
import type { ExportSize } from '../charts/ChartHost'
import { call, normalizeError } from '../../utils/ipc'

/** 常见的 pheatmap 渐变色板（低 → 中 → 高） */
const COLOR_PRESETS: { name: string; low: string; mid: string; high: string }[] = [
  { name: '蓝-白-红', low: '#2166AC', mid: '#FFFFFF', high: '#B2182B' },
  { name: '蓝-黄-红', low: '#4575B4', mid: '#FFFFBF', high: '#D73027' },
  { name: '白-红（单色）', low: '#FFFFFF', mid: '#FDDBC7', high: '#B2182B' },
  { name: 'Viridis', low: '#440154', mid: '#21918C', high: '#FDE725' }
]

const DEFAULT_CONFIG: HeatmapPlotConfig = {
  geneList: [],
  topN: 40,
  clusterRows: true,
  clusterCols: true,
  scale: 'row',
  showGeneNames: true,
  showSampleNames: true,
  showGroupAnnotation: true,
  colors: { low: COLOR_PRESETS[0].low, mid: COLOR_PRESETS[0].mid, high: COLOR_PRESETS[0].high }
}

/** 把用户粘贴的文本拆成基因列表（逗号 / 空格 / 换行都算分隔符） */
export function parseGeneList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
}

interface HeatmapPanelProps {
  rows: readonly DEResultRow[]
  thresholds: ThresholdState
}

export function HeatmapPanel({ rows, thresholds }: HeatmapPanelProps): JSX.Element {
  const [config, setConfig] = useState<HeatmapPlotConfig>(DEFAULT_CONFIG)
  const [listText, setListText] = useState('')
  const [mode, setMode] = useState<'top' | 'list'>('top')
  const [refreshKey, setRefreshKey] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const setExternal = usePlotDataStore((s) => s.setExternal)
  const external = usePlotDataStore((s) => s.external)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  /** 最终生效的配置：列表模式的名单从 textarea 解析后覆盖上去 */
  const effectiveConfig = useMemo<HeatmapPlotConfig>(() => {
    const genes = mode === 'list' ? parseGeneList(listText) : []
    return { ...config, geneList: genes }
  }, [config, mode, listText])

  const geneCount = effectiveConfig.geneList.length

  const patch = useCallback((next: Partial<HeatmapPlotConfig>) => {
    setConfig((prev) => ({ ...prev, ...next }))
  }, [])

  const handleExport = useCallback(
    async (format: ExportFormat, size: ExportSize) => {
      setExporting(true)
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile(
            format === 'png'
              ? {
                  defaultName: `heatmap-${stamp}.png`,
                  filters: [{ name: 'PNG 图片', extensions: ['png'] }]
                }
              : {
                  defaultName: `heatmap-${stamp}.pdf`,
                  filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
                }
          )
        )
        if (!outPath) return
        const result = await call(
          window.deg.plot.exportHeatmap({
            rows: rows as DEResultRow[],
            thresholds,
            ...effectiveConfig,
            widthIn: size.widthIn,
            heightIn: size.heightIn,
            dpi: size.dpi,
            outPath,
            format
          })
        )
        setToast(`已导出 ${result.genes} 个基因 × ${result.samples} 个样本：${result.outPath}`)
      } catch (err) {
        setToast(normalizeError(err).message)
      } finally {
        setExporting(false)
      }
    },
    [rows, thresholds, effectiveConfig]
  )

  return (
    <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0.5, mb: 1 }}>
        <Stack direction="row" spacing={1.5} alignItems="baseline">
          <Typography variant="h3">差异基因热图</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
            pheatmap ·{' '}
            {external ? `外部表 ${external.label} · ` : ''}
            {mode === 'list'
              ? geneCount > 0
                ? `自定义 ${geneCount} 个基因`
                : '请粘贴基因列表'
              : `Top ${config.topN}`}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          {/*
            热图这里也放一个导入入口。
            火山图那边导入后热图同样跟着换（共用 plotDataStore），
            但如果用户是直接滚到热图来看的，不该再让他滚回顶部才能导入。
          */}
          <Tooltip title="导入别的工具算好的差异表，用其中的基因来画热图">
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
          <Tooltip title="按当前参数导出 PNG / PDF">
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon sx={{ fontSize: 15 }} />}
                disabled={exporting || rows.length === 0}
                onClick={() => setExportOpen(true)}
                sx={{ height: 32 }}
              >
                {exporting ? '导出中…' : '导出热图'}
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 2 }}>
        <Box sx={{ minWidth: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
          <GgplotHeatmapPreview
            rows={rows}
            thresholds={thresholds}
            config={effectiveConfig}
            height={460}
            refreshKey={refreshKey}
          />
        </Box>

        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            基因来源
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={mode}
            onChange={(_, value) => {
              if (value) setMode(value)
            }}
            sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="top">自动 Top N</ToggleButton>
            <ToggleButton value="list">自定义列表</ToggleButton>
          </ToggleButtonGroup>

          {mode === 'top' ? (
            <Box sx={{ mt: 1.25 }}>
              <TextField
                size="small"
                type="number"
                label="基因数（按 FDR 升序取前 N）"
                value={config.topN}
                onChange={(event) => patch({ topN: Math.max(1, Number(event.target.value) || 1) })}
                inputProps={{ min: 1, max: 500, step: 10, style: { fontSize: 12 } }}
                InputLabelProps={{ sx: { fontSize: 11 } }}
                fullWidth
              />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5, lineHeight: 1.5 }}>
                只取当前阈值下显著的基因。上面拖阈值，这里跟着变。
              </Typography>
            </Box>
          ) : (
            <Box sx={{ mt: 1.25 }}>
              <TextField
                multiline
                minRows={3}
                maxRows={6}
                size="small"
                placeholder="TP53, EGFR, MYC…（逗号/空格/换行分隔）"
                value={listText}
                onChange={(event) => setListText(event.target.value)}
                inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
                fullWidth
              />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5, lineHeight: 1.5 }}>
                这里列出的基因<strong>不受 Top N 与显著性限制</strong>；矩阵里不存在的会被跳过。
              </Typography>
            </Box>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            聚类与标准化
          </Typography>
          <Stack spacing={0.25}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={config.clusterRows}
                  onChange={(event) => patch({ clusterRows: event.target.checked })}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>行聚类（基因）</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={config.clusterCols}
                  onChange={(event) => patch({ clusterCols: event.target.checked })}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>列聚类（样本）</Typography>}
              sx={{ m: 0 }}
            />
          </Stack>

          <TextField
            select
            size="small"
            label="标准化（scale）"
            value={config.scale}
            onChange={(event) => patch({ scale: event.target.value as HeatmapPlotConfig['scale'] })}
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ mt: 1, '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
            helperText={
              config.scale === 'row'
                ? '按基因标准化，突出每个基因在样本间的相对高低（最常用）'
                : config.scale === 'column'
                  ? '按样本标准化'
                  : '用原始表达值，高低表达相差大的基因会主导颜色'
            }
            FormHelperTextProps={{ sx: { fontSize: 10, mx: 0, lineHeight: 1.4 } }}
          >
            <option value="row">row（按基因）</option>
            <option value="column">column（按样本）</option>
            <option value="none">none（原始值）</option>
          </TextField>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            配色
          </Typography>
          <TextField
            select
            size="small"
            value={COLOR_PRESETS.findIndex(
              (p) => p.low === config.colors.low && p.high === config.colors.high
            )}
            onChange={(event) => {
              const preset = COLOR_PRESETS[Number(event.target.value)]
              if (preset) patch({ colors: { low: preset.low, mid: preset.mid, high: preset.high } })
            }}
            SelectProps={{ native: true }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          >
            {COLOR_PRESETS.map((preset, index) => (
              <option key={preset.name} value={index}>
                {preset.name}
              </option>
            ))}
            <option value={-1}>自定义…</option>
          </TextField>
          <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} alignItems="center">
            {(['low', 'mid', 'high'] as const).map((key) => (
              <Box key={key} sx={{ textAlign: 'center' }}>
                <Typography variant="body2" sx={{ fontSize: 10, color: 'text.secondary' }}>
                  {key === 'low' ? '低' : key === 'mid' ? '中' : '高'}
                </Typography>
                <Box
                  component="input"
                  type="color"
                  value={config.colors[key]}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    patch({ colors: { ...config.colors, [key]: event.target.value } })
                  }
                  sx={{
                    width: 34,
                    height: 22,
                    p: 0,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 0.75,
                    cursor: 'pointer',
                    backgroundColor: 'transparent',
                    '&::-webkit-color-swatch-wrapper': { p: 0 },
                    '&::-webkit-color-swatch': { border: 'none', borderRadius: '2px' }
                  }}
                />
              </Box>
            ))}
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            显示项
          </Typography>
          <Stack spacing={0.25}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={config.showGeneNames}
                  onChange={(event) => patch({ showGeneNames: event.target.checked })}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>基因名</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={config.showSampleNames}
                  onChange={(event) => patch({ showSampleNames: event.target.checked })}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>样本名</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={config.showGroupAnnotation}
                  onChange={(event) => patch({ showGroupAnnotation: event.target.checked })}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>分组注释条（列）</Typography>}
              sx={{ m: 0 }}
            />
          </Stack>

          <Button
            size="small"
            variant="text"
            fullWidth
            onClick={() => setRefreshKey((k) => k + 1)}
            sx={{ mt: 1, fontSize: 11 }}
          >
            重新绘制
          </Button>

          {toast && (
            <Typography
              variant="body2"
              sx={{ fontSize: 10.5, mt: 1, color: 'success.main', wordBreak: 'break-all' }}
            >
              {toast}
            </Typography>
          )}
        </Box>
      </Box>

      <DEImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(payload) => {
          setExternal(payload)
          setToast(`已载入 ${payload.rows.length.toLocaleString()} 行，热图将使用其中的基因`)
        }}
      />

      <PlotExportDialog
        open={exportOpen}
        busy={exporting}
        onClose={() => setExportOpen(false)}
        onConfirm={(format, size) => {
          setExportOpen(false)
          void handleExport(format, size)
        }}
      />
    </Card>
  )
}
