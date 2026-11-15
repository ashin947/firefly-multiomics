/**
 * 结果工具栏：搜索 / 仅显示显著 / 导出。
 *
 * 搜索只匹配基因名与基因 ID（用户不会用 logFC 搜基因）。
 *
 * 导出是**两级选择**：先选「只要差异基因」还是「全部基因」，再选保存位置。
 * 为什么不做成「导出当前表格」一个按钮：用户把表发给导师时，这两种需求都存在
 * 且都很常见 —— 「导出全部」用于自己复算，「只导显著」用于附表。只给一个按钮
 * 必然有一半人要手动删行。
 */
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined'
import SearchIcon from '@mui/icons-material/Search'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useState } from 'react'

/** 导出范围：只要差异基因 / 全部基因 */
export type ExportScope = 'significant' | 'all'

interface ResultToolbarProps {
  search: string
  onSearch: (value: string) => void
  onlySignificant: boolean
  onOnlySignificant: (value: boolean) => void
  /** 当前可见行数 / 总行数（给用户「筛选生效了吗」的即时反馈） */
  visibleCount: number
  totalCount: number
  /** 当前阈值下的差异基因数（上 + 下），导出菜单里要显示 */
  significantCount?: number
  onExport?: (scope: ExportScope) => void
  exportDisabled?: boolean
  /** 导出进行中：按钮转圈并禁用，防止连点产生多个对话框 */
  exporting?: boolean
}

export function ResultToolbar({
  search,
  onSearch,
  onlySignificant,
  onOnlySignificant,
  visibleCount,
  totalCount,
  significantCount = 0,
  onExport,
  exportDisabled = true,
  exporting = false
}: ResultToolbarProps): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  return (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.25 }} flexWrap="wrap" useFlexGap>
      <TextField
        size="small"
        placeholder="搜索基因名 / 基因 ID"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        sx={{ width: 240 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon sx={{ fontSize: 15 }} />
            </InputAdornment>
          )
        }}
      />

      <FormControlLabel
        control={
          <Switch size="small" checked={onlySignificant} onChange={(event) => onOnlySignificant(event.target.checked)} />
        }
        label={
          <Typography variant="body2" sx={{ fontSize: 12 }}>
            仅显示显著
          </Typography>
        }
        sx={{ m: 0 }}
      />

      <Box sx={{ flex: 1 }} />

      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
        显示 {visibleCount.toLocaleString()} / {totalCount.toLocaleString()} 行
      </Typography>

      <Tooltip title={exportDisabled ? '导出功能不可用（当前没有结果数据）' : '导出为 CSV，Excel 可直接打开'}>
        <span>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlinedIcon sx={{ fontSize: 15 }} />}
            disabled={exportDisabled || exporting}
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            {exporting ? '导出中…' : '导出表格'}
          </Button>
        </span>
      </Tooltip>

      {/*
        菜单向上弹：工具栏在页面下半部，向下弹会顶到窗口底、被底部状态栏压住
        （截图里「全部基因」的说明文字被裁掉半行）。anchored 到按钮右上，
        向上展开，整段都能看见。
      */}
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onExport?.('significant')
          }}
        >
          <ListItemText
            primary={`仅差异基因（${significantCount.toLocaleString()} 行）`}
            secondary="按当前阈值筛出的上调 + 下调"
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onExport?.('all')
          }}
        >
          <ListItemText
            primary={`全部基因（${totalCount.toLocaleString()} 行）`}
            secondary="包含不显著的行，便于自己复算"
          />
        </MenuItem>
      </Menu>
    </Stack>
  )
}
