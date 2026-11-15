/**
 * 基因 ID 解析器（ARCHITECTURE §9 T08 / PRD R-08）。
 *
 * 职责：
 *  1. 调 `r/probe/map_gene_ids.R`（AnnotationDbi + org.*.eg.db，**完全离线**）做
 *     SYMBOL / ENSEMBL / ENTREZ 互转；
 *  2. 结果落 `data/gene_id_map.json`（项目内可搬移），并在内存里缓存
 *     「同项目 + 同物种 + 同目标类型 + 同 ID 集合」的结果，避免重复起 R 进程；
 *  3. 未映射比例 > 5% 时给出 warning（PRD R-08：无法识别的 ID 数量给出提示）。
 *
 * 为什么要走 R 而不是在 TS 里查表：org.*.eg.db 是 Bioconductor 的 SQLite 注释库，
 * 里面还有同义词/别名等映射关系，自己维护一份必然过时。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PROJECT_FILES } from '@shared/constants'
import { toAppError, type AppError } from '@shared/errors'
import type { GeneIdEntry, GeneIdMap, GeneIdType } from '@shared/types/dataset'
import type { ResolveGeneIdsResult } from '@shared/types/ipc-contract'
import type { Species } from '@shared/types/project'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'
import { createRunId } from '../util/id'

/** 携带结构化错误的解析异常 */
export class GeneIdResolveError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'GeneIdResolveError'
  }
}

/** 未映射比例告警阈值（PRD R-08） */
export const UNMAPPED_WARN_RATIO = 0.05

const geneIdEntrySchema = z.object({
  symbol: z.string().nullable(),
  ensembl: z.string().nullable(),
  entrez: z.string().nullable()
})

const geneIdMapSchema = z.object({
  mapping: z.record(geneIdEntrySchema),
  unmapped: z.array(z.string())
})

export interface ResolveGeneIdsOptions {
  species: Species
  /** 目标类型；'UNKNOWN' 视为 SYMBOL */
  target: GeneIdType
  ids: string[]
  projectRoot: string
}

export class GeneIdResolver {
  /** 内存缓存：key = species|target|idsHash */
  private readonly cache = new Map<string, ResolveGeneIdsResult>()

  constructor(
    private readonly runner: RRunner,
    private readonly paths: PathService
  ) {}

  /** 同项目已解析过的映射（供富集模块直接复用，不再起 R 进程） */
  loadFromDisk(projectRoot: string): GeneIdMap | null {
    const file = path.join(projectRoot, PROJECT_FILES.geneIdMap)
    if (!fs.existsSync(file)) return null
    try {
      const parsed = geneIdMapSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async resolveGeneIds(options: ResolveGeneIdsOptions): Promise<ResolveGeneIdsResult> {
    const target: Exclude<GeneIdType, 'UNKNOWN'> =
      options.target === 'UNKNOWN' ? 'SYMBOL' : options.target
    const ids = dedupe(options.ids)
    if (ids.length === 0) {
      throw new GeneIdResolveError(
        toAppError('E_DATA_EMPTY', { message: '没有可用于 ID 转换的基因列表。' })
      )
    }

    const cacheKey = `${options.species}|${target}|${hashIds(ids)}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      logger.debug('geneid', `命中 ID 映射缓存 ${cacheKey.slice(0, 24)}…`)
      return cached
    }

    const runId = createRunId()
    // 放在 cache/ 下而不是 results/：这是中间产物，不该出现在结果列表里
    const runDir = path.join(options.projectRoot, 'cache', 'gene-id-map', runId)
    const config = {
      runId,
      projectRoot: options.projectRoot,
      runDir,
      themePath: this.paths.getPlotThemePath(),
      fontPath: this.paths.getRFontPath(),
      params: {
        species: options.species,
        ids,
        from: 'AUTO',
        to: target
      }
    }

    // 日志目录必须先建好：RProcessRunner 会往 logs/<runId>.log 追加内容
    try {
      fs.mkdirSync(path.join(options.projectRoot, 'logs'), { recursive: true })
    } catch {
      // 建不了目录时 RProcessRunner 会退化为「不写日志」，不影响映射结果
    }

    const result = await this.runner.run({
      runId,
      scriptRelPath: 'probe/map_gene_ids.R',
      config,
      runDir,
      // ID 映射只是查表，给 5 分钟足够（大基因集 + 慢磁盘也够）
      timeoutMs: 5 * 60 * 1000,
      logFile: path.join(options.projectRoot, 'logs', `${runId}.log`)
    })

    if (!result.ok) {
      throw new GeneIdResolveError(
        result.error ??
          toAppError('E_R_GENEID_MAP', {
            message: '基因 ID 映射失败。',
            detail: result.stderr
          })
      )
    }

    const mapFile = path.join(runDir, 'gene_id_map.json')
    let parsed: GeneIdMap
    try {
      if (!fs.existsSync(mapFile)) {
        throw new Error('gene_id_map.json 未生成')
      }
      const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as unknown
      const check = geneIdMapSchema.safeParse(raw)
      if (!check.success) {
        throw new Error(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      parsed = check.data
    } catch (err) {
      throw new GeneIdResolveError(
        toAppError('E_R_GENEID_MAP', {
          message: '基因 ID 映射结果文件不合法。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    // 落项目内副本（相对路径写进 project.json 之外的地方也能用）
    try {
      const target0 = path.join(options.projectRoot, PROJECT_FILES.geneIdMap)
      fs.mkdirSync(path.dirname(target0), { recursive: true })
      const tmp = `${target0}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8')
      fs.renameSync(tmp, target0)
    } catch (err) {
      logger.warn('geneid', `写入 gene_id_map.json 失败（不影响本次结果）: ${String(err)}`)
    }

    const total = ids.length
    const unmapped = parsed.unmapped.length
    const unmappedRatio = total === 0 ? 0 : unmapped / total

    const summary: ResolveGeneIdsResult = {
      mapping: parsed.mapping as Record<string, GeneIdEntry>,
      unmapped,
      total,
      unmappedRatio,
      target
    }
    if (unmappedRatio > UNMAPPED_WARN_RATIO) {
      summary.warning =
        `${unmapped} / ${total} 个基因 ID 无法转换为 ${target}（${(unmappedRatio * 100).toFixed(
          1
        )}%）。请确认基因 ID 类型选择是否正确，或先做 ID 转换再导入。`
    }

    this.cache.set(cacheKey, summary)
    logger.info(
      'geneid',
      `ID 映射完成 species=${options.species} target=${target} 总数=${total} 未映射=${unmapped} 耗时=${result.durationMs}ms`
    )
    return summary
  }

  /** 清空内存缓存（关闭项目时调用） */
  reset(): void {
    this.cache.clear()
  }
}

/** 去重并去掉空值，保持原顺序 */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** ID 集合的稳定 hash（顺序无关：先排序再 hash，避免同一集合不同顺序重复起进程） */
function hashIds(ids: string[]): string {
  const sorted = [...ids].sort()
  return crypto.createHash('sha1').update(sorted.join('\u0001')).digest('hex').slice(0, 16)
}
