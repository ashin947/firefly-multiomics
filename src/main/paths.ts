/**
 * 路径服务 —— 全项目**唯一**允许出现 `process.resourcesPath` / `app.getAppPath()` 的文件。
 *
 * 为什么必须集中（ARCHITECTURE §6.5）：
 *   开发期与打包后的目录布局不同（开发期在 <repo>/resources，打包后在 <install>/resources），
 *   散落在各处会导致「开发能跑、装完就崩」这类最难查的 bug。
 *   ESLint 的 no-restricted-syntax 规则强制了这条约束。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 是否开发期（未打包）。
 *
 * 防御性写法：在 ELECTRON_RUN_AS_NODE=1 这类非正常启动方式下，`require('electron')`
 * 返回的是二进制路径字符串而不是 API 对象，`app` 为 undefined。
 * 这里用可选链兜底，让错误推迟到真正调用 getAppPath() 时以可读方式抛出，
 * 而不是在模块 import 阶段就抛 TypeError（那会表现为「一启动就白屏」）。
 */
function detectDev(): boolean {
  const maybeApp = app as unknown as { isPackaged?: boolean } | undefined
  return !maybeApp?.isPackaged
}

/** 是否开发期（未打包） */
export const isDev: boolean = detectDev()

/** 打包后：<install>/resources；开发期：<repo>/resources */
export function getResourcesRoot(): string {
  return isDev ? path.join(app.getAppPath(), 'resources') : process.resourcesPath
}

/**
 * 仅用于「三级探测」的第 1 级：Electron 的 resources 目录。
 * 打包后 = <install>/resources；开发期 = node_modules/electron/dist/resources（通常是空的）。
 */
export function getPackagedResourcesRoot(): string {
  return process.resourcesPath
}

/**
 * 仅用于「三级探测」的第 2 级：应用代码根目录。
 * 开发期 = <repo>，因此第 2 级候选是 <repo>/resources/runtime/R/bin/Rscript。
 */
export function getAppPathRoot(): string {
  return app.getAppPath()
}

/** 便携版 R 根目录（含 bin/ 与 lib/） */
export function getRRuntimeRoot(): string {
  return path.join(getResourcesRoot(), 'runtime', 'R')
}

/** 随包分发的 R 包库（R_LIBS_SITE） */
export function getRlibsRoot(): string {
  return path.join(getResourcesRoot(), 'runtime', 'R-libs')
}

/** 内置字体目录 */
export function getRFontsDir(): string {
  return path.join(getResourcesRoot(), 'runtime', 'fonts')
}

/** 内置中文字体（R-30 中文不乱码的基石） */
export function getRFontPath(): string {
  return path.join(getRFontsDir(), 'NotoSansSC-Regular.otf')
}

/** demo 数据目录 */
export function getDemoDir(): string {
  return path.join(getResourcesRoot(), 'demo')
}

/**
 * 压力测试数据集目录（20000 基因 × 48 样本，约 2.8 MB）。
 *
 * 为什么单独放一份而不是替换默认示例数据：
 *   默认示例（2000×24）跑完只要 ~1 秒，适合第一次上手 —— 用户点完立刻看到结果。
 *   压力数据是给「想看进度条怎么走」的人用的：实测 limma-voom 2.8 秒、
 *   8 个进度台阶（默认只有 3 个），放进默认路径会毁掉首次体验。两份共存，由用户选择。
 */
export function getDemoStressDir(): string {
  return path.join(getResourcesRoot(), 'demo-stress')
}

/** R 包清单（自检 + 诊断用） */
export function getManifestPath(): string {
  return path.join(getResourcesRoot(), 'r-libs-manifest.json')
}

/** 图表主题契约（前端与 R 共用） */
export function getPlotThemePath(): string {
  return path.join(getResourcesRoot(), 'plotTheme.json')
}

/** R 脚本根：打包后在 resources/r，开发期在 <repo>/r */
export function getRScriptsRoot(): string {
  return isDev ? path.join(app.getAppPath(), 'r') : path.join(getResourcesRoot(), 'r')
}

/** 指定 R 根下的 Rscript 可执行文件路径 */
export function getRscriptBinary(root: string = getRRuntimeRoot()): string {
  const bin = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'
  return path.join(root, 'bin', bin)
}

/* ------------------------------------------------------------------ *
 * 可写区（userData）
 * ------------------------------------------------------------------ */

export function getUserDataDir(): string {
  return app.getPath('userData')
}

/** 探测结果缓存 */
export function getProbeCachePath(): string {
  return path.join(getUserDataDir(), 'runtime-probe.json')
}

/** R 的 TMPDIR（绝不用系统 TEMP：中文用户名 + 空格路径会让 R 的 tempdir 出问题） */
export function getTempDir(): string {
  // 允许把临时目录挪到别的盘（开发机上 C 盘空间紧张时用）。
  //
  // 为什么需要这个开关：R 子进程按 TMPDIR 建 `RtmpXXXXXX`，一次几百 MB，
  // 异常退出还不清理。实测一轮功能开发后 TEMP 里堆了 1.18 GB 的 Rtmp，
  // 把系统盘压到只剩 4 GB。设 `DEG_TMP_DIR` 即可让这些落到数据盘。
  //
  // 默认仍然是 userData/tmp —— 不能硬编码某个盘符，用户机器上未必有 D 盘。
  const override = process.env['DEG_TMP_DIR']
  if (override && override.trim().length > 0) return path.resolve(override.trim())
  return path.join(getUserDataDir(), 'tmp')
}

/** 用户自装 R 包目录（R_LIBS_USER，必须可写） */
export function getRlibsUserDir(): string {
  return path.join(getUserDataDir(), 'r-libs-user')
}

/** 主进程日志目录 */
export function getMainLogDir(): string {
  return path.join(getUserDataDir(), 'logs')
}

/** 最近项目列表落盘位置（RecentProjectsStore 用） */
export function getRecentProjectsPath(): string {
  return path.join(getUserDataDir(), 'recent-projects.json')
}

/** 用户设置落盘位置（SettingsStore 用） */
export function getSettingsPath(): string {
  return path.join(getUserDataDir(), 'settings.json')
}

/* ------------------------------------------------------------------ *
 * 项目内路径工具
 * ------------------------------------------------------------------ */

/** 项目内相对路径 → 绝对路径（project.json 里全部存相对路径，保证项目可整包搬移） */
export function resolveInProject(projectRoot: string, rel: string): string {
  return path.join(projectRoot, rel)
}

/** 绝对路径 → 项目内相对路径（POSIX 风格，便于跨平台迁移） */
export function toProjectRelative(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join('/')
}

/** 文件名清洗：去掉 Windows 非法字符，避免导出时写盘失败 */
export function sanitizeFileName(name: string): string {
  // 控制字符（\u0000-\u001f）必须一并剔除：Windows 会拒绝创建含这些字符的文件名。
  // 这条规则就是「有意匹配控制字符」，因此关闭 no-control-regex。
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'untitled'
}

/** 同步确保目录存在（幂等） */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 启动期需要预创建的可写目录 */
export function ensureWritableDirs(): void {
  for (const dir of [getUserDataDir(), getTempDir(), getMainLogDir(), getRlibsUserDir()]) {
    ensureDir(dir)
  }
}

/* ------------------------------------------------------------------ *
 * 可注入的路径服务接口
 * ------------------------------------------------------------------ *
 * RRuntimeResolver / ProjectService 等依赖它而不是直接 import 函数，
 * 这样单测可以传入假实现，无需启动 Electron。
 */
export interface PathService {
  readonly isDev: boolean
  getResourcesRoot(): string
  getPackagedResourcesRoot(): string
  getAppPathRoot(): string
  getRRuntimeRoot(): string
  getRlibsRoot(): string
  getRlibsUserDir(): string
  getRFontsDir(): string
  getRFontPath(): string
  getDemoDir(): string
  /** 压力测试数据集目录（20000 基因 × 48 样本） */
  getDemoStressDir(): string
  getManifestPath(): string
  getPlotThemePath(): string
  getRScriptsRoot(): string
  getRscriptBinary(root?: string): string
  getUserDataDir(): string
  getProbeCachePath(): string
  getTempDir(): string
  getMainLogDir(): string
  getRecentProjectsPath(): string
  getSettingsPath(): string
  resolveInProject(projectRoot: string, rel: string): string
  toProjectRelative(projectRoot: string, abs: string): string
  sanitizeFileName(name: string): string
}

export const pathService: PathService = {
  get isDev() {
    return isDev
  },
  getResourcesRoot,
  getPackagedResourcesRoot,
  getAppPathRoot,
  getRRuntimeRoot,
  getRlibsRoot,
  getRlibsUserDir,
  getRFontsDir,
  getRFontPath,
  getDemoDir,
  getDemoStressDir,
  getManifestPath,
  getPlotThemePath,
  getRScriptsRoot,
  getRscriptBinary,
  getUserDataDir,
  getProbeCachePath,
  getTempDir,
  getMainLogDir,
  getRecentProjectsPath,
  getSettingsPath,
  resolveInProject,
  toProjectRelative,
  sanitizeFileName
}
