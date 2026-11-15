/**
 * 工作台（S1）：项目列表 + 最近项目 + 环境自检。
 *
 * 这是用户打开软件看到的第一屏，因此三件事必须一眼可见：
 *  ① 我现在能做什么（新建/打开/载入示例）
 *  ② 我之前的项目在哪（最近项目表）
 *  ③ 我的环境行不行（右侧三盏灯 + 修复入口）
 */
import AddIcon from '@mui/icons-material/Add'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SPECIES, SPECIES_LABELS } from '@shared/constants'
import { DEFAULT_OMICS_ID, routes } from '@shared/routes'
import type { DemoVariant, ProjectStatus, RecentProject, Species } from '@shared/types/project'
import { DataTable, type Column } from '../components/common/DataTable'
import { EmptyState } from '../components/common/EmptyState'
import { ErrorBanner } from '../components/common/ErrorBanner'
import { RuntimeStatusLights } from '../components/runtime/RuntimeStatusLights'
import { DiagnosticsDialog } from '../components/runtime/DiagnosticsDialog'
import { useAppStore } from '../store/appStore'
import { useProjectStore } from '../store/projectStore'
import { formatRelativeTime } from '../utils/formatting'
import { call } from '../utils/ipc'

/** 项目状态 → 中文（PRD 要求「仅导入 / 分析中断 / 已完成」这类人话） */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  imported: '仅导入',
  analyzed: '已完成',
  interrupted: '分析中断',
  enriched: '已富集'
}

const STATUS_COLORS: Record<ProjectStatus, 'default' | 'success' | 'warning' | 'info'> = {
  imported: 'info',
  analyzed: 'success',
  interrupted: 'warning',
  enriched: 'success'
}

export function WorkspacePage(): JSX.Element {
  const navigate = useNavigate()
  const recent = useProjectStore((s) => s.recent)
  const meta = useProjectStore((s) => s.meta)
  const busy = useProjectStore((s) => s.busy)
  const error = useProjectStore((s) => s.error)
  const openProject = useProjectStore((s) => s.openProject)
  const loadDemo = useProjectStore((s) => s.loadDemo)
  const createProject = useProjectStore((s) => s.createProject)
  const loadRecent = useProjectStore((s) => s.loadRecent)
  const clearError = useProjectStore((s) => s.clearError)
  const mock = useAppStore((s) => s.info?.mock === true)

  const [newOpen, setNewOpen] = useState(false)
  const [name, setName] = useState('')
  const [species, setSpecies] = useState<Species>('human')
  const [parentDir, setParentDir] = useState('')

  // 注意：不在本页 mount 时再调一次 loadRecent —— AppShell 已在 appInfo 就绪后统一加载。
  // 两处都调会产生竞态：本页的调用早于 appInfo 到达，拿到空列表并覆盖演示项目。

  const handleOpenExisting = async (): Promise<void> => {
    try {
      const dir = await call(window.deg.system.pickDir())
      if (!dir) return
      const ok = await openProject(dir)
      if (ok) navigate(routes.module(DEFAULT_OMICS_ID))
    } catch {
      // 用户取消选择：静默
    }
  }

  const handleLoadDemo = async (variant: DemoVariant = 'default'): Promise<void> => {
    const ok = await loadDemo(variant)
    if (ok) navigate(routes.module(DEFAULT_OMICS_ID))
  }

  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || !parentDir) return
    const ok = await createProject({ name: name.trim(), species, parentDir })
    if (ok) {
      setNewOpen(false)
      setName('')
      navigate(routes.data(DEFAULT_OMICS_ID))
    }
  }

  const columns: Column<RecentProject>[] = [
    {
      id: 'name',
      label: '项目名称',
      render: (row) => (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {row.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
            {row.dir}
          </Typography>
        </Box>
      )
    },
    {
      id: 'species',
      label: '物种',
      width: 110,
      render: (row) => (
        <Typography variant="body2">{row.species === 'mouse' ? '小鼠' : '人'}</Typography>
      )
    },
    {
      id: 'status',
      label: '状态',
      width: 96,
      render: (row) => (
        <Chip
          size="small"
          label={PROJECT_STATUS_LABELS[row.status] ?? row.status}
          color={STATUS_COLORS[row.status] ?? 'default'}
          variant="outlined"
          sx={{ height: 20, fontSize: 11 }}
        />
      )
    },
    {
      id: 'updatedAt',
      label: '最近更新',
      width: 100,
      render: (row) => (
        <Typography variant="body2" color="text.secondary">
          {formatRelativeTime(row.updatedAt)}
        </Typography>
      )
    },
    {
      id: 'action',
      label: '',
      width: 64,
      align: 'right',
      render: (row) => (
        <Button
          size="small"
          onClick={async () => {
            const ok = await openProject(row.dir)
            if (ok) navigate(routes.module(DEFAULT_OMICS_ID))
          }}
        >
          打开
        </Button>
      )
    }
  ]

  return (
    <Box sx={{ p: 3, maxWidth: 1360, mx: 'auto' }}>
      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" sx={{ mb: 2.5 }}>
        <Box>
          <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
            工作台
          </Typography>
          <Typography variant="body1" color="text.secondary">
            选择一个组学模块开始分析，或继续之前的项目
          </Typography>
        </Box>
        {meta && (
          <Chip
            size="small"
            label={`当前项目：${meta.name}`}
            color="primary"
            variant="outlined"
            onClick={() => navigate(routes.module(DEFAULT_OMICS_ID))}
            sx={{ cursor: 'pointer' }}
          />
        )}
      </Stack>

      {error && (
        <Box sx={{ mb: 2 }}>
          <ErrorBanner error={error} onDismiss={clearError} />
        </Box>
      )}

      {mock && (
        <Alert severity="info" sx={{ mb: 2, py: 0.25 }}>
          当前为<strong>演示数据模式</strong>（<code>DEG_DEV_MOCK=1</code>）：项目列表、结果表与图表均为内置假数据，未调用 R。
        </Alert>
      )}

      {/* 三个入口 */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.75, mb: 2.5 }}>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.5 }}>
            新建项目
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 11.5, lineHeight: 1.6 }}>
            创建一个 .degproj 项目文件夹，数据与分析记录都保存在里面
          </Typography>
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
            新建
          </Button>
        </Card>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.5 }}>
            打开已有项目
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 11.5, lineHeight: 1.6 }}>
            选择 .degproj 文件夹，自动恢复上次的数据与分析结果
          </Typography>
          <Button size="small" variant="outlined" startIcon={<FolderOpenIcon />} onClick={() => void handleOpenExisting()}>
            打开
          </Button>
        </Card>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.5 }}>
            载入示例项目
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 11.5, lineHeight: 1.6 }}>
            内置 2000 基因 × 24 样本演示数据，用来快速熟悉流程
          </Typography>
          <Button size="small" variant="outlined" startIcon={<ScienceOutlinedIcon />} disabled={busy} onClick={() => void handleLoadDemo()}>
            载入
          </Button>
          {/*
            压力测试数据：不替换默认示例（那个 1 秒出结果，适合首次上手）。
            放在这里而不是设置页，是因为它属于「示例数据」这一族操作，
            用户想找它时不会去翻设置。
          */}
          <Button
            size="small"
            sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary', textAlign: 'left', lineHeight: 1.5 }}
            disabled={busy}
            onClick={() => void handleLoadDemo('stress')}
          >
            载入压力测试数据（20,000 基因 × 48 样本 · limma-voom 实测约 3 秒）
          </Button>
        </Card>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 2 }}>
        {/* 最近项目 */}
        <Card variant="outlined" sx={{ p: 2, minWidth: 0 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.25 }}>
            <Typography variant="h3">最近项目</Typography>
            <Button size="small" onClick={() => void loadRecent()}>
              刷新
            </Button>
          </Stack>
          {recent.length === 0 ? (
            <EmptyState
              title="还没有项目"
              description="新建一个项目，或载入内置示例项目快速了解流程。所有数据都保存在本机。"
              actionLabel="载入示例项目"
              onAction={() => void handleLoadDemo()}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={recent}
              getRowKey={(row) => row.dir}
              maxHeight={340}
              emptyText="还没有项目"
            />
          )}
        </Card>

        {/* 环境自检 */}
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h3" sx={{ mb: 1.25 }}>
            环境自检
          </Typography>
          <RuntimeStatusLights species={meta?.species ?? 'human'} />
          <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.7 }}>
              差异分析依赖 R 环境（limma / DESeq2）。物种注释库只影响基因名映射与富集，缺失不会阻断差异分析。
            </Typography>
          </Box>
        </Card>
      </Box>

      <DiagnosticsDialog />

      {/* 新建项目 */}
      <Dialog open={newOpen} onClose={() => setNewOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>新建项目</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              size="small"
              label="项目名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：肺腺癌 Tumor vs Normal"
              fullWidth
            />
            <TextField
              size="small"
              select
              label="物种"
              value={species}
              onChange={(event) => setSpecies(event.target.value as Species)}
              fullWidth
            >
              {SPECIES.map((item) => (
                <MenuItem key={item} value={item}>
                  {SPECIES_LABELS[item]}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                label="保存位置"
                value={parentDir}
                onChange={(event) => setParentDir(event.target.value)}
                placeholder="选择一个文件夹"
                fullWidth
              />
              <Button
                size="small"
                variant="outlined"
                onClick={async () => {
                  try {
                    const dir = await call(window.deg.system.pickDir())
                    if (dir) setParentDir(dir)
                  } catch {
                    // 取消选择
                  }
                }}
              >
                浏览
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
              将在所选位置创建 <code>{name.trim() || '<项目名>'}.degproj</code> 文件夹。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button size="small" onClick={() => setNewOpen(false)}>
            取消
          </Button>
          <Button size="small" variant="contained" disabled={!name.trim() || !parentDir} onClick={() => void handleCreate()}>
            创建
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
