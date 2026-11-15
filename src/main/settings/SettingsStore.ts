/**
 * 用户级设置的持久化（userData/settings.json）。
 *
 * 为什么不用 electron-store：
 *  这里只有一个字段，而 electron-store 在 v8 + Electron 30 组合下会拉进
 *  conf/ajv 一整条依赖链，并且对「写入时机早于 app ready」很敏感。
 *  自己写 40 行（含原子写与损坏兜底）比调依赖更可控。
 *
 * 容错原则：设置文件损坏/字段类型不对时**回落默认值并 warn**，
 * 绝不让一个坏的 settings.json 把应用挡在启动门外。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppSettings } from '@shared/types/runtime'
import { logger } from '../logger'

const settingsSchema = z.object({
  customRPath: z.string().min(1).nullable().default(null)
})

export const DEFAULT_SETTINGS: AppSettings = { customRPath: null }

export class SettingsStore {
  private cache: AppSettings | null = null

  constructor(private readonly filePath: string) {}

  /** 读取设置（内存缓存；文件不存在/损坏返回默认值） */
  get(): AppSettings {
    if (this.cache) return this.cache
    this.cache = this.read()
    return this.cache
  }

  /** 部分更新并落盘，返回更新后的完整设置 */
  update(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.get(), ...patch }
    // 空字符串视为「清除自定义路径」，避免用户清空输入框后存了个空串
    if (next.customRPath !== null && next.customRPath.trim() === '') next.customRPath = null
    this.cache = next
    this.write(next)
    return next
  }

  /** 当前自定义 R 路径（供 RRuntimeResolver 的候选链读取） */
  customRPath(): string | null {
    const value = this.get().customRPath
    return value && value.trim().length > 0 ? value.trim() : null
  }

  private read(): AppSettings {
    try {
      if (!fs.existsSync(this.filePath)) return { ...DEFAULT_SETTINGS }
      const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      const parsed = settingsSchema.safeParse(raw)
      if (!parsed.success) {
        logger.warn('settings', `设置文件格式不正确，已回落默认值：${this.filePath}`)
        return { ...DEFAULT_SETTINGS }
      }
      return { customRPath: parsed.data.customRPath }
    } catch (err) {
      logger.warn('settings', `读取设置失败，已回落默认值：${String(err)}`)
      return { ...DEFAULT_SETTINGS }
    }
  }

  /** 原子写：先写 tmp 再 rename，避免断电留下半个 JSON */
  private write(settings: AppSettings): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      // 写不进去只影响「下次启动记不住」，不影响本次使用
      logger.warn('settings', `保存设置失败：${String(err)}`)
    }
  }
}
