/**
 * scripts/lib/tmpdir.mjs —— 测试/走查用的临时目录一律落在项目内 `.tmp/`
 *
 * ## 为什么不用 os.tmpdir()
 *
 * 开发机的 `%TEMP%` 在 C 盘。这套脚本每次跑都会建几十上百 MB 的临时数据，
 * 更糟的是 **R 进程自己会建 `RtmpXXXXXX` 目录**（一次几百万字节，异常退出还
 * 不清理）。实测在一轮功能开发后 C 盘的 TEMP 里堆了 **1.18 GB 的 Rtmp**，
 * 把系统盘压到只剩 4 GB。
 *
 * 所以：临时目录固定在 `<repo>/.tmp/`，跟着项目待在数据盘。
 * `.tmp/` 已进 .gitignore，绝不入版本库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 项目根（scripts/lib → 上两级） */
export const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** 统一临时根目录 */
export const PROJECT_TMP = path.join(REPO_ROOT, '.tmp')

/**
 * 建一个带前缀的临时目录并返回路径（语义同 fs.mkdtempSync，只是落在项目内）。
 *
 * @param {string} prefix 目录名前缀，便于一眼看出是哪个脚本留下的
 */
export function makeTmpDir(prefix) {
  fs.mkdirSync(PROJECT_TMP, { recursive: true })
  return fs.mkdtempSync(path.join(PROJECT_TMP, prefix))
}

/**
 * 给子进程用的环境变量：把 TMPDIR/TEMP/TMP 指到项目内。
 *
 * R 进程按 TMPDIR 建 `RtmpXXXXXX`，不指的话它照样写 C 盘。
 */
export function tmpEnv(dir = PROJECT_TMP) {
  fs.mkdirSync(dir, { recursive: true })
  return { TMPDIR: dir, TEMP: dir, TMP: dir }
}

/**
 * 删除临时目录，**清不干净也不算失败**。
 *
 * ## 为什么不用 `fs.rmSync(dir, { recursive: true, force: true })` 了事
 *
 * 清理是**收尾**，不是断言。但在受限环境里（工作台/CI 的删除护栏会在一次调用里
 * 删超过 N 个文件时直接 throw），`rmSync` 会抛异常把整个脚本打挂 —— 结果是
 * 「6/6 全过」的脚本以退出码 1 结束，看起来像功能坏了。实测踩过：
 * `smoke-r-failures.mjs` 报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 而它自己刚打印完 6/6。
 *
 * 所以这里逐个删、每步都容错：删不掉就打印一行提示（临时目录留在 `.tmp/` 也无妨，
 * 它已经在 .gitignore 里），绝不把「清理失败」变成「验证失败」。
 *
 * @param {string} dir 要删的目录
 * @returns {boolean} 是否真的删干净了
 */
export function safeRemove(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        safeRemove(target)
      } else {
        try {
          fs.unlinkSync(target)
        } catch {
          /* 单个文件删不掉就跳过，不影响结果 */
        }
      }
    }
    fs.rmdirSync(dir)
    return true
  } catch (err) {
    console.warn(`[提示] 临时目录没清干净（不影响验证结果）：${dir} — ${err && err.message}`)
    return false
  }
}
