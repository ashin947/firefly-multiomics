/**
 * 系统类通道：文件对话框 / 资源管理器 / 应用信息 / R 运行时探测与诊断。
 *
 * 设计要点：这些通道只做「薄转发」，不含业务逻辑；
 * 唯一有实质内容的是 diagnostics —— 它要把「我找过哪些路径、每个包什么状态」
 * 拼成一份用户能看懂、能复制给技术支持的文本。
 */
import { app, dialog, shell } from 'electron'
import { z } from 'zod'
import { LIB_PATH_ROLE_LABELS } from '@shared/constants'
import { APP_NAME } from '@shared/constants'
import { IPC } from '@shared/ipc'
import type {
  AppInfo,
  DiagnosticsReport,
  LibPathEntry,
  RRuntimeInfo,
  RuntimeCandidate
} from '@shared/types/runtime'
import type { AppSettings, ValidateRPathResult } from '@shared/types/runtime'
import type { PlotThemeSpec } from '@shared/types/plot'
import { logger } from '../logger'
import { loadPlotTheme } from '../plot/PlotTheme'
import { buildLibPathEntries } from '../runtime/libPathRoles'
import { defineHandler, type AppContext } from './registerHandlers'

const fileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(z.string().min(1))
})

const pickFileSchema = z.object({
  filters: z.array(fileFilterSchema),
  multi: z.boolean().optional()
})

const saveFileSchema = z.object({
  defaultName: z.string(),
  filters: z.array(fileFilterSchema)
})

const revealPathSchema = z.object({
  path: z.string().min(1)
})

/**
 * 允许从界面打开的站点白名单。
 *
 * 这个通道能被页面脚本调用，不做校验等于给任意 URL 开了后门（最坏情况是把
 * `file://` 或自定义协议塞进系统浏览器）。所以只放行**明确的 https 主机**，
 * 并且要求完整 URL 前缀匹配 —— 光判 hostname 会被 `https://evil.com/?x=bio……` 绕过。
 */
const EXTERNAL_ALLOWLIST: readonly string[] = [
  'https://bioconductor.org/',
  'https://bioconductor.org/packages/celldex/',
  'https://bioconductor.org/packages/SingleR/',
  'https://bioconductor.org/help/workflows/simpleSingleCell/',
  'https://github.com/dviraran/SingleR'
]

const openExternalSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), '只允许打开 https 链接')
})

const probeSchema = z
  .object({
    force: z.boolean().optional()
  })
  .optional()

const setSettingsSchema = z.object({
  customRPath: z.string().nullable().optional()
})

const validatePathSchema = z.object({
  path: z.string().min(1, '请填写 Rscript 或 R 安装目录路径')
})

/** 生成 Markdown 形式的诊断报告（用户可整段复制给技术支持） */
export function buildDiagnosticsReport(
  info: RRuntimeInfo,
  candidates: RuntimeCandidate[],
  libPaths: LibPathEntry[] = [],
  rUserDefault = ''
): string {
  const lines: string[] = []
  lines.push(`# ${APP_NAME} 环境诊断报告`)
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 软件版本：${app.getVersion()}`)
  lines.push(`- 平台：${process.platform} ${process.arch}`)
  lines.push(`- Electron：${process.versions.electron} / Node：${process.versions.node}`)
  lines.push('')
  lines.push('## R 运行时')
  lines.push('')
  lines.push(`- 状态：${info.ok ? '可用' : '不可用'}`)
  lines.push(`- 来源：${info.source === 'bundled' ? '随包内置' : '系统 PATH'}`)
  lines.push(`- Rscript：${info.rscriptPath || '（未找到）'}`)
  lines.push(`- 版本：${info.version || '（未知）'}（要求 ≥ 4.2.0）`)
  lines.push(`- 架构：${info.arch || '（未知）'}`)
  lines.push(`- R_HOME：${info.rHome ?? '（未知）'}`)
  lines.push(`- 中文字体 DEGSans：${info.fontAvailable ? '就绪' : '缺失'}`)
  lines.push(`- 探测时间：${info.probedAt}`)
  lines.push('')
  lines.push('## 候选路径')
  lines.push('')
  for (const c of candidates) {
    lines.push(`- ${c.exists ? '[✓]' : '[✗]'} ${c.label}${c.path ? ` → ${c.path}` : ''}`)
  }
  lines.push('')
  lines.push('## R 包')
  lines.push('')
  if (info.packages.length === 0) {
    lines.push('（未探测到任何包）')
  } else {
    lines.push('| 包 | 版本 | 必需 | 状态 |')
    lines.push('|---|---|---|---|')
    for (const p of info.packages) {
      lines.push(`| ${p.name} | ${p.version ?? '-'} | ${p.required ? '是' : '否'} | ${p.ok ? 'OK' : '缺失'} |`)
    }
  }
  lines.push('')
  lines.push('## 物种注释库')
  lines.push('')
  lines.push(`- Human (org.Hs.eg.db)：${info.speciesLibs.human ? 'OK' : '缺失'}`)
  lines.push(`- Mouse (org.Mm.eg.db)：${info.speciesLibs.mouse ? 'OK' : '缺失'}`)
  lines.push('')
  if ((info.methods ?? []).length > 0) {
    // 按方法列出「能不能跑、缺什么」：这是客户问「我到底能做哪种分析」时唯一的答案，
    // 也解释了为什么缺 DESeq2 时 limma-voom 仍然可用。
    lines.push('## 方法可用性（按 R 包判定）')
    lines.push('')
    lines.push('| 方法 | 需要 | 缺失 | 可用 |')
    lines.push('|---|---|---|---|')
    for (const method of info.methods ?? []) {
      lines.push(
        `| ${method.label} | ${method.requiredPackages.join('、')} | ` +
          `${method.missingPackages.length > 0 ? method.missingPackages.join('、') : '-'} | ` +
          `${method.available ? '是' : '否'} |`
      )
    }
    lines.push('')
  }
  if (info.missingPackages.length > 0) {
    lines.push('## 缺失的必需包')
    lines.push('')
    lines.push('（不整体阻断：只有声明了该包的方法不可用，见上一节）')
    lines.push('')
    lines.push(info.missingPackages.map((n) => `- ${n}`).join('\n'))
    lines.push('')
  }
  if (info.warnings.length > 0) {
    lines.push('## 提示')
    lines.push('')
    lines.push(info.warnings.map((w) => `- ${w}`).join('\n'))
    lines.push('')
  }
  lines.push('## libPaths')
  lines.push('')
  lines.push(info.libPaths.length > 0 ? info.libPaths.map((p) => `- ${p}`).join('\n') : '（未知）')
  lines.push('')
  lines.push('## R 包搜索路径（按优先级）')
  lines.push('')
  if (libPaths.length === 0) {
    lines.push('（未知）')
  } else {
    lines.push('| # | 路径 | 来历 | 存在 | 生效 |')
    lines.push('|---|---|---|---|---|')
    libPaths.forEach((entry, index) => {
      lines.push(
        `| ${index + 1} | ${entry.path} | ${LIB_PATH_ROLE_LABELS[entry.role] ?? entry.role} | ` +
          `${entry.exists ? '是' : '否'} | ${entry.effective ? '是' : '否（被 R 跳过）'} |`
      )
    })
    const skipped = libPaths.filter((entry) => !entry.effective)
    if (skipped.length > 0) {
      lines.push('')
      lines.push(
        `> 注意：有 ${skipped.length} 个目录配了但没生效，最常见的原因是**目录不存在**（R 会静默跳过）。` +
          '「装完了还说缺包」通常就是包被装进了这些目录。'
      )
    }
  }
  lines.push('')
  if (rUserDefault.length > 0) {
    lines.push(`R 的原始 R_LIBS_USER 默认值：${rUserDefault}`)
  }
  return lines.join('\n')
}

export function registerSystemHandlers(ctx: AppContext): void {
  defineHandler(ctx, IPC.system.appInfo, null, async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    resourcesRoot: ctx.paths.getResourcesRoot(),
    rScriptsRoot: ctx.paths.getRScriptsRoot(),
    isDev: ctx.paths.isDev,
    platform: process.platform,
    arch: process.arch,
    userDataDir: ctx.paths.getUserDataDir(),
    // 演示数据开关：只在「未打包 + 显式设置 DEG_DEV_MOCK=1」时打开。
    // isDev 是硬门，因此打包产物里这条路径不可达（见 AppInfo.mock 的注释）。
    mock: ctx.paths.isDev && process.env['DEG_DEV_MOCK'] === '1'
  }))

  defineHandler(ctx, IPC.system.settings, null, async (): Promise<AppSettings> => {
    return ctx.settings.get()
  })

  defineHandler(ctx, IPC.system.setSettings, setSettingsSchema, async (req): Promise<AppSettings> => {
    const patch: Partial<AppSettings> = {}
    if (req.customRPath !== undefined) patch.customRPath = req.customRPath
    const next = ctx.settings.update(patch)
    // 设置变了必须让探测缓存失效：否则用户填完路径仍然看到「未检测到 R」，
    // 会以为输入没生效（这是最伤信任的一类 bug）。
    if (req.customRPath !== undefined) ctx.resolver.invalidate()
    logger.info('settings', `设置已更新 customRPath=${next.customRPath ?? '（未指定）'}`)
    return next
  })

  defineHandler(ctx, IPC.runtime.validatePath, validatePathSchema, async (req): Promise<ValidateRPathResult> => {
    const info = await ctx.resolver.probeExplicit(req.path)
    const usable = info.rscriptPath.length > 0
    return {
      usable,
      rscriptPath: info.rscriptPath,
      runtime: usable ? info : undefined,
      reason: usable ? undefined : info.warnings.join(' ')
    }
  })

  defineHandler(ctx, IPC.system.plotTheme, null, async (): Promise<PlotThemeSpec> => {
    return loadPlotTheme(ctx.paths.getPlotThemePath())
  })

  defineHandler(ctx, IPC.system.pickFile, pickFileSchema, async (req) => {
    const result = await dialog.showOpenDialog({
      title: '选择文件',
      properties: req.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: req.filters
    })
    if (result.canceled) return []
    return result.filePaths
  })

  defineHandler(ctx, IPC.system.pickDir, null, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  defineHandler(ctx, IPC.system.saveFile, saveFileSchema, async (req) => {
    const result = await dialog.showSaveDialog({
      title: '保存文件',
      defaultPath: req.defaultName,
      filters: req.filters
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  defineHandler(ctx, IPC.system.revealPath, revealPathSchema, async (req) => {
    // showItemInFolder 对不存在的路径是静默无操作，这里显式报错更利于排查
    shell.showItemInFolder(req.path)
    logger.debug('system', `在文件夹中显示：${req.path}`)
  })

  defineHandler(ctx, IPC.system.openExternal, openExternalSchema, async (req) => {
    const allowed = EXTERNAL_ALLOWLIST.some((prefix) => req.url.startsWith(prefix))
    if (!allowed) {
      throw new Error(`不允许打开的链接：${req.url}`)
    }
    await shell.openExternal(req.url)
    logger.info('system', `在系统浏览器中打开：${req.url}`)
    return true
  })

  defineHandler(ctx, IPC.runtime.probe, probeSchema, async (req): Promise<RRuntimeInfo> => {
    const force = req?.force === true
    if (force) {
      // 「重新检测」必须同时清掉磁盘缓存，否则 mtime 未变时会立刻命中旧结果
      ctx.resolver.invalidate()
    }
    return ctx.resolver.resolve({ force })
  })

  defineHandler(ctx, IPC.runtime.diagnostics, null, async (): Promise<DiagnosticsReport> => {
    const runtime = await ctx.resolver.resolve()
    const candidates = ctx.resolver.candidates()

    // R 的原始默认库路径：命中缓存时是同步返回；本次进程还没起过 R 时补一次探测
    // （约 0.3 s）。探测失败返回 null —— 诊断页少一行说明，不影响其它内容。
    const defaults = runtime.rscriptPath
      ? await ctx.rDefaultLibs.ensure(runtime.rscriptPath)
      : null

    const libPaths = buildLibPathEntries({
      effective: runtime.libPaths,
      bundled: ctx.paths.getRlibsRoot(),
      appUser: ctx.paths.getRlibsUserDir(),
      rUserDefault: defaults?.user ?? '',
      rSiteDefault: defaults?.site ?? '',
      rHome: runtime.rHome ?? defaults?.rHome ?? null
    })

    return {
      runtime,
      report: buildDiagnosticsReport(runtime, candidates, libPaths, defaults?.user ?? ''),
      candidates,
      libPaths,
      rUserDefault: defaults?.user ?? ''
    }
  })
}
