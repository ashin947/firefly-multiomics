/**
 * R 能力自检（调 r/probe/check_runtime.R）。
 *
 * 为什么不在 Node 里自己判断：
 *  「有没有装某个包」「包的版本是多少」只有 R 自己知道（.libPaths() 受环境影响）。
 *  让 R 跑一次自检并把结果以协议消息回传，是唯一可靠的判断方式。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import type { RPackageStatus, RuntimeProbeResult } from '@shared/types/runtime'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RProcessRunner } from '../process/RProcessRunner'
import {
  manifestSpeciesLibs,
  readPackageManifest,
  requiredPackageNames,
  type PackageManifest
} from './rPackageManifest'

export class RRuntimeProbe {
  constructor(
    private readonly runner: RProcessRunner,
    private readonly paths: PathService
  ) {}

  /** 读取包清单（失败时返回一个「空清单」，让自检至少能跑起来并报告 R 版本） */
  readManifest(): PackageManifest {
    try {
      return readPackageManifest(this.paths.getManifestPath())
    } catch (err) {
      logger.warn('runtime', `读取 R 包清单失败，将使用空清单: ${String(err)}`)
      return {
        schemaVersion: 1,
        rVersion: '',
        speciesLibs: { human: 'org.Hs.eg.db', mouse: 'org.Mm.eg.db' },
        packages: []
      }
    }
  }

  /**
   * 对指定 Rscript 执行自检。
   * @throws AppError 包装后的错误（调用方决定是否降级为 warnings）
   */
  async run(rscriptPath: string): Promise<RuntimeProbeResult> {
    const manifest = this.readManifest()
    const requiredPackages = requiredPackageNames(manifest)
    const speciesLibs = manifestSpeciesLibs(manifest)

    // 自检的运行目录放在 userData/tmp 下：可写、且不会污染项目
    const runDir = path.join(this.paths.getTempDir(), `probe-${Date.now().toString(36)}`)
    fs.mkdirSync(runDir, { recursive: true })

    const config = {
      runId: `probe-${Date.now().toString(36)}`,
      projectRoot: runDir,
      runDir,
      themePath: this.paths.getPlotThemePath(),
      fontPath: this.paths.getRFontPath(),
      params: {
        requiredPackages,
        speciesLibs,
        // 期望的字体族名：R 侧注册成功后会出现在 fontFamilies 里
        fontFamily: 'DEGSans'
      }
    }

    const result = await this.runner.run({
      runId: config.runId,
      scriptRelPath: path.join('probe', 'check_runtime.R'),
      config,
      runDir,
      rscriptPath,
      timeoutMs: 60_000,
      logFile: path.join(runDir, 'probe.log')
    })

    if (!result.ok) {
      const err = result.error ?? toAppError('E_RT_MISSING', { message: 'R 能力自检失败' })
      throw err
    }

    const summary = result.summary ?? {}
    return this.normalize(summary, requiredPackages)
  }

  /**
   * 把 R 回传的 summary 收敛成 RuntimeProbeResult。
   * R 侧的 JSON 结构可能与 TS 类型有细微差异（null/空数组/字符串数字），
   * 这里做一次防御性归一化，避免脏数据流到 UI。
   */
  private normalize(summary: Record<string, unknown>, requiredPackages: string[]): RuntimeProbeResult {
    const asString = (v: unknown, fallback = ''): string =>
      typeof v === 'string' ? v : v == null ? fallback : String(v)

    const packagesRaw = Array.isArray(summary.packages) ? summary.packages : []
    const packages: RPackageStatus[] = packagesRaw
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => {
        const name = asString(p.name)
        const version = typeof p.version === 'string' && p.version.length > 0 ? p.version : null
        const ok = p.ok === true
        const required =
          typeof p.required === 'boolean' ? p.required : requiredPackages.includes(name)
        return { name, version, ok, required }
      })

    const speciesRaw =
      typeof summary.speciesLibs === 'object' && summary.speciesLibs !== null
        ? (summary.speciesLibs as Record<string, unknown>)
        : {}
    const fontFamilies = Array.isArray(summary.fontFamilies)
      ? summary.fontFamilies.filter((f): f is string => typeof f === 'string')
      : []
    const libPaths = Array.isArray(summary.libPaths)
      ? summary.libPaths.filter((f): f is string => typeof f === 'string')
      : []

    return {
      rVersion: asString(summary.rVersion),
      rArch: asString(summary.rArch),
      platform: asString(summary.platform, process.platform),
      packages,
      speciesLibs: {
        human: speciesRaw.human === true,
        mouse: speciesRaw.mouse === true
      },
      fontFamilies,
      libPaths,
      rHome: typeof summary.rHome === 'string' ? summary.rHome : undefined
    }
  }
}
