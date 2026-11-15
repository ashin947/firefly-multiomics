/**
 * 最近项目列表（ARCHITECTURE §6.6 / T06 第 4 条）。
 *
 * 规则：
 *  - 最多 20 条，按 updatedAt 降序；
 *  - 同一目录只保留一条（重新打开即刷新到最前）；
 *  - **读取时剔除已不存在的目录**（用户可能删了项目文件夹），并顺手回写。
 *
 * 存储：electron-store（userData/recent-projects.json）。
 * 它不可用（权限/首次启动异常）时降级为纯内存，绝不让首页打不开。
 */
import fs from 'node:fs'
import Store from 'electron-store'
import type { RecentProject } from '@shared/types/project'
import { LIMITS } from '@shared/constants'
import { logger } from '../logger'

interface RecentProjectsSchema {
  recent: RecentProject[]
}

export class RecentProjectsStore {
  private readonly store: Store<RecentProjectsSchema> | null
  /** electron-store 不可用时的降级存储 */
  private memory: RecentProject[] = []

  constructor() {
    try {
      this.store = new Store<RecentProjectsSchema>({
        name: 'recent-projects',
        defaults: { recent: [] }
      })
    } catch (err) {
      logger.warn('project', `初始化最近项目存储失败，降级为内存模式: ${String(err)}`)
      this.store = null
    }
  }

  /** 读取（已剔除失效目录，并按 updatedAt 降序） */
  list(): RecentProject[] {
    const raw = this.store ? this.store.get('recent') : this.memory
    const items = Array.isArray(raw) ? raw : []

    const alive: RecentProject[] = []
    let removed = 0
    for (const item of items) {
      if (!item || typeof item.dir !== 'string') continue
      try {
        if (fs.existsSync(item.dir) && fs.statSync(item.dir).isDirectory()) {
          alive.push(item)
        } else {
          removed += 1
        }
      } catch {
        removed += 1
      }
    }

    const sorted = alive
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, LIMITS.recentProjects)

    if (removed > 0) {
      logger.info('project', `最近项目列表剔除 ${removed} 个已失效目录`)
      this.write(sorted)
    }
    return sorted
  }

  /** 新增或刷新一条（同目录去重） */
  add(item: RecentProject): RecentProject[] {
    const current = this.list().filter((r) => r.dir !== item.dir)
    const next = [item, ...current]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, LIMITS.recentProjects)
    this.write(next)
    return next
  }

  /** 更新某目录的状态/名称（保存项目时调用） */
  touch(dir: string, patch: Partial<RecentProject>): RecentProject[] {
    const current = this.list()
    const existing = current.find((r) => r.dir === dir)
    if (!existing) return current
    return this.add({ ...existing, ...patch })
  }

  remove(dir: string): RecentProject[] {
    const next = this.list().filter((r) => r.dir !== dir)
    this.write(next)
    return next
  }

  clear(): void {
    this.write([])
  }

  private write(items: RecentProject[]): void {
    if (!this.store) {
      this.memory = items
      return
    }
    try {
      this.store.set('recent', items)
    } catch (err) {
      logger.warn('project', `写入最近项目列表失败: ${String(err)}`)
      this.memory = items
    }
  }
}
