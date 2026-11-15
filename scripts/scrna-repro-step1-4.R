#!/usr/bin/env Rscript
# =============================================================================
# scrna-repro-step1-4.R —— 单细胞流程「第 1~4 步」独立复现脚本
#
# 用途：不经过软件界面，直接用 R 从原始 10x 目录跑到「聚类 + UMAP/tSNE」，
#       打印每一步的关键数字，便于跟软件里的结果对照。
#
# 这份脚本是**自包含**的：不 source 项目里的 loader.R，也不读 run_config.json，
# 只依赖 Seurat / harmony。目的是让任何人在自己的 R 里能独立验证流程。
#
# 用法：
#   Rscript scrna-repro-step1-4.R <数据根目录>
#   Rscript scrna-repro-step1-4.R D:/ai/data/data/GSE313726_RAW
#   Rscript scrna-repro-step1-4.R <数据根目录> <输出目录>
#
# 数据根目录的结构（每个样本一个子目录，里面是 10x 三件套）：
#   <根目录>/MD/{matrix.mtx.gz, barcodes.tsv.gz, genes.tsv.gz}
#   <根目录>/WW/...
# 支持 CellRanger v2（genes.tsv）与 v3（features.tsv），也支持
# <根目录>/<样本>/outs/filtered_feature_bc_matrix/ 这种嵌套结构。
#
# 与客户原始脚本（scrna-reference.txt）的差异，都写在对应行的注释里。
# =============================================================================

suppressPackageStartupMessages({
  library(Seurat)
  library(SeuratObject)
  library(Matrix)
})

# ---- 参数（默认值 = 客户确认过的口径）--------------------------------------
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  stop("用法: Rscript scrna-repro-step1-4.R <数据根目录> [输出目录]", call. = FALSE)
}
DATA_DIR <- normalizePath(args[1], mustWork = TRUE)
OUT_DIR <- if (length(args) >= 2) args[2] else file.path(getwd(), "scrna-repro-out")

MIN_CELLS <- 3L        # 客户脚本固定值，不要改
MIN_FEATURES <- 100L   # 客户脚本固定值，不要改
MIN_FEATURE_QC <- 200  # 第 2 步：nFeature_RNA > 200（严格大于）
MIN_COUNT_QC <- 500    # 第 2 步：nCount_RNA > 500（严格大于）
MAX_MT <- 0.2          # 第 2 步：percent.mt < 20%（客户脚本没有这条，本流程新增）
N_FEATURES <- 2000     # 高变基因数
N_PCS <- 30            # PCA 维数
RESOLUTION <- 0.25     # 聚类分辨率（客户脚本 0.1，客户改要求为 0.25）

dir.create(OUT_DIR, showWarnings = FALSE, recursive = TRUE)

elapsed <- function(t0) round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
hr <- function(title) cat("\n", strrep("=", 72), "\n", title, "\n", strrep("=", 72), "\n", sep = "")

# ---- 第 1 步：找目录 → 读 10x → 建对象 → 合并 --------------------------------
hr("第 1 步：数据导入与对象构建")
t0 <- Sys.time()

# 找出所有「含 10x 三件套」的目录；取最浅的那一层，样本名 = 该目录的名字
find_10x_dirs <- function(root) {
  hits <- character(0)
  walk <- function(dir, depth) {
    if (depth > 3) return(invisible())
    files <- list.files(dir)
    has_matrix <- any(grepl("^(matrix\\.mtx(\\.gz)?)$", files))
    has_bc <- any(grepl("^(barcodes\\.tsv(\\.gz)?)$", files))
    has_feat <- any(grepl("^(features|genes)\\.tsv(\\.gz)?$", files))
    if (has_matrix && has_bc && has_feat) {
      hits <<- c(hits, dir)
      return(invisible())
    }
    for (sub in list.dirs(dir, recursive = FALSE, full.names = TRUE)) walk(sub, depth + 1)
  }
  walk(root, 0)
  hits
}

pick_file <- function(dir, candidates) {
  for (f in candidates) if (file.exists(file.path(dir, f))) return(f)
  NA_character_
}

dirs <- find_10x_dirs(DATA_DIR)
if (length(dirs) == 0) stop("在 ", DATA_DIR, " 下没有找到 10x 三件套目录", call. = FALSE)

# 样本名：目录名；若目录名是 filtered_feature_bc_matrix 这种容器名，往上取一层
container <- c("filtered_feature_bc_matrix", "filtered_gene_bc_matrices", "outs", "raw_feature_bc_matrix")
sample_of <- function(d) {
  nm <- basename(d)
  p <- d
  while (nm %in% container) {
    p <- dirname(p)
    nm <- basename(p)
  }
  nm
}
names(dirs) <- make.unique(vapply(dirs, sample_of, character(1)))
cat("找到样本：", paste(names(dirs), collapse = ", "), "\n", sep = "")

objs <- list()
for (i in seq_along(dirs)) {
  d <- dirs[[i]]
  nm <- names(dirs)[i]
  mtx <- pick_file(d, c("matrix.mtx.gz", "matrix.mtx"))
  bc <- pick_file(d, c("barcodes.tsv.gz", "barcodes.tsv"))
  feat <- pick_file(d, c("features.tsv.gz", "features.tsv", "genes.tsv.gz", "genes.tsv"))

  # ★ 不用 Read10X()：Seurat 5 的 Read10X 只认 features.tsv.gz，不认 v2 的 genes.tsv.gz
  counts <- Seurat::ReadMtx(
    mtx = file.path(d, mtx),
    cells = file.path(d, bc),
    features = file.path(d, feat),
    feature.column = 2,   # 第 2 列是 symbol；v2 的 genes.tsv 是 id+symbol
    cell.column = 1
  )
  obj <- CreateSeuratObject(
    counts = counts,
    project = nm,
    min.cells = MIN_CELLS,
    min.features = MIN_FEATURES
  )
  obj$orig.ident <- nm
  cat(sprintf("  %-10s %d genes x %d cells  (原始矩阵 %d x %d)\n",
              nm, nrow(obj), ncol(obj), nrow(counts), ncol(counts)))
  objs[[nm]] <- obj
}
rm(counts)

merged <- if (length(objs) == 1L) objs[[1]] else
  merge(objs[[1]], y = objs[-1], add.cell.ids = names(objs), project = "scrna")

# 合并校验：静默丢样本只能靠总数对照发现
expected <- sum(vapply(objs, function(o) as.integer(ncol(o)), integer(1)))
if (ncol(merged) != expected) {
  stop(sprintf("merge 丢细胞了：合并后 %d，各样本之和 %d", ncol(merged), expected), call. = FALSE)
}
cat(sprintf("\n合并：%d 基因 x %d 细胞（校验通过：%d = 各样本之和）\n",
            nrow(merged), ncol(merged), expected))

# ---- 第 2 步：QC 与过滤 -----------------------------------------------------
hr("第 2 步：QC 与过滤")

# percent.mt：不区分大小写的 ^mt-，同时覆盖人(MT-)、鼠(mt-)、水稻(Mt-)
mt_genes <- grep("^mt-", rownames(merged), ignore.case = TRUE, value = TRUE)
cat("线粒体基因：", length(mt_genes), "个\n", sep = "")
if (length(mt_genes) > 0) {
  joined <- JoinLayers(merged)   # Seurat v5 合并后是多层的，取 counts 前要先 Join
  cm <- LayerData(joined, assay = "RNA", layer = "counts")
  pct <- Matrix::colSums(cm[mt_genes, , drop = FALSE]) / Matrix::colSums(cm) * 100
  merged$percent.mt <- as.numeric(pct[colnames(merged)])   # 按细胞名对齐，不靠位置
  cat(sprintf("percent.mt 中位数：%.2f%%\n", median(merged$percent.mt, na.rm = TRUE)))
}

before <- ncol(merged)
keep <- merged$nFeature_RNA > MIN_FEATURE_QC &
  merged$nCount_RNA > MIN_COUNT_QC
if (!is.null(merged$percent.mt)) keep <- keep & merged$percent.mt < MAX_MT * 100
filtered <- subset(merged, cells = colnames(merged)[keep])

cat(sprintf("过滤：%d → %d 细胞（移除 %d，%.2f%%）\n",
            before, ncol(filtered), before - ncol(filtered),
            100 * (before - ncol(filtered)) / before))
cat("  每样本剩余：\n")
print(table(filtered$orig.ident))
rm(merged, joined, cm); invisible(gc())

# ---- 第 3 步：标准化 → 高变基因 → PCA → harmony -----------------------------
hr("第 3 步：标准化 · PCA · 批次校正")
t3 <- Sys.time()

obj <- NormalizeData(filtered, normalization.method = "LogNormalize",
                     scale.factor = 10000, verbose = FALSE)
obj <- FindVariableFeatures(obj, selection.method = "vst",
                            nfeatures = N_FEATURES, verbose = FALSE)
# ★ 只 scale 高变基因：全基因的 scale.data 是稠密矩阵，
#   28525 × 26565 × 8 字节 ≈ 5.6 GB，26k 细胞会直接爆内存。
#   PCA / harmony 只用高变基因，结果与全基因一致。
obj <- ScaleData(obj, features = VariableFeatures(obj), verbose = FALSE)
# ★ RunPCA 的 pc.genes 在 Seurat 5 已废弃，等价写法是 features=
obj <- RunPCA(obj, npcs = N_PCS, features = VariableFeatures(obj), verbose = FALSE)

n_samples <- length(unique(as.character(obj$orig.ident)))
if (n_samples >= 2) {
  th <- Sys.time()
  obj <- IntegrateLayers(obj, method = HarmonyIntegration,
                         orig.reduction = "pca", new.reduction = "harmony",
                         verbose = FALSE)
  active_reduction <- "harmony"
  cat(sprintf("harmony 完成：%.1f s（%d 个样本）\n", elapsed(th), n_samples))
} else {
  active_reduction <- "pca"
  cat("只有 1 个样本，跳过批次校正，下游使用 pca\n")
}
cat(sprintf("3 步合计：%.1f s\n", elapsed(t3)))

# ---- 第 4 步：聚类 + UMAP + tSNE -------------------------------------------
hr("第 4 步：聚类 · UMAP · tSNE")
t4 <- Sys.time()

obj <- FindNeighbors(obj, reduction = active_reduction, dims = 1:N_PCS, verbose = FALSE)
obj <- FindClusters(obj, resolution = RESOLUTION, cluster.name = "clusters", verbose = FALSE)
Idents(obj) <- "clusters"
cat(sprintf("聚类完成：%d 个 cluster（resolution = %.2f）\n",
            length(levels(obj$clusters)), RESOLUTION))

obj <- RunUMAP(obj, reduction = active_reduction, dims = 1:N_PCS,
               reduction.name = "umap", verbose = FALSE)
cat("UMAP 完成\n")

# tSNE 的 perplexity 必须小于 (n-1)/3，细胞少时要自动调小，否则直接报错
n_cells <- ncol(obj)
perp <- min(30, (n_cells - 1) / 3)
if (n_cells >= 20) {
  obj <- RunTSNE(obj, reduction = active_reduction, dims = 1:N_PCS,
                 reduction.name = "tsne", perplexity = perp, check_duplicates = FALSE)
  cat(sprintf("tSNE 完成（perplexity = %.1f）\n", perp))
} else {
  cat("细胞数 < 20，跳过 tSNE\n")
}
cat(sprintf("4 步合计：%.1f s\n", elapsed(t4)))

# ---- 汇总 ----------------------------------------------------------------
hr("汇总（请与软件界面逐项对照）")
cat(sprintf("细胞数            : %d\n", ncol(obj)))
cat(sprintf("基因数            : %d\n", nrow(obj)))
cat(sprintf("高变基因          : %d\n", length(VariableFeatures(obj))))
cat(sprintf("PCA 维数          : %d\n", N_PCS))
cat(sprintf("使用的降维        : %s\n", active_reduction))
cat(sprintf("resolution        : %.2f\n", RESOLUTION))
cat(sprintf("cluster 数        : %d\n", length(levels(obj$clusters))))
cat(sprintf("reductions        : %s\n", paste(Reductions(obj), collapse = ", ")))

tab <- as.data.frame(table(cluster = obj$clusters, sample = obj$orig.ident))
wide <- reshape(tab, idvar = "cluster", timevar = "sample", direction = "wide")
names(wide) <- sub("^Freq\\.", "", names(wide))
wide$total <- rowSums(wide[, -1, drop = FALSE])
cat("\n每个 cluster 的细胞数：\n")
print(wide)

write.csv(wide, file.path(OUT_DIR, "cluster_summary.csv"), row.names = FALSE)
saveRDS(obj, file.path(OUT_DIR, "obj_step4.rds"))
cat("\n中间对象已保存：", file.path(OUT_DIR, "obj_step4.rds"), "\n", sep = "")
cat("cluster 表已保存：", file.path(OUT_DIR, "cluster_summary.csv"), "\n", sep = "")
cat(sprintf("全程耗时：%.1f s\n", elapsed(t0)))

# 打印环境信息：两边结果对不上时，第一件事就是比 Seurat / harmony 版本
cat("\n运行环境：\n")
for (pkg in c("Seurat", "SeuratObject", "harmony")) {
  cat(sprintf("  %-14s %s\n", pkg, as.character(packageVersion(pkg))))
}
cat(sprintf("  %-14s %s\n", "R", paste(R.version$major, R.version$minor, sep = ".")))
