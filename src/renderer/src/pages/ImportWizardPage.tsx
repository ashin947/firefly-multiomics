/**
 * 数据导入向导（转录组模块 · 三步）。
 *
 * ① 表达矩阵（拖拽 / 选择）→ ② 分组信息 → ③ 校验结果
 *
 * 两个硬约束：
 *  - 重复基因未选合并策略时**不允许**下一步（数据正确性关口）；
 *  - 存在 error 级问题时「下一步」置灰并显示问题数徽标（PRD S2 验收点）。
 *
 * 演示模式（AppInfo.mock）下自动载入内置矩阵，便于无 R 环境时走查界面。
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import Typography from '@mui/material/Typography'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { findModule } from '@shared/modules'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { DuplicateStrategy } from '@shared/types/dataset'
import { DataTypeSelector } from '../components/import/DataTypeSelector'
import { DuplicateStrategyDialog } from '../components/import/DuplicateStrategyDialog'
import { GeneIdPanel } from '../components/import/GeneIdPanel'
import { GroupMappingForm } from '../components/import/GroupMappingForm'
import { MatrixPreview } from '../components/import/MatrixPreview'
import { DropZone } from '../components/common/DropZone'
import { EmptyState } from '../components/common/EmptyState'
import { ErrorBanner } from '../components/common/ErrorBanner'
import { IssueList } from '../components/common/IssueList'
import { useAppStore } from '../store/appStore'
import { countIssues, hasBlockingIssue, useDatasetStore, type WizardStep } from '../store/datasetStore'
import { formatPercent } from '../utils/formatting'

const STEP_LABELS = ['表达矩阵', '分组信息', '校验结果']

export function ImportWizardPage(): JSX.Element {
  const navigate = useNavigate()
  const { omicsId = DEFAULT_OMICS_ID } = useParams<{ omicsId: string }>()
  const module = findModule(omicsId)
  const moduleName = module?.name ?? '模块'
  const mock = useAppStore((s) => s.info?.mock === true)
  const matrix = useDatasetStore((s) => s.matrix)
  const groups = useDatasetStore((s) => s.groups)
  const issues = useDatasetStore((s) => s.issues)
  const summary = useDatasetStore((s) => s.summary)
  const step = useDatasetStore((s) => s.step)
  const dataType = useDatasetStore((s) => s.dataType)
  const geneIdColumn = useDatasetStore((s) => s.geneIdColumn)
  const requiresChoice = useDatasetStore((s) => s.requiresChoice)
  const duplicateChoice = useDatasetStore((s) => s.duplicateChoice)
  const importing = useDatasetStore((s) => s.importing)
  const validating = useDatasetStore((s) => s.validating)
  const error = useDatasetStore((s) => s.error)
  const setStep = useDatasetStore((s) => s.setStep)
  const setDataType = useDatasetStore((s) => s.setDataType)
  const importMatrix = useDatasetStore((s) => s.importMatrix)
  const importGroups = useDatasetStore((s) => s.importGroups)
  const setGeneIdColumn = useDatasetStore((s) => s.setGeneIdColumn)
  const aggregateDuplicates = useDatasetStore((s) => s.aggregateDuplicates)
  const validate = useDatasetStore((s) => s.validate)
  const clearError = useDatasetStore((s) => s.clearError)

  const [dialogOpen, setDialogOpen] = useState(false)

  // 演示模式：自动载入内置矩阵，避免截图/走查时看到空白向导
  useEffect(() => {
    if (mock && !matrix) void importMatrix('(demo) GSE_demo_expression.csv')
  }, [mock, matrix, importMatrix])

  // 出现重复基因且未选策略 → 立刻弹窗（强制决策）
  useEffect(() => {
    if (requiresChoice && duplicateChoice) setDialogOpen(true)
  }, [requiresChoice, duplicateChoice])

  const counts = useMemo(() => countIssues(issues), [issues])
  const blocking = hasBlockingIssue(issues)

  // 防御：规划中的模块还没有自己的数据导入页（空转的「空间数据导入」是规划中的）。
  // 直接输入 `/module/spatial/data` 时不能渲染转录组的 bulk 矩阵向导 —— 那会让
  // 用户以为空转数据可以按表达矩阵导入。此处放在所有 hook 之后，保证 hook 顺序稳定。
  if (module && module.status === 'planned') {
    return (
      <Box sx={{ p: 4 }}>
        <EmptyState
          title={`${module.name}模块尚未开放`}
          description="该模块的数据导入与质控将在后续版本提供，会按它自己的数据形态（稀疏矩阵 / 矩阵 + 空间坐标）设计向导。"
          actionLabel={`返回${moduleName}模块`}
          onAction={() => navigate(routes.module(module.id))}
        />
      </Box>
    )
  }

  const canNext = (): boolean => {
    if (step === 0) return Boolean(matrix) && !requiresChoice
    if (step === 1) return Boolean(groups)
    return !blocking
  }

  const handleNext = async (): Promise<void> => {
    if (step === 0) {
      if (requiresChoice) {
        setDialogOpen(true)
        return
      }
      setStep(1)
      return
    }
    if (step === 1) {
      await validate()
      return
    }
    // 校验通过 → 进入本模块的差异分析配置页（分析类型由路径里的 analysisId 决定）
    navigate(routes.analysis(omicsId, 'de'))
  }

  const handleConfirmStrategy = async (strategy: DuplicateStrategy): Promise<void> => {
    const ok = await aggregateDuplicates(strategy)
    if (ok) setDialogOpen(false)
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1180, mx: 'auto' }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(routes.module(omicsId))} sx={{ mb: 1.5 }}>
        返回{moduleName}模块
      </Button>

      <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
        数据导入与质控
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2.5 }}>
        表达矩阵 + 分组表，13 项格式校验通过后才能进入差异分析
      </Typography>

      <Stepper activeStep={step} sx={{ mb: 2.5 }}>
        {STEP_LABELS.map((label) => (
          <Step key={label}>
            <StepLabel>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {label}
              </Typography>
            </StepLabel>
          </Step>
        ))}
      </Stepper>

      {error && (
        <Box sx={{ mb: 2 }}>
          <ErrorBanner error={error} onDismiss={clearError} />
        </Box>
      )}

      {step === 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 2 }}>
          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              表达矩阵
            </Typography>
            <DropZone
              filterKey="matrix"
              title="导入表达矩阵"
              hint="支持 CSV / TSV / Excel；首列为基因 ID，其余列为样本"
              loading={importing}
              onFile={(filePath) => void importMatrix(filePath)}
              selectedName={matrix ? summary?.matrixSourceFile ?? '已导入' : null}
            />

            {matrix && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="h3" sx={{ mb: 1 }}>
                  数据预览
                </Typography>
                <MatrixPreview preview={matrix.preview} />
              </Box>
            )}
          </Card>

          <Stack spacing={2}>
            <Card variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h3" sx={{ mb: 1.25 }}>
                数据类型
              </Typography>
              <DataTypeSelector value={dataType} onChange={setDataType} disabled={importing} />
            </Card>

            <Card variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h3" sx={{ mb: 1.25 }}>
                基因 ID
              </Typography>
              <GeneIdPanel
                geneIdType={matrix?.detectedGeneIdType ?? 'UNKNOWN'}
                geneIdColumn={geneIdColumn}
                geneIdSample={matrix?.geneIdSample ?? []}
                columns={matrix?.preview.columns ?? []}
                onSelectColumn={(column) => void setGeneIdColumn(column)}
                disabled={!matrix || importing}
              />
            </Card>

            {summary && (
              <Card variant="outlined" sx={{ p: 2 }}>
                <Typography variant="h3" sx={{ mb: 1 }}>
                  摘要
                </Typography>
                <Stack spacing={0.5}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                    基因数：{summary.geneCount.toLocaleString()}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                    样本数：{summary.sampleCount}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                    缺失值比例：{formatPercent(summary.naRatio)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                    编码：{summary.encoding.toUpperCase()} ｜ 分隔符：{summary.delimiter === '\t' ? 'Tab' : summary.delimiter}
                  </Typography>
                </Stack>
              </Card>
            )}
          </Stack>
        </Box>
      )}

      {step === 1 && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h3" sx={{ mb: 1.25 }}>
            分组信息
          </Typography>
          <GroupMappingForm
            matrixSamples={summary?.samples ?? []}
            groups={groups}
            importing={importing}
            issues={issues}
            onImport={(filePath) => void importGroups(filePath)}
            onIntersect={() => navigate(routes.data(omicsId))}
          />
        </Card>
      )}

      {step === 2 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 2 }}>
          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              校验结果（13 项规则）
            </Typography>
            <IssueList issues={issues} emptyText="13 项校验全部通过，可以进入差异分析。" />
          </Card>

          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 1.25 }}>
              数据摘要
            </Typography>
            {summary && (
              <Stack spacing={0.75}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    基因
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {summary.geneCount.toLocaleString()}
                  </Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    样本
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {summary.sampleCount}
                  </Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    分组
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {Object.keys(summary.groups).length} 组
                  </Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    全零基因
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {summary.allZeroGeneCount}（已过滤）
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={0.75} sx={{ pt: 1 }} flexWrap="wrap" useFlexGap>
                  {counts.error > 0 && <Chip size="small" color="error" label={`${counts.error} 错误`} />}
                  {counts.warning > 0 && <Chip size="small" color="warning" label={`${counts.warning} 警告`} />}
                  {counts.info > 0 && <Chip size="small" label={`${counts.info} 提示`} />}
                </Stack>
              </Stack>
            )}
          </Card>
        </Box>
      )}

      {/* 底部操作栏 */}
      <Stack direction="row" spacing={1.5} justifyContent="flex-end" alignItems="center" sx={{ mt: 2.5 }}>
        {step === 2 && blocking && (
          <Typography variant="body2" sx={{ color: 'error.main', fontSize: 11.5, mr: 'auto' }}>
            存在 {counts.error} 个错误，需先修复才能进入差异分析。
          </Typography>
        )}
        <Button size="small" disabled={step === 0} onClick={() => setStep((step - 1) as WizardStep)}>
          上一步
        </Button>
        <Button
          size="small"
          variant="contained"
          endIcon={<ArrowForwardIcon />}
          disabled={!canNext() || importing || validating}
          onClick={() => void handleNext()}
        >
          {step === 2 ? '进入差异分析' : validating ? '校验中…' : '下一步'}
          {step === 0 && requiresChoice ? '（需先选择合并方式）' : ''}
        </Button>
      </Stack>

      {duplicateChoice && (
        <DuplicateStrategyDialog
          open={dialogOpen}
          choice={duplicateChoice}
          submitting={importing}
          onCancel={() => setDialogOpen(false)}
          onConfirm={(strategy) => void handleConfirmStrategy(strategy)}
        />
      )}
    </Box>
  )
}
