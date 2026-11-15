/**
 * 全局子进程注册表 + 「真正 kill」（ARCHITECTURE §6.2 / 附录 A.3）。
 *
 * 为什么不能只调 child.kill()：
 *  Rscript.exe 在 Windows 上可能再 fork（future / parallel / BiocParallel 后端），
 *  只杀父进程会留下孤儿进程继续吃 CPU，用户以为「取消了」其实还在跑。
 *  所以 Windows 用 `taskkill /T /F` 杀整棵树，POSIX 用进程组 `kill(-pid)`。
 */
import { execFile, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { LIMITS } from '@shared/constants'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

export interface ChildRecord {
  runId: string
  child: ChildProcess
  startedAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 计时器不应阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
  })
}

export class ChildProcessManager {
  private readonly map = new Map<string, ChildRecord>()

  register(runId: string, child: ChildProcess): void {
    this.map.set(runId, { runId, child, startedAt: Date.now() })
  }

  /** 进程正常结束后必须调用，否则注册表会一直持有已退出的 ChildProcess（内存泄漏） */
  unregister(runId: string): void {
    this.map.delete(runId)
  }

  has(runId: string): boolean {
    return this.map.has(runId)
  }

  count(): number {
    return this.map.size
  }

  list(): { runId: string; pid: number | undefined; startedAt: number }[] {
    return [...this.map.values()].map((r) => ({
      runId: r.runId,
      pid: r.child.pid,
      startedAt: r.startedAt
    }))
  }

  /**
   * 终止一个任务。
   * @returns 是否确实有进程被终止（runId 不存在时返回 false）
   */
  async kill(runId: string): Promise<boolean> {
    const rec = this.map.get(runId)
    if (!rec) return false
    const { child } = rec

    // 先挂 exit 监听再发信号，避免「进程在两者之间退出」导致永久等待
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })

    if (process.platform === 'win32' && child.pid) {
      try {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } catch (err) {
        // taskkill 对「进程已退出」会返回非 0，属正常情况，不应中断清理流程
        logger.debug('proc', `taskkill 返回异常（通常为进程已退出）: ${String(err)}`)
      }
    } else if (child.pid) {
      try {
        // 负 pid = 整个进程组（spawn 时 detached: true 建立了独立进程组）
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程已不存在
        }
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已不存在
      }
    }

    await Promise.race([exited, sleep(LIMITS.killWaitMs)])
    this.map.delete(runId)
    logger.info('proc', `已终止子进程 runId=${runId} pid=${child.pid ?? '?'}`)
    return true
  }

  /** 退出前清理全部子进程（before-quit 调用，必须 await） */
  async killAll(): Promise<void> {
    const runIds = [...this.map.keys()]
    if (runIds.length === 0) return
    await Promise.all(runIds.map((id) => this.kill(id).catch(() => false)))
  }

  /** 最后兜底：will-quit 阶段同步尽力杀，不 await */
  killAllSync(): void {
    for (const { child } of this.map.values()) {
      if (!child.pid) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
      }
    }
    this.map.clear()
  }
}
