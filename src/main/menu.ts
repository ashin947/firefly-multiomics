/**
 * 应用菜单。
 *
 * 原则：菜单项只做「主进程自己能做到的事」或「转发给渲染进程的明确动作」。
 * 尚未实现的动作一律 disable 并留注释，避免用户点到静默无效的菜单项。
 */
import { app, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME, MIN_R_VERSION } from '@shared/constants'
import { getResourcesRoot } from './paths'

export interface MenuHandlers {
  /** 「打开项目…」——T06 完成后由 index.ts 注入 */
  onOpenProject?: () => void
  /** 「导出诊断日志」——T03 完成后由 index.ts 注入 */
  onExportLog?: () => void
  onReload?: () => void
  onToggleDevTools?: () => void
}

export function buildApplicationMenu(handlers: MenuHandlers = {}): void {
  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      {
        label: '打开项目…',
        accelerator: 'CmdOrCtrl+O',
        enabled: Boolean(handlers.onOpenProject),
        click: () => handlers.onOpenProject?.()
      },
      { type: 'separator' },
      {
        label: '导出诊断日志…',
        enabled: Boolean(handlers.onExportLog),
        click: () => handlers.onExportLog?.()
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      {
        label: '重新加载界面',
        accelerator: 'CmdOrCtrl+R',
        click: () => handlers.onReload?.()
      },
      {
        label: '开发者工具',
        accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
        click: () => handlers.onToggleDevTools?.()
      },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' }
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: '帮助',
    submenu: [
      {
        label: '打开资源目录',
        click: () => {
          void shell.openPath(getResourcesRoot())
        }
      },
      {
        label: `关于 ${APP_NAME}`,
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: `关于 ${APP_NAME}`,
            message: `${APP_NAME} ${app.getVersion()}`,
            detail: [
              `Electron ${process.versions.electron}`,
              `Chromium ${process.versions.chrome}`,
              `Node ${process.versions.node}`,
              `要求 R ≥ ${MIN_R_VERSION}`,
              '',
              '数据全程在本机处理，不会上传任何内容。'
            ].join('\n'),
            buttons: ['确定']
          })
        }
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = [fileMenu, viewMenu, helpMenu]
  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about', label: `关于 ${app.getName()}` },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
