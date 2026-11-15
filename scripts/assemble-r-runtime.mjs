#!/usr/bin/env node
/**
 * assemble-r-runtime.mjs —— 把用户提供的 R 便携版装配进 resources/runtime（T04 第 5 条）
 *
 * 为什么需要这个脚本：
 *   仓库里**不放** R 二进制（1.5–2.5 GB，且 R 是 GPL，分发方式需法务确认）。
 *   开发者本机要跑通 R 相关功能，用它把本机 R 拷进 resources/runtime/R/，
 *   打包时 electron-builder 的 extraResources 再把它放进安装包。
 *
 * 用法：
 *   npm run assemble:r -- --from "C:/Program Files/R/R-4.3.2"
 *   npm run assemble:r -- --from /opt/R/4.3.2 --libs /home/me/R/library --force
 *   npm run assemble:r                       # 用 R_HOME 环境变量
 *
 * 退出码：0 成功（或已装配且未指定 --force）；2 缺参数；3 源路径不存在；4 源路径不是合法 R；5 拷贝失败
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const TARGET_R = path.join(REPO_ROOT, 'resources', 'runtime', 'R')
const TARGET_LIBS = path.join(REPO_ROOT, 'resources', 'runtime', 'R-libs')

/** R 安装目录里需要随包分发的子目录（doc/tests 之类不拷，省体积） */
const R_SUBDIRS = ['bin', 'lib', 'library', 'etc', 'share', 'modules']

const isWin = process.platform === 'win32'
const RSCRIPT_NAME = isWin ? 'Rscript.exe' : 'Rscript'

function usage() {
  console.log(`
用法: node scripts/assemble-r-runtime.mjs --from <R_HOME> [--libs <R_LIBS_SITE>] [--force]

  --from <path>   本机 R 安装根目录（含 bin/${RSCRIPT_NAME}）。省略时读环境变量 R_HOME
  --libs <path>   额外的 R 包库（site-library），其下每个包会被拷到 resources/runtime/R-libs
  --force         目标已存在时仍然覆盖
  --help          显示本帮助
`)
}

function parseArgs(argv) {
  const opts = { from: process.env.R_HOME || '', libs: '', force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--from') opts.from = argv[++i] ?? ''
    else if (arg === '--libs') opts.libs = argv[++i] ?? ''
    else if (arg === '--force') opts.force = true
    else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      usage()
      process.exit(2)
    }
  }
  return opts
}

/** 递归统计目录体积（字节） */
function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          // 单个文件统计失败不影响总体
        }
      }
    }
  }
  return total
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function isEmptyDir(dir) {
  try {
    return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
  } catch {
    return true
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: false, force: true })
}

function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.from) {
    console.error('错误：未指定 R 安装目录。请用 --from <R_HOME>，或设置环境变量 R_HOME。')
    usage()
    process.exit(2)
  }

  const from = path.resolve(opts.from)
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    console.error(`错误：R 安装目录不存在：${from}`)
    process.exit(3)
  }

  const rscript = path.join(from, 'bin', RSCRIPT_NAME)
  if (!fs.existsSync(rscript)) {
    console.error(`错误：${from} 不是有效的 R 安装目录 —— 未找到 bin/${RSCRIPT_NAME}`)
    console.error(`      请确认路径指向 R 的安装根目录（例如 C:/Program Files/R/R-4.3.2）。`)
    process.exit(4)
  }

  const alreadyAssembled = fs.existsSync(path.join(TARGET_R, 'bin', RSCRIPT_NAME))
  if (alreadyAssembled && !opts.force) {
    console.log(`已装配，跳过：${TARGET_R}`)
    console.log(`（如需覆盖请加 --force）`)
    console.log(`当前体积：R=${human(dirSize(TARGET_R))}，R-libs=${human(dirSize(TARGET_LIBS))}`)
    return
  }

  const startedAt = Date.now()
  console.log(`装配 R 运行时`)
  console.log(`  源      : ${from}`)
  console.log(`  目标 R  : ${TARGET_R}`)
  console.log(`  目标 lib: ${TARGET_LIBS}`)

  try {
    for (const sub of R_SUBDIRS) {
      const src = path.join(from, sub)
      if (!fs.existsSync(src)) {
        console.log(`  跳过不存在的子目录: ${sub}`)
        continue
      }
      console.log(`  拷贝 ${sub}/ ...`)
      copyDir(src, path.join(TARGET_R, sub))
    }
  } catch (err) {
    console.error(`错误：拷贝 R 安装目录失败 —— ${err instanceof Error ? err.message : String(err)}`)
    process.exit(5)
  }

  // 额外的 R 包库（site-library）
  const libsSource = opts.libs || process.env.R_LIBS_SITE || ''
  if (libsSource && fs.existsSync(libsSource)) {
    try {
      fs.mkdirSync(TARGET_LIBS, { recursive: true })
      const entries = fs.readdirSync(libsSource, { withFileTypes: true })
      let copied = 0
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const pkgDir = path.join(libsSource, entry.name)
        // 只拷真正的 R 包（含 DESCRIPTION）
        if (!fs.existsSync(path.join(pkgDir, 'DESCRIPTION'))) continue
        copyDir(pkgDir, path.join(TARGET_LIBS, entry.name))
        copied += 1
      }
      console.log(`  从 ${libsSource} 拷入 ${copied} 个 R 包`)
    } catch (err) {
      console.error(`警告：拷贝 R 包库失败 —— ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (libsSource) {
    console.log(`  警告：指定的 R 包库不存在，已跳过：${libsSource}`)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('')
  console.log('装配完成')
  console.log(`  R       : ${human(dirSize(TARGET_R))}`)
  console.log(`  R-libs  : ${human(dirSize(TARGET_LIBS))}`)
  console.log(`  耗时    : ${elapsed}s`)
  console.log('')
  console.log('下一步：npm run verify:r 校验运行时是否可用')
}

try {
  main()
} catch (err) {
  console.error(`装配失败：${err instanceof Error ? err.stack : String(err)}`)
  process.exit(5)
}
