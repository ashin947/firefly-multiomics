/**
 * 绘图模块 —— 分面小提琴 / 箱线 / 蜂群图。
 *
 * ## 数据怎么进 R
 *
 * 只传**文件路径**：表达矩阵可能有几千基因 × 上百样本，序列化成 JSON 走 IPC
 * 再让 R 重建一遍毫无意义。界面需要基因名时走只读的 `viz.inspectSource`。
 *
 * ## 为什么 FDR 的校正范围要写在界面上
 *
 * 每个基因的每对分组都做一次检验，一张图 20 个基因 × 3 组就有 60 次比较。
 * 「在每个基因内部校正」和「在整张图范围内校正」得到的 FDR 差一个数量级，
 * 而图上只显示一个数字 —— 不说清楚，用户没法在方法学里写对。
 * 所以这里固定按「所有基因 × 所有两两比较」统一 BH 校正，并在界面上写出来。
 */
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { VizInspectResult, VizPlotSpec, VizRenderRequest, ViolinOptions } from '@shared/types/viz'
import { PlotExportDialog, type ExportFormat } from '../components/result/PlotExportDialog'
import { SourceFileField } from '../components/viz/SourceFileField'
import { VizPreview } from '../components/viz/VizPreview'
import { call, normalizeError } from '../utils/ipc'

/** ggsci / RColorBrewer 里常用的几套，名字直接传给 R 的 resolve_palette */
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

const MAX_GENES = 60

/**
 * 把用户输入的一段文本拆成基因名。
 *
 * Autocomplete 在 `freeSolo` 下按回车只会把**整段**当成一个值提交：
 * 用户粘贴 "RB1 CDKN2A ALK" 回车，得到的是一个名字里带空格的「基因」，
 * 而 R 侧按这个名字去矩阵里查必然查不到 —— 表现是「选了一堆基因但不出图」。
 * 所以每次提交都按空白/逗号/分号拆开，去空去重再截断。
 */
function normalizeGenes(values: readonly string[]): string[] {
  const flat = values
    .flatMap((value) => String(value).split(/[\s,;]+/))
    .map((gene) => gene.trim())
    .filter((gene) => gene.length > 0)
  return Array.from(new Set(flat)).slice(0, MAX_GENES)
}

export function ViolinPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()

  const [matrixPath, setMatrixPath] = useState('')
  const [matrixInfo, setMatrixInfo] = useState<VizInspectResult | null>(null)
  const [groupsPath, setGroupsPath] = useState('')
  const [groupsInfo, setGroupsInfo] = useState<VizInspectResult | null>(null)

  const [genes, setGenes] = useState<string[]>([])
  /** 基因输入框里还没提交的文本（失焦时要提交它，见 onBlur 注释） */
  const [geneInput, setGeneInput] = useState('')
  const [plotType, setPlotType] = useState<ViolinOptions['plotType']>('violin')
  const [inputIsLog2, setInputIsLog2] = useState(true)
  const [testMethod, setTestMethod] = useState<ViolinOptions['testMethod']>('wilcox')
  const [pLabel, setPLabel] = useState<ViolinOptions['pLabel']>('p')
  const [refGroup, setRefGroup] = useState('')
  const [showPoints, setShowPoints] = useState(true)
  const [showMean, setShowMean] = useState(true)
  const [paletteChoice, setPaletteChoice] = useState('lancet')
  const [customColors, setCustomColors] = useState('#4C72B0,#DD8452,#55A868')
  const [facetFreeY, setFacetFreeY] = useState(true)
  const [yLabel, setYLabel] = useState('')
  const [title, setTitle] = useState('')

  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [lastExport, setLastExport] = useState<string | null>(null)

  const palette = paletteChoice === '__custom__' ? customColors : paletteChoice
  const groupLevels = useMemo(() => groupsInfo?.roleValues.group ?? [], [groupsInfo])
  const geneOptions = useMemo(() => matrixInfo?.rowKeys ?? [], [matrixInfo])
  const ready = Boolean(matrixPath && groupsPath && genes.length > 0)

  /**
   * 空图时的提示要指到**当前缺的那一步**。
   *
   * 原来固定写「选择表达矩阵、分组表，并至少选 1 个基因」，在用户已经选好两个文件、
   * 只是忘了按回车的时候，这句话看起来像是批评他没选文件 —— 于是他回去重新选文件，
   * 问题依旧。提示必须跟着状态走。
   */
  const emptyHint = (() => {
    if (!matrixPath) return '先在左侧选择表达矩阵'
    if (!groupsPath) return '再选择分组表（两列：样本名、分组）'
    if (genes.length === 0) return '在「基因」里选或输入基因名，输入后按回车（可一次粘贴多个）'
    return '正在准备预览…'
  })()

  const build = useCallback(
    (size: { widthIn: number; heightIn: number }) => {
      if (!ready) return null
      // 分面多少决定画幅：一行放 4 个基因时宽高比接近 2:1，这里给个最小建议值，
      // 但真正的尺寸由容器实测决定（见 VizPreview 的注释）
      void size
      return {
        kind: 'violin' as const,
        title: title || undefined,
        source: {
          matrixPath,
          groupsPath,
          geneColumn: matrixInfo?.suggested.geneColumn,
          genes
        },
        options: {
          plotType,
          inputIsLog2,
          testMethod,
          pLabel,
          refGroup: refGroup || undefined,
          showPoints,
          showMean,
          palette,
          facetFreeY,
          yLabel: yLabel || undefined
        }
      } satisfies VizPlotSpec
    },
    [
      ready,
      matrixPath,
      groupsPath,
      matrixInfo,
      genes,
      plotType,
      inputIsLog2,
      testMethod,
      pLabel,
      refGroup,
      showPoints,
      showMean,
      palette,
      facetFreeY,
      yLabel,
      title
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
            defaultName: `violin.${format}`,
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
            分面小提琴图
          </Typography>
          <Typography variant="body1" color="text.secondary">
            多基因 × 多组的分布对比 · 自动标注组间两两比较的 FDR
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={genes.length > 0 ? `${genes.length} 个基因 / ${groupLevels.length || '?'} 组` : '待配置'}
          sx={{ height: 22, fontSize: 10.5 }}
        />
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)', gap: 2 }}>
        <Card variant="outlined" sx={{ p: 2, alignSelf: 'start' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
            数据
          </Typography>

          <Stack spacing={1.25}>
            <SourceFileField
              label="选择表达矩阵"
              value={matrixPath}
              onChange={(path, info) => {
                setMatrixPath(path)
                setMatrixInfo(info)
                // 换矩阵后旧的基因选择基本都失效了，清掉避免拿错基因名去查
                setGenes([])
                setGeneInput('')
              }}
              hint={
                matrixInfo
                  ? `${matrixInfo.totalRows} 行 × ${matrixInfo.totalColumns} 列（基因列：${
                      matrixInfo.suggested.geneColumn ?? '第一列'
                    }）`
                  : '行 = 基因，列 = 样本，第一列是基因 ID'
              }
            />

            <SourceFileField
              label="选择分组表"
              value={groupsPath}
              onChange={(path, info) => {
                setGroupsPath(path)
                setGroupsInfo(info)
                setRefGroup('')
              }}
              hint={
                groupsInfo
                  ? groupLevels.length > 0
                    ? `分组列：${groupsInfo.suggested.groupColumn ?? '第二列'}，共 ${groupLevels.length} 组`
                    : '没识别到分组列，请确认表里有 sample / group 两列'
                  : '两列：样本名、分组'
              }
            />
          </Stack>

          <Divider sx={{ my: 1.75 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            基因（最多 {MAX_GENES} 个）
          </Typography>
          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={geneOptions}
            value={genes}
            // 受控 inputValue：需要在失焦时把「打了但没回车」的内容也提交掉
            inputValue={geneInput}
            onInputChange={(_, value) => setGeneInput(value)}
            onChange={(_, value) => {
              setGenes(normalizeGenes(value))
              setGeneInput('')
            }}
            onBlur={() => {
              // 用户打了基因名却没按回车就去点别处 —— 这时右侧预览是空的，
              // 而界面上看不出「还得再按一下回车」。失焦即提交能消掉这个死角。
              if (geneInput.trim()) {
                setGenes(normalizeGenes([...genes, geneInput]))
                setGeneInput('')
              }
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder={matrixPath ? '选或输入基因名，多个用空格/逗号分隔' : '先选矩阵'}
                helperText={matrixPath ? '输入后按回车加入；可一次粘贴多个（空格、逗号、换行都行）' : undefined}
                inputProps={{ ...params.inputProps, style: { fontSize: 11.5 } }}
                FormHelperTextProps={{ sx: { fontSize: 10.5, mx: 0.5 } }}
              />
            )}
            noOptionsText="矩阵里没有这个基因，仍可直接回车加入（名称需与矩阵一致）"
          />
          {genes.length >= MAX_GENES && (
            <Typography variant="body2" color="warning.main" sx={{ fontSize: 10.5, mt: 0.5 }}>
              已达 {MAX_GENES} 个上限，多余的基因被忽略。分面太多时每格会小到看不清，
              建议拆成多张图。
            </Typography>
          )}

          <Divider sx={{ my: 1.75 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            画法与检验
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={plotType}
            onChange={(_, value) => {
              if (value) setPlotType(value)
            }}
            sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="violin">小提琴</ToggleButton>
            <ToggleButton value="box">箱线</ToggleButton>
            <ToggleButton value="beeswarm">蜂群</ToggleButton>
          </ToggleButtonGroup>

          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField
              select
              size="small"
              label="检验方法"
              value={testMethod}
              onChange={(event) => setTestMethod(event.target.value as ViolinOptions['testMethod'])}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
              fullWidth
            >
              <option value="wilcox">Wilcoxon 秩和</option>
              <option value="t">t 检验</option>
            </TextField>
            <TextField
              select
              size="small"
              label="括号标注"
              value={pLabel}
              onChange={(event) => setPLabel(event.target.value as ViolinOptions['pLabel'])}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
              fullWidth
            >
              <option value="p">p 值</option>
              <option value="fdr">FDR（BH 校正）</option>
            </TextField>
          </Stack>

          <TextField
            select
            size="small"
            label="参与比较的组"
            value={refGroup}
            onChange={(event) => setRefGroup(event.target.value)}
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mt: 1 }}
            fullWidth
          >
            <option value="">全部两两比较</option>
            {groupLevels.map((group) => (
              <option key={group} value={group}>
                其他组 vs {group}
              </option>
            ))}
          </TextField>

          <Stack direction="row" spacing={2} flexWrap="wrap" sx={{ mt: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={inputIsLog2}
                  onChange={(e) => setInputIsLog2(e.target.checked)}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>已 log2</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showPoints}
                  onChange={(e) => setShowPoints(e.target.checked)}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>原始点</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={<Switch size="small" checked={showMean} onChange={(e) => setShowMean(e.target.checked)} />}
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>均值线</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={facetFreeY}
                  onChange={(e) => setFacetFreeY(e.target.checked)}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>y 轴独立</Typography>}
              sx={{ m: 0 }}
            />
          </Stack>

          <Divider sx={{ my: 1.75 }} />

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

          <Alert severity="info" sx={{ mt: 1.5, fontSize: 10.5 }}>
            括号标的是{pLabel === 'fdr' ? ' BH 校正后的 FDR' : '未校正的组间 p 值'}
            {pLabel === 'fdr' ? '（在「所有基因 × 所有两两比较」上统一校正，不是每个基因各校正一次）' : '；需要多重检验校正时在上面切到 FDR'}。
          </Alert>
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
              matrixPath,
              groupsPath,
              genes.join(','),
              plotType,
              inputIsLog2,
              testMethod,
              pLabel,
              refGroup,
              showPoints,
              showMean,
              palette,
              facetFreeY,
              yLabel,
              title
            ]}
            height={560}
            emptyHint={emptyHint}
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
