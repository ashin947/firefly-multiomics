/**
 * R 运行时解析器（ARCHITECTURE §6.1 / T04）。
 *
 * 三级探测（短路，命中即停）：
 *   1. <resourcesPath>/runtime/R/bin/Rscript      —— 打包后的生产形态
 *   2. <appPath>/resources/runtime/R/bin/Rscript  —— 开发期形态
 *   3. PATH 中的 Rscript                          —— 开发者本机已装 R
 *
 * 缓存策略（userData/runtime-probe.json）：
 *   命中条件：rscriptPath 存在 + mtime/size 未变 + manifest hash 未变 + 未超过 7 天。
 *   命中时**同步返回**（保证首页秒开），随后后台静默重探（stale-while-revalidate），
 *   结果有变化才发 deg:event:runtimeChanged。
 *
 * 关键健壮性要求：三级都找不到时必须返回 ok:false 且带可读原因，**绝不能让主进程崩溃**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MIN_R_VERSION, PROBE_CACHE_TTL_MS } from '@shared/constants'
import { missingPackagesFor } from '@shared/runtimeStatus'
import type { AnalysisMethodId } from '@shared/types/project'
import type {
  RPackageStatus,
  RRuntimeInfo,
  RuntimeCandidate,
  RuntimeMethodStatus,
  RuntimeProbeCache,
  RuntimeProbeResult,
  RuntimeSource
} from '@shared/types/runtime'
import { logger, type LoggerLike } from '../logger'
import type { PathService } from '../paths'
import type { RProcessRunner } from '../process/RProcessRunner'
import {
  hashFile,
  manifestSpeciesLibs,
  readPackageManifest,
  requiredPackageNames,
  type PackageManifest
} from './rPackageManifest'
import { RRuntimeProbe } from './RRuntimeProbe'

/** 可注入依赖（单测不需要启动 Electron，也不需要真 R） */
export interface RuntimeResolverDeps {
  existsSync?: (p: string) => boolean
  statSync?: (p: string) => { mtimeMs: number; size: number } | null
  which?: (cmd: string) => string | null
  readTextFile?: (p: string) => string | null
  writeTextFile?: (p: string, data: string) => void
  log?: LoggerLike
  now?: () => number
  /** 探测结果变化时通知（context 里接 webContents.send） */
  onChanged?: (info: RRuntimeInfo) => void
  /** 关闭后台 stale-while-revalidate（单测用，避免不确定的异步行为） */
  disableRevalidate?: boolean
  /**
   * 用户在设置里指定的 R 路径（Rscript 可执行文件，或 R 安装根目录）。
   * 客户机器上 R 常装在 `D:\R-4.3.2` 且不在 PATH —— 这是真实场景，
   * 因此自定义路径**优先级最高**（用户显式指定就该赢过一切自动探测）。
   */
  customRPath?: () => string | null
  /**
   * 已注册的分析方法及其声明的 R 包（来自 `AnalysisRegistry`）。
   *
   * 为什么是回调而不是数组：`registry` 的模块注册发生在 resolver 构造之后
   * （`registerBuiltinModules()`），传数组会拿到空列表。回调在每次 buildInfo 时求值，
   * 顺序问题自然消失。
   *
   * 传空/不传时 `info.methods` 为空数组 —— 灯与文案都会退化为「只看 missingPackages」，
   * 不会凭空报缺（单测里通常不注册模块）。
   */
  methodSpecs?: () => MethodPackageSpec[]
}

/** 一种方法在环境层面的包依赖（resolver 只需要这些，不碰业务逻辑） */
export interface MethodPackageSpec {
  id: AnalysisMethodId
  label: string
  requiredPackages: string[]
}

/** 在 PATH 中查找可执行文件（Windows 需要遍历 PATHEXT） */
function whichSync(cmd: string): string | null {
  const dirs = (process.env['PATH'] ?? process.env['Path'] ?? '')
    .split(path.delimiter)
    .filter((d) => d.trim().length > 0)
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter((e) => e.trim().length > 0)
      : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        // 权限不足等：继续找下一个
      }
    }
  }
  return null
}

export class RRuntimeResolver {
  private memoryCache: RuntimeProbeCache | null = null
  private inflight: Promise<RRuntimeInfo> | null = null
  private revalidating = false
  private manifestCache: PackageManifest | null = null
  private readonly runtimeProbe: RRuntimeProbe
  private readonly log: LoggerLike

  constructor(
    runner: RProcessRunner,
    private readonly paths: PathService,
    private readonly deps: RuntimeResolverDeps = {}
  ) {
    this.runtimeProbe = new RRuntimeProbe(runner, paths)
    this.log = deps.log ?? logger
  }

  /* ---------------------------------------------------------------- *
   * 公共 API
   * ---------------------------------------------------------------- */

  /** 三级探测 + 缓存；force=true 跳过缓存 */
  async resolve(opts: { force?: boolean } = {}): Promise<RRuntimeInfo> {
    const force = opts.force === true
    if (!force) {
      const cached = this.memoryCache ?? this.loadCache()
      if (cached && this.isCacheValid(cached)) {
        this.memoryCache = cached
        const info = this.buildInfo(cached.result, cached.rscriptPath, cached.probedAt)
        this.scheduleRevalidate(cached)
        return info
      }
    }
    return this.probeAndBuild()
  }

  /** 候选 Rscript 路径，按优先级排列（含存在性标记，供诊断页展示） */
  candidates(): RuntimeCandidate[] {
    const bin = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'
    const build = (root: string): string => path.join(root, 'bin', bin)

    const list: RuntimeCandidate[] = []
    const push = (candidate: RuntimeCandidate): void => {
      // 开发期第 1、2 级可能指向同一个路径，去重避免诊断页出现重复行
      if (candidate.path && list.some((c) => c.path === candidate.path)) return
      list.push(candidate)
    }

    // ⓪ 用户指定（最高优先级）
    for (const custom of this.customCandidatePaths(bin)) {
      push({
        path: custom,
        source: 'custom',
        exists: this.exists(custom),
        label: `⓪ 用户指定（${custom}）`
      })
    }

    const level1 = build(path.join(this.paths.getPackagedResourcesRoot(), 'runtime', 'R'))
    push({
      path: level1,
      source: 'bundled',
      exists: this.exists(level1),
      label: '① 打包内置（resources/runtime/R）'
    })

    const level2 = build(path.join(this.paths.getAppPathRoot(), 'resources', 'runtime', 'R'))
    push({
      path: level2,
      source: 'bundled',
      exists: this.exists(level2),
      label: '② 开发期目录（<app>/resources/runtime/R）'
    })

    const systemPath = this.which('Rscript')
    push({
      path: systemPath ?? '',
      source: 'system',
      exists: Boolean(systemPath),
      label: systemPath ? `③ 系统 PATH（${systemPath}）` : '③ 系统 PATH（未找到 Rscript）'
    })

    return list
  }

  /** 能力自检（调 probe/check_runtime.R） */
  async probe(rscriptPath: string): Promise<RuntimeProbeResult> {
    return this.runtimeProbe.run(rscriptPath)
  }

  /**
   * 探测一个**显式指定**的 Rscript 路径（设置页「校验」按钮用）。
   *
   * 与 resolve() 的区别：不写缓存、不改候选链、不影响当前生效的运行时 ——
   * 用户可能只是「试一试」，试完不保存就不该污染全局状态。
   */
  async probeExplicit(inputPath: string): Promise<RRuntimeInfo> {
    const bin = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'
    const candidates = this.normalizeCustomPaths(inputPath, bin)
    const hit = candidates.find((p) => this.exists(p))
    if (!hit) {
      return {
        ok: false,
        source: 'custom',
        rscriptPath: '',
        rHome: null,
        version: '',
        arch: '',
        libPaths: [],
        packages: [],
        missingPackages: [],
        missingSpeciesLibs: [],
        speciesLibs: { human: false, mouse: false },
        fontAvailable: false,
        probedAt: new Date(this.now()).toISOString(),
        methods: [],
        warnings: [
          `路径不存在或不是可执行文件：${inputPath}`,
          `已尝试：${candidates.join('；')}`,
          '请指向 Rscript.exe，或 R 安装根目录（如 D:\\R-4.3.2）。'
        ]
      }
    }
    try {
      const result = await this.probe(hit)
      return this.buildInfo(result, hit, new Date(this.now()).toISOString())
    } catch (err) {
      return {
        ok: false,
        source: 'custom',
        rscriptPath: hit,
        rHome: null,
        version: '',
        arch: '',
        libPaths: [],
        packages: [],
        missingPackages: [],
        missingSpeciesLibs: [],
        speciesLibs: { human: false, mouse: false },
        fontAvailable: false,
        probedAt: new Date(this.now()).toISOString(),
        methods: [],
        warnings: [`该路径无法运行 R：${err instanceof Error ? err.message : String(err)}`]
      }
    }
  }

  /** 自定义路径的全部候选形态（原样 / <dir>/bin / <dir>/bin/x64） */
  private normalizeCustomPaths(input: string, bin: string): string[] {
    const trimmed = input.trim().replace(/^"+|"+$/g, '')
    if (!trimmed) return []
    const base = path.basename(trimmed).toLowerCase()
    const binLower = bin.toLowerCase()
    // 已经指向可执行文件：原样返回
    if (base === binLower || base === 'rscript' || base === 'rscript.exe') return [trimmed]
    const list = [path.join(trimmed, 'bin', bin)]
    if (process.platform === 'win32') list.push(path.join(trimmed, 'bin', 'x64', bin))
    return list
  }

  /** 当前生效的自定义候选（用户没设置时为空数组） */
  private customCandidatePaths(bin: string): string[] {
    const raw = this.deps.customRPath?.() ?? null
    if (!raw) return []
    return this.normalizeCustomPaths(raw, bin)
  }

  /** 清空缓存（用户点「重新检测」或清单变更时） */
  invalidate(): void {
    this.memoryCache = null
    this.manifestCache = null
    try {
      const file = this.paths.getProbeCachePath()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (err) {
      this.log.warn('runtime', `删除探测缓存失败: ${String(err)}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * 内部实现
   * ---------------------------------------------------------------- */

  private exists(p: string): boolean {
    if (this.deps.existsSync) return this.deps.existsSync(p)
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }

  private stat(p: string): { mtimeMs: number; size: number } | null {
    if (this.deps.statSync) return this.deps.statSync(p)
    try {
      const s = fs.statSync(p)
      return { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  }

  private which(cmd: string): string | null {
    if (this.deps.which) return this.deps.which(cmd)
    return whichSync(cmd)
  }

  private readText(p: string): string | null {
    if (this.deps.readTextFile) return this.deps.readTextFile(p)
    try {
      if (!fs.existsSync(p)) return null
      return fs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }

  private writeText(p: string, data: string): void {
    if (this.deps.writeTextFile) {
      this.deps.writeTextFile(p, data)
      return
    }
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, p)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** 读取包清单（失败降级为空清单，不影响「R 是否存在」的判断） */
  private manifest(): PackageManifest {
    if (this.manifestCache) return this.manifestCache
    try {
      this.manifestCache = readPackageManifest(this.paths.getManifestPath())
    } catch (err) {
      this.log.warn('runtime', `读取 R 包清单失败: ${String(err)}`)
      this.manifestCache = {
        schemaVersion: 1,
        rVersion: '',
        speciesLibs: { human: 'org.Hs.eg.db', mouse: 'org.Mm.eg.db' },
        packages: []
      }
    }
    return this.manifestCache
  }

  private currentManifestHash(): string {
    return hashFile(this.paths.getManifestPath())
  }

  private loadCache(): RuntimeProbeCache | null {
    const text = this.readText(this.paths.getProbeCachePath())
    if (!text) return null
    try {
      const raw = JSON.parse(text) as Partial<RuntimeProbeCache>
      if (!raw || typeof raw !== 'object') return null
      if (typeof raw.rscriptPath !== 'string' || raw.rscriptPath.length === 0) return null
      if (!raw.result || typeof raw.result !== 'object') return null
      if (typeof raw.probedAt !== 'string') return null
      return {
        rscriptPath: raw.rscriptPath,
        rscriptMtimeMs: typeof raw.rscriptMtimeMs === 'number' ? raw.rscriptMtimeMs : -1,
        rscriptSize: typeof raw.rscriptSize === 'number' ? raw.rscriptSize : -1,
        manifestHash: typeof raw.manifestHash === 'string' ? raw.manifestHash : '',
        result: raw.result,
        probedAt: raw.probedAt
      }
    } catch {
      return null
    }
  }

  /** 缓存是否仍然有效（任一条件不满足即失效） */
  private isCacheValid(cache: RuntimeProbeCache): boolean {
    if (!this.exists(cache.rscriptPath)) return false

    const stat = this.stat(cache.rscriptPath)
    if (!stat) return false
    if (cache.rscriptMtimeMs !== stat.mtimeMs) return false
    if (cache.rscriptSize !== stat.size) return false

    if (cache.manifestHash !== this.currentManifestHash()) return false

    const probedAtMs = Date.parse(cache.probedAt)
    if (Number.isNaN(probedAtMs)) return false
    if (this.now() - probedAtMs > PROBE_CACHE_TTL_MS) return false

    return true
  }

  private async probeAndBuild(): Promise<RRuntimeInfo> {
    if (this.inflight) return this.inflight
    this.inflight = this.doProbe().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doProbe(): Promise<RRuntimeInfo> {
    const candidates = this.candidates()
    const hit = candidates.find((c) => c.exists)

    // 三级都找不到：返回结构化失败信息（**不抛异常**，主进程必须活着）
    if (!hit || !hit.path) {
      const info = this.buildNotFoundInfo(candidates)
      this.log.warn('runtime', '未检测到任何 R 运行时')
      return info
    }

    try {
      const result = await this.probe(hit.path)
      const probedAt = new Date(this.now()).toISOString()
      const info = this.buildInfo(result, hit.path, probedAt)

      const cache: RuntimeProbeCache = {
        rscriptPath: hit.path,
        rscriptMtimeMs: this.stat(hit.path)?.mtimeMs ?? -1,
        rscriptSize: this.stat(hit.path)?.size ?? -1,
        manifestHash: this.currentManifestHash(),
        result,
        probedAt
      }
      this.memoryCache = cache
      try {
        this.writeText(this.paths.getProbeCachePath(), JSON.stringify(cache, null, 2))
      } catch (err) {
        // 缓存写不进去只影响下次启动速度，不影响功能
        this.log.warn('runtime', `写入探测缓存失败: ${String(err)}`)
      }
      this.log.info(
        'runtime',
        `R 探测完成 path=${hit.path} version=${info.version} ok=${info.ok} 缺失包=${info.missingPackages.length}`
      )
      return info
    } catch (err) {
      // 找到 Rscript 但自检跑不起来（损坏/被杀软拦截/缺 DLL）：仍返回可读信息
      const message = err instanceof Error ? err.message : String(err)
      const info: RRuntimeInfo = {
        ok: false,
        source: hit.source,
        rscriptPath: hit.path,
        rHome: null,
        version: '',
        arch: '',
        libPaths: [],
        packages: [],
        missingPackages: [],
        missingSpeciesLibs: [],
        speciesLibs: { human: false, mouse: false },
        fontAvailable: false,
        probedAt: new Date(this.now()).toISOString(),
        methods: [],
        warnings: [`R 环境自检失败：${message}`]
      }
      this.log.error('runtime', 'R 能力自检失败', err)
      return info
    }
  }

  /** 后台静默重探（stale-while-revalidate） */
  private scheduleRevalidate(cached: RuntimeProbeCache): void {
    if (this.deps.disableRevalidate || this.revalidating) return
    this.revalidating = true
    // 记录「返回给 UI 的那份」，重探后与之比对，变了才通知
    const previousSignature = JSON.stringify(this.buildInfo(cached.result, cached.rscriptPath, cached.probedAt))
    // 用 setTimeout(0) 让出当前事件循环，保证 resolve() 是「同步返回」语义
    setTimeout(() => {
      void (async () => {
        try {
          const fresh = await this.doProbe()
          const freshSignature = JSON.stringify(fresh)
          if (freshSignature !== previousSignature) {
            this.log.info('runtime', '后台重探发现运行时变化，已通知 UI')
            this.deps.onChanged?.(fresh)
          }
        } catch (err) {
          this.log.debug('runtime', `后台重探失败（忽略）: ${String(err)}`)
        } finally {
          this.revalidating = false
        }
      })()
    }, 0)
  }

  /** 校验版本 >= 4.2.0 */
  private checkVersion(version: string): boolean {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    const patch = Number(match[3] ?? '0')
    const min = MIN_R_VERSION.split('.').map((n) => Number(n))
    const minMajor = min[0] ?? 4
    const minMinor = min[1] ?? 2
    const minPatch = min[2] ?? 0
    if (major !== minMajor) return major > minMajor
    if (minor !== minMinor) return minor > minMinor
    return patch >= minPatch
  }

  private sourceOf(rscriptPath: string): RuntimeSource {
    // 用户指定的路径优先判定：即使它恰好位于内置目录下，也应显示「用户指定」，
    // 这样用户才能确认「我填的路径真的生效了」。
    const custom = this.deps.customRPath?.() ?? null
    if (custom) {
      const bin = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'
      if (this.normalizeCustomPaths(custom, bin).includes(rscriptPath)) return 'custom'
    }
    const bundledRoots = [
      path.join(this.paths.getPackagedResourcesRoot(), 'runtime', 'R'),
      path.join(this.paths.getAppPathRoot(), 'resources', 'runtime', 'R')
    ]
    return bundledRoots.some((root) => rscriptPath.startsWith(root)) ? 'bundled' : 'system'
  }

  private buildInfo(
    result: RuntimeProbeResult,
    rscriptPath: string,
    probedAt: string
  ): RRuntimeInfo {
    const required = requiredPackageNames(this.manifest())
    const packages = result.packages

    // 缺失包 = 核心必需包中「探测到但不可用」+「清单要求但 R 完全没报告」的
    // ★ 物种注释库（speciesScoped）不在此列：它由 missingSpeciesLibs 单独表达，
    //   只有当前项目物种对应的库缺失时才提示（见 shared/runtimeStatus.ts）。
    const missing: string[] = packages
      .filter((p) => p.required && !p.ok && !this.isSpeciesScoped(p.name))
      .map((p) => p.name)
    for (const name of required) {
      if (!packages.some((p) => p.name === name) && !missing.includes(name)) missing.push(name)
    }

    // 物种注释库缺失清单（非阻断）
    const missingSpeciesLibs: string[] = []
    for (const [species, pkg] of Object.entries(manifestSpeciesLibs(this.manifest()))) {
      const flags = result.speciesLibs as Record<string, boolean | undefined>
      if (!flags[species]) missingSpeciesLibs.push(pkg)
    }

    const versionOk = this.checkVersion(result.rVersion)
    const fontAvailable = result.fontFamilies.includes('DEGSans')

    // 按方法判包：缺 DESeq2 不该让 limma-voom 显示为不可用。
    // ★ 缺失包的计算走 `missingPackagesFor()`（shared/runtimeStatus），
    //   `RProcessRunner` / `AnalysisRunner` 起进程前的门禁用的是同一个函数 —— 不可能分叉。
    const methods = this.buildMethods(missing, packages)

    const warnings: string[] = []
    if (!versionOk) {
      warnings.push(`R 版本 ${result.rVersion || '未知'} 低于要求的 ${MIN_R_VERSION}，可能无法正常运行分析。`)
    }
    if (missing.length > 0) {
      warnings.push(`缺少必需 R 包：${missing.join('、')}`)
    }
    if (!fontAvailable) {
      warnings.push('未检测到内置中文字体 DEGSans，图表中的中文可能显示为方框（可用回退字体出图）。')
    }
    // 物种库只提示、不阻断（做 Mouse 项目的人不该被缺 Human 库拦住）
    for (const pkg of missingSpeciesLibs) {
      const label = pkg === 'org.Hs.eg.db' ? 'Human' : pkg === 'org.Mm.eg.db' ? 'Mouse' : pkg
      warnings.push(`未安装 ${label} 物种注释库（${pkg}）：对应物种的项目将无法做基因名映射与 GO 富集。`)
    }

    return {
      ok: versionOk && missing.length === 0,
      source: this.sourceOf(rscriptPath),
      rscriptPath,
      rHome: result.rHome ?? null,
      version: result.rVersion,
      arch: result.rArch,
      libPaths: result.libPaths ?? [],
      packages,
      missingPackages: missing,
      missingSpeciesLibs,
      speciesLibs: result.speciesLibs,
      fontAvailable,
      probedAt,
      warnings,
      methods
    }
  }

  /**
   * 把「注册表里的方法 + 缺失包」拼成逐方法的可用性。
   *
   * 只有这里算一次。首页灯、诊断页、预检、起 R 前的门禁全部读这份结果
   * （或读同一个 `missingPackagesFor()`），因此不会出现「首页说能用、跑起来说缺包」。
   */
  private buildMethods(missing: readonly string[], packages: RPackageStatus[]): RuntimeMethodStatus[] {
    const specs = this.deps.methodSpecs?.() ?? []
    const probe = { missingPackages: [...missing], packages }
    return specs.map((spec) => {
      const missingForMethod = missingPackagesFor(probe, spec.requiredPackages)
      return {
        id: spec.id,
        label: spec.label,
        requiredPackages: [...spec.requiredPackages],
        missingPackages: missingForMethod,
        available: missingForMethod.length === 0
      }
    })
  }

  /** 该包是否是「按物种必需」的注释库（不参与 ok 判定） */
  private isSpeciesScoped(packageName: string): boolean {
    return this.manifest().packages.some((p) => p.name === packageName && p.speciesScoped)
  }

  private buildNotFoundInfo(candidates: RuntimeCandidate[]): RRuntimeInfo {
    const tried = candidates.map((c) => `  · ${c.label}`).join('\n')
    return {
      ok: false,
      source: 'bundled',
      rscriptPath: '',
      rHome: null,
      version: '',
      arch: '',
      libPaths: [],
      packages: [],
      missingPackages: [],
      missingSpeciesLibs: [],
      speciesLibs: { human: false, mouse: false },
      fontAvailable: false,
      probedAt: new Date(this.now()).toISOString(),
      methods: [],
      warnings: [
        '未检测到 R 运行环境。已尝试以下位置：',
        tried,
        '修复方式：① 把 R 便携版放到 resources/runtime/R/（需含 bin/Rscript）；② 执行 npm run assemble:r 自动装配；③ 安装 R 4.2+ 并加入 PATH。'
      ]
    }
  }
}
