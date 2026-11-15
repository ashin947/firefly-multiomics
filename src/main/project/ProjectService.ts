/**
 * 项目服务：新建 / 打开 / 保存 / 关闭 / 载入示例（ARCHITECTURE §6.6 / T06）。
 *
 * 三条不可妥协的实现细节：
 *  1. **原子写**：project.json 先写 .tmp 再 rename。直接 writeFile 覆盖时若断电/崩溃，
 *     会留下半截 JSON，用户下次打开就是「项目损坏」——这是最容易丢数据的地方。
 *  2. **中断恢复**：lastRun.status === 'running' 说明上次分析没跑完（进程已随软件退出），
 *     打开时改成 interrupted，UI 才能提示「上次分析中断」。
 *  3. 项目内所有路径都存**相对项目根的 POSIX 路径**，用户把 .degproj 拷到别的盘也能打开。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  APP_NAME,
  PROJECT_DIRS,
  PROJECT_FILE,
  PROJECT_FILES,
  PROJECT_SUFFIX
} from '@shared/constants'
import { toAppError, type AppError } from '@shared/errors'
import type {
  DemoVariant,
  OpenProjectResult,
  ProjectCreateRequest,
  ProjectMeta,
  RecentProject
} from '@shared/types/project'
import { logger } from '../logger'
import type { PathService } from '../paths'
import { ProjectSchema, ProjectSchemaError } from './ProjectSchema'
import type { ProjectStore } from './ProjectStore'
import type { RecentProjectsStore } from './RecentProjectsStore'

/** 携带结构化 AppError 的服务层异常（handler 统一转 IpcResult） */
export class ServiceError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message)
    this.name = 'ServiceError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export class ProjectService {
  constructor(
    private readonly paths: PathService,
    private readonly store: ProjectStore,
    private readonly recent: RecentProjectsStore,
    private readonly appVersion: string
  ) {}

  /** 新建项目：建目录树 + 写初始 project.json */
  create(input: ProjectCreateRequest): ProjectMeta {
    const rawName = input.name.trim()
    if (!rawName) {
      throw new ServiceError(toAppError('E_VALIDATION', { message: '项目名称不能为空' }))
    }
    if (!fs.existsSync(input.parentDir)) {
      throw new ServiceError(
        toAppError('E_IO_PERMISSION', {
          message: `父目录不存在：${input.parentDir}`,
          suggestion: '请选择一个已存在的文件夹作为项目保存位置。'
        })
      )
    }

    const { name, root } = this.resolveUniqueRoot(input.parentDir, rawName)

    try {
      for (const dir of PROJECT_DIRS) {
        fs.mkdirSync(path.join(root, dir), { recursive: true })
      }
    } catch (err) {
      throw new ServiceError(
        toAppError('E_IO_PERMISSION', {
          message: `创建项目目录失败：${root}`,
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    const meta = this.createInitialMeta(name, input.species)
    this.atomicWriteJson(path.join(root, PROJECT_FILE), meta)

    this.store.set(meta, root)
    this.recent.add(this.toRecent(meta, root))
    logger.info('project', `新建项目 name=${name} root=${root}`)
    return meta
  }

  /** 打开项目：读取 + 校验 + 迁移 + 中断恢复 */
  open(dir: string): OpenProjectResult {
    const root = path.resolve(dir)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ServiceError(
        toAppError('E_PROJECT_CORRUPT', { message: `项目目录不存在：${root}` })
      )
    }

    const file = path.join(root, PROJECT_FILE)
    if (!fs.existsSync(file)) {
      throw new ServiceError(
        toAppError('E_PROJECT_CORRUPT', {
          message: `未找到 ${PROJECT_FILE}，这可能不是一个「Firefly」项目目录。`,
          suggestion: '请选择以 .degproj 结尾的项目文件夹。'
        })
      )
    }

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      throw new ServiceError(
        toAppError('E_PROJECT_CORRUPT', {
          message: 'project.json 无法解析（文件可能已损坏）。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    let meta: ProjectMeta
    try {
      meta = ProjectSchema.migrate(raw)
    } catch (err) {
      if (err instanceof ProjectSchemaError) throw new ServiceError(err.appError)
      throw err
    }

    // 目录结构自愈：旧版本创建的项目可能缺 figures/cache 等目录
    for (const sub of PROJECT_DIRS) {
      try {
        fs.mkdirSync(path.join(root, sub), { recursive: true })
      } catch {
        // 建不了目录不影响打开（真正写入时会报 E_IO_PERMISSION）
      }
    }

    // 中断恢复：running 状态说明上次分析未正常结束（进程已随软件退出）
    if (meta.lastRun && meta.lastRun.status === 'running') {
      // ★ 单次运行标记 interrupted（而不是 failed）：
      //   failed 表示「分析报错了」，用户该去看日志找原因；
      //   interrupted 表示「分析被打断了」，用户直接重跑即可。
      //   混用会让 PRD US-09 的「人话错误提示」变成误导。
      meta = {
        ...meta,
        status: 'interrupted',
        lastRun: { ...meta.lastRun, status: 'interrupted', finishedAt: nowIso() },
        updatedAt: nowIso()
      }
      this.atomicWriteJson(file, meta)
      logger.warn('project', `检测到上次分析中断，已标记为 interrupted: ${meta.lastRun?.runId}`)
    }

    this.store.set(meta, root)
    this.recent.add(this.toRecent(meta, root))
    logger.info('project', `打开项目 name=${meta.name} root=${root} status=${meta.status}`)
    return { meta, dataset: meta.dataset }
  }

  /** 保存（浅合并 patch）并原子落盘 */
  save(patch: Partial<ProjectMeta>): ProjectMeta {
    const root = this.store.getRoot()
    const current = this.store.get()
    if (!root || !current) {
      throw new ServiceError(toAppError('E_VALIDATION', { message: '当前没有打开的项目' }))
    }

    const merged: ProjectMeta = { ...current, ...patch, updatedAt: nowIso() }
    let validated: ProjectMeta
    try {
      validated = ProjectSchema.validate(merged)
    } catch (err) {
      if (err instanceof ProjectSchemaError) {
        throw new ServiceError(
          toAppError('E_VALIDATION', {
            message: err.appError.message,
            detail: err.appError.detail
          })
        )
      }
      throw err
    }

    this.atomicWriteJson(path.join(root, PROJECT_FILE), validated)
    this.store.set(validated, root)
    this.recent.touch(root, {
      name: validated.name,
      status: validated.status,
      species: validated.species,
      updatedAt: validated.updatedAt
    })
    return validated
  }

  /** 关闭当前项目（只清内存态，不删文件） */
  close(): void {
    const root = this.store.getRoot()
    this.store.clear()
    logger.info('project', `关闭项目 ${root ?? '(无)'}`)
  }

  /**
   * 载入示例数据：新建项目 + 把 resources/demo 的 CSV 拷进 data/。
   *
   * `parentDir` 为空串表示「用默认位置」= `userData/demo-projects`：
   * 示例项目是给用户熟悉流程用的，不该逼他先选一个保存目录，
   * 也不该散落在用户真正的工作目录里。
   *
   * 说明：dataset 摘要（2000×24、分组、问题清单）由 IPC 层的 `project.loadDemo`
   * 用真实的 MatrixImporter / GroupImporter / DataValidator 产出 —— 项目服务不重复
   * 实现 CSV 解析，避免两套解析逻辑产生不一致的摘要。
   */
  loadDemo(parentDir: string, variant: DemoVariant = 'default'): ProjectMeta {
    const isStress = variant === 'stress'
    const demoDir = isStress ? this.paths.getDemoStressDir() : this.paths.getDemoDir()
    const demoExpression = path.join(demoDir, 'expression.csv')
    const demoGroups = path.join(demoDir, 'groups.csv')

    if (!fs.existsSync(demoExpression)) {
      throw new ServiceError(
        toAppError('E_UNKNOWN', {
          title: '示例数据缺失',
          message: `未找到 ${demoExpression}`,
          suggestion: isStress
            ? '请执行 npm run gen:demo:stress 重新生成压力测试数据。'
            : '请重新安装软件，或执行 npm run gen:demo 重新生成示例数据。'
        })
      )
    }

    // 空串 → 默认位置（见方法注释）
    const targetDir =
      parentDir.trim().length > 0 ? parentDir : path.join(this.paths.getUserDataDir(), 'demo-projects')
    try {
      fs.mkdirSync(targetDir, { recursive: true })
    } catch (err) {
      throw new ServiceError(
        toAppError('E_IO_PERMISSION', {
          message: `无法创建示例项目目录：${targetDir}`,
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    const meta = this.create({
      name: isStress ? '压力测试数据（48 样本 × 20000 基因）' : '示例数据（24 样本 × 2000 基因）',
      species: 'human',
      parentDir: targetDir
    })
    const root = this.store.requireRoot()

    try {
      // raw 与 clean 初始相同：示例数据已是干净数据，用户若重新导入会覆盖 clean
      fs.copyFileSync(demoExpression, path.join(root, PROJECT_FILES.rawMatrix))
      fs.copyFileSync(demoExpression, path.join(root, PROJECT_FILES.cleanMatrix))
      if (fs.existsSync(demoGroups)) {
        fs.copyFileSync(demoGroups, path.join(root, PROJECT_FILES.groups))
      }
    } catch (err) {
      throw new ServiceError(
        toAppError('E_IO_PERMISSION', {
          message: '复制示例数据到项目目录失败。',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }

    logger.info('project', `载入示例数据 root=${root}`)
    return meta
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  private createInitialMeta(name: string, species: ProjectMeta['species']): ProjectMeta {
    const ts = nowIso()
    return {
      schemaVersion: 1,
      projectId: crypto.randomUUID(),
      name,
      species,
      createdAt: ts,
      updatedAt: ts,
      appVersion: this.appVersion || APP_NAME,
      status: 'imported',
      dataType: 'counts',
      analyses: [],
      enrichRuns: [],
      plots: {}
    }
  }

  /** 同名目录已存在且非空时自动加序号（类似「新建文件夹 (2)」），避免用户操作失败 */
  private resolveUniqueRoot(parentDir: string, baseName: string): { name: string; root: string } {
    let name = baseName
    let root = path.join(parentDir, `${this.paths.sanitizeFileName(name)}${PROJECT_SUFFIX}`)
    let i = 1
    for (;;) {
      let occupied = false
      try {
        occupied = fs.existsSync(root) && fs.readdirSync(root).length > 0
      } catch {
        occupied = fs.existsSync(root)
      }
      if (!occupied) break
      i += 1
      name = `${baseName} (${i})`
      root = path.join(parentDir, `${this.paths.sanitizeFileName(name)}${PROJECT_SUFFIX}`)
    }
    return { name, root }
  }

  private toRecent(meta: ProjectMeta, root: string): RecentProject {
    return {
      dir: root,
      name: meta.name,
      species: meta.species,
      status: meta.status,
      updatedAt: meta.updatedAt
    }
  }

  /** 原子写：tmp + rename（同目录 rename 在 NTFS/ext4 上是原子操作） */
  private atomicWriteJson(file: string, data: unknown): void {
    const tmp = `${file}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        // 清理失败不影响错误上报
      }
      throw new ServiceError(
        toAppError('E_IO_PERMISSION', {
          message: `写入 ${PROJECT_FILE} 失败：${file}`,
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }
}
