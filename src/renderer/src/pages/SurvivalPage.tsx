/**
 * 绘图模块 —— Kaplan-Meier 生存曲线（survminer::ggsurvplot）。
 *
 * ## 两种分组，客户要求都保留
 *
 *  - **用随访表里的分组列**：用户自己的分组（低/中/高危、分期、治疗臂），组数不限。
 *  - **按基因表达高低**：经典 KM-by-gene，选一个基因，按中位数 / 三分位 /
 *    四分位 / 最优截断切分。
 *
 * 两种模式需要的输入不同，所以下方的列映射区会跟着切换 —— 而不是把两套输入
 * 都摆出来让人自己判断哪个有用。
 *
 * ## 生存时间与状态必须显式确认
 *
 * 随访表的列名千奇百怪（`OS.time`、`随访月数`、`status`、`vital`）。
 * 自动探测给个初始值，但**必须让用户看得见并且能改**：把「随访时间」认成
 * 「年龄」画出来的 KM 曲线一样漂亮，只是完全没有意义。
 * 所以选完文件后把探测到的三列摊开显示，而不是藏在高级选项里。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { SurvivalOptions, VizInspectResult, VizPlotSpec, VizRenderRequest } from '@shared/types/viz'
import { PlotExportDialog, type ExportFormat } from '../components/result/PlotExportDialog'
import { SourceFileField } from '../components/viz/SourceFileField'
import { VizPreview } from '../components/viz/VizPreview'
import { call, normalizeError } from '../utils/ipc'

const PALETTES = [
  { value: 'lancet', label: 'Lancet' },
  { value: 'jco', label: 'JCO' },
  { value: 'npg', label: 'Nature (NPG)' },
  { value: 'aaas', label: 'AAAS' },
  { value: 'nejm', label: 'NEJM' },
  { value: 'd3', label: 'D3' },
  { value: 'Set1', label: 'Brewer Set1' },
  { value: 'Dark2', label: 'Brewer Dark2' },
  { value: '__custom__', label: '自定义色值' }
]

/** log-rank 权重：对应 survdiff 的 rho，也对应 survminer 的 log.rank.weights */
const LOG_RANK_WEIGHTS = [
  { value: '1', label: '标准 log-rank（Mantel-Haenszel）' },
  { value: '1,-1', label: 'Gehan-Wilcoxon（早期事件权重更高）' },
  { value: 'n', label: 'Tarone-Ware' },
  { value: 'n^2', label: 'Peto' },
  { value: 'FH', label: 'Fleming-Harrington' }
]

const CUT_METHODS = [
  { value: 'median', label: '按中位数（High / Low）' },
  { value: 'tertile', label: '按三分位（Low / Medium / High）' },
  { value: 'quartile', label: '按四分位（Q1~Q4）' },
  { value: 'optimal', label: '最优截断（maxstat）' }
]

export function SurvivalPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()

  const [clinicalPath, setClinicalPath] = useState('')
  const [clinicalInfo, setClinicalInfo] = useState<VizInspectResult | null>(null)
  const [groupBy, setGroupBy] = useState<SurvivalOptions['groupBy']>('table')

  const [timeColumn, setTimeColumn] = useState('')
  const [statusColumn, setStatusColumn] = useState('')
  const [groupColumn, setGroupColumn] = useState('')

  const [matrixPath, setMatrixPath] = useState('')
  const [matrixInfo, setMatrixInfo] = useState<VizInspectResult | null>(null)
  const [gene, setGene] = useState('')
  const [cutMethod, setCutMethod] = useState<SurvivalOptions['cutMethod']>('median')

  const [paletteChoice, setPaletteChoice] = useState('lancet')
  const [customColors, setCustomColors] = useState('#4C72B0,#DD8452,#55A868')
  const [confInt, setConfInt] = useState(true)
  const [pval, setPval] = useState(true)
  const [pvalMethod, setPvalMethod] = useState(true)
  const [logRankWeights, setLogRankWeights] = useState('1')
  const [riskTable, setRiskTable] = useState(true)
  const [riskTableHeight, setRiskTableHeight] = useState(0.25)
  const [xLabel, setXLabel] = useState('')
  const [yLabel, setYLabel] = useState('')
  const [title, setTitle] = useState('')

  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [lastExport, setLastExport] = useState<string | null>(null)

  // 探测到的列名自动填进三个下拉；用户改过之后不再覆盖（否则一换文件就被冲掉）
  useEffect(() => {
    if (!clinicalInfo) return
    setTimeColumn((prev) => prev || clinicalInfo.suggested.timeColumn || '')
    setStatusColumn((prev) => prev || clinicalInfo.suggested.statusColumn || '')
    setGroupColumn((prev) => prev || clinicalInfo.suggested.groupColumn || '')
  }, [clinicalInfo])

  const palette = paletteChoice === '__custom__' ? customColors : paletteChoice
  const geneOptions = useMemo(() => matrixInfo?.rowKeys ?? [], [matrixInfo])

  const columns = clinicalInfo?.columns ?? []
  const roleReady =
    Boolean(clinicalPath) && Boolean(timeColumn) && Boolean(statusColumn) &&
    (groupBy === 'gene' || Boolean(groupColumn))
  const ready = roleReady && (groupBy === 'table' || Boolean(matrixPath && gene))

  const build = useCallback(
    (size: { widthIn: number; heightIn: number }) => {
      if (!ready) return null
      void size
      return {
        kind: 'survival' as const,
        title: title || undefined,
        source: {
          clinicalPath,
          matrixPath: groupBy === 'gene' ? matrixPath : undefined
        },
        options: {
          groupBy,
          groupColumn: groupColumn || undefined,
          timeColumn: timeColumn || undefined,
          statusColumn: statusColumn || undefined,
          gene: groupBy === 'gene' ? gene : undefined,
          cutMethod: groupBy === 'gene' ? cutMethod : undefined,
          palette,
          confInt,
          pval,
          pvalMethod,
          logRankWeights,
          riskTable,
          riskTableHeight,
          xLabel: xLabel || undefined,
          yLabel: yLabel || undefined
        }
      } satisfies VizPlotSpec
    },
    [
      ready,
      clinicalPath,
      groupBy,
      groupColumn,
      timeColumn,
      statusColumn,
      gene,
      cutMethod,
      palette,
      confInt,
      pval,
      pvalMethod,
      logRankWeights,
      riskTable,
      riskTableHeight,
      xLabel,
      yLabel,
      title,
      matrixPath
    ]
  )

  const doExport = useCallback(
    async (format: ExportFormat, exportSize: { widthIn: number; heightIn: number; dpi: number }) => {
      setExportError(null)
      const request = build({ widthIn: exportSize.widthIn, heightIn: exportSize.heightIn })
      if (!request) return
      setExporting(true)
      try {
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `survival.${format}`,
            filters: [
              format === 'png'
                ? { name: 'PNG 图片', extensions: ['png'] }
                : { name: 'PDF 文档', extensions: ['pdf'] }
            ]
          })
        )
        if (!outPath) return
        await call(
          window.deg.viz.render({
            ...request,
            outPath,
            format,
            widthIn: exportSize.widthIn,
            heightIn: exportSize.heightIn,
            dpi: exportSize.dpi
          } as VizRenderRequest)
        )
        setLastExport(outPath)
        setExportOpen(false)
      } catch (err) {
        setExportError(normalizeError(err).message)
      } finally {
        setExporting(false)
      }
    },
    [build]
  )

  return (
    <Box sx={{ p: 3, maxWidth: 1520, mx: 'auto' }}>
      <Button
        size="small"
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(routes.module(omicsId))}
        sx={{ mb: 1.5 }}
      >
        返回模块
      </Button>

      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
            生存曲线
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Kaplan-Meier 曲线 · 支持两组以上 · 可按分组列或按基因表达分组
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={groupBy === 'gene' ? `按表达分组：${gene || '未选基因'}` : `按分组列：${groupColumn || '未选'}`}
          sx={{ height: 22, fontSize: 10.5 }}
        />
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)', gap: 2 }}>
        <Card variant="outlined" sx={{ p: 2, alignSelf: 'start' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
            数据
          </Typography>

          <SourceFileField
            label="选择随访表"
            value={clinicalPath}
            onChange={(path, info) => {
              setClinicalPath(path)
              setClinicalInfo(info)
              // 换文件后旧的列映射一定失效，清空让自动探测重新填
              setTimeColumn('')
              setStatusColumn('')
              setGroupColumn('')
            }}
            hint={
              clinicalInfo
                ? `${clinicalInfo.totalRows} 行，列：${clinicalInfo.columns.slice(0, 6).join(' / ')}${
                    clinicalInfo.columns.length > 6 ? ' …' : ''
                  }`
                : '至少含 样本 / 生存时间 / 结局状态 三列；按基因分组时可以不选分组列'
            }
          />

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            列映射
          </Typography>
          <Stack spacing={1}>
            <TextField
              select
              size="small"
              label="生存时间列"
              value={timeColumn}
              onChange={(event) => setTimeColumn(event.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
              fullWidth
            >
              <option value="">请选择</option>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="结局状态列（1=事件 0=删失）"
              value={statusColumn}
              onChange={(event) => setStatusColumn(event.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
              fullWidth
            >
              <option value="">请选择</option>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </TextField>
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            分组方式
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={groupBy}
            onChange={(_, value) => {
              if (value) setGroupBy(value)
            }}
            sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="table">用分组列</ToggleButton>
            <ToggleButton value="gene">按基因表达</ToggleButton>
          </ToggleButtonGroup>

          {groupBy === 'table' ? (
            <TextField
              select
              size="small"
              label="分组列"
              value={groupColumn}
              onChange={(event) => setGroupColumn(event.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mt: 1 }}
              fullWidth
            >
              <option value="">请选择</option>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </TextField>
          ) : (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <SourceFileField
                label="选择表达矩阵"
                value={matrixPath}
                onChange={(path, info) => {
                  setMatrixPath(path)
                  setMatrixInfo(info)
                  setGene('')
                }}
                hint={
                  matrixInfo
                    ? `${matrixInfo.rowKeyTotal} 个基因 × ${matrixInfo.totalColumns - 1} 个样本（列名须与随访表的 sample 列一致）`
                    : '行 = 基因，列 = 样本，第一列是基因 ID；列名必须和随访表的 sample 列对得上'
                }
              />
              <TextField
                select
                size="small"
                label="基因"
                value={gene}
                onChange={(event) => setGene(event.target.value)}
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
                fullWidth
              >
                <option value="">请选择基因</option>
                {geneOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </TextField>
              <Alert severity="info" sx={{ fontSize: 10.5 }}>
                矩阵的<strong>列名</strong>要和随访表的样本名逐一对上（按名字取交集，对不上的样本会被忽略）；切分只影响分组，不改动表达值。
              </Alert>
              <TextField
                select
                size="small"
                label="切分方式"
                value={cutMethod}
                onChange={(event) => setCutMethod(event.target.value as SurvivalOptions['cutMethod'])}
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
                fullWidth
              >
                {CUT_METHODS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </TextField>
            </Stack>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            ggsurvplot 选项
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <FormControlLabel
              control={<Switch size="small" checked={confInt} onChange={(e) => setConfInt(e.target.checked)} />}
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>置信区间</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={<Switch size="small" checked={pval} onChange={(e) => setPval(e.target.checked)} />}
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>P 值</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch size="small" checked={riskTable} onChange={(e) => setRiskTable(e.target.checked)} />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>risk table</Typography>}
              sx={{ m: 0 }}
            />
          </Stack>

          <TextField
            select
            size="small"
            label="log-rank 权重"
            value={logRankWeights}
            onChange={(event) => setLogRankWeights(event.target.value)}
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mt: 1 }}
            fullWidth
          >
            {LOG_RANK_WEIGHTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </TextField>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={pvalMethod}
                disabled={!pval}
                onChange={(e) => setPvalMethod(e.target.checked)}
              />
            }
            label={<Typography variant="body2" sx={{ fontSize: 12 }}>显示检验方法名</Typography>}
            sx={{ m: 0, mt: 0.5 }}
          />

          {riskTable && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                risk table 高度：{Math.round(riskTableHeight * 100)}%
              </Typography>
              <Slider
                size="small"
                min={0.1}
                max={0.45}
                step={0.05}
                value={riskTableHeight}
                onChange={(_, value) => setRiskTableHeight(value as number)}
              />
            </Box>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Stack spacing={1}>
            <TextField
              select
              size="small"
              label="配色"
              value={paletteChoice}
              onChange={(event) => setPaletteChoice(event.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
              fullWidth
            >
              {PALETTES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </TextField>
            {paletteChoice === '__custom__' && (
              <TextField
                size="small"
                label="色值（逗号分隔）"
                value={customColors}
                onChange={(event) => setCustomColors(event.target.value)}
                inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                fullWidth
              />
            )}
            <TextField
              size="small"
              label="x 轴标题（可空）"
              value={xLabel}
              onChange={(event) => setXLabel(event.target.value)}
              inputProps={{ style: { fontSize: 11.5 } }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              fullWidth
            />
            <TextField
              size="small"
              label="y 轴标题（可空）"
              value={yLabel}
              onChange={(event) => setYLabel(event.target.value)}
              inputProps={{ style: { fontSize: 11.5 } }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              fullWidth
            />
            <TextField
              size="small"
              label="图标题（可空）"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              inputProps={{ style: { fontSize: 11.5 } }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              fullWidth
            />
          </Stack>
        </Card>

        <Card variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0.5, mb: 1 }}>
            <Typography variant="h3">预览</Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={!ready || exporting}
              onClick={() => setExportOpen(true)}
              sx={{ height: 32 }}
            >
              导出图片…
            </Button>
          </Stack>

          <VizPreview
            build={build}
            deps={[
              clinicalPath,
              groupBy,
              groupColumn,
              timeColumn,
              statusColumn,
              matrixPath,
              gene,
              cutMethod,
              palette,
              confInt,
              pval,
              pvalMethod,
              logRankWeights,
              riskTable,
              riskTableHeight,
              xLabel,
              yLabel,
              title
            ]}
            height={580}
            emptyHint={
              ready ? '正在准备预览…' : '选择随访表并确认时间 / 状态列后自动出图'
            }
          />

          {exportError && (
            <Alert severity="error" sx={{ mt: 1, fontSize: 11.5 }}>
              {exportError}
            </Alert>
          )}

          {lastExport && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                已导出：{lastExport}
              </Typography>
              <Button
                size="small"
                onClick={() => void call(window.deg.system.revealPath({ path: lastExport }))}
                sx={{ fontSize: 11 }}
              >
                打开所在目录
              </Button>
            </Stack>
          )}
        </Card>
      </Box>

      <PlotExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onConfirm={(format, size) => void doExport(format, size)}
        busy={exporting}
      />
    </Box>
  )
}
