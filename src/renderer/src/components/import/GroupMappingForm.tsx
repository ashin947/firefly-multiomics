/**
 * 分组表映射：样本列 / 分组列识别 + 样本差集 + 自动取交集。
 *
 * 「自动取交集」是 PRD 明确要求的动作：矩阵有 24 个样本、分组表只有 20 个时，
 * 用户最想要的是「用共同的那 20 个」，而不是自己一个个删。差集必须双向展示
 * （矩阵多出来的、分组表多出来的），否则用户不知道该改哪一边。
 */
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CallMergeIcon from '@mui/icons-material/CallMerge'
import type { GroupImportResult, Issue } from '@shared/types/dataset'
import { DropZone } from '../common/DropZone'

interface GroupMappingFormProps {
  /** 矩阵里的样本名（用于差集对比） */
  matrixSamples: string[]
  groups: GroupImportResult | null
  importing: boolean
  /** 校验产生的样本不匹配问题（可能为空） */
  issues: readonly Issue[]
  onImport: (filePath: string) => void
  onIntersect: () => void
}

export function GroupMappingForm({
  matrixSamples,
  groups,
  importing,
  issues,
  onImport,
  onIntersect
}: GroupMappingFormProps): JSX.Element {
  const mismatch = issues.find((issue) => issue.rule === 'sample-mismatch')

  if (!groups) {
    return (
      <Stack spacing={1.5}>
        <DropZone
          filterKey="groups"
          title="导入分组表"
          hint="两列即可：一列样本名、一列分组名（如 sample,group）"
          loading={importing}
          onFile={onImport}
        />
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, lineHeight: 1.7 }}>
          分组表决定「谁和谁比」。第一版支持 CSV / TSV / Excel，列名可用 sample/样本、group/分组。
        </Typography>
      </Stack>
    )
  }

  const groupEntries = Object.entries(groups.groups)
  const groupSamples = Object.values(groups.groups).flat()
  const onlyInMatrix = matrixSamples.filter((s) => !groupSamples.includes(s))
  const onlyInGroups = groupSamples.filter((s) => !matrixSamples.includes(s))

  return (
    <Stack spacing={1.75}>
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
          已识别分组
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {groupEntries.map(([name, samples]) => (
            <Chip
              key={name}
              label={`${name} · ${samples.length} 例`}
              color={samples.length < 2 ? 'error' : samples.length === 2 ? 'warning' : 'success'}
              variant="outlined"
              size="small"
            />
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, fontSize: 11 }}>
          样本列：{groups.sampleColumn} ｜ 分组列：{groups.groupColumn} ｜ 共 {groupSamples.length} 个样本
        </Typography>
      </Box>

      {(onlyInMatrix.length > 0 || onlyInGroups.length > 0) && (
        <Alert
          severity="warning"
          action={
            <Button size="small" color="inherit" startIcon={<CallMergeIcon />} onClick={onIntersect}>
              自动取交集
            </Button>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.25 }}>
            样本名不一致
          </Typography>
          {onlyInMatrix.length > 0 && (
            <Typography variant="body2" sx={{ fontSize: 11.5 }}>
              仅出现在矩阵中（{onlyInMatrix.length}）：{onlyInMatrix.slice(0, 6).join('、')}
              {onlyInMatrix.length > 6 ? ' …' : ''}
            </Typography>
          )}
          {onlyInGroups.length > 0 && (
            <Typography variant="body2" sx={{ fontSize: 11.5 }}>
              仅出现在分组表中（{onlyInGroups.length}）：{onlyInGroups.slice(0, 6).join('、')}
              {onlyInGroups.length > 6 ? ' …' : ''}
            </Typography>
          )}
        </Alert>
      )}

      {mismatch && !(onlyInMatrix.length > 0 || onlyInGroups.length > 0) && (
        <Alert severity={mismatch.level === 'error' ? 'error' : 'warning'}>
          <Typography variant="body2">{mismatch.message}</Typography>
        </Alert>
      )}

      <Box>
        <DropZone
          filterKey="groups"
          title="重新选择分组表"
          hint="已导入，可重新选择覆盖"
          loading={importing}
          onFile={onImport}
          selectedName={`已导入：${groupSamples.length} 个样本`}
        />
      </Box>
    </Stack>
  )
}
