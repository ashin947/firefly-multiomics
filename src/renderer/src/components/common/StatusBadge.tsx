/**
 * 状态徽标：模块/分析的「可用 / 规划中」，以及环境灯的小圆点。
 *
 * 徽标必须一眼可辨（客户明确要求）：可用=绿、规划中=灰。
 * 环境灯的三色语义来自 @shared/runtimeStatus，组件本身不做判定。
 */
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import type { StatusLight } from '@shared/runtimeStatus'

interface StatusBadgeProps {
  status: 'available' | 'planned'
  size?: 'small' | 'medium'
}

export function StatusBadge({ status, size = 'small' }: StatusBadgeProps): JSX.Element {
  const available = status === 'available'
  return (
    <Chip
      size={size}
      label={available ? '可用' : '规划中'}
      sx={{
        height: 20,
        fontSize: 11,
        fontWeight: 500,
        borderRadius: '4px',
        color: available ? '#1B5E20' : '#5A6472',
        backgroundColor: available ? '#E6F4EA' : '#ECEFF3',
        border: `1px solid ${available ? '#B7DFC2' : '#DCE1E8'}`
      }}
    />
  )
}

const LIGHT_COLORS: Record<StatusLight, string> = {
  green: '#2E7D32',
  yellow: '#ED6C02',
  red: '#C62828'
}

interface StatusLightDotProps {
  light: StatusLight
  /** hover 提示文案（例如「缺少 org.Hs.eg.db」） */
  hint?: string
  size?: number
  /**
   * 尚未探测完 / 探测失败：**只画一个中性灰点**，不给绿黄红。
   *
   * 为什么必须这样：颜色本身就是一句结论。探针还没回来时给黄点，
   * 等于断言「有东西缺」；用户会照着这句话去修一个并不存在的问题。
   * 灰色（无色）是唯一诚实的表达。
   */
  pending?: boolean
}

/** 中性灰：既不是「好」也不是「坏」，就是「还不知道」 */
const PENDING_COLOR = '#9AA4B2'

/** 单个状态灯（小圆点），带 hover 说明 */
export function StatusLightDot({ light, hint, size = 8, pending = false }: StatusLightDotProps): JSX.Element {
  const color = pending ? PENDING_COLOR : LIGHT_COLORS[light]
  const dot = (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: `0 0 0 2px ${color}22`,
        flex: '0 0 auto'
      }}
    />
  )
  return hint ? <Tooltip title={hint}>{dot}</Tooltip> : dot
}
