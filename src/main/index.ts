/**
 * 主进程入口：生命周期、单实例锁、子进程清理。
 *
 * 关键点（ARCHITECTURE §3 / §6.2）：
 *  - 单实例锁：多开会抢同一份 userData 与项目文件，必须拒绝；
 *  - before-quit 必须 await killAll()，否则 Windows 上残留 Rscript.exe；
 *  - 用 isQuitting 标志防止 preventDefault 造成「退不掉」的死循环。
 */
import { app, BrowserWindow } from 'electron'
import { APP_ID } from '@shared/constants'
import { ensureWritableDirs } from './paths'
import { logger } from './logger'
import { createMainWindow } from './window'
import { buildApplicationMenu } from './menu'
import { createAppContext, registerAllHandlers, type AppContext } from './ipc/registerHandlers'

let mainWindow: BrowserWindow | null = null
let context: AppContext | null = null
let isQuitting = false

/** 单实例锁：第二个实例启动时直接把已有窗口拉到前台 */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // 主进程未捕获异常：记日志但不退出（一次计算失败不该让整个软件挂掉）
  process.on('uncaughtException', (err) => {
    logger.error('main', '未捕获异常', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('main', '未处理的 Promise 拒绝', reason)
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // Windows 上设置 AppUserModelId，任务栏图标与通知才能正确归属
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID)
  }

  await app.whenReady()

  try {
    ensureWritableDirs()
  } catch (err) {
    // userData 不可写时仍要让用户看到界面（后续保存会报 E_IO_PERMISSION）
    logger.error('main', '创建可写目录失败', err)
  }

  context = createAppContext()
  registerAllHandlers(context)

  mainWindow = createMainWindow()

  buildApplicationMenu({
    onReload: () => mainWindow?.webContents.reload(),
    onToggleDevTools: () => mainWindow?.webContents.toggleDevTools()
  })

  // 路径解析结果写进日志：这是「开发期 / 打包后」两套目录布局最容易出错的地方，
  // 出问题时用户导出日志就能直接看到实际解析到的路径。
  logger.info('main', '路径解析完成', {
    resourcesRoot: context.paths.getResourcesRoot(),
    rScriptsRoot: context.paths.getRScriptsRoot(),
    userData: context.paths.getUserDataDir(),
    isDev: context.paths.isDev
  })
  logger.info('main', `启动完成 version=${app.getVersion()} platform=${process.platform}`)

  app.on('activate', () => {
    // macOS：点 Dock 图标且无窗口时重建
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  // 有存活子进程时先杀掉再退，避免 Windows 残留 Rscript.exe
  if (context && context.children.count() > 0) {
    event.preventDefault()
    isQuitting = true
    logger.info('main', `退出前清理 ${context.children.count()} 个 R 子进程`)
    void context.children
      .killAll()
      .catch((err: unknown) => logger.error('main', '清理子进程失败', err))
      .finally(() => {
        logger.flush()
        app.quit()
      })
    return
  }
  isQuitting = true
  logger.info('main', '正常退出')
  logger.flush()
})

app.on('will-quit', () => {
  // 最后兜底：同步尽力杀，不再 await（此时事件循环可能已接近关闭）
  context?.children.killAllSync()
})
