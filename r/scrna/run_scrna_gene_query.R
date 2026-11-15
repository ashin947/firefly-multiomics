# =============================================================================
# r/scrna/run_scrna_gene_query.R —— 第 6 步：基因查询（注释之后）
#
# 一个按钮出三张图：
#
#   p06_feature.png  FeaturePlot（空间表达）—— **颜色必须是表达量渐变**
#   p07_violin.png   VlnPlot（分布）        —— fill = 分组色
#   p08_dotplot.png  DotPlot（比例 + 均值） —— 点色 = 表达量、轴文字 = 分组色
#
# ## 配色规则（关键）
#
#   group.by = "celltype" → 用 `obj@misc$celltypePalette`（**由簇色派生**，不另生成）；
#   group.by = "clusters" → 用 `obj@misc$clusterPalette`。
#   两者是同一套颜色的两种粒度，所以「注释前那块粉色 → 注释后还是粉色」。
#
# ## split.by 的两个坑
#
#   1. **不要按样本重新配色**。VlnPlot(split.by=) 默认把 fill 换成批次变量，
#      于是同一个细胞类型在不同样本里颜色不同，看起来像「类型变了」。
#      所以小提琴这里自己拼 ggplot：fill 恒等于**分组色**，样本只做分面。
#   2. **图会非常大**。13 簇 × 6 样本 = 78 个分面。宽高按「分组数 × 拆分数」动态算，
#      并一律 `limitsize = FALSE`（否则 ggsave 直接拒绝保存）。
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

.scrna_save <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

#' 取某个分组列的有序取值：celltype 按对象里 factor 的顺序，clusters 按数字序
.scrna_group_levels <- function(obj, column) {
  if (identical(column, "clusters")) return(.scrna_cluster_levels(obj, "clusters"))
  ids <- obj@meta.data[[column]]
  if (is.factor(ids)) levels(ids) else sort(unique(as.character(ids[!is.na(ids)])))
}

#' 分组配色：celltype 走派生色板，clusters 走簇色板
.scrna_group_palette <- function(obj, column) {
  pal <- if (identical(column, "celltype")) {
    .scrna_celltype_palette(obj, "clusters", "celltype")
  } else {
    .scrna_cluster_palette(obj, "clusters")
  }
  lv <- .scrna_group_levels(obj, column)
  # 对象里出现但色板里没有的（理论上不会）补灰色，避免出现 NA 颜色导致整组画不出来
  missing <- setdiff(lv, names(pal))
  if (length(missing) > 0) {
    pal <- c(pal, stats::setNames(rep("#999999", length(missing)), missing))
  }
  pal[lv]
}

deg_main("scrna/run_scrna_gene_query.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "jsonlite"))
  startedAt <- Sys.time()

  objectFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step6.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objectFile)) objectFile else file.path(ctx$runDir, objectFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("object not found: ", basename(objectFile), " (apply the annotation first)"),
             status = 12L)
  }
  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)
  obj <- tryCatch(SeuratObject::JoinLayers(obj), error = function(e) obj)
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", "the object has no 'clusters' column", status = 13L)
  }
  obj <- .scrna_order_clusters(obj, "clusters")

  groupBy <- as.character(.scrna_param(ctx, "groupBy", "celltype"))
  splitBy <- as.character(.scrna_param(ctx, "splitBy", ""))
  if (!groupBy %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", paste0(
      "grouping column '", groupBy, "' does not exist in this object. ",
      "Available: ", paste(utils::head(colnames(obj@meta.data), 12), collapse = ", "),
      if (identical(groupBy, "celltype")) ". Annotate the object first (step 6)." else ""), status = 13L)
  }
  if (nzchar(splitBy) && !splitBy %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", paste0("split column '", splitBy, "' does not exist"), status = 13L)
  }
  # 分组列转成有序 factor：图例/轴的顺序要和 UMAP 一致
  obj@meta.data[[groupBy]] <- factor(as.character(obj@meta.data[[groupBy]]),
                                     levels = .scrna_group_levels(obj, groupBy))

  genes <- .scrna_param(ctx, "genes", NULL)
  genes <- if (is.null(genes)) character(0) else trimws(as.character(genes))
  genes <- unique(genes[nzchar(genes)])
  if (length(genes) == 0) {
    deg_stop("E_VALIDATION", "no genes given (paste at least one gene name)", status = 11L)
  }
  missingGenes <- setdiff(genes, rownames(obj))
  genes <- genes[genes %in% rownames(obj)]

  for (f in c("p06_feature.png", "p07_violin.png", "p08_dotplot.png")) {
    old <- file.path(ctx$runDir, f)
    if (file.exists(old)) unlink(old)
  }
  if (length(missingGenes) > 0) {
    emit_log("warn", sprintf("genes not in dataset: %s",
                             paste(utils::head(missingGenes, 10), collapse = ", ")))
  }
  if (length(genes) == 0) {
    deg_stop("E_DATA_EMPTY", paste0(
      "none of the ", length(missingGenes), " gene name(s) exist in this dataset (",
      paste(utils::head(missingGenes, 8), collapse = ", "),
      if (length(missingGenes) > 8) ", ..." else "", "). Dataset uses: ",
      paste(utils::head(rownames(obj), 3), collapse = ", "), " ..."), status = 14L)
  }

  # ---- 每个基因的稀疏程度（界面据此给诊断）--------------------------------
  exprForStats <- SeuratObject::LayerData(obj, assay = "RNA", layer = "data")[genes, , drop = FALSE]
  geneStats <- lapply(seq_along(genes), function(i) {
    v <- as.numeric(exprForStats[i, ])
    list(
      gene = genes[i],
      pctExpressing = round(mean(v > 0), 4),
      mean = round(mean(v), 4),
      max = round(max(v), 3)
    )
  })
  sparseGenes <- vapply(Filter(function(g) g$pctExpressing < 0.1, geneStats),
                        function(g) g$gene, character(1))
  if (length(sparseGenes) > 0) {
    emit_log("warn", sprintf(
      "these genes are expressed in <10%% of cells (%s); the violin will collapse to a line — read the DotPlot instead",
      paste(sparseGenes, collapse = ", ")))
  }

  groups <- .scrna_group_levels(obj, groupBy)
  pal <- .scrna_group_palette(obj, groupBy)
  splits <- if (nzchar(splitBy)) sort(unique(as.character(obj@meta.data[[splitBy]]))) else character(0)
  nSplits <- max(1L, length(splits))
  plots <- list()

  # ---- 1. FeaturePlot：颜色 = 表达量（这条不能改）------------------------
  # ★ 用 `combine = FALSE` 取回单张图再自己 wrap，而不是让它自己拼：
  #   带 split.by + 多基因时，Seurat 自己组合出来的面板**尺寸不一致**
  #   （最后一张会缩成小图、还单独带一条色带），实测非常难看。
  emit_progress("plot", 30, "FeaturePlot")
  ncolF <- min(length(genes), 2L)
  nrowF <- ceiling(length(genes) / ncolF) * nSplits
  feat <- tryCatch({
    deg_ensure_pkgs("patchwork")
    panels <- Seurat::FeaturePlot(
      obj, features = unique(genes), reduction = "umap",
      split.by = if (nzchar(splitBy)) splitBy else NULL,
      order = TRUE, combine = FALSE, cols = c("lightgrey", "#b2182b")
    )
    panels <- lapply(panels, function(pp) {
      pp + ggplot2::theme_bw(base_size = 9) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    })
    patchwork::wrap_plots(panels, ncol = ncolF) +
      patchwork::plot_layout(guides = "collect") +
      patchwork::plot_annotation(
        title = sprintf("Expression on UMAP (group: %s%s)", groupBy,
                        if (nzchar(splitBy)) paste0(", split: ", splitBy) else ""),
        caption = paste0(
          "Colour = expression level (light grey = low, dark red = high). ",
          "Panels are split by ", if (nzchar(splitBy)) splitBy else "none", "."
        ),
        theme = ggplot2::theme(plot.title = ggplot2::element_text(size = 9),
                               plot.caption = ggplot2::element_text(size = 7))
      )
  }, error = function(e) {
    emit_log("warn", paste0("FeaturePlot failed: ", conditionMessage(e)))
    NULL
  })
  if (!is.null(feat) && .scrna_save(feat, file.path(ctx$runDir, "p06_feature.png"),
                                    max(8, min(40, 3.4 * ncolF)),
                                    max(6, min(40, 3.0 * nrowF + 0.6)), "feature")) {
    plots[[length(plots) + 1L]] <- list(
      id = "feature", file = "p06_feature.png",
      caption = sprintf("FeaturePlot（%d 个基因；颜色 = 表达量%s）", length(genes),
                        if (nzchar(splitBy)) paste0("，按 ", splitBy, " 分面") else "")
    )
  }

  # ---- 2. 小提琴：fill = 分组色（不按样本重配色）+ 均值点 + 表达比例 -------
  # 稀疏基因（>50% 细胞为 0）的琴身必然缩成竖线，这是数据形态不是画错；
  # 每簇标出「均值点 + 表达比例%」之后，线状图照样能读出「哪群表达得多」。
  emit_progress("plot", 60, "violin")
  vlnCols <- if (length(genes) <= 4L) length(genes) else 2L
  vln <- tryCatch({
    exprMat <- SeuratObject::LayerData(obj, assay = "RNA", layer = "data")[unique(genes), , drop = FALSE]
    df <- data.frame(
      gene = rep(rownames(exprMat), times = ncol(exprMat)),
      expr = as.numeric(as.matrix(exprMat)),
      group = rep(as.character(obj@meta.data[[groupBy]]), each = nrow(exprMat)),
      stringsAsFactors = FALSE
    )
    df$gene <- factor(df$gene, levels = unique(genes))
    df$group <- factor(df$group, levels = groups)
    if (nzchar(splitBy)) {
      df$facet <- rep(as.character(obj@meta.data[[splitBy]]), each = nrow(exprMat))
      df$facet <- factor(df$facet, levels = splits)
    } else {
      df$facet <- factor("all")
    }

    # 每 (基因, 分组, 面) 的均值 / 表达比例 / 最大值
    by <- c("gene", "group", "facet")
    m1 <- stats::aggregate(expr ~ gene + group + facet, data = df, FUN = mean)
    names(m1)[4] <- "avg"
    m2 <- stats::aggregate(I(expr > 0) ~ gene + group + facet, data = df, FUN = mean)
    names(m2)[4] <- "pct"
    m3 <- stats::aggregate(expr ~ gene + group + facet, data = df, FUN = max)
    names(m3)[4] <- "top"
    agg <- merge(merge(m1, m2, by = by), m3, by = by)
    gmax <- stats::aggregate(top ~ gene + facet, data = agg, FUN = max)
    agg$labelY <- agg$top +
      0.09 * gmax$top[match(paste(agg$gene, agg$facet), paste(gmax$gene, gmax$facet))]

    p <- ggplot2::ggplot(df, ggplot2::aes(x = group, y = expr, fill = group)) +
      ggplot2::geom_violin(scale = "width", trim = TRUE, colour = NA) +
      ggplot2::geom_point(data = agg, ggplot2::aes(x = group, y = avg), inherit.aes = FALSE,
                          size = 0.8, colour = "grey10") +
      ggplot2::geom_text(data = agg,
                         ggplot2::aes(x = group, y = labelY, label = sprintf("%.0f%%", pct * 100)),
                         inherit.aes = FALSE,
                         size = if (length(groups) > 8) 1.7 else 2.0, colour = "grey35")
    # 分面：行 = 基因，列 = 样本；fill 永远是分组色（这才是「不按样本重配色」）
    p <- if (nzchar(splitBy)) {
      p + ggplot2::facet_grid(gene ~ facet, scales = "free_y")
    } else {
      p + ggplot2::facet_wrap(~gene, ncol = vlnCols, scales = "free_y")
    }
    p +
      ggplot2::scale_fill_manual(values = unname(pal[groups])) +
      ggplot2::labs(
        x = NULL, y = "Expression level (log-normalized)", fill = groupBy,
        caption = paste0(
          "Colour = ", groupBy, " (same palette as UMAP), not expression level.  ",
          "Dot = mean expression, % = fraction of cells expressing the gene.\n",
          "Sparse genes (>50% zeros) collapse to a thin line by nature - ",
          "judge them by dot size/colour in the DotPlot below."
        )
      ) +
      ggplot2::theme_bw(base_size = 9) +
      ggplot2::theme(
        axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 6),
        panel.grid.minor = ggplot2::element_blank(),
        legend.key.size = ggplot2::unit(0.32, "cm"),
        legend.text = ggplot2::element_text(size = 6.5),
        legend.title = ggplot2::element_text(size = 8)
      )
  }, error = function(e) {
    emit_log("warn", paste0("violin failed: ", conditionMessage(e)))
    NULL
  })
  # 宽：不拆分时每个基因 panel 至少 3.2 英寸；拆分时按样本列数（每列 3.2 英寸起）
  vlnW <- if (nzchar(splitBy)) {
    max(9, min(60, 3.2 * nSplits * if (length(genes) > 1) 1.2 else 1))
  } else {
    max(7, 3.2 * min(length(genes), 4L))
  }
  vlnRows <- if (nzchar(splitBy)) length(genes) else ceiling(length(genes) / vlnCols)
  vlnH <- max(4, min(40, 3.2 * vlnRows + 1.4))
  if (!is.null(vln) && .scrna_save(vln, file.path(ctx$runDir, "p07_violin.png"), vlnW, vlnH, "violin")) {
    plots[[length(plots) + 1L]] <- list(
      id = "violin", file = "p07_violin.png",
      caption = sprintf("小提琴（fill = %s 颜色%s）", groupBy,
                        if (nzchar(splitBy)) paste0("，按 ", splitBy, " 分面") else "")
    )
  }

  # ---- 3. DotPlot：点色 = 表达量、轴文字 = 分组色 --------------------------
  # ★ 没有直接用 `Seurat::DotPlot(split.by=)`：它会把「分组_样本」拼成一个新标签
  #   放到 y 轴（实测：`0_MD` / `0_WW` 交错，28 行），而不是按样本分面 ——
  #   y 轴文字按分组上色时就只能按行号循环取色，颜色全错位。
  #   这里自己算「分组 × 拆分」的均值与检出率，用 facet 分面，y 轴只留分组名。
  emit_progress("plot", 85, "DotPlot")
  dot <- tryCatch({
    data <- SeuratObject::LayerData(obj, assay = "RNA", layer = "data")[unique(genes), , drop = FALSE]
    g <- as.character(obj@meta.data[[groupBy]])
    combo <- if (nzchar(splitBy)) {
      paste(g, as.character(obj@meta.data[[splitBy]]), sep = "\u0001")
    } else {
      g
    }
    idx <- split(seq_len(ncol(data)), combo)
    # 均值与检出率：逐组合算，避免把 26k 细胞整矩阵转成稠密
    # ★ 只查 1 个基因时 `vapply` 会返回**向量**而不是 1 行矩阵（维度塌陷），
    #   后面 `rownames(avg)` 就是 NULL，整个 DotPlot 直接失败 —— 实测踩过：
    #   「拆分模式三张图只剩 feature,violin」。这里显式补回矩阵形状。
    as_mat <- function(x) {
      if (!is.null(dim(x))) return(x)
      matrix(x, nrow = nrow(data), dimnames = list(rownames(data), names(x)))
    }
    avg <- as_mat(vapply(idx, function(ii) {
      Matrix::rowMeans(data[, ii, drop = FALSE])
    }, numeric(nrow(data))))
    pct <- as_mat(vapply(idx, function(ii) {
      Matrix::rowSums(data[, ii, drop = FALSE] > 0) / max(1L, length(ii))
    }, numeric(nrow(data))))
    df <- data.frame(
      gene = rep(rownames(avg), times = ncol(avg)),
      combo = rep(colnames(avg), each = nrow(avg)),
      avg = as.numeric(avg),
      pct = as.numeric(pct),
      stringsAsFactors = FALSE
    )
    df$group <- sub("\u0001.*$", "", df$combo)
    df$split <- if (nzchar(splitBy)) sub("^.*\u0001", "", df$combo) else "all"
    if (nzchar(splitBy)) df$split <- factor(df$split, levels = splits)
    df$gene <- factor(df$gene, levels = unique(genes))
    df$group <- factor(df$group, levels = groups)
    # 每个基因各自缩放到 0~1（与 Seurat 的 scale.by='feature' 同义）：
    # 不同基因的表达量级差很多，不缩放的话一个高表达基因会把其它全压成灰
    df$scaled <- stats::ave(df$avg, df$gene, FUN = function(x) {
      r <- range(x)
      if (!is.finite(diff(r)) || diff(r) == 0) rep(0, length(x)) else (x - r[1]) / diff(r)
    })
    dots <- ggplot2::ggplot(df, ggplot2::aes(x = gene, y = group)) +
      ggplot2::geom_point(ggplot2::aes(size = pct, colour = scaled)) +
      ggplot2::scale_colour_gradient(low = "lightgrey", high = "#b2182b",
                                     name = "Scaled\nexpression") +
      ggplot2::scale_size_area(max_size = 5, labels = function(x) paste0(round(x * 100), "%"),
                               name = "% expressed") +
      ggplot2::labs(x = NULL, y = groupBy,
                    caption = "dot colour = mean expression (scaled per gene), size = % expressed, y-axis colour = group") +
      ggplot2::theme_bw(base_size = 9) +
      ggplot2::theme(
        axis.text.y = ggplot2::element_text(colour = unname(pal[groups]), size = 7),
        axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 7),
        panel.grid.minor = ggplot2::element_blank(),
        plot.margin = ggplot2::margin(8, 10, 8, 46, "pt")
      )
    # 只有一列分面时不画 strip（省地方、也更像「一张图」）
    dots <- if (nzchar(splitBy)) {
      dots + ggplot2::facet_wrap(~split, ncol = if (nSplits > 4) 3 else nSplits)
    } else {
      dots
    }
    dots
  }, error = function(e) {
    emit_log("warn", paste0("DotPlot failed: ", conditionMessage(e)))
    NULL
  })
  dotW <- if (nzchar(splitBy)) {
    max(8, min(60, (2.2 + 1.1 * length(genes)) * min(nSplits, 3)))
  } else {
    max(7, min(40, 3 + 1.1 * length(genes)))
  }
  if (!is.null(dot) && .scrna_save(dot, file.path(ctx$runDir, "p08_dotplot.png"), dotW,
                                  max(5, min(30, 2 + 0.34 * length(groups))), "dotplot")) {
    plots[[length(plots) + 1L]] <- list(
      id = "dotplot", file = "p08_dotplot.png",
      caption = sprintf("DotPlot（%d 个基因；点色 = 表达量，y 轴文字 = %s 颜色%s）",
                        length(genes), groupBy,
                        if (nzchar(splitBy)) paste0("，按 ", splitBy, " 分面") else "")
    )
  }

  if (length(plots) == 0) {
    deg_stop("E_R_GENERIC", "all three gene-query plots failed; see the log", status = 1L)
  }
  for (pl in plots) emit_artifact("plot", pl$file)

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    genes = unname(genes),
    missingGenes = unname(missingGenes),
    geneStats = unname(geneStats),
    groupBy = groupBy,
    splitBy = splitBy,
    nGroups = as.integer(length(groups)),
    samples = unname(splits),
    nCells = as.integer(ncol(obj)),
    palette = unname(lapply(groups, function(g) list(group = g, color = unname(pal[[g]])))),
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
