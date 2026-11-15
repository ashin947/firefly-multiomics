/**
 * 当前项目的内存态（唯一真源）。
 *
 * 为什么需要它：project.json 是落盘形态，但 UI 与各服务需要频繁读「当前项目」，
 * 每次读文件既慢又可能读到写一半的状态。所有变更走 patch()，落盘由 ProjectService 负责。
 */
import type { ProjectMeta } from '@shared/types/project'

export type ProjectSubscriber = (meta: ProjectMeta | null) => void

export class ProjectStore {
  private current: ProjectMeta | null = null
  /** 当前项目根目录（绝对路径，.degproj 文件夹本身） */
  private root: string | null = null
  private readonly listeners = new Set<ProjectSubscriber>()

  get(): ProjectMeta | null {
    return this.current
  }

  getRoot(): string | null {
    return this.root
  }

  has(): boolean {
    return this.current !== null
  }

  /** 取当前项目，未打开时抛错（调用方应先用 has() 判断） */
  require(): ProjectMeta {
    if (!this.current) {
      throw new Error('当前没有打开的项目')
    }
    return this.current
  }

  requireRoot(): string {
    if (!this.root) {
      throw new Error('当前没有打开的项目')
    }
    return this.root
  }

  set(meta: ProjectMeta | null, root: string | null = null): void {
    this.current = meta
    this.root = meta ? root : null
    this.emit()
  }

  /**
   * 浅合并更新。
   * @returns 更新后的项目；未打开项目时返回 null（不抛错，便于防抖保存）
   */
  patch(partial: Partial<ProjectMeta>): ProjectMeta | null {
    if (!this.current) return null
    this.current = { ...this.current, ...partial }
    this.emit()
    return this.current
  }

  subscribe(fn: ProjectSubscriber): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  clear(): void {
    this.current = null
    this.root = null
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.current)
      } catch {
        // 订阅者异常不应影响其它订阅者
      }
    }
  }
}
