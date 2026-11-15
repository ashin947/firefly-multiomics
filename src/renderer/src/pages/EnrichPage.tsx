/**
 * 富集分析页（ORA：GO / KEGG）。
 *
 * ## 基因从哪来
 *
 * 默认是「当前阈值下的全部显著基因」—— 与结果页统计卡同一个判定函数，
 * 所以这里显示 123 个基因，结果页的上调+下调也一定是 123。
 * 用户也可以切到「仅上调 / 仅下调」或直接粘一份基因列表。
 *
 * ## 背景
 *
 *  - 内置 human / mouse：走 clusterProfiler 的 OrgDb + enrichGO / enrichKEGG
 *  - 内置 rice：Bioconductor **没有** org.Os.eg.db（不是没装，是这个包不存在），
 *    所以水稻走随包注释表 resources/annot/rice_go.tsv
 *    （25443 个 LOC_Os 基因 / 97 个 GO Slim term，由 scripts/build-rice-annot.mjs
 *    从客户的 rice_go_matched.txt 聚合而来，打包时随 extraResources 一起发）。
 *    产物不在时 R 侧报 E_RT_ANNOTATION_MISSING，并提示改用自定义文件 ——
 *    这条兜底必须保留：用户可能删了文件，也可能用的是裁剪过的安装包。
 *  - 自定义：用户提供 `gene<TAB>term<TAB>...` 格式的注释文件，
 *    走 enricher() + TERM2GENE。水稻 R498 这类非模式物种只能走这条。
 *
 * ★ 按 BP/CC/MF 分类富集：内置与自定义两条路都支持。传了具体分类时 R 侧先用
 *   GO.db 把 term 收窄到那一类再 enricher()，于是 BH 校正的分母是「本类 term 数」
 *   而不是全表 97 个 —— 与客户脚本 docs/reference/rice-enrich-method.R 口径一致。
 *
 * ## 为什么运行是同步等待
 *
 * 一次 ORA 1~5 秒，直接等结果比引入一整套进度/取消机制划算。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import Tooltip from '@mui/material/Tooltip'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { EnrichResultRow, EnrichSpecies } from '@shared/types/enrich'
import { useAnalysisStore } from '../store/analysisStore'
import { useThresholdStore } from '../store/thresholdStore'
import { filterByThreshold } from '../utils/threshold'
import { call, normalizeError } from '../utils/ipc'

type GeneMode = 'all' | 'up' | 'down' | 'manual'
// 直接用共享类型，别再本地复制一份 —— 加 'other' 时两处都得改，
// 漏一处就是「类型说没有、界面上却有」的不一致（本轮就撞了一次）。
type Species = EnrichSpecies

interface RunState {
  enrichId: string
  rows: EnrichResultRow[]
  summary: Record<string, unknown>
}

/** 数据来源标签（结果表里的「类型」列） */
/** 结果表一次最多渲染多少行 —— 提示文案与实际切片共用这一个常量 */
const TABLE_ROW_LIMIT = 500

const SOURCE_LABEL: Record<string, string> = {
  'GO:BP': 'GO·BP',
  'GO:CC': 'GO·CC',
  'GO:MF': 'GO·MF',
  KEGG: 'KEGG',
  // 'Pathway' 只出现在「用户自己给了 pathway 注释文件」这条路上；
  // 标记成「自定义」会和「内置 rice 的 dosa 通路」混为一谈 ——
  // 内置那条 R 侧写 database = "KEGG"（见 run_ora.R 的 normalize_result 调用），
  // 所以这里显示「通路」，与界面上那个开关的名字一致。
  Pathway: '通路'
}

/**
 * 基因 ID 类型。
 *
 * 内置物种必须先映射到 ENTREZ 才能进 enrichGO / enrichKEGG，所以这个选项直接
 * 决定富集能不能跑起来 —— 选错会得到「0 个基因能映射」，而不是「跑通了但结果为空」。
 * 差异分析出来的 geneId 大多是 SYMBOL（如 TP53），所以默认 SYMBOL。
 */
const GENE_ID_TYPES = [
  { value: 'SYMBOL', label: 'Symbol（TP53）' },
  { value: 'ENSEMBL', label: 'Ensembl（ENSG00000…）' },
  { value: 'ENTREZID', label: 'Entrez（7157）' },
  { value: 'REFSEQ', label: 'RefSeq（NM_000546）' },
  { value: 'GENENAME', label: '基因全名' }
] as const

export function EnrichPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()
  const analysisRows = useAnalysisStore((s) => s.rows)
  const logFC = useThresholdStore((s) => s.logFC)
  const fdr = useThresholdStore((s) => s.fdr)
  const basis = useThresholdStore((s) => s.basis)

  const thresholds = useMemo(() => ({ logFC, fdr, basis }), [logFC, fdr, basis])

  // ---- 配置 ---------------------------------------------------------------
  const [geneMode, setGeneMode] = useState<GeneMode>('all')
  const [manualText, setManualText] = useState('')
  const [species, setSpecies] = useState<Species>('human')
  const [geneIdType, setGeneIdType] = useState<string>('SYMBOL')
  const [sources, setSources] = useState<('go' | 'kegg')[]>(['go', 'kegg'])
  const [ontology, setOntology] = useState<'BP' | 'MF' | 'CC' | 'ALL'>('ALL')
  const [pCut, setPCut] = useState(0.05)
  const [qCut, setQCut] = useState(0.05)
  const [background, setBackground] = useState<'builtin' | 'custom'>('builtin')
  const [customGo, setCustomGo] = useState('')
  const [customPathway, setCustomPathway] = useState('')
  const [customPrefix, setCustomPrefix] = useState('')

  // ---- 运行状态 -----------------------------------------------------------
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RunState | null>(null)

  // ---- 气泡图 -------------------------------------------------------------
  const [plotUrl, setPlotUrl] = useState<string | null>(null)
  const [plotLoading, setPlotLoading] = useState(false)
  const [topN, setTopN] = useState(10)
  const [splitByOntology, setSplitByOntology] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportingTable, setExportingTable] = useState(false)
  const plotSeq = useRef(0)

  /** 按当前模式算出参与富集的基因 */
  const genes = useMemo<string[]>(() => {
    if (geneMode === 'manual') {
      return manualText
        .split(/[\s,;]+/)
        .map((g) => g.trim())
        .filter((g) => g.length > 0)
    }
    if (!analysisRows || analysisRows.length === 0) return []
    if (geneMode === 'all') return filterByThreshold(analysisRows, thresholds, true).map((r) => r.geneId)
    const wantUp = geneMode === 'up'
    return filterByThreshold(analysisRows, thresholds, true)
      .filter((r) => (wantUp ? r.logFC > 0 : r.logFC < 0))
      .map((r) => r.geneId)
  }, [geneMode, manualText, analysisRows, thresholds])

  const run = useCallback(async () => {
    setError(null)
    if (genes.length < 3) {
      setError(`至少需要 3 个基因，当前只有 ${genes.length} 个。`)
      return
    }
    // 自定义背景下 sources 不起作用（文件里有什么就富集什么，R 那边整个分支不读
    // databases），所以要换个校验条件，否则用户只选了 GO 注释文件、KEGG 开关是开的，
    // 会「校验通过」然后得到一个只有 GO 的结果，看着像 KEGG 没跑出来。
    if (background === 'custom') {
      if (!customGo && !customPathway) {
        setError('自定义背景下请至少选择一个注释文件（GO 或 Pathway）。')
        return
      }
    } else if (sources.length === 0) {
      setError('请至少选择一个数据库（GO 或 KEGG）。')
      return
    }
    setRunning(true)
    try {
      const res = await call(
        window.deg.enrich.run({
          genes,
          geneIdType,
          species,
          sources,
          ontology,
          pvalueCutoff: pCut,
          qvalueCutoff: qCut,
          ...(background === 'custom'
            ? {
                customGoPath: customGo || undefined,
                customPathwayPath: customPathway || undefined,
                customTermPrefix: customPrefix || undefined
              }
            : {})
        })
      )
      setResult({ enrichId: res.enrichId, rows: res.rows, summary: res.summary })
    } catch (err) {
      setError(normalizeError(err).message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [genes, sources, species, geneIdType, ontology, pCut, qCut, background, customGo, customPathway, customPrefix])

  /** 结果或绘图参数变化 → 重新生成气泡图（防抖 600ms） */
  useEffect(() => {
    if (!result || result.rows.length === 0) {
      setPlotUrl(null)
      return undefined
    }
    const seq = (plotSeq.current += 1)
    const timer = setTimeout(() => {
      setPlotLoading(true)
      void (async () => {
        try {
          const plot = await call(
            window.deg.enrich.plot({
              enrichId: result.enrichId,
              widthIn: 7.2,
              heightIn: 5.6,
              topN,
              splitByOntology
            })
          )
          if (plotSeq.current !== seq) return
          setPlotUrl(plot.dataUrl ?? null)
        } catch {
          if (plotSeq.current === seq) setPlotUrl(null)
        } finally {
          if (plotSeq.current === seq) setPlotLoading(false)
        }
      })()
    }, 600)
    return () => clearTimeout(timer)
  }, [result, topN, splitByOntology])

  const exportPlot = useCallback(
    async (format: 'png' | 'pdf') => {
      if (!result) return
      setExporting(true)
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `enrich-${stamp}.${format}`,
            filters: [
              format === 'png'
                ? { name: 'PNG 图片', extensions: ['png'] }
                : { name: 'PDF 文档', extensions: ['pdf'] }
            ]
          })
        )
        if (!outPath) return
        await call(
          window.deg.enrich.plot({
            enrichId: result.enrichId,
            outPath,
            format,
            widthIn: 8,
            heightIn: 6,
            dpi: 300,
            topN,
            splitByOntology
          })
        )
      } catch (err) {
        setError(normalizeError(err).message)
      } finally {
        setExporting(false)
      }
    },
    [result, topN, splitByOntology]
  )

  /**
   * 导出结果表。
   *
   * 与 exportPlot 的分工：图是「重新画一张」，表是「把 R 已经写好的那份拷出来」——
   * 后者不需要再起 R，csv 甚至只是 `fs.copyFile`。
   * 默认文件名带日期，和气泡图导出的命名一致。
   */
  const exportTable = useCallback(
    async (format: 'csv' | 'xlsx') => {
      if (!result) return
      setExportingTable(true)
      try {
        const stamp = new Date().toISOString().slice(0, 10)
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: `enrich-${stamp}.${format}`,
            filters: [
              format === 'csv'
                ? { name: 'CSV 表格', extensions: ['csv'] }
                : { name: 'Excel 工作簿', extensions: ['xlsx'] }
            ]
          })
        )
        if (!outPath) return
        await call(
          window.deg.enrich.exportTable({
            enrichId: result.enrichId,
            outPath,
            format
          })
        )
      } catch (err) {
        setError(normalizeError(err).message)
      } finally {
        setExportingTable(false)
      }
    },
    [result]
  )

  const pickFile = useCallback(async (setter: (p: string) => void) => {
    try {
      const picked = await call(
        window.deg.system.pickFile({
          filters: [
            // Excel 也放进来：陌生物种的注释多半是客户直接导出的 xlsx，
            // 让用户先手动另存为 csv 是没有理由的一步（主进程会转）。
            {
              name: '注释文件（文本或 Excel）',
              extensions: ['txt', 'tsv', 'csv', 'xlsx', 'xls', 'annotate', 'go', 'pathway']
            },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
      )
      if (picked[0]) setter(picked[0])
    } catch {
      // 用户取消不算错误
    }
  }, [])

  const hasAnalysis = Boolean(analysisRows && analysisRows.length > 0)

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
            富集分析
          </Typography>
          <Typography variant="body1" color="text.secondary">
            GO / KEGG 过表达富集（ORA）· 背景：内置物种注释库或自定义注释文件
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={`当前阈值 logFC ≥ ${logFC.toFixed(1)} 且 ${basis === 'pValue' ? 'P' : 'FDR'} < ${fdr.toFixed(3)}`}
          sx={{ height: 22, fontSize: 10.5 }}
        />
      </Stack>

      {/* ---------------- 配置 ---------------- */}
      <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 2 }}>
          {/* 基因来源 */}
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              基因来源
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              fullWidth
              value={geneMode}
              onChange={(_, value) => {
                if (value) setGeneMode(value)
              }}
              sx={{ '& .MuiToggleButton-root': { py: 0.25, fontSize: 11, textTransform: 'none' } }}
            >
              <ToggleButton value="all">全部差异基因</ToggleButton>
              <ToggleButton value="up">仅上调</ToggleButton>
              <ToggleButton value="down">仅下调</ToggleButton>
              <ToggleButton value="manual">手动</ToggleButton>
            </ToggleButtonGroup>

            {geneMode === 'manual' ? (
              <TextField
                multiline
                minRows={3}
                maxRows={5}
                size="small"
                placeholder="粘贴基因列表（逗号/空格/换行分隔）"
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                inputProps={{ style: { fontSize: 11.5, fontFamily: 'monospace' } }}
                sx={{ mt: 1 }}
                fullWidth
              />
            ) : null}

            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mt: 0.75 }}>
              将使用 <strong>{genes.length}</strong> 个基因
              {!hasAnalysis && geneMode !== 'manual' ? '（当前没有差异结果，请改用手动输入）' : ''}
            </Typography>
          </Box>

          {/* 物种与数据库 */}
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              物种与数据库
            </Typography>
            <TextField
              select
              size="small"
              label="物种"
              value={species}
              onChange={(event) => {
                const next = event.target.value as Species
                setSpecies(next)
                // 水稻有随包的内置 GO Slim 注释，选它不需要用户自己准备文件。
                // 「其他」没有内置注释，必须自带文件 —— 选中就强制切到自定义，
                // 否则用户会拿到「0 个基因匹配」而不知道是物种选错了。
                if (next === 'other') setBackground('custom')
              }}
              // 自定义注释下物种设置**不生效**（R 侧 useCustom 分支完全不读它），
              // 所以灰掉并解释，而不是让它看起来还能选。
              disabled={background === 'custom'}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mb: 1 }}
              fullWidth
            >
              <option value="human">人（org.Hs.eg.db / hsa）</option>
              <option value="mouse">小鼠（org.Mm.eg.db / mmu）</option>
              {/* 不再叫「内置 GO Slim 注释」——客户完全可能选水稻 + 自定义文件，
                  那时内置注释根本没用上，标签必须同时说清两件事 */}
              <option value="rice">水稻（内置 GO Slim / 可自定义）</option>
              <option value="other">其他（非模式生物，需自定义注释）</option>
            </TextField>
            {background === 'custom' && (
              // 一行说完。写长句会在窄列里折成三行，把下面的「基因 ID 类型」挤到贴边；
              // 底部已经有完整的「自定义背景时忽略物种设置」说明，这里只需要就近提示。
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 2, lineHeight: 1.4 }}>
                用自定义注释时物种设置不生效
              </Typography>
            )}

            <TextField
              select
              size="small"
              label="基因 ID 类型"
              value={geneIdType}
              onChange={(event) => setGeneIdType(event.target.value)}
              // ★ 水稻也要禁用：走注释表那条分支时 R 侧**不读 geneIdType**，
              //   它按注释文件里的原始基因名直接匹配。留着可点会让用户以为
              //   「选 Symbol 就会帮我换算」——实际什么也不会发生
              //   （截图里「水稻 + Symbol（TP53）」并排出现时尤其明显）。
              disabled={background === 'custom' || species === 'rice'}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mb: species === 'rice' ? 0.5 : 1 }}
              fullWidth
            >
              {GENE_ID_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </TextField>
            {species === 'rice' && (
              // 禁用而不解释就是另一种「界面说谎」：用户会问「为什么点不了」。
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mb: 1, lineHeight: 1.5 }}>
                {background === 'custom'
                  ? '使用自定义注释文件时按文件里的基因名直接匹配，不需要换算 ID 类型。'
                  : '水稻内置注释按 LOC_Os 基因名直接匹配，不需要换算 ID 类型。'}
              </Typography>
            )}

            <Stack direction="row" spacing={1}>
              {(['go', 'kegg'] as const).map((db) => (
                <FormControlLabel
                  key={db}
                  control={
                    <Switch
                      size="small"
                      checked={sources.includes(db)}
                      onChange={(event) =>
                        setSources((prev) =>
                          event.target.checked ? [...prev, db] : prev.filter((x) => x !== db)
                        )
                      }
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ fontSize: 12 }}>
                      {/* 自定义背景下 KEGG 来自 pathway 注释文件，不再走 enrichKEGG，
                          标成「KEGG」会让人以为它还会联网去取 KEGG 通路 */}
                      {db === 'go' ? 'GO' : background === 'custom' ? '通路' : 'KEGG'}
                    </Typography>
                  }
                  sx={{ m: 0 }}
                />
              ))}
            </Stack>

            <TextField
              select
              size="small"
              label="GO 分类"
              value={ontology}
              onChange={(event) => setOntology(event.target.value as typeof ontology)}
              disabled={!sources.includes('go')}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
              sx={{ '& .MuiInputBase-root': { height: 34, fontSize: 12 }, mt: 1 }}
              fullWidth
            >
              <option value="ALL">BP + MF + CC（全部）</option>
              <option value="BP">BP（生物过程）</option>
              <option value="MF">MF（分子功能）</option>
              <option value="CC">CC（细胞组分）</option>
            </TextField>
          </Box>

          {/* 阈值与背景 */}
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              阈值与背景
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                type="number"
                label="P 上限"
                value={pCut}
                onChange={(event) => setPCut(Math.max(0.001, Number(event.target.value) || 0.05))}
                inputProps={{ min: 0.001, max: 1, step: 0.01, style: { fontSize: 12 } }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                fullWidth
              />
              <TextField
                size="small"
                type="number"
                label="q 上限"
                value={qCut}
                onChange={(event) => setQCut(Math.max(0.001, Number(event.target.value) || 0.05))}
                inputProps={{ min: 0.001, max: 1, step: 0.01, style: { fontSize: 12 } }}
                InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                fullWidth
              />
            </Stack>

            <RadioGroup
              row
              value={background}
              onChange={(event) => setBackground(event.target.value as 'builtin' | 'custom')}
              sx={{ mt: 1 }}
            >
              {/*
                物种选「其他」时**隐藏**「内置注释库」而不是禁用它：
                禁用会让人问「为什么点不了」，而「非模式生物没有内置注释」这件事
                本身就该在选项层面表达出来。
              */}
              {species !== 'other' && (
                <FormControlLabel
                  value="builtin"
                  control={<Radio size="small" />}
                  label={<Typography variant="body2" sx={{ fontSize: 12 }}>内置注释库</Typography>}
                />
              )}
              <FormControlLabel
                value="custom"
                control={<Radio size="small" />}
                label={<Typography variant="body2" sx={{ fontSize: 12 }}>自定义文件</Typography>}
              />
            </RadioGroup>

            {background === 'custom' ? (
              <Stack spacing={0.75}>
                <Button size="small" variant="text" onClick={() => void pickFile(setCustomGo)} sx={{ justifyContent: 'flex-start', fontSize: 11 }}>
                  {customGo ? `GO：${customGo.split(/[\\/]/).pop()}` : '选择 GO 注释文件'}
                </Button>
                <Button size="small" variant="text" onClick={() => void pickFile(setCustomPathway)} sx={{ justifyContent: 'flex-start', fontSize: 11 }}>
                  {customPathway ? `Pathway：${customPathway.split(/[\\/]/).pop()}` : '选择 Pathway 注释文件'}
                </Button>
                <TextField
                  size="small"
                  label="term 前缀（可选）"
                  placeholder="KEGG / Reactome，留空=全部"
                  value={customPrefix}
                  onChange={(event) => setCustomPrefix(event.target.value)}
                  inputProps={{ style: { fontSize: 11.5 } }}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 11 } }}
                  fullWidth
                />
              </Stack>
            ) : null}
          </Box>
        </Box>

        <Divider sx={{ my: 1.75 }} />

        <Stack direction="row" spacing={1.5} alignItems="center">
          <Button variant="contained" size="small" onClick={() => void run()} disabled={running || genes.length < 3}>
            {running ? '正在富集…' : '开始富集'}
          </Button>
          {running && <CircularProgress size={16} />}
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
            自定义背景时忽略物种设置，直接用注释文件里的 gene-term 对应关系。
          </Typography>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 1.5, fontSize: 12 }}>
            {error}
          </Alert>
        )}
      </Card>

      {/* ---------------- 结果 ---------------- */}
      {result && result.rows.length > 0 && (
        <>
          <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0.5, mb: 1 }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline">
                <Typography variant="h3">富集气泡图</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  共 {result.rows.length} 个条目
                </Typography>
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  type="number"
                  label="每类前 N"
                  value={topN}
                  onChange={(event) => setTopN(Math.max(1, Number(event.target.value) || 10))}
                  inputProps={{ min: 1, max: 50, step: 5, style: { fontSize: 12 } }}
                  InputLabelProps={{ shrink: true, sx: { fontSize: 10.5 } }}
                  sx={{ width: 96, '& .MuiInputBase-root': { height: 32 } }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={splitByOntology}
                      onChange={(event) => setSplitByOntology(event.target.checked)}
                    />
                  }
                  label={<Typography variant="body2" sx={{ fontSize: 11 }}>GO 分面</Typography>}
                  sx={{ m: 0 }}
                />
                <Button size="small" variant="outlined" disabled={exporting} onClick={() => void exportPlot('png')} sx={{ height: 32 }}>
                  PNG
                </Button>
                <Button size="small" variant="outlined" disabled={exporting} onClick={() => void exportPlot('pdf')} sx={{ height: 32 }}>
                  PDF
                </Button>
              </Stack>
            </Stack>

            <Box sx={{ position: 'relative', minHeight: 420 }}>
              {plotUrl ? (
                <Box component="img" src={plotUrl} alt="富集气泡图" sx={{ width: '100%', display: 'block' }} />
              ) : (
                <Box sx={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', fontSize: 12 }}>
                  {plotLoading ? '正在生成气泡图…' : '暂无图'}
                </Box>
              )}
              {plotLoading && plotUrl && (
                <Chip size="small" label="正在重绘…" sx={{ position: 'absolute', top: 8, left: 8, height: 20, fontSize: 10 }} />
              )}
            </Box>
          </Card>

          <Card variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline">
                <Typography variant="h3">富集结果表</Typography>
                {/*
                  ★ 截断必须写在标题旁，不能只写在表格下方：
                    「共 1853 条」而表格滚到 500 行就到底，用户会以为后面丢了数据。
                    说明放底部等于没有 —— 没人会为了找限制去读页脚。
                */}
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  {result.rows.length > TABLE_ROW_LIMIT
                    ? `显示前 ${TABLE_ROW_LIMIT} / 共 ${result.rows.length.toLocaleString()} 条（完整结果请用右上角导出）`
                    : `共 ${result.rows.length} 条`}
                </Typography>
              </Stack>
              {/*
                导出的是 **R 侧写出的全量结果表**，不是这张表当前筛选后的视图
                （表格最多显示前 500 条、气泡图只画 topN）。
                用户筛了 3 行却导出 41 行很容易被当成 bug，所以 tooltip 里写明。
              */}
              <Stack direction="row" spacing={1} alignItems="center">
                <Tooltip title="导出全量结果（R 侧写出的完整结果表，不受本页筛选/显示上限影响）">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={exportingTable}
                      onClick={() => void exportTable('csv')}
                      sx={{ height: 30 }}
                    >
                      CSV
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="导出全量结果（Excel，表头冻结、列宽自适应）">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={exportingTable}
                      onClick={() => void exportTable('xlsx')}
                      sx={{ height: 30 }}
                    >
                      Excel
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
            <TableContainer sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: 11 }}>类型</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>条目</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">基因数</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">Gene Ratio</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">P 值</TableCell>
                    <TableCell sx={{ fontSize: 11 }} align="right">校正 P</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {result.rows.slice(0, TABLE_ROW_LIMIT).map((row, index) => (
                    <TableRow key={`${row.id}-${index}`} hover>
                      <TableCell sx={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        {SOURCE_LABEL[row.source] ?? row.source}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} title={row.description}>
                        {row.description}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.count}</TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.geneRatio}</TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.pvalue.toExponential(2)}</TableCell>
                      <TableCell sx={{ fontSize: 11.5 }} align="right">{row.pAdjust.toExponential(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5, mt: 1 }}>
              按校正 P 升序排列，表格最多显示前 500 条；完整结果已存到项目的 results/enrich 目录。
            </Typography>
          </Card>
        </>
      )}

      {result && result.rows.length === 0 && (
        <Alert severity="info" sx={{ fontSize: 12 }}>
          没有显著富集的条目。可以放宽 P / q 阈值，或换用更合适的背景。
        </Alert>
      )}
    </Box>
  )
}
