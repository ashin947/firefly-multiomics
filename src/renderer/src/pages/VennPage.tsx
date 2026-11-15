/**
 * 绘图模块 —— Venn 图。
 *
 * ## 输入是粘贴的基因列表，不是文件
 *
 * 客户明确选了「只粘贴列表」。Venn 的输入是几个基因集合，量级几千个字符串，
 * 走 IPC 直接进 R 最省事；逼用户为每组准备一个文件反而更麻烦。
 *
 * ## 2~5 组与 6~7 组是两套画法
 *
 * 见 `r/viz/plot_venn.R` 的文件头：VennDiagram 只支持到 5 组，6 组以上用椭圆
 * 硬凑会出现「某个交集画不出来但图看着正常」——那是错的图。6~7 组改用
 * ggVennDiagram 的矩形布局，界面上明确提示这句。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tooltip from '@mui/material/Tooltip'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { VizPlotSpec, VizRenderRequest, VizRenderResult } from '@shared/types/viz'
import { PlotExportDialog, type ExportFormat } from '../components/result/PlotExportDialog'
import { VizPreview } from '../components/viz/VizPreview'
import { call, normalizeError } from '../utils/ipc'

/** R 侧返回的一个交集区域 */
interface VennRegion {
  region: string
  sets: string[]
  count: number
  genes: string[]
}

interface VennSetInput {
  id: number
  name: string
  text: string
  color: string
}

const MAX_SETS = 7
const MIN_SETS = 2

/** 默认配色：与 plotTheme 的强调色系接近，4 组以内区分度足够 */
const DEFAULT_COLORS = ['#4C72B0', '#DD8452', '#55A868', '#C44E52', '#8172B3', '#937860', '#DA8BC3']

let nextId = 1
function makeSet(index: number): VennSetInput {
  nextId += 1
  return {
    id: nextId,
    name: `基因集 ${index + 1}`,
    text: '',
    color: DEFAULT_COLORS[index % DEFAULT_COLORS.length]
  }
}

/**
 * 复制到剪贴板。
 *
 * 优先用 `navigator.clipboard`（Electron 里 file:// 也算安全上下文）；
 * 某些环境下它会被权限策略拒掉，退回隐藏 textarea + execCommand。
 * 不引第三方 clipboard 库 —— 只为了这一处。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * 把 R 返回的基因字段收敛成数组。
 *
 * R 侧的 JSON 序列化用 `auto_unbox = TRUE`，**长度为 1 的向量会变成标量**：
 * 某个交集恰好只有 1 个基因时，`genes` 会从 `["TP53"]` 变成 `"TP53"`，
 * 于是 `genes.join()` 抛 TypeError，整个页面白屏（客户已经撞过一次）。
 *
 * 根因在 R 侧修掉了（那一处已包成 `as.list`），但 IPC 边界上的数据永远要假设
 * 形状可能不对 —— 一个字段的形状问题不该让整页崩掉。
 */
function toGeneList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((gene) => String(gene))
  if (value === null || value === undefined || value === '') return []
  return [String(value)]
}

/** 粘贴内容 → 基因数组：逗号、空格、分号、换行都当分隔符 */
function parseGenes(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
}

export function VennPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()

  const [sets, setSets] = useState<VennSetInput[]>(() => [makeSet(0), makeSet(1), makeSet(2)])
  const [fill, setFill] = useState(true)
  const [showCount, setShowCount] = useState(true)
  const [showPercent, setShowPercent] = useState(false)
  const [title, setTitle] = useState('')

  /** R 返回的每个交集区域（含基因）。图上点不了数字，靠这张表回答「里面有哪些基因」 */
  const [regions, setRegions] = useState<VennRegion[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [lastExport, setLastExport] = useState<string | null>(null)

  const parsed = useMemo(
    () => sets.map((set) => ({ ...set, genes: parseGenes(set.text) })),
    [sets]
  )
  const nonEmpty = useMemo(() => parsed.filter((set) => set.genes.length > 0), [parsed])
  const ready = nonEmpty.length >= MIN_SETS

  const handleResult = useCallback((result: VizRenderResult) => {
    const raw = (result.summary as { regions?: unknown }).regions
    if (!Array.isArray(raw)) {
      setRegions([])
      return
    }
    const parsed = (raw as Partial<VennRegion>[])
      .filter((item) => item && typeof item.region === 'string')
      .map((item) => ({
        region: String(item.region),
        sets: toGeneList(item.sets),
        count: Number(item.count) || 0,
        genes: toGeneList(item.genes)
      }))
      // 只留非空区域；基因多的排前面（用户最先想看「三组都有的那些」）
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
    setRegions(parsed)
    // 展开状态跟着新结果走：区域集合变了，旧的 key 可能已经不存在
    setExpanded((prev) => (prev && parsed.some((item) => item.region === prev) ? prev : null))
  }, [])

  const updateSet = useCallback((id: number, patch: Partial<VennSetInput>) => {
    setSets((prev) => prev.map((set) => (set.id === id ? { ...set, ...patch } : set)))
  }, [])

  const build = useCallback(
    (size: { widthIn: number; heightIn: number }) => {
      if (!ready) return null
      const payload: VizPlotSpec = {
        kind: 'venn',
        title: title || undefined,
        sets: nonEmpty.map((set) => ({
          // 空名称回退到序号，否则 R 里的 names() 会出现空串，图例就是一个空白
          name: set.name.trim() || `基因集 ${sets.findIndex((s) => s.id === set.id) + 1}`,
          genes: set.genes
        })),
        options: {
          fill,
          showCount,
          showPercent,
          palette: nonEmpty.map((set) => set.color)
        }
      }
      void size
      return payload
    },
    [ready, nonEmpty, sets, title, fill, showCount, showPercent]
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
            defaultName: `venn.${format}`,
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
    <Box sx={{ p: 3, maxWidth: 1360, mx: 'auto' }}>
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
            Venn 图
          </Typography>
          <Typography variant="body1" color="text.secondary">
            多组基因列表求交集 · 每组一列，直接粘贴即可
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={`${nonEmpty.length} 组有效 / 共 ${sets.length} 组`}
          sx={{ height: 22, fontSize: 10.5 }}
        />
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 420px) minmax(0, 1fr)', gap: 2 }}>
        {/* ---------------- 配置 ---------------- */}
        <Card variant="outlined" sx={{ p: 2, alignSelf: 'start' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
            基因列表
          </Typography>

          <Stack spacing={1.5}>
            {sets.map((set, index) => (
              <Box key={set.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box
                    component="input"
                    type="color"
                    value={set.color}
                    onChange={(event) => updateSet(set.id, { color: event.target.value })}
                    sx={{
                      width: 26,
                      height: 26,
                      p: 0,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 0.75,
                      backgroundColor: 'transparent',
                      cursor: 'pointer'
                    }}
                  />
                  <TextField
                    size="small"
                    label={`组 ${index + 1} 名称`}
                    value={set.name}
                    onChange={(event) => updateSet(set.id, { name: event.target.value })}
                    inputProps={{ style: { fontSize: 12 } }}
                    InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                    sx={{ '& .MuiInputBase-root': { height: 32 }, flex: 1 }}
                  />
                  <IconButton
                    size="small"
                    disabled={sets.length <= MIN_SETS}
                    onClick={() => setSets((prev) => prev.filter((s) => s.id !== set.id))}
                    title="删除这一组"
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
                <TextField
                  multiline
                  minRows={3}
                  maxRows={7}
                  size="small"
                  placeholder="粘贴基因列表（逗号 / 空格 / 换行分隔）"
                  value={set.text}
                  onChange={(event) => updateSet(set.id, { text: event.target.value })}
                  inputProps={{ style: { fontSize: 11, fontFamily: 'monospace' } }}
                  sx={{ mt: 0.75 }}
                  fullWidth
                />
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.25 }}>
                  {parseGenes(set.text).length} 个基因
                </Typography>
              </Box>
            ))}
          </Stack>

          <Button
            size="small"
            startIcon={<AddIcon />}
            disabled={sets.length >= MAX_SETS}
            onClick={() => setSets((prev) => [...prev, makeSet(prev.length)])}
            sx={{ mt: 1 }}
          >
            增加一组（最多 {MAX_SETS} 组）
          </Button>

          {sets.length > 5 ? (
            <Alert severity="info" sx={{ mt: 1, fontSize: 11 }}>
              6 组以上改用矩形布局。经典椭圆排布在 6 组时无法保证每个交集都被画出，
              图会看着正常但读数是错的。
            </Alert>
          ) : null}

          <Divider sx={{ my: 1.75 }} />

          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
            显示选项
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <FormControlLabel
              control={<Switch size="small" checked={fill} onChange={(e) => setFill(e.target.checked)} />}
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>填充</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch size="small" checked={showCount} onChange={(e) => setShowCount(e.target.checked)} />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>显示数量</Typography>}
              sx={{ m: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showPercent}
                  onChange={(e) => setShowPercent(e.target.checked)}
                />
              }
              label={<Typography variant="body2" sx={{ fontSize: 12 }}>显示占比</Typography>}
              sx={{ m: 0 }}
            />
          </Stack>

          <TextField
            size="small"
            label="标题（可空）"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            inputProps={{ style: { fontSize: 12 } }}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34 }, mt: 1.5 }}
            fullWidth
          />
        </Card>

        {/* ---------------- 预览 ---------------- */}
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
            deps={[nonEmpty.length, fill, showCount, showPercent, title, sets.map((s) => `${s.name}:${s.text.length}`).join('|')]}
            onResult={handleResult}
            height={520}
            emptyHint={
              ready ? '正在准备预览…' : `至少填写 ${MIN_SETS} 组基因才会出图（当前 ${nonEmpty.length} 组有内容）`
            }
          />

          {/* ---- 交集明细：点行展开基因 ---- */}
          {regions.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 0.75, px: 0.5 }}>
                <Typography variant="h3">交集明细</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  点一行看该区域的基因；数字与图上一致，只列非空区域
                </Typography>
              </Stack>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: 11, width: 32 }} />
                    <TableCell sx={{ fontSize: 11 }}>区域</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">
                      基因数
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {regions.map((item) => {
                    const open = expanded === item.region
                    return (
                      <Fragment key={item.region}>
                        <TableRow
                          hover
                          onClick={() => setExpanded(open ? null : item.region)}
                          sx={{ cursor: 'pointer' }}
                        >
                          <TableCell sx={{ py: 0.25 }}>
                            {open ? (
                              <KeyboardArrowDownIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                            ) : (
                              <KeyboardArrowRightIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                            )}
                          </TableCell>
                          <TableCell sx={{ fontSize: 11.5, py: 0.25 }}>{item.region}</TableCell>
                          <TableCell sx={{ fontSize: 11.5, py: 0.25 }} align="right">
                            {item.count}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow>
                            <TableCell colSpan={3} sx={{ py: 0.5, backgroundColor: 'action.hover' }}>
                              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                                  {item.count} 个基因
                                </Typography>
                                <Tooltip title={copiedKey === item.region ? '已复制' : '复制全部基因'}>
                                  <Button
                                    size="small"
                                    startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                                    sx={{ fontSize: 10.5, minWidth: 0, py: 0 }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      void copyText(item.genes.join('\n')).then((ok) => {
                                        if (!ok) return
                                        setCopiedKey(item.region)
                                        window.setTimeout(() => setCopiedKey(null), 1500)
                                      })
                                    }}
                                  >
                                    {copiedKey === item.region ? '已复制' : '复制'}
                                  </Button>
                                </Tooltip>
                              </Stack>
                              <Box
                                sx={{
                                  maxHeight: 160,
                                  overflow: 'auto',
                                  fontFamily: 'monospace',
                                  fontSize: 10.5,
                                  lineHeight: 1.7,
                                  wordBreak: 'break-all',
                                  color: 'text.secondary',
                                  pr: 0.5
                                }}
                              >
                                {item.genes.join(', ')}
                              </Box>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </Box>
          )}

          {!ready && (
            <Alert severity="info" sx={{ mt: 1, fontSize: 11.5 }}>
              每组把基因名粘进去就行，换行、逗号、空格都能当分隔符。Venn 图至少需要 2 组。
            </Alert>
          )}

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
