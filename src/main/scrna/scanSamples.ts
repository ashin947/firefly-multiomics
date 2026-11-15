/**
 * 10x 样本目录扫描（**只扫文件名，不读矩阵**）。
 *
 * ## 为什么要下钻
 *
 * CellRanger 的输出层级不止一种，客户手里三种都可能有：
 *
 * ```
 * root/MD/{barcodes,genes,matrix}                      ← 本批数据（v2 平铺）
 * root/sample/outs/filtered_feature_bc_matrix/{...}    ← cellranger count 原始输出
 * root/sample/filtered_gene_bc_matrices/GRCh38/{...}   ← 老版本（v2 带基因组层）
 * ```
 *
 * 只认第一层会漏掉后两种；只认固定层级又会在「用户直接选了某个样本目录」时
 * 一个都扫不到。所以用**递归下钻 + 由深到浅判断**：找到含三件套的目录就收，
 * 并把它上层的「样本名」带出来。
 *
 * ## 为什么扫描要快
 *
 * 扫描只做 `existsSync`，绝不打开 matrix.mtx（本批数据单份就有 40 MB，
 * 两份解压后上百万行）。用户点「扫描」要立刻看到列表，读矩阵留到「构建对象」。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ScrnaMatrixLayout, ScrnaScanSample } from '@shared/types/scrna'

/**
 * 这些目录名只是**容器**，不是样本名。
 *
 * `outs` / `filtered_feature_bc_matrix` 是 CellRanger 的固定结构；
 * `GRCh38` / `hg19` / `mm10` 是 v2 时代的基因组层。往上找样本名时要跳过它们，
 * 否则界面上会出现一堆叫「outs」的样本。
 */
const CONTAINER_DIRS = new Set([
  'outs',
  'filtered_feature_bc_matrix',
  'raw_feature_bc_matrix',
  'filtered_gene_bc_matrices',
  'raw_gene_bc_matrices',
  'filtered_gene_bc_matrices_h5',
  'grch38',
  'grch37',
  'hg19',
  'hg38',
  'mm10',
  'mm9',
  'rn6',
  'drosophila_melanogaster_bdgp6'
])

/** 递归深度上限：10x 正常结构不超过 3 层，6 层足够且能防住误选整个磁盘根 */
const MAX_DEPTH = 6

function firstExisting(dir: string, names: string[]): string {
  for (const name of names) {
    if (fs.existsSync(path.join(dir, name))) return name
  }
  return ''
}

/**
 * 判断一个目录是不是 10x 矩阵目录。
 *
 * 三件套缺一不可：`matrix.mtx(.gz)` + `barcodes.tsv(.gz)` + `features.tsv(.gz)` 或 `genes.tsv(.gz)`。
 * v2/v3 的差别只有第三件的文件名，所以两种都认 —— 客户的 GSE313726 是 v2（genes.tsv）。
 */
export function detect10xDir(dir: string): {
  layout: ScrnaMatrixLayout
  files: { matrix: string; barcodes: string; features: string }
} | null {
  const matrix = firstExisting(dir, ['matrix.mtx.gz', 'matrix.mtx'])
  const barcodes = firstExisting(dir, ['barcodes.tsv.gz', 'barcodes.tsv'])
  const features = firstExisting(dir, [
    'features.tsv.gz',
    'features.tsv',
    'genes.tsv.gz',
    'genes.tsv'
  ])
  if (!matrix || !barcodes || !features) return null
  return {
    layout: features.startsWith('features') ? 'v3' : 'v2',
    files: { matrix, barcodes, features }
  }
}

/**
 * 从「找到三件套的目录」往上走，找出样本名。
 *
 * 跳过容器目录（见 `CONTAINER_DIRS`），最多走到 rootDir 的下一层；
 * 一路都是容器名时退回最靠近 rootDir 的那一层目录名。
 */
export function sampleNameOf(rootDir: string, matrixDir: string): string {
  const root = path.resolve(rootDir)
  let cur = path.resolve(matrixDir)
  let fallback = path.basename(cur)

  // 先把自己算作候选（用户直接选了 MD 这种目录时，它就是样本目录）
  // 用带上限的循环而不是 `while (true)`：路径层级再深也不可能超过 16 层，
  // 显式上限既让 lint 满意，也能在 path.dirname 万一不收敛时兜住。
  for (let guard = 0; guard < 16; guard += 1) {
    const base = path.basename(cur)
    if (cur === root) break
    if (!CONTAINER_DIRS.has(base.toLowerCase())) return base
    fallback = base
    const parent = path.dirname(cur)
    if (parent === cur) break
    // 不允许越过 rootDir：再往上就是用户的工作目录，名字与样本无关
    if (path.resolve(parent) === root) {
      // root 本身可能是「样本名」——但它是用户选的根，不能当样本名用
      return fallback
    }
    cur = parent
  }
  return fallback
}

export interface ScanOutcome {
  samples: ScrnaScanSample[]
  scannedDirs: number
}

/**
 * 扫描根目录下的所有 10x 样本。
 *
 * 去重规则：
 *   - 同一目录只收一次；
 *   - 同名样本（`a/MD` 与 `b/MD` 都叫 MD）追加 `-2`、`-3` —— **不能覆盖**，
 *     否则用户会以为少了一个样本；
 *   - `raw_feature_bc_matrix` 与 `filtered_feature_bc_matrix` 并存时**只收 filtered**：
 *     raw 里包含未过滤的全部 barcode，一起导入等于把空液滴也算进细胞数。
 */
export function scanSamples(rootDir: string): ScanOutcome {
  const root = path.resolve(rootDir)
  const found: { dir: string; layout: ScrnaMatrixLayout; files: ScrnaScanSample['files'] }[] = []
  let scannedDirs = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    scannedDirs += 1

    const hit = detect10xDir(dir)
    if (hit) {
      // raw 与 filtered 并存时跳过 raw（filtered 才是「细胞」
      const isRaw = path.basename(dir).toLowerCase().startsWith('raw_')
      const hasFilteredSibling = fs.existsSync(
        path.join(path.dirname(dir), 'filtered_feature_bc_matrix')
      )
      if (!(isRaw && hasFilteredSibling)) {
        found.push({ dir, layout: hit.layout, files: hit.files })
      }
      // 命中就不再往下钻：目录里面不会再有另一个矩阵
      return
    }

    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 没权限的目录直接跳过，不能让一个目录把整次扫描打断
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      walk(path.join(dir, entry.name), depth + 1)
    }
  }

  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    // 根目录本身可能就是样本目录（用户直接选了 MD）
    const rootHit = detect10xDir(root)
    if (rootHit) {
      found.push({ dir: root, layout: rootHit.layout, files: rootHit.files })
    } else {
      walk(root, 0)
    }
  }

  const used = new Map<string, number>()
  const samples: ScrnaScanSample[] = found.map((item) => {
    const base = sampleNameOf(root, item.dir)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return {
      name: n === 1 ? base : `${base}-${n}`,
      dir: item.dir,
      layout: item.layout,
      files: item.files
    }
  })

  // 按名字排序：递归顺序依赖文件系统，不排序的话两次扫描的列表顺序可能不同，
  // 用户改好的样本名会在下次扫描后"跳位"
  samples.sort((a, b) => a.name.localeCompare(b.name))
  return { samples, scannedDirs }
}
