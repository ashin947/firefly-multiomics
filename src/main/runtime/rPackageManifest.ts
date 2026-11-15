/**
 * R 包清单（resources/r-libs-manifest.json）的读取与校验。
 *
 * 这份清单是「必需包」的唯一真源：
 *  - check_runtime.R 用它决定要探测哪些包；
 *  - 诊断页用它展示「需要什么 / 有什么 / 缺什么」；
 *  - 它的内容 hash 是探测缓存的失效条件之一（改了清单就必须重探）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'

const packageEntrySchema = z.object({
  name: z.string().min(1),
  /** 期望版本；null 表示不校验版本 */
  version: z.string().nullable().optional(),
  purpose: z.string().default(''),
  required: z.boolean().default(true),
  /**
   * 物种相关包（org.Hs.eg.db / org.Mm.eg.db）标记为 speciesScoped。
   * 这类包**不参与** RRuntimeInfo.ok 的判定：缺 Human 库不该拦住 Mouse 项目，
   * 只有当前项目物种对应的库缺失时才给黄灯提示（见 shared/runtimeStatus.ts）。
   */
  speciesScoped: z.boolean().default(false),
  source: z.enum(['CRAN', 'Bioconductor', 'bundled']).optional(),
  /** 物种相关包标记所属物种 */
  species: z.enum(['human', 'mouse', 'rat', 'zebrafish', 'arabidopsis', 'yeast']).optional()
})

export const packageManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** 构建时使用的 R 版本 */
  rVersion: z.string(),
  bioconductorVersion: z.string().optional(),
  /** 物种 → org.*.eg.db 包名 */
  speciesLibs: z.record(z.string()).default({}),
  packages: z.array(packageEntrySchema)
})

export type PackageManifest = z.infer<typeof packageManifestSchema>
export type ManifestPackage = z.infer<typeof packageEntrySchema>

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** 读取并校验清单；文件缺失或格式错误时抛 ManifestError */
export function readPackageManifest(manifestPath: string): PackageManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestError(`R 包清单不存在：${manifestPath}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new ManifestError(`R 包清单不是合法 JSON：${String(err)}`)
  }
  const parsed = packageManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestError(`R 包清单格式不正确：${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
  }
  return parsed.data
}

/** 文件内容 sha1（用于缓存失效判断）；文件不存在返回空串的 hash，保证逻辑稳定 */
export function hashFile(file: string): string {
  try {
    if (!fs.existsSync(file)) return crypto.createHash('sha1').update('').digest('hex')
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return crypto.createHash('sha1').update('').digest('hex')
  }
}

/** 从清单中取出「核心必需包名」列表（排除物种相关包） */
export function requiredPackageNames(manifest: PackageManifest): string[] {
  return manifest.packages
    .filter((p) => p.required && !p.speciesScoped)
    .map((p) => p.name)
}

/** 从清单中取出「按物种必需」的包名列表（speciesScoped=true） */
export function speciesScopedPackageNames(manifest: PackageManifest): string[] {
  return manifest.packages.filter((p) => p.speciesScoped).map((p) => p.name)
}

/** 从清单中取出「物种 → 包名」映射（缺失时回落到内置默认） */
export function manifestSpeciesLibs(manifest: PackageManifest): Record<string, string> {
  const entries = Object.entries(manifest.speciesLibs)
  if (entries.length > 0) return manifest.speciesLibs
  return { human: 'org.Hs.eg.db', mouse: 'org.Mm.eg.db' }
}
