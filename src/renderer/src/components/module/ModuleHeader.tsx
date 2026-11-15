/**
 * 模块标题区（三个模块共用）。
 *
 * 客户要求「一眼看出这个模块是干什么的、吃什么数据」，
 * 所以固定三行信息：模块名 + 一句话定位 + 数据规模提示，右侧挂状态徽标。
 */
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { ModuleDef } from '@shared/modules'
import { StatusBadge } from '../common/StatusBadge'

interface ModuleHeaderProps {
  module: ModuleDef
  /** 右侧附加操作（如「开始导入」按钮） */
  actions?: React.ReactNode
}

export function ModuleHeader({ module, actions }: ModuleHeaderProps): JSX.Element {
  return (
    <Stack
      direction="row"
      alignItems="flex-start"
      justifyContent="space-between"
      spacing={2}
      sx={{ mb: 2.5 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h1" sx={{ fontSize: 22 }}>
            {module.name}
          </Typography>
          <StatusBadge status={module.status} size="medium" />
        </Stack>
        <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          {module.tagline}
          <Box component="span" sx={{ mx: 0.75, color: 'text.disabled' }}>
            ｜
          </Box>
          {module.scale}
        </Typography>
      </Box>
      {actions && <Box sx={{ flex: '0 0 auto' }}>{actions}</Box>}
    </Stack>
  )
}
