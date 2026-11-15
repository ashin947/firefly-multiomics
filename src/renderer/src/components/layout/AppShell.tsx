/**
 * 应用外壳：左侧侧栏 + 主内容区 + 底部状态栏。
 *
 * 与旧方案的差别：不再用顶部步骤条，因为新 IA 是「模块并列」而不是「线性流程」。
 * 用户可能只做导入就退出，也可能从工作台直接打开历史结果，
 * 用步骤条会给出「必须走完」的错误暗示。
 */
import Box from '@mui/material/Box'
import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useAppStore } from '../../store/appStore'
import { useProjectStore } from '../../store/projectStore'
import { useRuntimeStore } from '../../store/runtimeStore'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function AppShell(): JSX.Element {
  const bootstrap = useAppStore((s) => s.bootstrap)
  const info = useAppStore((s) => s.info)
  const probe = useRuntimeStore((s) => s.probe)
  const loadRecent = useProjectStore((s) => s.loadRecent)
  const hydrateMock = useProjectStore((s) => s.hydrateMock)
  const restoreLast = useProjectStore((s) => s.restoreLast)
  /**
   * 自动恢复只做一次。
   *
   * 用 ref 而不是「meta 为空才恢复」：StrictMode 下 effect 会跑两次，
   * 第二次如果用户已经手动打开了别的项目，再 open 一次会把它覆盖掉 —— 这是竞态，
   * 而且只在开发模式下偶发，最难查。ref 是同步的，天然没有这个问题。
   */
  const restoredRef = useRef(false)

  // 启动自检：appInfo + settings → R 探测 → 最近项目。
  // 顺序有讲究：必须先拿到 appInfo（含 mock 开关），否则演示模式下的探测会走真实 IPC。
  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    if (!info) return
    void probe(false)
    void loadRecent()
    // 演示模式：注入内置项目，否则分析配置页/结果页会因「没有数据」而显示空态
    if (info.mock) hydrateMock()
    // 放在 hydrateMock() **之后**：演示模式下先注入假项目，避免真实 IPC 把它覆盖
    if (!restoredRef.current) {
      restoredRef.current = true
      void restoreLast()
    }
  }, [info, probe, loadRecent, hydrateMock, restoreLast])

  return (
    <Box sx={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden', backgroundColor: 'background.default' }}>
      <Sidebar />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box component="main" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          <Outlet />
        </Box>
        <StatusBar />
      </Box>
    </Box>
  )
}
