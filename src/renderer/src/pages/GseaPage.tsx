/**
 * GSEA 页面。
 *
 * ## 与富集页的定位差异
 *
 * 富集页（ORA）吃「一组基因」，基因来自项目里的差异结果或手动粘贴；
 * GSEA 吃「全部基因 + logFC 的排序」，所以必须让用户**导入一份差异结果文件**
 * （基因列 + logFC 列），不能只给基因名 —— 没有排序就没有 GSEA。
 *
 * ## 为什么结果「一次到位」
 *
 * top-N 与「指定通路」都在开跑前就定了，R 在分析末尾把两张图一起画好。
 * 所以这里没有「调参数→重画」的循环，页面只有一个运行按钮。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useCallback, useMemo, useState } from 'react'
import type { GseaCollection, GseaRunResult, GseaSource } from '@shared/types/gsea'
import { SourceFileField } from '../components/viz/SourceFileField'
import { call, normalizeError } from '../utils/ipc'

/** 每个物种可选的 MSigDB 集合 —— 小鼠没有 KEGG，MSigDB 未提供 m2.cp.kegg_legacy */
const COLLECTIONS: Record<Exclude<GseaSource, 'custom'>, { value: GseaCollection; label: string }[]> = {
  human: [
    { value: 'hallmark', label: 'Hallmark（50 集，推荐）' },
    { value: 'kegg', label: 'KEGG 通路（186 集）' },
    { value: 'reactome', label: 'Reactome 通路（1736 集）' }
  ],
  mouse: [
    { value: 'hallmark', label: 'Hallmark（50 集，推荐）' },
    { value: 'reactome', label: 'Reactome 通路（1289 集）' }
  ]
}

/**
 * 曲线配色预设。
 *
 * 第一项是**客户原脚本里的那套**（`ccc = c('#55B7E6','#193E8F','#E53528','#F09739', ...)`），
 * 设为默认 —— 他拿这套配色出过图，换掉会和以前的图对不上。
 * 其余几项是常见期刊配色，方便换风格时不用改代码。
 * 色值取自 ggsci 对应的调色板（`pal_simpsons` 等），不是随手编的。
 */
const PALETTES: { value: string; label: string; colors: string[] }[] = [
  {
    value: 'original',
    label: '原脚本配色（蓝/深蓝/红/橙/黄/天蓝）',
    colors: ['#55B7E6', '#193E8F', '#E53528', '#F09739', '#FED439', '#709AE1']
  },
  {
    value: 'simpsons',
    label: '辛普森（Simpsons）',
    colors: ['#FED439', '#709AE1', '#8A9197', '#D2AF81', '#FD7446', '#D5E4A2']
  },
  {
    value: 'lancet',
    label: 'Lancet',
    colors: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91']
  },
  {
    value: 'nature',
    label: 'Nature',
    colors: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4']
  },
  {
    value: 'jco',
    label: 'JCO',
    colors: ['#0073C2', '#EFC000', '#868686', '#CD534C', '#7AA6DC', '#003C67']
  }
]

const SPECIES_LABEL: Record<GseaSource, string> = {
  human: '人',
  mouse: '小鼠',
  custom: '自定义 GMT'
}

/** 默认值集中在这里，避免散落在 JSX 里 */
const DEFAULTS = {
  topN: 5,
  minSize: 15,
  maxSize: 500,
  nperm: 1000,
  widthIn: 10.5,
  heightIn: 8
}

/** 百分比/科学计数显示 */
function fmtP(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v < 1e-4) return v.toExponential(2)
  return v.toFixed(4)
}

export function GseaPage(): JSX.Element {
  const [degPath, setDegPath] = useState('')
  const [degHint, setDegHint] = useState('')

  const [source, setSource] = useState<GseaSource>('human')
  const [collection, setCollection] = useState<GseaCollection>('hallmark')
  const [gmtPath, setGmtPath] = useState('')

  const [topN, setTopN] = useState(String(DEFAULTS.topN))
  const [pathwaysText, setPathwaysText] = useState('')
  const [minSize, setMinSize] = useState(String(DEFAULTS.minSize))
  const [maxSize, setMaxSize] = useState(String(DEFAULTS.maxSize))
  const [nperm, setNperm] = useState(String(DEFAULTS.nperm))
  const [paletteKey, setPaletteKey] = useState(PALETTES[0].value)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GseaRunResult | null>(null)

  const collections = source === 'custom' ? [] : COLLECTIONS[source]

  /** 物种切换时，若当前集合在新物种里不存在（如小鼠没有 kegg），回落到第一项 */
  const changeSource = useCallback((next: GseaSource) => {
    setSource(next)
    if (next !== 'custom') {
      const allowed = COLLECTIONS[next].map((c) => c.value)
      setCollection((prev) => (allowed.includes(prev) ? prev : allowed[0]))
    }
  }, [])

  const wantedPathways = useMemo(
    () =>
      pathwaysText
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [pathwaysText]
  )

  const ready = Boolean(degPath) && (source !== 'custom' || Boolean(gmtPath))

  const run = useCallback(async () => {
    if (!ready) return
    setRunning(true)
    setError(null)
    try {
      const res = await call(
        window.deg.gsea.run({
          degPath,
          pvalueCutoff: 1,
          source,
          collection,
          gmtPath: source === 'custom' ? gmtPath : undefined,
          topN: Number(topN) || DEFAULTS.topN,
          pathways: wantedPathways,
          minSize: Number(minSize) || DEFAULTS.minSize,
          maxSize: Number(maxSize) || DEFAULTS.maxSize,
          nperm: Number(nperm) || DEFAULTS.nperm,
          widthIn: DEFAULTS.widthIn,
          heightIn: DEFAULTS.heightIn,
          palette: PALETTES.find((p) => p.value === paletteKey)?.colors ?? PALETTES[0].colors
        })
      )
      setResult(res)
    } catch (err) {
      setError(normalizeError(err).message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [ready, degPath, source, collection, gmtPath, topN, wantedPathways, minSize, maxSize, nperm, paletteKey])

  /**
   * 导出图片：R 已经画好了两份（png 给预览、pdf 给投稿），这里只是复制。
   *
   * 格式必须由按钮显式指定，不能靠保存框的扩展名去猜 —— 两份是独立文件，
   * 猜错就等于给了用户一个「后缀是 .pdf 的位图」。富集页也是 PNG / PDF 两个按钮，
   * 两个页面的交互保持一致。
   */
  const exportPlot = useCallback(
    async (which: 'top' | 'detail', format: 'png' | 'pdf') => {
      if (!result) return
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `gsea-${which === 'detail' ? 'detail' : 'top'}-${stamp}.${format}`,
            filters:
              format === 'pdf'
                ? [{ name: 'PDF 矢量图', extensions: ['pdf'] }]
                : [{ name: 'PNG 图片', extensions: ['png'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.gsea.exportPlot({ gseaId: result.gseaId, which, outPath, format }))
      } catch (err) {
        setError(normalizeError(err).message)
      }
    },
    [result]
  )

  /**
   * 导出**完整**结果表（磁盘上那份 gsea_result.csv，不是界面上的若干行）。
   *
   * 格式由两个按钮显式给出：CSV 给 R/Python 继续处理，Excel 给不写代码的人看。
   * 不让用户靠改后缀去猜 —— 和图的导出保持同一套习惯。
   */
  const exportTable = useCallback(
    async (format: 'csv' | 'xlsx') => {
      if (!result) return
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `gsea-result-${stamp}.${format}`,
            filters:
              format === 'xlsx'
                ? [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
                : [{ name: 'CSV 表格', extensions: ['csv'] }]
          })
        )
        if (!outPath) return
        await call(
          window.deg.gsea.exportTable({ gseaId: result.gseaId, outPath, format })
        )
      } catch (err) {
        setError(normalizeError(err).message)
      }
    },
    [result]
  )

  const summary = result?.summary ?? {}
  const geneSets = Number(summary['geneSets'] ?? 0)
  const inputGenes = Number(summary['inputGenes'] ?? 0)

  /**
   * 「显著」按 **p 值** 算，不按校正 p。
   *
   * 客户实验室的习惯（和他们的 violin 图一致）：先看名义 p 值挑候选，再看 FDR。
   * 而且计数必须在**同一份数据**上算 —— 原来读的是 R 的 `summary.significant`
   * （padj 口径），界面却把 p 值与 padj 并排列出来，读的人很容易把两个数对上但口径不同。
   * 现在两张皮合成一张：数字就是从下面这张表里数出来的。
   */
  const pSigCount = useMemo(
    () => (result?.rows ?? []).filter((r) => Number.isFinite(r.pvalue) && r.pvalue < 0.05).length,
    [result]
  )
  const fdrSigCount = useMemo(
    () => (result?.rows ?? []).filter((r) => Number.isFinite(r.pAdjust) && r.pAdjust < 0.05).length,
    [result]
  )

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 380px) 1fr', gap: 2, p: 2, height: '100%' }}>
      {/* ---------------- 左侧配置 ---------------- */}
      <Card variant="outlined" sx={{ p: 2, overflowY: 'auto' }}>
        <Typography variant="h3" sx={{ mb: 1.5 }}>
          GSEA 配置
        </Typography>

        <SourceFileField
          label="差异结果文件"
          value={degPath}
          onChange={(path, info) => {
            setDegPath(path)
            setDegHint(
              info
                ? `${info.totalRows} 行｜列：${info.columns.slice(0, 6).join(' / ')}${
                    info.columns.length > 6 ? ' …' : ''
                  }`
                : ''
            )
          }}
          extensions={['csv', 'tsv', 'txt']}
          hint={degHint || '需要含基因列与 logFC 列（GSEA 靠 logFC 排序）'}
        />

        <Divider sx={{ my: 1.5 }} />

        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
          基因集
        </Typography>
        <TextField
          select
          size="small"
          label="物种"
          value={source}
          onChange={(e) => changeSource(e.target.value as GseaSource)}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
          sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mb: 1 }}
          fullWidth
        >
          {(Object.keys(SPECIES_LABEL) as GseaSource[]).map((s) => (
            <option key={s} value={s}>
              {SPECIES_LABEL[s]}
            </option>
          ))}
        </TextField>

        {source === 'custom' ? (
          <SourceFileField
            label="GMT 文件"
            value={gmtPath}
            onChange={(path) => setGmtPath(path)}
            extensions={['gmt', 'txt']}
            hint="标准 GMT：名称<TAB>描述<TAB>基因…"
          />
        ) : (
          <TextField
            select
            size="small"
            label="集合"
            value={collection}
            onChange={(e) => setCollection(e.target.value as GseaCollection)}
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          >
            {collections.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </TextField>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 0.5 }}>
          {source === 'mouse'
            ? '内置为 MSigDB 2024.1.Mm（小鼠没有 KEGG 集合，MSigDB 未提供）'
            : source === 'human'
              ? '内置为 MSigDB 2024.1.Hs（symbol 版）'
              : '自定义 GMT 由你提供，软件只读不解释'}
        </Typography>

        <Divider sx={{ my: 1.5 }} />

        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            label="默认画前 N 个（按 p 值）"
            value={topN}
            onChange={(e) => setTopN(e.target.value)}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          />
          <TextField
            size="small"
            label="置换次数"
            value={nperm}
            onChange={(e) => setNperm(e.target.value)}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          />
        </Stack>

        <TextField
          size="small"
          multiline
          minRows={2}
          maxRows={4}
          label="额外指定通路（可选）"
          placeholder="填写基因集名称，一行一个或逗号分隔"
          value={pathwaysText}
          onChange={(e) => setPathwaysText(e.target.value)}
          InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
          sx={{ mt: 1.5, mb: 0.5, '& .MuiInputBase-root': { fontSize: 11.5 } }}
          helperText="指定的通路会单独出一张详情图（最多叠 4 条曲线）"
          FormHelperTextProps={{ sx: { fontSize: 10.5 } }}
          fullWidth
        />

        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="最小基因数"
            value={minSize}
            onChange={(e) => setMinSize(e.target.value)}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          />
          <TextField
            size="small"
            label="最大基因数"
            value={maxSize}
            onChange={(e) => setMaxSize(e.target.value)}
            InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
            sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
            fullWidth
          />
        </Stack>

        <TextField
          select
          size="small"
          label="曲线配色"
          value={paletteKey}
          onChange={(e) => setPaletteKey(e.target.value)}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
          sx={{ mt: 1, '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}
          fullWidth
        >
          {PALETTES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </TextField>

        <Button
          variant="contained"
          size="small"
          onClick={run}
          disabled={!ready || running}
          startIcon={running ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ mt: 2, fontSize: 12 }}
          fullWidth
        >
          {running ? '正在运行…' : '开始 GSEA'}
        </Button>

        {!ready && (
          <Typography variant="body2" color="text.disabled" sx={{ fontSize: 10.5, mt: 1 }}>
            需要先选择差异结果文件{source === 'custom' ? '和 GMT 文件' : ''}。
          </Typography>
        )}
      </Card>

      {/* ---------------- 右侧结果 ---------------- */}
      <Card variant="outlined" sx={{ p: 2, overflowY: 'auto' }}>
        {error && (
          <Alert severity="error" sx={{ mb: 1.5, fontSize: 11.5 }}>
            {error}
          </Alert>
        )}

        {!result && !error && (
          <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', color: 'text.disabled' }}>
            <Stack alignItems="center" spacing={1}>
              <Typography variant="body2">选择差异结果文件后点「开始 GSEA」</Typography>
              <Typography variant="body2" sx={{ fontSize: 10.5 }}>
                默认按 p 值画前 {DEFAULTS.topN} 个基因集
              </Typography>
            </Stack>
          </Box>
        )}

        {result && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h3">GSEA 结果</Typography>
              <Chip size="small" label={`${geneSets} 个基因集`} sx={{ fontSize: 10.5, height: 20 }} />
              <Chip
                size="small"
                label={`p < 0.05：${pSigCount}`}
                color={pSigCount > 0 ? 'success' : 'default'}
                variant="outlined"
                sx={{ fontSize: 10.5, height: 20 }}
              />
              <Chip
                size="small"
                label={`FDR < 0.05：${fdrSigCount}`}
                variant="outlined"
                sx={{ fontSize: 10.5, height: 20 }}
              />
              <Chip size="small" label={`${inputGenes} 个基因入表`} sx={{ fontSize: 10.5, height: 20 }} />
            </Stack>

            {result.topPlot && (
              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    前 {Number(summary['topN'] ?? DEFAULTS.topN)} 个基因集（按 p 值）
                  </Typography>
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => exportPlot('top', 'png')}>
                      导出 PNG
                    </Button>
                    <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => exportPlot('top', 'pdf')}>
                      导出 PDF
                    </Button>
                  </Stack>
                </Stack>
                <Box
                  component="img"
                  src={result.topPlot}
                  alt="GSEA 总览图"
                  sx={{ width: '100%', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
                />
              </Box>
            )}

            {result.detailPlot && (
              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {/* 没指定通路时画的是 top1，标题不能写「指定通路」—— 那是在说谎 */}
                    {wantedPathways.length > 0 ? '指定通路详情' : '最显著基因集详情（未指定通路时的默认）'}
                  </Typography>
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => exportPlot('detail', 'png')}>
                      导出 PNG
                    </Button>
                    <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => exportPlot('detail', 'pdf')}>
                      导出 PDF
                    </Button>
                  </Stack>
                </Stack>
                <Box
                  component="img"
                  src={result.detailPlot}
                  alt="GSEA 详情图"
                  sx={{ width: '100%', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
                />
              </Box>
            )}

            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  结果表（按 p 值升序，共 {result.rows.length} 条）
                </Typography>
                <Stack direction="row" spacing={0.5}>
                  <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => void exportTable('csv')}>
                    导出完整 CSV
                  </Button>
                  <Button size="small" sx={{ fontSize: 10.5 }} onClick={() => void exportTable('xlsx')}>
                    导出 Excel
                  </Button>
                </Stack>
              </Stack>
              <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: '#fff', textAlign: 'left' }}>
                      {['基因集', '大小', 'ES', 'NES', 'p 值', '校正 p'].map((h) => (
                        <th key={h} style={{ padding: '4px 6px', borderBottom: '1px solid #e0e0e0', position: 'sticky', top: 0, background: '#fff' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr
                        key={r.pathway}
                        // 浅绿底 = 名义 p < 0.05；字重加粗 = 校正后仍显著。
                        // 两档分开标，是为了让「过了 p 但没扛住多重检验」这件事一眼能看出来。
                        style={{ background: r.pvalue < 0.05 ? 'rgba(76,175,80,0.10)' : undefined }}
                      >
                        <td
                          style={{
                            padding: '3px 6px',
                            borderBottom: '1px solid #f0f0f0',
                            fontWeight: r.pAdjust < 0.05 ? 600 : 400
                          }}
                        >
                          {r.pathway}
                        </td>
                        <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f0f0' }}>{r.size}</td>
                        <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f0f0' }}>{r.es.toFixed(3)}</td>
                        <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f0f0' }}>{r.nes.toFixed(3)}</td>
                        <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f0f0' }}>{fmtP(r.pvalue)}</td>
                        <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f0f0' }}>{fmtP(r.pAdjust)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Box>
          </Stack>
        )}
      </Card>
    </Box>
  )
}
