/**
 * 差异分析配置页（S3）。
 *
 * 组成：方法选择 → 对比组 → 过滤 → 预检 → 开始分析（运行态遮罩）。
 *
 * 演示模式下「开始分析」会走 analysisStore 的假运行（按真实阶段推进），
 * 结束后自动跳结果页，让客户能在无 R 的机器上看到完整闭环。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { METHOD_STAGES, type Stage } from '@shared/constants'
import { findAnalysis, findModule } from '@shared/modules'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import { ContrastSelector } from '../components/analysis/ContrastSelector'
import { FilterConfig } from '../components/analysis/FilterConfig'
import { MethodSelector, type DEMethodId } from '../components/analysis/MethodSelector'
import { PreflightCheckList } from '../components/analysis/PreflightCheckList'
import { RunOverlay } from '../components/run/RunOverlay'
import { ErrorBanner } from '../components/common/ErrorBanner'
import { EmptyState } from '../components/common/EmptyState'
import { useAnalysisRun } from '../hooks/useAnalysisRun'
import { usePreflight } from '../hooks/usePreflight'
import { useAnalysisStore } from '../store/analysisStore'
import { useAppStore } from '../store/appStore'
import { useProjectStore } from '../store/projectStore'
import { useThresholdStore } from '../store/thresholdStore'

export function AnalysisConfigPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID, analysisId = 'de' } = useParams<{ omicsId: string; analysisId: string }>()
  // 标题与返回按钮都从模块目录取，避免「换到别的模块还写着转录组」这种硬编码味道
  const moduleName = findModule(omicsId)?.name ?? '模块'
  const analysisName = findAnalysis(omicsId, analysisId)?.name ?? '差异表达分析'
  const dataset = useProjectStore((s) => s.dataset)
  const meta = useProjectStore((s) => s.meta)
  const mock = useAppStore((s) => s.info?.mock === true)

  const draft = useAnalysisStore((s) => s.draft)
  const setMethod = useAnalysisStore((s) => s.setMethod)
  const setDraft = useAnalysisStore((s) => s.setDraft)
  const setContrast = useAnalysisStore((s) => s.setContrast)
  const swapContrast = useAnalysisStore((s) => s.swapContrast)
  const loadMockResult = useAnalysisStore((s) => s.loadMockResult)

  const run = useAnalysisRun()
  const hydrateThresholds = useThresholdStore((s) => s.hydrate)
  // 当前阈值：随运行请求一起发给 R（决定 de.csv 的 regulation 列），
  // 也决定「看结果」时结果页的初始阈值 —— 三处必须是同一对数字。
  const logFCThreshold = useThresholdStore((s) => s.logFC)
  const fdrThreshold = useThresholdStore((s) => s.fdr)

  // 用 useMemo 固定引用：`dataset?.groups ?? {}` 每次渲染都会产生新对象，
  // 会让下游组件（ContrastSelector）每帧重算
  const groups = useMemo(() => dataset?.groups ?? {}, [dataset?.groups])
  const groupNames = Object.keys(groups)

  // 首次进入：把对比组默认填成「第一个组 vs 第二个组」，避免空下拉
  useEffect(() => {
    if (groupNames.length >= 2 && (!draft.contrast.numerator || !draft.contrast.denominator)) {
      setContrast(groupNames[1], groupNames[0])
    }
  }, [groupNames, draft.contrast.numerator, draft.contrast.denominator, setContrast])

  // 数据类型跟随数据集（已归一化的数据不能用 voom/DESeq2）
  useEffect(() => {
    if (meta && draft.dataType !== meta.dataType) {
      setDraft({ dataType: meta.dataType })
    }
  }, [meta, draft.dataType, setDraft])

  /**
   * limma-lm 的「数据已 log2 转换」默认值跟随数据类型：
   * counts → 关闭（走 limma-trend）、normalized → 开启（直接拟合）。
   *
   * 但**只在用户没手动改过时才覆盖**（用 ref 记）。否则用户明明选了「counts + 已 log2」
   * 这种合理组合，一切换数据集就被悄悄改回去 —— 那和不给开关没区别。
   */
  const inputIsLog2Touched = useRef(false)
  useEffect(() => {
    if (inputIsLog2Touched.current) return
    const next = draft.dataType !== 'counts'
    if (draft.inputIsLog2 !== next) setDraft({ inputIsLog2: next })
  }, [draft.dataType, draft.inputIsLog2, setDraft])

  // ★ 预检结果全部来自主进程（`deg:analysis:preflight`，300ms 防抖）。
  //   前端不再自己算规则：历史实现里那份 `buildPreflightItems` / `methodAvailability`
  //   与主进程 preflight 是两份实现，一旦漂移就是「清单全绿但点了报错」。
  const preflight = usePreflight(draft)
  const preflightItems = preflight.result?.items ?? []
  const preflightMethods = preflight.result?.methods ?? null
  // 预检结论缺失（还没回来 / 通道失败）时不阻断：让用户仍能尝试运行，
  // 由主进程 start() 做最后一道权威校验并给出结构化错误。
  const preflightBlocked = preflight.result ? !preflight.result.canRun : false
  const canStart = !preflightBlocked && run.phase !== 'running'

  const stages = (METHOD_STAGES[draft.method] ?? ['read', 'filter', 'fit', 'test', 'write']) as Stage[]

  const handleStart = async (): Promise<void> => {
    if (!canStart) return
    // ★ 把当前阈值一起发出去：R 用它写 de.csv 的 regulation 列。
    //   这样用户在 Excel 里数出来的 up/down 行数与界面统计卡一致 ——
    //   「界面说 123、Excel 数出 216」这类不报错但结论不一致的问题最难发现。
    await run.start({
      method: draft.method,
      config: { ...draft, thresholds: { logFC: logFCThreshold, fdr: fdrThreshold } }
    })
  }

  const handleViewResult = (): void => {
    // 不要重置成 1.0/0.05：本次分析用的就是当前这对阈值，重置会让结果页的统计卡
    // 与刚生成的 de.csv 对不上（用户会以为软件算错了）。
    hydrateThresholds({ logFC: logFCThreshold, fdr: fdrThreshold })
    navigate(routes.result(omicsId))
  }

  // 演示模式下运行结束自动跳结果页（客户演示时少一次点击）
  useEffect(() => {
    if (mock && run.phase === 'success') {
      const timer = setTimeout(() => navigate(routes.result(omicsId)), 700)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [mock, run.phase, navigate, omicsId])

  if (!dataset) {
    return (
      <Box sx={{ p: 4 }}>
        <EmptyState
          title="还没有可分析的数据"
          description="请先在「数据导入与质控」中导入表达矩阵与分组表，校验通过后再来做差异分析。"
          actionLabel="去导入数据"
          onAction={() => navigate(routes.data(omicsId))}
        />
      </Box>
    )
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1180, mx: 'auto' }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(routes.module(omicsId))} sx={{ mb: 1.5 }}>
        返回{moduleName}模块
      </Button>

      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" sx={{ mb: 2.5 }}>
        <Box>
          <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
            {analysisName}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {dataset.geneCount.toLocaleString()} 基因 × {dataset.sampleCount} 样本 ·{' '}
            {groupNames.length} 个分组
            {meta ? ` · ${meta.name}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          {mock && <Chip size="small" color="warning" variant="outlined" label="演示数据" />}
          <Chip size="small" variant="outlined" label={`数据类型：${draft.dataType === 'counts' ? '原始 counts' : '已归一化'}`} />
        </Stack>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 2 }}>
        <Stack spacing={2}>
          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              分析方法
            </Typography>
            <MethodSelector
              value={draft.method as DEMethodId}
              onChange={(method) => setMethod(method)}
              methods={preflightMethods}
              disabled={run.phase === 'running'}
            />
            {preflight.result && !preflight.result.canRun && (
              <Typography variant="body2" sx={{ mt: 1, fontSize: 11.5, color: 'error.main' }}>
                {preflight.result.items.find((item) => item.level === 'error')?.detail ?? '当前条件下无法运行分析。'}
              </Typography>
            )}
          </Card>

          {/*
            limma-lm 独有的分支开关：只在该方法下出现，避免其它方法看到无关选项。
            位置紧贴方法卡：它决定「这个方法是直接拟合还是先转 log2-CPM」，
            属于方法层面的选择，放到过滤设置后面会让用户以为它是个次要开关
            （第一版就放在最下面，900px 高的窗口里要滚动才看得见）。
          */}
          {draft.method === 'limma-lm' && (
            <Card variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h3" sx={{ mb: 1.25 }}>
                limma 线性模型选项
              </Typography>
              <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
                <Box>
                  <Typography variant="body1" sx={{ fontSize: 13 }}>
                    数据已 log2 转换
                  </Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: 11, lineHeight: 1.65, maxWidth: 560, mt: 0.25 }}
                  >
                    {draft.inputIsLog2 === false
                      ? '关闭：按原始 counts 处理，先做 TMM + log2-CPM 转换（limma-trend），并开启趋势型方差收缩。'
                      : '开启：直接对 log2 表达值拟合线性模型（芯片 / 已用其它工具归一化的数据）。'}
                  </Typography>
                </Box>
                <Switch
                  checked={draft.inputIsLog2 !== false}
                  disabled={run.phase === 'running'}
                  onChange={(event) => {
                    inputIsLog2Touched.current = true
                    setDraft({ inputIsLog2: event.target.checked })
                  }}
                  inputProps={{ 'aria-label': '数据已 log2 转换' }}
                />
              </Stack>
              {draft.inputIsLog2 === false && (
                <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 1.5 }}>
                  <Typography variant="body2" sx={{ fontSize: 11.5 }}>
                    先验计数（prior.count）
                  </Typography>
                  <TextField
                    size="small"
                    type="number"
                    value={draft.priorCount ?? 2}
                    disabled={run.phase === 'running'}
                    onChange={(event) => {
                      // 只接受合法区间：非法输入直接忽略，宁可保持原值也不要把
                      // NaN / 负数写进 run_config.json（R 侧虽然有防御，但不该依赖它）
                      const next = Number(event.target.value)
                      if (Number.isFinite(next) && next >= 0.5 && next <= 10) {
                        setDraft({ priorCount: next })
                      }
                    }}
                    inputProps={{ min: 0.5, max: 10, step: 0.5, 'aria-label': '先验计数' }}
                    sx={{ width: 104 }}
                  />
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                    越大越保守，limma-trend 常用 2
                  </Typography>
                </Stack>
              )}
            </Card>
          )}

          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              对比组
            </Typography>
            <ContrastSelector
              groups={groups}
              groupColumn={dataset.groupColumn}
              numerator={draft.contrast.numerator}
              denominator={draft.contrast.denominator}
              onChange={setContrast}
              onSwap={swapContrast}
              disabled={run.phase === 'running'}
            />
          </Card>

          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              低表达过滤
            </Typography>
            <FilterConfig
              filter={draft.filter}
              keepAllGenes={draft.keepAllGenes}
              onChange={(patch) => setDraft(patch)}
              disabled={run.phase === 'running'}
            />
          </Card>
        </Stack>

        <Stack spacing={2}>
          <Card variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.25 }}>
              <Typography variant="h3">运行前预检</Typography>
              {preflight.busy && (
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                  检查中…
                </Typography>
              )}
            </Stack>
            <PreflightCheckList items={preflightItems} busy={preflight.busy} />
            {preflight.error && (
              <Box
                sx={{
                  mt: 1.5,
                  px: 1.25,
                  py: 1,
                  borderRadius: 1.5,
                  backgroundColor: '#FFF8E6',
                  border: '1px solid #F2DFB4'
                }}
              >
                <Typography variant="body2" sx={{ fontSize: 11, color: 'warning.dark', lineHeight: 1.6 }}>
                  预检暂不可用，仍可尝试运行。主进程会在启动前再校验一次。
                </Typography>
              </Box>
            )}
          </Card>

          {run.error && run.phase === 'failed' && <ErrorBanner error={run.error} />}

          <Button
            variant="contained"
            size="large"
            startIcon={<PlayArrowIcon />}
            disabled={!canStart}
            onClick={() => void handleStart()}
            sx={{ py: 1.1 }}
          >
            {run.phase === 'running' ? '正在运行…' : '开始分析'}
          </Button>
          {preflightBlocked && (
            <Typography variant="body2" sx={{ fontSize: 11, color: 'error.main', textAlign: 'center' }}>
              预检存在未通过的项，请先修复。
            </Typography>
          )}

          <Card variant="outlined" sx={{ p: 1.75, backgroundColor: '#FAFBFD' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.7 }}>
              分析全程在本机运行，不会上传数据。运行中可随时取消；取消后 R 进程会被立即终止。
            </Typography>
          </Card>
        </Stack>
      </Box>

      <RunOverlay
        open={run.phase === 'running' || run.phase === 'success' || run.phase === 'failed' || run.phase === 'cancelled'}
        phase={run.phase}
        stages={stages}
        currentStage={run.stage}
        doneStages={run.doneStages}
        pct={run.pct}
        stageMessage={run.stageMessage}
        logs={run.logs}
        startedAt={run.startedAt}
        finishedAt={run.finishedAt}
        error={run.error}
        mock={mock}
        onCancel={() => void run.cancel()}
        onClose={() => {
          run.reset()
          if (mock) loadMockResult()
        }}
        onViewResult={handleViewResult}
      />
    </Box>
  )
}
