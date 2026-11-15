/**
 * 主窗口创建与安全策略（ARCHITECTURE T01 第 3 条）。
 *
 * 安全基线：
 *   contextIsolation: true   —— preload 与页面脚本处于不同 JS 上下文
 *   nodeIntegration: false   —— 页面拿不到 require / process
 *   sandbox: false           —— preload 需要 require('electron')，故关闭沙箱（仅 preload 受益）
 *   webSecurity: true        —— 不做同源放宽
 */
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { APP_NAME } from '@shared/constants'
import { logger } from './logger'

export const WINDOW_DEFAULT_WIDTH = 1200
export const WINDOW_DEFAULT_HEIGHT = 800
export const WINDOW_MIN_WIDTH = 1024
export const WINDOW_MIN_HEIGHT = 700

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false, // 等 ready-to-show，避免白屏闪烁
    // 与渲染进程 theme 的 background.default 保持一致（浅绿）。
    // 不一致的后果是启动/缩放窗口时先闪一下灰蓝再变绿，很难看。
    backgroundColor: '#E9F4EE',
    title: APP_NAME,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // 渲染进程崩溃/无响应要有日志，否则用户只会看到白屏
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('window', `渲染进程异常退出: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('unresponsive', () => {
    logger.warn('window', '渲染进程无响应')
  })
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    logger.error('window', `页面加载失败 code=${errorCode} ${errorDescription} url=${validatedURL}`)
  })

  // 所有 window.open / target=_blank 一律拦截：需要外链时交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 禁止页面被导航到外部地址（防钓鱼/误跳转）
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      logger.warn('window', `已拦截页面跳转: ${url}`)
    }
  })

  loadRenderer(win)
  return win
}

/** 开发期加载 dev server，生产期加载打包后的 HTML */
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    return
  }
  void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}
