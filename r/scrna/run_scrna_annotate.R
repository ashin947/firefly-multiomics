# =============================================================================
# r/scrna/run_scrna_annotate.R —— 单细胞流程第 6 步：细胞类型注释
#
# ## 两条路并存（客户这批走 A）
#
#   A. **人工注释**（默认）：一张「簇 → 细胞类型」的映射表，用户在界面上填，
#      或导入他现成的 `07.clusterAnn.txt`（两列、制表符、**无表头**、cluster + label）。
#      为什么默认是它：SingleR 只有人和鼠的参考集，而客户数据是水稻（`Os01g…`），
#      走不了自动注释。
#
#   B. **SingleR 自动**（人/鼠）：按 cluster 注释（`SingleR(..., clusters=)`），不是逐细胞。
#      参考集来自 celldex（首次使用需联网下载几百 MB），也支持导入自有参考 .rds
#      （客户脚本里就是 `ref_Human_all.RData`）。
#
# ## 三条边界（都会明确报错/提示，不静默兜底）
#
#   1. 导入的注释表与对象的簇**对不上**（少/多/名字不符）→ 报错并列出差异。
#      静默用默认名是最坏的结果：用户以为注释成功了，其实是 `cluster_7`。
#   2. 两个簇填同一个 celltype → **允许**（这是合并），但要告诉用户合了哪几个。
#   3. 全部留空 → 不报错，用 `cluster_N`，并提示「尚未命名细胞类型」。
#
# ## 应用后**不要删 clusters 列**
#
# 第 8 步（细胞类型富集）与第 9 步（pseudobulk）都可能需要按原始 cluster 回溯，
# 删掉就再也拿不回来了。
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
source(file.path(.deg_root, "scrna", "common_plot.R"))

.scrna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

.scrna_save <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

#' 读注释表（兼容客户格式：两列、制表符、无表头）
#'
#' 也接受带表头的写法（cluster / celltype）与逗号分隔 —— 客户给的格式是一种，
#' 但用户手改过的表往往多个表头，不该因为多一行表头就报错。
.scrna_read_annotation <- function(path) {
  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_MISSING", paste0("annotation file not found: ", basename(path)), status = 12L)
  }
  lines <- readLines(path, warn = FALSE, encoding = "UTF-8")
  lines <- lines[nzchar(trimws(lines))]
  if (length(lines) == 0) {
    deg_stop("E_DATA_EMPTY", paste0("annotation file is empty: ", basename(path)), status = 13L)
  }
  sep <- if (grepl("\t", lines[1], fixed = TRUE)) "\t" else ","
  cells <- strsplit(lines, sep, fixed = TRUE)
  first <- tolower(trimws(cells[[1]]))
  if (length(first) >= 2 && grepl("cluster", first[1]) && grepl("cell|label|type", first[2])) {
    cells <- cells[-1]
  }
  if (length(cells) == 0) {
    deg_stop("E_DATA_EMPTY", paste0("annotation file has header but no rows: ", basename(path)),
             status = 13L)
  }
  cluster <- vapply(cells, function(x) trimws(x[1]), character(1))
  label <- vapply(cells, function(x) if (length(x) >= 2) trimws(x[2]) else "", character(1))
  data.frame(cluster = cluster, celltype = label, stringsAsFactors = FALSE)
}

#' 校验收到的映射表：簇必须与对象**一一对上**
#'
#' 少一个簇 → 那些簇会退回 `cluster_N`，用户以为注释成功了；
#' 多一个簇 → 说明表不是这批数据的。两种都必须报错并列出差异。
.scrna_validate_mapping <- function(mapping, clusters) {
  mapClusters <- unique(mapping$cluster)
  missingClusters <- setdiff(clusters, mapClusters)
  extraClusters <- setdiff(mapClusters, clusters)
  if (length(missingClusters) > 0 || length(extraClusters) > 0) {
    deg_stop("E_DATA_INVALID",
             paste0(
               "annotation table does not match the object's clusters.",
               if (length(missingClusters) > 0) paste0(
                 " Missing: ", paste(utils::head(missingClusters, 10), collapse = ", "),
                 if (length(missingClusters) > 10) " ..." else "", ".") else "",
               if (length(extraClusters) > 0) paste0(
                 " Not in object: ", paste(utils::head(extraClusters, 10), collapse = ", "),
                 if (length(extraClusters) > 10) " ..." else "", ".") else ""
             ),
             status = 13L)
  }
  invisible(TRUE)
}

#' 每簇 top10 marker（给注释表用；没有 marker 文件就返回空）
.scrna_top10_by_cluster <- function(runDir) {
  f <- file.path(runDir, "markers_top10.csv")
  if (!file.exists(f)) return(list())
  df <- tryCatch(
    utils::read.csv(f, stringsAsFactors = FALSE, check.names = FALSE),
    error = function(e) NULL
  )
  if (is.null(df) || nrow(df) == 0) return(list())
  split(df, as.character(df$cluster))
}

#' 把映射写进对象并出图
.scrna_apply_celltype <- function(ctx, obj, mapping, clusters) {
  # 空 celltype → cluster_<id>（不报错：用户可能只想先看个大概）
  defaulted <- mapping$celltype == "" | is.na(mapping$celltype)
  mapping$celltype[defaulted] <- paste0("cluster_", mapping$cluster[defaulted])
  if (any(defaulted)) {
    emit_log("warn", sprintf("%d cluster(s) left unnamed, using cluster_<id>", sum(defaulted)))
  }

  named <- stats::setNames(mapping$celltype, mapping$cluster)
  # ★ `unname()` 不能省。`named[cells]` 取出来的向量带的是**簇号**做名字
  #   （"0","1",…），而 `obj$col <- vec` 会拿这些名字去匹配细胞条码，
  #   匹配不上就报 "No cell overlap between new meta data and Seurat object"。
  #   实测踩过：注释表读到、校验通过、写回对象时全军覆没。
  labels <- unname(named[as.character(obj$clusters)])
  if (length(labels) != ncol(obj)) {
    deg_stop("E_RESULT_INVALID", sprintf(
      "annotation produced %d labels for %d cells", length(labels), ncol(obj)), status = 13L)
  }
  if (anyNA(labels)) {
    deg_stop("E_DATA_INVALID",
             "some cells have no matching cluster in the annotation", status = 13L)
  }
  obj$celltype <- factor(labels, levels = unique(mapping$celltype))
  # ★ clusters 列保留：第 8/9 步可能还要按原始簇回溯
  Seurat::Idents(obj) <- "celltype"

  # 同名合并：告诉用户合了哪几个
  merged <- lapply(split(mapping$cluster, mapping$celltype), function(x) as.character(x))
  merged <- merged[vapply(merged, length, integer(1)) > 1]
  if (length(merged) > 0) {
    emit_log("info", paste0("merged clusters into one cell type: ",
                            paste(sprintf("%s <- [%s]", names(merged),
                                          vapply(merged, paste, character(1), collapse = ", ")),
                                  collapse = "; ")))
  }
  list(obj = obj, merged = merged, defaulted = sum(defaulted))
}

deg_main("scrna/run_scrna_annotate.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "data.table", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step5.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("step-5 object not found: ", basename(objPath), " (run the marker step first)"),
             status = 12L)
  }
  mode <- as.character(.scrna_param(ctx, "mode", "manual"))

  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", "the object has no 'clusters' column", status = 13L)
  }
  obj <- .scrna_order_clusters(obj, "clusters")
  clusters <- levels(obj$clusters)
  cellsPerCluster <- table(as.character(obj$clusters))
  emit_log("info", sprintf("object: %d cells, %d cluster(s): %s",
                           ncol(obj), length(clusters), paste(clusters, collapse = ", ")))

  # ---- 得到 mapping -------------------------------------------------------
  if (identical(mode, "singleR")) {
    deg_stop("E_R_GENERIC", paste0(
      "singleR mode must be requested through the dedicated preview call ",
      "(label preview first, then apply). This script only applies a mapping."), status = 1L)
  }

  annotationFile <- as.character(.scrna_param(ctx, "annotationFile", ""))
  assignments <- .scrna_param(ctx, "assignments", NULL)

  if (nzchar(annotationFile)) {
    mapping <- .scrna_read_annotation(annotationFile)
    emit_log("info", sprintf("annotation file parsed: %d row(s) from %s",
                             nrow(mapping), basename(annotationFile)))
  } else if (!is.null(assignments)) {
    mapping <- data.frame(
      cluster = vapply(assignments, function(a) as.character(a$cluster), character(1)),
      celltype = vapply(assignments, function(a) as.character(a$celltype), character(1)),
      stringsAsFactors = FALSE
    )
    emit_log("info", sprintf("assignments from request: %d row(s)", nrow(mapping)))
  } else {
    deg_stop("E_VALIDATION", "either annotationFile or assignments is required", status = 11L)
  }
  mapping$cluster <- trimws(as.character(mapping$cluster))
  mapping$celltype <- trimws(as.character(mapping$celltype))

  # 同一簇在表里出现两次：取最后一次（用户改过的值在后面）
  if (anyDuplicated(mapping$cluster)) {
    dup <- unique(mapping$cluster[duplicated(mapping$cluster)])
    emit_log("warn", paste0("duplicated cluster rows, the last one wins: ",
                            paste(dup, collapse = ", ")))
    mapping <- mapping[!duplicated(mapping$cluster, fromLast = TRUE), , drop = FALSE]
  }

  emit_progress("filter", 20, "validating annotation")
  .scrna_validate_mapping(mapping, clusters)

  # ---- 应用 ---------------------------------------------------------------
  applied <- .scrna_apply_celltype(ctx, obj, mapping, clusters)
  obj <- applied$obj
  emit_log("info", sprintf("celltype assigned: %d cluster(s) -> %d type(s)",
                           length(clusters), length(unique(as.character(obj$celltype)))))

  # ---- 标签策略：类型少用质心，类型多用 repel ----------------------------
  nCelltypes <- length(unique(as.character(obj$celltype)))
  useCentroidLabels <- nCelltypes <= 8
  labelArg <- if (useCentroidLabels) FALSE else TRUE

  # ---- 细胞类型配色：从簇配色派生（不另生成一套）--------------------------
  # 合并出来的类型取它「第一个簇（按 levels 顺序）」的颜色，这样注释前后的图
  # 一眼能对上：UMAP 上那块粉色的细胞，变成 "Mesophyll" 之后还是粉色。
  # 存进 misc 跟着 rds 走，基因查询面板（另一个脚本）直接读。
  clusterPal <- .scrna_cluster_palette(obj, "clusters")
  celltypePal <- .scrna_celltype_palette(obj, "clusters", "celltype")
  obj@misc$celltypePalette <- celltypePal
  # 簇 → 细胞类型的反查表（从对象取，而不是从 mapping 取：
  # mapping 里留空的簇会被 .scrna_apply_celltype 补成 cluster_N，那份在函数外部看不到）
  ctOfCluster <- tapply(as.character(obj$celltype),
                        factor(as.character(obj$clusters), levels = clusters),
                        function(x) x[1])
  emit_log("info", paste0("celltype palette: ",
                          paste(sprintf("%s=%s", names(celltypePal), unname(celltypePal)),
                                collapse = ", ")))

  # ---- 出图 ---------------------------------------------------------------
  emit_progress("plot", 55, "annotation plots")
  plots <- list()
  top10 <- .scrna_top10_by_cluster(ctx$runDir)

  p1 <- tryCatch({
    base <- Seurat::DimPlot(obj, reduction = "umap", group.by = "celltype", label = labelArg,
                            repel = TRUE, pt.size = 0.5, label.size = 3.5,
                            cols = unname(celltypePal)) +
      ggplot2::labs(title = "UMAP · cell type") +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    if (useCentroidLabels) .scrna_centroid_labels(base, obj, "umap", "celltype") else base
  }, error = function(e) { emit_log("warn", paste0("celltype umap failed: ", conditionMessage(e))); NULL })
  if (!is.null(p1) && .scrna_save(p1, file.path(ctx$runDir, "p01_umap_celltype.png"), 7.5, 5.5, "umap_celltype")) {
    plots[[length(plots) + 1L]] <- list(id = "umap_celltype", file = "p01_umap_celltype.png",
                                        caption = "UMAP 按细胞类型着色")
  }

  p2 <- tryCatch({
    deg_ensure_pkgs("patchwork")
    left <- Seurat::DimPlot(obj, reduction = "umap", group.by = "clusters", label = TRUE,
                            repel = TRUE, pt.size = 0.3, label.size = 3,
                            cols = unname(clusterPal)) +
      ggplot2::labs(title = "Clusters (cluster colours)") + ggplot2::theme_bw(base_size = 9) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    right <- Seurat::DimPlot(obj, reduction = "umap", group.by = "celltype", label = labelArg,
                             repel = TRUE, pt.size = 0.3, label.size = 3,
                             cols = unname(celltypePal)) +
      ggplot2::labs(title = "Cell types") + ggplot2::theme_bw(base_size = 9) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    patchwork::wrap_plots(left, right, ncol = 2)
  }, error = function(e) { emit_log("warn", paste0("compare plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p2) && .scrna_save(p2, file.path(ctx$runDir, "p02_umap_cluster_vs_celltype.png"),
                                  11, 5, "cluster_vs_celltype")) {
    plots[[length(plots) + 1L]] <- list(id = "cluster_vs_celltype",
                                        file = "p02_umap_cluster_vs_celltype.png",
                                        caption = "左 cluster、右 celltype：看有没有合并/拆分")
  }

  # 每样本各细胞类型占比（客户脚本里的 RATIO 图）
  p3 <- tryCatch({
    df <- as.data.frame(table(sample = as.character(obj$orig.ident),
                              celltype = as.character(obj$celltype)),
                        stringsAsFactors = FALSE)
    names(df) <- c("sample", "celltype", "cells")
    totals <- stats::aggregate(cells ~ sample, data = df, FUN = sum)
    df$ratio <- df$cells / totals$cells[match(df$sample, totals$sample)]
    ggplot2::ggplot(df, ggplot2::aes(x = sample, y = ratio, fill = celltype)) +
      ggplot2::geom_col(width = 0.7) +
      ggplot2::scale_y_continuous(labels = function(x) sprintf("%.0f%%", x * 100), limits = c(0, 1)) +
      ggplot2::labs(x = NULL, y = "Cell type ratio", fill = NULL,
                    title = "Cell type composition per sample") +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank(), legend.position = "right")
  }, error = function(e) { emit_log("warn", paste0("ratio plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p3) && .scrna_save(p3, file.path(ctx$runDir, "p03_celltype_ratio.png"), 8, 4.6, "ratio")) {
    plots[[length(plots) + 1L]] <- list(id = "ratio", file = "p03_celltype_ratio.png",
                                        caption = "每样本各细胞类型占比")
  }
  # ---- tSNE 版（客户第 4 步就要求 umap / tSNE 都要，注释后只给 UMAP 会显得漏了）----
  hasTsne <- "tsne" %in% names(obj@reductions)
  if (!hasTsne) {
    emit_log("warn", "object has no 'tsne' reduction; skipping tSNE celltype plots")
  } else {
    p4 <- tryCatch({
      base <- Seurat::DimPlot(obj, reduction = "tsne", group.by = "celltype", label = labelArg,
                              repel = TRUE, pt.size = 0.5, label.size = 3.5,
                              cols = unname(celltypePal)) +
        ggplot2::labs(title = "tSNE · cell type") +
        ggplot2::theme_bw(base_size = 10) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      # ★ 客户报的问题就在这：两个类型时 repel 把 Vascular 的标签推没了，
      #   图上只剩 Parenchyma。类型 ≤ 8 时一律走质心直标。
      if (useCentroidLabels) .scrna_centroid_labels(base, obj, "tsne", "celltype") else base
    }, error = function(e) { emit_log("warn", paste0("celltype tsne failed: ", conditionMessage(e))); NULL })
    if (!is.null(p4) && .scrna_save(p4, file.path(ctx$runDir, "p04_tsne_celltype.png"),
                                    7.5, 5.5, "tsne_celltype")) {
      plots[[length(plots) + 1L]] <- list(id = "tsne_celltype", file = "p04_tsne_celltype.png",
                                          caption = "tSNE 按细胞类型着色")
    }

    p5 <- tryCatch({
      deg_ensure_pkgs("patchwork")
      left <- Seurat::DimPlot(obj, reduction = "tsne", group.by = "clusters", label = TRUE,
                              repel = TRUE, pt.size = 0.3, label.size = 3,
                              cols = unname(clusterPal)) +
        ggplot2::labs(title = "Clusters (cluster colours)") +
        ggplot2::theme_bw(base_size = 9) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      right <- Seurat::DimPlot(obj, reduction = "tsne", group.by = "celltype", label = labelArg,
                               repel = TRUE, pt.size = 0.3, label.size = 3,
                               cols = unname(celltypePal)) +
        ggplot2::labs(title = "Cell types (derived colours)") +
        ggplot2::theme_bw(base_size = 9) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      patchwork::wrap_plots(left, right, ncol = 2)
    }, error = function(e) { emit_log("warn", paste0("tsne compare failed: ", conditionMessage(e))); NULL })
    if (!is.null(p5) && .scrna_save(p5, file.path(ctx$runDir, "p05_tsne_cluster_vs_celltype.png"),
                                    11, 5, "tsne_cluster_vs_celltype")) {
      plots[[length(plots) + 1L]] <- list(id = "tsne_cluster_vs_celltype",
                                          file = "p05_tsne_cluster_vs_celltype.png",
                                          caption = "tSNE 左 cluster、右 celltype（配色由簇色派生）")
    }
  }

  for (pl in plots) emit_artifact("plot", pl$file)

  # ---- 汇总 ---------------------------------------------------------------
  perCluster <- lapply(clusters, function(cl) {
    lab <- as.character(mapping$celltype[mapping$cluster == cl])[1]
    if (is.na(lab) || !nzchar(lab)) lab <- paste0("cluster_", cl)
    top <- top10[[cl]]
    list(
      cluster = cl,
      cells = as.integer(cellsPerCluster[[cl]]),
      celltype = lab,
      top10 = unname(lapply(seq_len(if (is.null(top)) 0L else min(10L, nrow(top))), function(i) list(
        gene = as.character(top$gene[i]),
        avgLog2FC = round(as.numeric(top$avg_log2FC[i]), 4)
      )))
    )
  })

  # 表也落盘，方便对账
  outDf <- data.frame(
    cluster = vapply(perCluster, function(x) x$cluster, character(1)),
    cells = vapply(perCluster, function(x) x$cells, integer(1)),
    celltype = vapply(perCluster, function(x) x$celltype, character(1)),
    stringsAsFactors = FALSE
  )
  data.table::fwrite(outDf, file.path(ctx$runDir, "celltype_annotation.csv"))
  emit_artifact("table", "celltype_annotation.csv", rows = nrow(outDf), schema = "ScrnaCelltypeRow[]")

  obj@misc$annotationMode <- "manual"
  obj@misc$celltypes <- unique(as.character(obj$celltype))
  emit_progress("write", 92, "saving obj_step6.rds")
  saveRDS(obj, file.path(ctx$runDir, "obj_step6.rds"))
  emit_artifact("scrna_object", "obj_step6.rds")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  emit_result(list(
    nCells = as.integer(ncol(obj)),
    nClusters = as.integer(length(clusters)),
    mode = "manual",
    nCelltypes = as.integer(length(unique(as.character(obj$celltype)))),
    renamed = as.integer(length(applied$merged)),
    merged = unname(lapply(names(applied$merged), function(nm) list(
      celltype = nm, clusters = unname(as.character(applied$merged[[nm]]))
    ))),
    unnamed = as.integer(applied$defaulted),
    celltypes = unname(perCluster),
    clusters = unname(as.character(clusters)),
    # 配色映射：{celltype, color, fromClusters} —— 让界面与冒烟都能核对「派生对不对」
    celltypePalette = unname(lapply(names(celltypePal), function(ct) list(
      celltype = ct,
      color = unname(celltypePal[[ct]]),
      fromClusters = unname(names(ctOfCluster)[!is.na(ctOfCluster) & ctOfCluster == ct])
    ))),
    plots = unname(plots),
    annotationFile = "celltype_annotation.csv",
    objectFile = "obj_step6.rds",
    durationMs = as.integer(durationMs)
  ))
})
