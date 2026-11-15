#!/usr/bin/env node
/**
 * gen-r-libs-manifest.mjs —— 扫描已装配的 R 包，刷新 resources/r-libs-manifest.json 的版本号
 *
 * 为什么需要它：
 *   清单里的 version 字段在仓库中是 null（我们不入库 R 包）。
 *   打包前跑一次本脚本，就能把「这个安装包里实际带的包版本」写进清单，
 *   用户反馈问题时我们能准确知道对方装的是什么版本。
 *
 * 用法：
 *   node scripts/gen-r-libs-manifest.mjs
 *   node scripts/gen-r-libs-manifest.mjs --strict   # 有必需包缺失时退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const MANIFEST = path.join(REPO_ROOT, 'resources', 'r-libs-manifest.json')
const LIB_DIRS = [
  path.join(REPO_ROOT, 'resources', 'runtime', 'R-libs'),
  // 便携版 R 自带的 library（base + recommended）
  path.join(REPO_ROOT, 'resources', 'runtime', 'R', 'library')
]

const strict = process.argv.includes('--strict')

/** 从 DESCRIPTION 里读 Version 字段 */
function readPackageVersion(pkgDir) {
  const desc = path.join(pkgDir, 'DESCRIPTION')
  if (!fs.existsSync(desc)) return null
  const text = fs.readFileSync(desc, 'utf8')
  // DESCRIPTION 是 DCF 格式：`Version: 3.1.2`，可能跨行续写但 Version 不会
  const match = /^Version:\s*(\S+)\s*$/m.exec(text)
  return match ? match[1] : null
}

function scanInstalledPackages() {
  const found = new Map()
  for (const dir of LIB_DIRS) {
    if (!fs.existsSync(dir)) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pkgDir = path.join(dir, entry.name)
      const version = readPackageVersion(pkgDir)
      if (version) found.set(entry.name, version)
    }
  }
  return found
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`错误：清单不存在：${MANIFEST}`)
    process.exit(2)
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const installed = scanInstalledPackages()

  if (installed.size === 0) {
    console.warn('警告：未在 resources/runtime 下找到任何 R 包（先执行 npm run assemble:r）。清单未改动。')
    if (strict) process.exit(1)
    return
  }

  let updated = 0
  const missing = []
  for (const pkg of manifest.packages ?? []) {
    const version = installed.get(pkg.name)
    if (version) {
      if (pkg.version !== version) {
        pkg.version = version
        updated += 1
      }
    } else if (pkg.required) {
      missing.push(pkg.name)
    }
  }

  manifest.generatedAt = new Date().toISOString()
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`R 包清单已刷新：${MANIFEST}`)
  console.log(`  扫描到 ${installed.size} 个已安装包，更新 ${updated} 条版本记录`)
  if (missing.length > 0) {
    console.warn(`  警告：${missing.length} 个必需包未安装：${missing.join('、')}`)
    if (strict) process.exit(1)
  }
}

try {
  main()
} catch (err) {
  console.error(`刷新清单失败：${err instanceof Error ? err.stack : String(err)}`)
  process.exit(2)
}
