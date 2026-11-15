import { createTheme } from '@mui/material/styles'

/**
 * MUI 主题。
 *
 * 中文字体栈顺序很关键：Windows 优先「微软雅黑」，macOS 优先「苹方」，
 * 最后回落到内置的 Noto Sans SC —— 保证三端中文都不会落到衬线或方框字体。
 */
const FONT_STACK = [
  '"Microsoft YaHei"',
  '"PingFang SC"',
  '"Noto Sans SC"',
  '"Hiragino Sans GB"',
  'system-ui',
  '-apple-system',
  'Segoe UI',
  'Roboto',
  'sans-serif'
].join(', ')

export const theme = createTheme({
  palette: {
    mode: 'light',
    /**
     * 浅绿主色（客户 2026-11-13 要求「界面换成浅绿色」）。
     *
     * 为什么主色不是真的「浅」绿：按钮是白字压在 primary 上，
     * #90EE90 这种浅绿对比度只有 1.7:1，白字等于看不见。这里取 #357E5C
     * （对比度约 4.9:1，过 WCAG AA），再用大面积的浅绿背景（#F1F8F3）
     * 与浅绿描边/选中底把「浅绿」的观感做出来 ——
     * 整体看着是浅绿，但字和按钮都还读得清。
     */
    primary: { main: '#357E5C', dark: '#245C42', light: '#7FC8A0' },
    secondary: { main: '#4E9E8A' },
    // success 比 primary 更深更黄一点：两者会被放在一起（绿主色 + 绿「可用」徽标），
    // 同色同深浅会分不清「这是主操作」还是「这是状态」
    success: { main: '#2E7D32' },
    warning: { main: '#ED6C02' },
    error: { main: '#C62828' },
    background: { default: '#E9F4EE', paper: '#FFFFFF' },
    text: { primary: '#1A211D', secondary: '#5A6B62' }
  },
  typography: {
    fontFamily: FONT_STACK,
    fontSize: 13.5,
    h1: { fontSize: 26, fontWeight: 600 },
    h2: { fontSize: 21, fontWeight: 600 },
    h3: { fontSize: 17, fontWeight: 600 },
    body1: { fontSize: 13.5 },
    body2: { fontSize: 12.5 },
    button: { textTransform: 'none', fontWeight: 500 }
  },
  shape: { borderRadius: 6 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true }
    },
    MuiTooltip: {
      defaultProps: { arrow: true, enterDelay: 400 }
    },
    MuiTableCell: {
      styleOverrides: {
        root: { paddingTop: 6, paddingBottom: 6 }
      }
    }
  }
})

export default theme
