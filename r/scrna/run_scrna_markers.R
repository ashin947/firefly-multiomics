# =============================================================================
# r/scrna/run_scrna_markers.R —— 单细胞流程第 5 步：各簇 Marker 基因
#
# ## 对照客户脚本（docs/reference/scrna-reference.txt:98-111）
#
#   logFCfilter   = 0.5
#   adjPvalFilter = 0.05
#   pbmc.markers <- FindAllMarkers(combined, only.pos = FALSE, assay = "RNA",
#                                  slot = "data", min.pct = 0.25,
#                                  logfc.threshold = logFCfilter)
#   sig.markers  <- pbmc.markers[abs(avg_log2FC) > logFCfilter &
#                                p_val_adj < adjPvalFilter, ]
#   top10 <- sig.markers %>% group_by(cluster) %>% top_n(n = 10, wt = avg_log2FC)
#   p <- DoHeatmap(combined, features = top10$gene) + NoLegend()
#
# 三层「筛」必须都保留，不能合并成一层：
#   ① `logfc.threshold` 交给 FindAllMarkers —— **它参与计算**，会显著减少要检验的基因数；
#   ② `only.pos = FALSE` —— 客户要双向 marker（下调的也要）；
#   ③ 结果表再按 `abs(avg_log2FC) > logFC & p_val_adj < adjP` 过一遍 ——
#      `logfc.threshold` 只保证「方向上的阈值」，配 `only.pos = FALSE` 时它对负方向的
#      约束与 `abs()` 口径不完全等价，所以客户脚本里这一步不是多余的。
#
# ## 两个技术坑
#
# 1. **先 JoinLayers**：Seurat v5 合并后是多层（counts.MD / counts.WW），
#    FindAllMarkers 在多层对象上又慢又容易报错。
# 2. **画热图前必须补 ScaleData**：第 3 步只 scale 了 2000 个高变基因（否则 5.6 GB
#    稠密矩阵），而 top10 marker 基本都不是高变基因 —— DoHeatmap 会直接报
#    "No requested features found in the scale.data slot"。
#    ★ 补的时候必须 `union(VariableFeatures(obj), genes)`：`ScaleData(features=)` 是
#      **替换** scale.data，只传 genes 会把 PCA 用的那份冲掉（以后要重跑 PCA 就得重算）。
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

#' 客户脚本里的 min.pct —— 写死，界面只读
SCR_MIN_PCT <- 0.25

.scrna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

.scrna_num <- function(ctx, name, default) {
  v <- suppressWarnings(as.numeric(.scrna_param(ctx, name, default)))
  if (length(v) != 1L || is.na(v)) default else v
}

.scrna_save <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

deg_main("scrna/run_scrna_markers.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "data.table", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step4.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("step-4 object not found: ", basename(objPath), " (run the clustering step first)"),
             status = 12L)
  }
  logfcThreshold <- .scrna_num(ctx, "logfcThreshold", 0.5)
  adjPvalFilter <- .scrna_num(ctx, "adjPvalFilter", 0.05)
  if (logfcThreshold < 0) {
    deg_stop("E_VALIDATION", paste0("logfcThreshold must be >= 0, got ", logfcThreshold), status = 11L)
  }
  if (adjPvalFilter <= 0 || adjPvalFilter > 1) {
    deg_stop("E_VALIDATION", paste0("adjPvalFilter must be in (0, 1], got ", adjPvalFilter), status = 11L)
  }

  emit_progress("read", 4, "loading object")
  obj <- readRDS(objPath)
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID",
             "the object has no 'clusters' column; run the clustering step first", status = 13L)
  }
  # 兜底：老对象（第 4 步还没排数字序时产出的）在这里纠正一次，
  # 用的是与第 4 步**同一个**函数，不会出现两套排序逻辑。
  obj <- .scrna_order_clusters(obj, "clusters")
  Seurat::Idents(obj) <- "clusters"
  clusters <- levels(obj$clusters)
  nCells <- ncol(obj)
  emit_log("info", sprintf("object: %d genes x %d cells, %d cluster(s)",
                           nrow(obj), nCells, length(clusters)))

  # 细胞数太少的簇：仍参与计算（客户脚本也没排除），但要提醒结果不稳
  cellsPerCluster <- table(as.character(obj$clusters))
  small <- names(cellsPerCluster)[cellsPerCluster < 10L]
  if (length(small) > 0) {
    emit_log("warn", sprintf(
      "cluster(s) with < 10 cells (markers may be unstable): %s",
      paste(sprintf("%s(%d)", small, as.integer(cellsPerCluster[small])), collapse = ", ")))
  }

  # ---- 1. 拼成单层 --------------------------------------------------------
  layers <- tryCatch(SeuratObject::Layers(obj[["RNA"]]), error = function(e) character(0))
  if (length(layers) > 1L) {
    emit_log("info", sprintf("joining %d layers before FindAllMarkers (%s)",
                             length(layers), paste(layers, collapse = ", ")))
    obj <- tryCatch(SeuratObject::JoinLayers(obj), error = function(e) {
      emit_log("warn", paste0("JoinLayers failed: ", conditionMessage(e)))
      obj
    })
  }

  # ---- 2. FindAllMarkers --------------------------------------------------
  # ★★ FindAllMarkers 内部用 future 并行，会把 `data` 矩阵当作 globals 导出。
  #    2.6 万细胞 × 2.8 万基因的 data 矩阵约 5.4 GB，远超 future 默认上限
  #    （`future.globals.maxSize` = 500 MB）——结果**每个 future 都失败，函数静默返回 0 行**，
  #    只看日志会以为「没有 marker」，实际一个基因都没算。
  #    实测：默认设置下 26,571 细胞 30 秒返回 0 行；设成 sequential + 放大上限后
  #    132 秒返回 3,188 行。
  #    用 sequential 而不是多核：多核会把 5 GB 矩阵复制到每个 worker，直接 OOM。
  deg_ensure_pkgs(c("future", "future.apply"))
  oldMaxSize <- getOption("future.globals.maxSize")
  options(future.globals.maxSize = 16 * 1024^3)
  suppressMessages(future::plan("sequential"))
  on.exit({
    options(future.globals.maxSize = oldMaxSize)
    try(suppressMessages(future::plan("sequential")), silent = TRUE)
  }, add = TRUE)

  emit_progress("test", 10, sprintf("FindAllMarkers (%d clusters, may take 3~10 min)", length(clusters)))
  emit_log("info", sprintf(
    "FindAllMarkers: only.pos=FALSE, layer='data', min.pct=%s, logfc.threshold=%s",
    SCR_MIN_PCT, logfcThreshold))
  tFind <- Sys.time()
  markers <- tryCatch(
    Seurat::FindAllMarkers(
      obj,
      only.pos = FALSE,
      assay = "RNA",
      layer = "data",              # Seurat 5 用 layer=；slot= 已废弃
      min.pct = SCR_MIN_PCT,
      logfc.threshold = logfcThreshold,
      verbose = FALSE
    ),
    error = function(e) {
      deg_stop("E_R_GENERIC", paste0("FindAllMarkers failed: ", conditionMessage(e)), status = 1L)
    }
  )
  findSeconds <- as.numeric(difftime(Sys.time(), tFind, units = "secs"))
  totalMarkers <- nrow(markers)
  emit_log("info", sprintf("FindAllMarkers returned %d row(s) in %.1f s", totalMarkers, findSeconds))
  if (totalMarkers == 0L) {
    # 0 行有两种完全不同的原因，别让用户猜到：「阈值太严」还是「并行失败」
    emit_log("warn", paste0(
      "FindAllMarkers returned 0 rows. If the thresholds are not strict, this usually means ",
      "its internal future workers failed (data matrix exceeds future.globals.maxSize)."))
  }

  # ---- 3. 二次筛选（客户脚本第二层）--------------------------------------
  emit_progress("test", 55, "filtering by |avg_log2FC| and p_val_adj")
  if (is.null(markers) || totalMarkers == 0L) {
    sig <- markers[0, , drop = FALSE]
  } else {
    sig <- markers[
      abs(as.numeric(markers$avg_log2FC)) > logfcThreshold &
        as.numeric(markers$p_val_adj) < adjPvalFilter,
      ,
      drop = FALSE
    ]
  }
  sigMarkers <- nrow(sig)
  emit_log("info", sprintf(
    "after |avg_log2FC| > %s & p_val_adj < %s: %d row(s)", logfcThreshold, adjPvalFilter, sigMarkers))

  # ---- 4. 每簇 top10（按 avg_log2FC 降序，与客户 top_n(wt = avg_log2FC) 一致）----
  top10 <- if (sigMarkers > 0L) {
    sig <- sig[order(-as.numeric(sig$avg_log2FC)), , drop = FALSE]
    do.call(rbind, lapply(split(sig, sig$cluster), function(df) utils::head(df, 10L)))
  } else {
    sig
  }
  rownames(top10) <- NULL

  perCluster <- lapply(clusters, function(cl) {
    sub <- if (sigMarkers > 0L) sig[as.character(sig$cluster) == cl, , drop = FALSE] else sig
    top <- if (nrow(sub) > 0L) utils::head(sub[order(-as.numeric(sub$avg_log2FC)), , drop = FALSE], 10L) else sub
    list(
      cluster = cl,
      cells = as.integer(cellsPerCluster[[cl]]),
      sigCount = as.integer(nrow(sub)),
      top10 = unname(lapply(seq_len(nrow(top)), function(i) list(
        gene = as.character(top$gene[i]),
        avgLog2FC = round(as.numeric(top$avg_log2FC[i]), 4),
        pvalAdj = signif(as.numeric(top$p_val_adj[i]), 4),
        pct1 = round(as.numeric(top$pct.1[i]), 4),
        pct2 = round(as.numeric(top$pct.2[i]), 4)
      )))
    )
  })

  # ---- 5. 写表（几十万行，必须 data.table::fwrite）------------------------
  emit_progress("write", 62, "writing marker tables")
  writeMarkers <- function(df, file) {
    if (is.null(df) || nrow(df) == 0L) {
      # 空表也要有表头，否则下游读的人会以为文件坏了
      empty <- data.frame(cluster = character(0), gene = character(0), avg_log2FC = numeric(0),
                          p_val = numeric(0), p_val_adj = numeric(0), pct.1 = numeric(0),
                          pct.2 = numeric(0), stringsAsFactors = FALSE)
      data.table::fwrite(empty, file)
    } else {
      keep <- intersect(c("cluster", "gene", "avg_log2FC", "p_val", "p_val_adj", "pct.1", "pct.2"), names(df))
      data.table::fwrite(df[, keep, drop = FALSE], file)
    }
  }
  writeMarkers(sig, file.path(ctx$runDir, "markers_sig.csv"))
  writeMarkers(top10, file.path(ctx$runDir, "markers_top10.csv"))
  emit_artifact("table", "markers_sig.csv", rows = sigMarkers, schema = "ScrnaMarkerRow[]")
  emit_artifact("table", "markers_top10.csv", rows = nrow(top10), schema = "ScrnaMarkerRow[]")

  # ---- 6. 出图 ------------------------------------------------------------
  plots <- list()

  if (sigMarkers > 0L) {
    genes <- unique(as.character(top10$gene))
    genes <- genes[genes %in% rownames(obj)]
    if (length(genes) > 0L) {
      # ★ 必须补 scale：top10 基本不是高变基因，第 3 步的 scale.data 里没有它们。
      #   且必须 union(HVG, genes) —— ScaleData(features=) 是替换而非追加，
      #   只传 genes 会把 PCA 用的那份冲掉。
      emit_progress("plot", 68, sprintf("ScaleData for %d marker genes", length(genes)))
      obj <- tryCatch(
        Seurat::ScaleData(obj,
                          features = union(Seurat::VariableFeatures(obj), genes),
                          verbose = FALSE),
        error = function(e) {
          emit_log("warn", paste0("ScaleData for markers failed: ", conditionMessage(e)))
          obj
        }
      )

      emit_progress("plot", 72, "DoHeatmap")
      heat <- tryCatch({
        p <- Seurat::DoHeatmap(obj, features = genes, group.by = "clusters",
                               size = 4, raster = FALSE, angle = 0) +
          ggplot2::theme(
            # 基因名是 `Os01g0100100` 这种 12+ 字符，字号必须小但不能再小
            axis.text.y = ggplot2::element_text(size = 4),
            # 左边留够空间给长基因名，否则会被画布边缘裁掉
            plot.margin = ggplot2::margin(4, 8, 4, 4, unit = "mm")
          )
        p
      }, error = function(e) {
        emit_log("warn", paste0("DoHeatmap failed: ", conditionMessage(e)))
        NULL
      })
      nRows <- length(clusters)
      # ★ 高度按基因数给（每行约 0.075 英寸）：140 个基因 → 10.5 英寸，
      #   行高才够放完整基因名。原来固定比例下每行只有几像素，名字被裁成 `Os01g010…`。
      # 宽度按簇数给：簇多时 14 英寸会把每块挤扁。
      heatHeight <- max(8, min(30, length(genes) * 0.075))
      heatWidth <- max(10, min(20, 8 + 0.35 * nRows))
      emit_log("info", sprintf("heatmap canvas: %.1f x %.1f in for %d genes x %d clusters",
                               heatWidth, heatHeight, length(genes), nRows))
      if (!is.null(heat) &&
          .scrna_save(heat, file.path(ctx$runDir, "p01_top10_heatmap.png"),
                      heatWidth, heatHeight, "heatmap")) {
        plots[[length(plots) + 1L]] <- list(
          id = "heatmap", file = "p01_top10_heatmap.png",
          caption = sprintf("每簇 top10 marker 热图（%d 个基因 × %d 个 cluster）", length(genes), nRows))
      }

      # 小提琴：前 6 个 cluster 合成一张；其余按簇单独出
      emit_progress("plot", 82, "top10 violin")
      buildViolin <- function(geneList, title) {
        # ★ 是 rownames（基因）不是 colnames（细胞）——写成 colnames 会把整个基因列表过滤空，
      #   于是小提琴图一张都画不出来，而且不报错
      geneList <- geneList[geneList %in% rownames(obj)]
        if (length(geneList) == 0L) return(NULL)
        tryCatch(
          Seurat::VlnPlot(obj, features = geneList, group.by = "clusters",
                          pt.size = 0, ncol = 5, combine = TRUE) +
            ggplot2::labs(title = title) &
            ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1),
                           axis.title.x = ggplot2::element_blank()),
          error = function(e) {
            emit_log("warn", paste0("VlnPlot failed: ", conditionMessage(e)))
            NULL
          }
        )
      }

      headClusters <- utils::head(clusters, 6)
      headGenes <- unique(as.character(top10$gene[as.character(top10$cluster) %in% headClusters]))
      v1 <- buildViolin(headGenes, sprintf("Top10 markers of first %d clusters", length(headClusters)))
      if (!is.null(v1) && .scrna_save(v1, file.path(ctx$runDir, "p02_top10_violin.png"),
                                      14, max(8, ceiling(length(headGenes) / 5) * 2.4),
                                      "violin")) {
        plots[[length(plots) + 1L]] <- list(
          id = "violin", file = "p02_top10_violin.png",
          caption = sprintf("前 %d 个 cluster 的 top10 marker 表达（小提琴）", length(headClusters)))
      }

      restClusters <- setdiff(clusters, headClusters)
      for (cl in restClusters) {
        g <- unique(as.character(top10$gene[as.character(top10$cluster) == cl]))
        if (length(g) == 0L) next
        vv <- buildViolin(g, sprintf("Cluster %s top10 markers", cl))
        f <- sprintf("p02_top10_violin_c%s.png", cl)
        if (!is.null(vv) && .scrna_save(vv, file.path(ctx$runDir, f),
                                        10, max(4, ceiling(length(g) / 5) * 2.4),
                                        paste0("violin_", cl))) {
          plots[[length(plots) + 1L]] <- list(
            id = paste0("violin_c", cl), file = f,
            caption = sprintf("cluster %s 的 top10 marker 表达", cl))
        }
      }
    }
  } else {
    emit_log("warn",
             "no significant marker at the current thresholds; skipping heatmap and violin plots")
  }

  # ---- 6.5 自选基因图 -----------------------------------------------------
  # 自选基因的 DotPlot / 小提琴已经**搬出去**成独立脚本 run_scrna_custom_plots.R：
  # 客户要的是「填基因 → 按一下出两张图」，不该逼他为了换一组基因把 FindAllMarkers
  # 重跑四分钟。这里不再画，也不再接收 dotGenes 参数。

  # ---- 7. 每簇 marker 数量 -------------------------------------------------
  emit_progress("plot", 90, "marker counts per cluster")
  countDf <- data.frame(
    cluster = clusters,
    sigCount = vapply(perCluster, function(x) x$sigCount, integer(1)),
    cells = vapply(perCluster, function(x) x$cells, integer(1)),
    stringsAsFactors = FALSE
  )
  p3 <- tryCatch({
    ggplot2::ggplot(countDf, ggplot2::aes(x = stats::reorder(cluster, -sigCount), y = sigCount)) +
      ggplot2::geom_col(fill = "#46bac2", width = 0.72) +
      ggplot2::geom_text(ggplot2::aes(label = sigCount), vjust = -0.4, size = 3) +
      ggplot2::labs(x = "Cluster", y = "Significant markers",
                    title = sprintf("Significant markers per cluster (logFC > %s, padj < %s)",
                                    logfcThreshold, adjPvalFilter)) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
  }, error = function(e) { emit_log("warn", paste0("count plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p3) &&
      .scrna_save(p3, file.path(ctx$runDir, "p03_marker_counts.png"),
                  max(5, 0.6 * length(clusters) + 3), 3.8, "counts")) {
    plots[[length(plots) + 1L]] <- list(
      id = "counts", file = "p03_marker_counts.png",
      caption = "每个 cluster 的显著 marker 数量（某簇为 0 说明它可能只是别的簇的碎片）")
  }
  for (pl in plots) emit_artifact("plot", pl$file)

  # ---- 8. 保存 ------------------------------------------------------------
  obj@misc$markersLogfcThreshold <- logfcThreshold
  obj@misc$markersAdjPvalFilter <- adjPvalFilter
  obj@misc$markersMinPct <- SCR_MIN_PCT
  emit_progress("write", 95, "saving obj_step5.rds")
  saveRDS(obj, file.path(ctx$runDir, "obj_step5.rds"))
  emit_artifact("scrna_object", "obj_step5.rds")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  emit_result(list(
    nCells = as.integer(nCells),
    nClusters = as.integer(length(clusters)),
    clusters = unname(as.character(clusters)),
    minPct = SCR_MIN_PCT,
    logfcThreshold = logfcThreshold,
    adjPvalFilter = adjPvalFilter,
    totalMarkers = as.integer(totalMarkers),
    sigMarkers = as.integer(sigMarkers),
    findSeconds = round(findSeconds, 1),
    perCluster = unname(perCluster),
    plots = unname(plots),
    sigFile = "markers_sig.csv",
    top10File = "markers_top10.csv",
    objectFile = "obj_step5.rds",
    durationMs = as.integer(durationMs)
  ))
})
