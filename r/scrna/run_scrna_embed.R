# =============================================================================
# r/scrna/run_scrna_embed.R —— 单细胞流程第 4 步：聚类 · UMAP · tSNE
#
# ## 对照客户脚本（docs/reference/scrna-reference.txt:76-91）
#
#   pcSelect = 30
#   combined <- FindNeighbors(combined1, reduction = harmony, dims = 1:pcSelect)
#   combined <- FindClusters(combined, resolution = 0.1, cluster.name = harmony_clusters)
#   #pbmc <- RunTSNE(object = pbmc, dims = 1:pcSelect)          ← 客户注释掉了
#   combined <- RunUMAP(combined, reduction = harmony, dims = 1:pcSelect,
#                       reduction.name = umap.harmony)
#
# 三处必须偏离：
#
# 1. **resolution 用 0.25**（客户后来改的）。0.1 在 2.6 万细胞上只切出几个大类，
#    他自己说的。0.25 是他的选择，不是我们拍的。
#
# 2. **聚类列名叫 `clusters`，不叫 `harmony_clusters`**。单样本时根本没有 harmony，
#    列名带 harmony 会让后续所有引用（Marker、注释、下游）都建立在错误前提上。
#
# 3. **reduction 名固定成 `umap` / `tsne`**，不带 `.harmony` 后缀。两种模式
#    （多样本 harmony / 单样本 pca）共用同一套名字，下游就不必再分支判断。
#
# 4. **tSNE 要跑**（客户脚本里注释掉了，但需求里明确要求）。
#    tSNE 在 2.6 万细胞上是分钟级，所以单独报耗时、单独推进度。
#
# ## 调色板：不能用客户脚本的 color74
#
# 客户脚本里 `color74 <- c( #0f82bf, #e92633, ...)` —— **每个颜色前面都有 `#`**，
# 整段被注释掉了，`color74` 实际是**空向量**。照抄会给 DimPlot 一个空 palette，
# 表现为「所有 cluster 同色」或直接报错。这里用 Seurat 自带的 DiscretePalette 生成。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))
source(file.path(.deg_root, "scrna", "common_levels.R"))
source(file.path(.deg_root, "scrna", "common_palette.R"))

.scrna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

.scrna_num <- function(ctx, name, default) {
  v <- suppressWarnings(as.numeric(.scrna_param(ctx, name, default)))
  if (length(v) != 1L || is.na(v)) default else v
}

#' 保存一张图；失败只 warn
.scrna_save <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

deg_main("scrna/run_scrna_embed.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "jsonlite", "data.table"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step3.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("step-3 object not found: ", basename(objPath), " (run the normalization/PCA step first)"),
             status = 12L)
  }
  resolution <- .scrna_num(ctx, "resolution", 0.25)
  if (resolution <= 0 || resolution > 5) {
    deg_stop("E_VALIDATION", paste0("resolution out of range (0, 5]: ", resolution), status = 11L)
  }

  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)

  # ---- reduction 与 dims：**从对象自己身上读** ---------------------------
  reductionsAvailable <- names(obj@reductions)
  activeReduction <- .scrna_param(ctx, "activeReduction", NULL)
  if (is.null(activeReduction) || !nzchar(as.character(activeReduction))) {
    activeReduction <- obj@misc$activeReduction
  }
  if (is.null(activeReduction) || !nzchar(as.character(activeReduction))) {
    # 兜底：老对象没有 misc 字段时按「有 harmony 就用 harmony」
    activeReduction <- if ("harmony" %in% reductionsAvailable) "harmony" else "pca"
    emit_log("warn", sprintf("activeReduction not recorded in the object; inferred '%s' from reductions (%s)",
                             activeReduction, paste(reductionsAvailable, collapse = ", ")))
  }
  activeReduction <- as.character(activeReduction)
  if (!activeReduction %in% reductionsAvailable) {
    deg_stop("E_DATA_INVALID",
             sprintf("reduction '%s' not found in the object (available: %s)",
                     activeReduction, paste(reductionsAvailable, collapse = ", ")),
             status = 13L)
  }

  nPcs <- .scrna_param(ctx, "nPcs", NULL)
  if (is.null(nPcs)) nPcs <- obj@misc$nPcs
  if (is.null(nPcs)) nPcs <- 30L
  nPcs <- as.integer(nPcs)
  # 维度不能超过该 reduction 实际有的维数
  dimsAvailable <- ncol(Seurat::Embeddings(obj, activeReduction))
  if (nPcs > dimsAvailable) {
    emit_log("warn", sprintf("nPcs (%d) exceeds available dims (%d); using %d",
                             nPcs, dimsAvailable, dimsAvailable))
    nPcs <- as.integer(dimsAvailable)
  }

  emit_log("info", sprintf("object: %d genes x %d cells; using reduction '%s' with dims 1:%d",
                           nrow(obj), ncol(obj), activeReduction, nPcs))
  emit_log("info", sprintf("clustering resolution = %s (client changed 0.1 -> 0.25)", resolution))

  # ---- 1. 近邻 + 聚类 -----------------------------------------------------
  emit_progress("test", 12, sprintf("FindNeighbors (%s, dims 1:%d)", activeReduction, nPcs))
  obj <- Seurat::FindNeighbors(obj, reduction = activeReduction, dims = 1:nPcs, verbose = FALSE)

  emit_progress("test", 25, sprintf("FindClusters (resolution %s)", resolution))
  tCluster <- Sys.time()
  obj <- Seurat::FindClusters(obj, resolution = resolution, cluster.name = "clusters",
                              verbose = FALSE)
  clusterSeconds <- as.numeric(difftime(Sys.time(), tCluster, units = "secs"))
  # ★ 列名叫 clusters（不带 harmony 前缀）：单样本时没有 harmony，
  #   带前缀的列名会让下游所有引用建立在错误前提上。
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_RESULT_INVALID", "FindClusters did not create the 'clusters' column", status = 13L)
  }
  # ★ 必须按**数字序**设 levels：默认 factor 是字典序（0 1 10 11 2 …），
  #   会一路影响热图色带、小提琴分面、结果表排序，以及第 6/8 步的分组顺序。
  #   这里就定死，下游读到的天然是有序的。
  obj <- .scrna_order_clusters(obj, "clusters")
  Seurat::Idents(obj) <- "clusters"
  clusterLevels <- levels(obj$clusters)
  nClusters <- length(clusterLevels)
  emit_log("info", sprintf("FindClusters: %d cluster(s) in %.1f s (cluster.name = 'clusters')",
                           nClusters, clusterSeconds))

  # ---- 2. UMAP ------------------------------------------------------------
  emit_progress("fit", 45, sprintf("RunUMAP (%s, dims 1:%d)", activeReduction, nPcs))
  tUmap <- Sys.time()
  obj <- Seurat::RunUMAP(obj, reduction = activeReduction, dims = 1:nPcs,
                         reduction.name = "umap", verbose = FALSE)
  umapSeconds <- as.numeric(difftime(Sys.time(), tUmap, units = "secs"))
  emit_log("info", sprintf("RunUMAP done in %.1f s (reduction.name = 'umap')", umapSeconds))

  # ---- 3. tSNE ------------------------------------------------------------
  # ★ perplexity 必须随细胞数缩小：tSNE 要求 n_cells > 3 * perplexity，
  #   默认 30 意味着「细胞数 ≥ 91」。小数据集（或单样本只取了几十个细胞做流程验证）
  #   会直接报 "perplexity is too large for the number of samples" —— 这条不是罕见情况，
  #   客户拿单样本做小规模试验时会撞上。
  tsneSkipped <- FALSE
  tsneSeconds <- 0
  perplexity <- if (ncol(obj) >= 20L) {
    min(30L, max(5L, as.integer(floor((ncol(obj) - 1L) / 3L))))
  } else {
    NA_integer_
  }
  if (is.na(perplexity)) {
    tsneSkipped <- TRUE
    emit_log("warn", sprintf(
      "skipping tSNE: only %d cells (tSNE needs at least ~20 to be meaningful)",
      ncol(obj)))
  } else {
    emit_progress("test", 65, sprintf("RunTSNE (perplexity %d, slow: 3~5 min expected)", perplexity))
    emit_log("info", sprintf(
      "RunTSNE started with perplexity = %d (min(30, (n-1)/3), n = %d); this is the slow step",
      perplexity, ncol(obj)))
    tTsne <- Sys.time()
    obj <- Seurat::RunTSNE(obj, reduction = activeReduction, dims = 1:nPcs,
                           perplexity = perplexity,
                           reduction.name = "tsne", check_duplicates = FALSE)
    tsneSeconds <- as.numeric(difftime(Sys.time(), tTsne, units = "secs"))
    emit_log("info", sprintf("RunTSNE done in %.1f s (reduction.name = 'tsne')", tsneSeconds))
  }

  # ---- 4. 出图 ------------------------------------------------------------
  emit_progress("plot", 85, "embedding plots")
  deg_ensure_pkgs("ggplot2")
  # ★ 配色只在这里算一次并写进对象：UMAP、DotPlot、小提琴、热图色带全用它，
  #   避免「两处各调一次 DiscretePalette 导致颜色错位」。
  pal <- .scrna_cluster_palette(obj, "clusters")
  obj@misc$clusterPalette <- pal
  plots <- list()

  dimPlot <- function(reduction, groupBy, label, title, labelSize = 5) {
    Seurat::DimPlot(obj, reduction = reduction, group.by = groupBy, label = label,
                    repel = TRUE, pt.size = 0.5,
                    cols = if (groupBy == "clusters") unname(pal) else NULL,
                    label.size = labelSize) +
      ggplot2::labs(title = title) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
  }

  specs <- list(
    list(id = "umap_clusters", file = "p01_umap_clusters.png", reduction = "umap",
         group = "clusters", label = TRUE, title = sprintf("UMAP · %d clusters", nClusters),
         caption = sprintf("UMAP，按 cluster 着色（resolution %s，共 %d 个 cluster）", resolution, nClusters)),
    list(id = "umap_samples", file = "p02_umap_samples.png", reduction = "umap",
         group = "orig.ident", label = FALSE, title = "UMAP · samples",
         caption = "UMAP，按样本着色（看样本是否混匀）"),
    list(id = "tsne_clusters", file = "p03_tsne_clusters.png", reduction = "tsne",
         group = "clusters", label = TRUE, title = sprintf("tSNE · %d clusters", nClusters),
         caption = "tSNE，按 cluster 着色"),
    list(id = "tsne_samples", file = "p04_tsne_samples.png", reduction = "tsne",
         group = "orig.ident", label = FALSE, title = "tSNE · samples",
         caption = "tSNE，按样本着色")
  )
  # 细胞太少跳过 tSNE 时，别去画一个不存在的 reduction
  if (tsneSkipped) {
    specs <- Filter(function(sp) sp$reduction != "tsne", specs)
  }
  for (sp in specs) {
    p <- tryCatch(dimPlot(sp$reduction, sp$group, sp$label, sp$title),
                  error = function(e) {
                    emit_log("warn", paste0(sp$id, " plot failed: ", conditionMessage(e)))
                    NULL
                  })
    if (!is.null(p) && .scrna_save(p, file.path(ctx$runDir, sp$file), 7, 5, sp$id)) {
      plots[[length(plots) + 1L]] <- list(id = sp$id, file = sp$file, caption = sp$caption)
    }
  }

  # ---- 5. cluster 大小 ----------------------------------------------------
  counts <- as.data.frame(table(cluster = factor(obj$clusters, levels = clusterLevels)))
  names(counts) <- c("cluster", "cells")
  p5 <- tryCatch({
    ggplot2::ggplot(counts, ggplot2::aes(x = stats::reorder(cluster, -cells), y = cells)) +
      ggplot2::geom_col(fill = "#46bac2", width = 0.72) +
      ggplot2::geom_text(ggplot2::aes(label = cells), vjust = -0.4, size = 3) +
      ggplot2::labs(x = "Cluster", y = "Cells", title = "Cells per cluster") +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
  }, error = function(e) { emit_log("warn", paste0("cluster size plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p5) && .scrna_save(p5, file.path(ctx$runDir, "p05_cluster_sizes.png"),
                                  max(5, 0.6 * nClusters + 3), 3.8, "cluster_sizes")) {
    plots[[length(plots) + 1L]] <- list(id = "cluster_sizes", file = "p05_cluster_sizes.png",
                                        caption = "每个 cluster 的细胞数")
  }

  # ---- 6. cluster 内样本占比 ---------------------------------------------
  perCluster <- lapply(clusterLevels, function(cl) {
    idx <- as.character(obj$clusters) == cl
    samples <- unique(as.character(obj$orig.ident))
    perSample <- lapply(samples, function(s) list(
      sample = s, cells = as.integer(sum(idx & as.character(obj$orig.ident) == s))
    ))
    list(cluster = cl,
         cells = as.integer(sum(idx)),
         perSample = unname(perSample[!vapply(perSample, function(x) x$cells == 0L, logical(1))]))
  })

  ratioDf <- do.call(rbind, lapply(perCluster, function(pc) {
    total <- pc$cells
    do.call(rbind, lapply(pc$perSample, function(ps) data.frame(
      cluster = pc$cluster, sample = ps$sample, cells = ps$cells,
      ratio = if (total > 0) ps$cells / total else 0,
      stringsAsFactors = FALSE
    )))
  }))
  p6 <- tryCatch({
    ggplot2::ggplot(ratioDf, ggplot2::aes(x = cluster, y = ratio, fill = sample)) +
      ggplot2::geom_col(width = 0.75) +
      ggplot2::scale_y_continuous(labels = function(x) sprintf("%.0f%%", x * 100), limits = c(0, 1)) +
      ggplot2::labs(x = "Cluster", y = "Sample ratio", fill = NULL,
                    title = "Sample composition per cluster") +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank(), legend.position = "top")
  }, error = function(e) { emit_log("warn", paste0("ratio plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p6) && .scrna_save(p6, file.path(ctx$runDir, "p06_cluster_sample_ratio.png"),
                                  max(5, 0.6 * nClusters + 3), 3.8, "cluster_ratio")) {
    plots[[length(plots) + 1L]] <- list(id = "cluster_ratio", file = "p06_cluster_sample_ratio.png",
                                        caption = "每个 cluster 内各样本的占比（看有没有样本特异的簇）")
  }

  for (pl in plots) emit_artifact("plot", pl$file)

  # cluster 汇总表（界面可下载）
  summaryDf <- data.frame(
    cluster = counts$cluster,
    cells = counts$cells,
    stringsAsFactors = FALSE
  )
  data.table::fwrite(summaryDf, file.path(ctx$runDir, "cluster_summary.csv"))
  emit_artifact("table", "cluster_summary.csv", rows = nrow(summaryDf), schema = "ScrnaClusterStat[]")

  # ---- 7. 保存 ------------------------------------------------------------
  obj@misc$clustersResolution <- resolution
  obj@misc$clustersDims <- as.integer(nPcs)
  obj@misc$clustersReduction <- activeReduction
  emit_progress("write", 95, "saving obj_step4.rds")
  saveRDS(obj, file.path(ctx$runDir, "obj_step4.rds"))
  emit_artifact("scrna_object", "obj_step4.rds")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  emit_result(list(
    nCells = as.integer(ncol(obj)),
    nClusters = as.integer(nClusters),
    resolution = resolution,
    dims = as.integer(nPcs),
    activeReduction = activeReduction,
    reductions = unname(as.character(names(obj@reductions))),
    clusterColumn = "clusters",
    perCluster = unname(perCluster),
    umapSeconds = round(umapSeconds, 1),
    tsneSeconds = round(tsneSeconds, 1),
    tsneSkipped = tsneSkipped,
    tsnePerplexity = if (is.na(perplexity)) NULL else as.integer(perplexity),
    clusterSeconds = round(clusterSeconds, 1),
    plots = unname(plots),
    summaryFile = "cluster_summary.csv",
    objectFile = "obj_step4.rds",
    durationMs = as.integer(durationMs)
  ))
})
