/**
 * 左侧固定侧栏（新 IA 的骨架）。
 *
 * 结构：产品名 → 工作台 → 分析模块（带状态徽标）→ 设置/诊断 → 底部 R 环境状态。
 * 选中项用「左侧 3px 色条 + 浅蓝底」双重视觉信号 —— 只靠背景色在浅色主题下
 * 对比度不够，用户扫一眼找不到自己在哪。
 */
import Box from '@mui/material/Box'
import fireflyLogo from '../../assets/firefly-logo.svg'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import { NavLink, useLocation } from 'react-router-dom'
import { APP_NAME, APP_NAME_EN } from '@shared/constants'
import { MODULES } from '@shared/modules'
import { routes } from '@shared/routes'
import { useAppStore } from '../../store/appStore'
import { useRuntimeStore } from '../../store/runtimeStore'
import { runtimeDisplay } from '../../utils/runtimeDisplay'
import { StatusBadge, StatusLightDot } from '../common/StatusBadge'

/** 与 StatusBar 共用同一套措辞：同一个状态在两处说不同的话，用户会以为是两回事 */
const LIGHT_TEXT = { green: '环境正常', yellow: '环境待完善', red: '环境不可用' } as const

export const SIDEBAR_WIDTH = 220

interface NavItemProps {
  to: string
  label: string
  icon?: JSX.Element
  badge?: JSX.Element
  /** 精确匹配（工作台） */
  end?: boolean
}

function NavItem({ to, label, icon, badge, end = false }: NavItemProps): JSX.Element {
  const location = useLocation()
  const active = end ? location.pathname === to : location.pathname.startsWith(to)
  return (
    <Box
      component={NavLink}
      to={to}
      end={end}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 0.9,
        mx: 1,
        borderRadius: 1.5,
        textDecoration: 'none',
        color: active ? 'primary.main' : 'text.primary',
        backgroundColor: active ? 'rgba(53,126,92,0.09)' : 'transparent',
        fontWeight: active ? 600 : 500,
        fontSize: 13,
        transition: 'background-color .14s ease',
        '&:hover': { backgroundColor: active ? 'rgba(53,126,92,0.12)' : 'rgba(0,0,0,0.035)' },
        '&::before': active
          ? {
              content: '""',
              position: 'absolute',
              left: -8,
              top: 8,
              bottom: 8,
              width: 3,
              borderRadius: '0 3px 3px 0',
              backgroundColor: 'primary.main'
            }
          : undefined
      }}
    >
      {icon && <Box sx={{ display: 'flex', '& svg': { fontSize: 17 } }}>{icon}</Box>}
      <Box sx={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
      {badge}
    </Box>
  )
}

export function Sidebar(): JSX.Element {
  const info = useAppStore((s) => s.info)
  const runtime = useRuntimeStore((s) => s.info)
  const probing = useRuntimeStore((s) => s.probing)
  const probeError = useRuntimeStore((s) => s.error)
  const openDiagnostics = useRuntimeStore((s) => s.openDiagnostics)

  // 侧边栏只有一个点 → 文案与灯色都走 runtimeDisplay 这一个口径（与底栏同一句）
  const display = runtimeDisplay(runtime, probing, probeError)

  return (
    <Box
      component="nav"
      sx={{
        width: SIDEBAR_WIDTH,
        flex: `0 0 ${SIDEBAR_WIDTH}px`,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid',
        borderColor: 'divider',
        backgroundColor: '#FFFFFF'
      }}
    >
      {/* 产品名 */}
      <Box
        sx={{
          px: 2,
          pt: 2,
          pb: 1.5,
          position: 'relative',
          // 一层极淡的径向渐变，让品牌区从纯白里"浮"出来一点；
          // 透明度压到 0.5 以下，避免抢走下方导航的注意力
          background:
            'radial-gradient(120px 56px at 18px 22px, rgba(79,107,237,0.10), rgba(18,165,148,0.04) 60%, transparent 100%)'
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          {/* 标记：渐变圆角方块 + 一条白色波浪（虫） */}
          <Box
            sx={{
              width: 28,
              height: 28,
              flex: '0 0 28px',
              borderRadius: '9px',
              background: 'linear-gradient(135deg, #357E5C 0%, #8ED0AC 100%)',
              display: 'grid',
              placeItems: 'center',
              boxShadow: '0 2px 8px rgba(79,107,237,0.32)'
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M5 16.5c2.6 0 3.2-4.2 5.6-4.2 2.2 0 2.2 3.4 4.4 3.4 1.8 0 2.6-2.2 4-2.2"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="2.3"
                strokeLinecap="round"
              />
              <circle cx="19.2" cy="13.5" r="1.5" fill="#FFFFFF" />
            </svg>
          </Box>

          <Box sx={{ minWidth: 0 }}>
            <Typography
              sx={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: 0.6,
                lineHeight: 1.25,
                // 渐变文字：底色裁剪到文字上。WebkitTextFillColor 必须显式设成
                // transparent，只写 backgroundClip:text 在部分 Chromium 版本上
                // 会退化成「有背景但字看不清」
                background: 'linear-gradient(120deg, #245C42 0%, #357E5C 42%, #8ED0AC 100%)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                color: 'transparent'
              }}
            >
              {APP_NAME}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: 9.5, letterSpacing: 0.5, mt: 0.25, whiteSpace: 'nowrap' }}
            >
              {APP_NAME_EN.toUpperCase()} · 多组学分析 · v{info?.version ?? '1.0.0'}
            </Typography>
          </Box>
        </Stack>
      </Box>
      <Divider sx={{ mb: 0.5 }} />

      <Box sx={{ flex: 1, overflowY: 'auto', py: 0.5 }}>
        <NavItem to={routes.workspace} label="工作台" icon={<DashboardOutlinedIcon />} end />

        <Typography
          variant="body2"
          sx={{ px: 2.5, pt: 1.5, pb: 0.5, fontSize: 10.5, fontWeight: 600, color: 'text.disabled', letterSpacing: 0.6 }}
        >
          分析模块
        </Typography>
        <Stack spacing={0.25}>
          {MODULES.map((module) => (
            <NavItem
              key={module.id}
              to={routes.module(module.id)}
              label={module.name}
              badge={<StatusBadge status={module.status} />}
            />
          ))}
        </Stack>

        <Typography
          variant="body2"
          sx={{ px: 2.5, pt: 1.5, pb: 0.5, fontSize: 10.5, fontWeight: 600, color: 'text.disabled', letterSpacing: 0.6 }}
        >
          系统
        </Typography>
        <NavItem to={routes.settings} label="设置 / 诊断" icon={<SettingsOutlinedIcon />} />
      </Box>

      {/* 品牌 logo：放在导航下方、环境状态之上。
          用 SVG 而不是 PNG —— 侧栏宽度固定但屏幕 DPI 各不相同，
          矢量在任何缩放下都清晰；`import` 由 Vite 处理成资源 URL。 */}
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', px: 2, pb: 1.25 }}>
        <Box
          component="img"
          src={fireflyLogo}
          alt="Firefly"
          sx={{ width: 120, maxWidth: '100%', opacity: 0.9, userSelect: 'none' }}
        />
      </Box>

      {/* 底部常驻环境状态 */}
      <Divider />
      <Box
        onClick={openDiagnostics}
        sx={{
          px: 2,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          cursor: 'pointer',
          '&:hover': { backgroundColor: 'rgba(0,0,0,0.03)' }
        }}
      >
        <StatusLightDot
          light={display.light ?? 'yellow'}
          pending={display.light === null}
          hint={display.detail ? `${display.hint}：${display.detail}` : display.hint}
          size={9}
        />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.3 }}>
            {display.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
            {/* ready 才敢说「环境正常/待完善」；未探测完说「检测中」，出错说「未知」 */}
            {display.light ? LIGHT_TEXT[display.light] : display.state === 'error' ? '状态未知' : '检测中'} · 点击查看诊断
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}
