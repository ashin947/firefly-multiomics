# =============================================================================
# r/scrna/run_scrna_custom_plots.R —— 第 5 步：自选基因「一键出两张图」
#
# ## 为什么单独一个脚本，而不是塞进 markers
#
# 客户要的是「填基因 → 按一下 → 出图」。如果把它挂在 FindAllMarkers 那次运行里，
# 换一组基因就得重跑 4 分钟的差异分析 —— 而这两个图只依赖 `data` 层，
# 跟 marker 一点关系都没有。独立脚本 = 换基因只需 20 秒。
#
# ## 两张图一起出、一起失败
#
#   一个基因都不存在 → 两张都不画，报 E_DATA_EMPTY 并点名缺失基因。
#   只画一张、另一张静默缺失是最坏的结果：用户以为哪张图坏了。
#   部分存在 → 用存在的画，缺失的列在返回值里（界面提示，不阻断）。
#
# ## 配色
#
#   · 小提琴 **fill = 簇色**（与 UMAP 同一份 `obj@misc$clusterPalette`）——
#     客户明确要求「颜色和 UMAP 一致」。所以 y 轴不是表达量色带，
#     而表达高低由纵向分布本身表达（caption 里注明这一点）。
#   · DotPlot 的点色仍表示表达量（灰→红），簇名（y 轴）上簇色。
#     两种编码共存不冲突：点色管「多高」，轴文字管「哪一群」。
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

#' 把用户输入的一坨基因名规范化：去空白、去空串、去重，保留输入顺序
.scrna_gene_list <- function(value) {
  if (is.null(value)) return(character(0))
  genes <- trimws(as.character(value))
  genes <- genes[nzchar(genes)]
  unique(genes)
}

deg_main("scrna/run_scrna_custom_plots.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "patchwork", "jsonlite"))
  startedAt <- Sys.time()

  # ---- 1. 读对象 ----------------------------------------------------------
  objectFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step5.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objectFile)) objectFile else file.path(ctx$runDir, objectFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("object not found: ", basename(objectFile), " (run the marker step first)"),
             status = 12L)
  }
  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", "the object has no 'clusters' column", status = 13L)
  }
  obj <- .scrna_order_clusters(obj, "clusters")
  obj <- tryCatch(SeuratObject::JoinLayers(obj), error = function(e) obj)

  # ---- 2. 基因校验（两张图共用一份结论）----------------------------------
  genes <- .scrna_gene_list(.scrna_param(ctx, "genes", NULL))
  if (length(genes) == 0) {
    deg_stop("E_VALIDATION", "no genes given (paste at least one gene name)", status = 11L)
  }
  missingGenes <- setdiff(genes, rownames(obj))
  genes <- genes[genes %in% rownames(obj)]

  # 先删旧图：本次不画时不能留下上一次的图（否则界面以为图更新了）
  for (f in c("p04_dotplot_custom.png", "p05_violin_custom.png")) {
    old <- file.path(ctx$runDir, f)
    if (file.exists(old)) unlink(old)
  }

  if (length(missingGenes) > 0) {
    emit_log("warn", sprintf(
      "these genes are not in the dataset: %s",
      paste(utils::head(missingGenes, 10), collapse = ", ")))
  }
  if (length(genes) == 0) {
    # ★ 一个都不存在 → 两张都不画。只画一张会让人以为另一张坏了。
    deg_stop("E_DATA_EMPTY", paste0(
      "none of the ", length(missingGenes), " gene name(s) exist in this dataset",
      if (length(missingGenes) > 0) paste0(" (", paste(utils::head(missingGenes, 8), collapse = ", "),
                                           if (length(missingGenes) > 8) ", ..." else "", ")") else "",
      ". Check the gene ID system — this dataset uses: ",
      paste(utils::head(rownames(obj), 3), collapse = ", "), " ..."), status = 14L)
  }

  groups <- .scrna_cluster_levels(obj, "clusters")
  pal <- .scrna_cluster_palette(obj, "clusters")
  plots <- list()

  # ---- 每个基因的稀疏程度（界面据此给诊断，也是「为什么琴身是竖线」的解释）----
  # 单细胞数据里多数基因在多数细胞里是 0；一个基因 79% 的细胞为 0 时，
  # 密度峰值全压在 y=0，`scale="width"` 归一后琴身必然缩成一根竖线 ——
  # 这是稀疏数据的固有形态，不是画错。但用户必须知道「该看哪个编码」。
  exprAll <- SeuratObject::LayerData(obj, assay = "RNA", layer = "data")[genes, , drop = FALSE]
  geneStats <- lapply(seq_along(genes), function(i) {
    v <- as.numeric(exprAll[i, ])
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
      "these genes are expressed in <10%% of cells (%s); their violin will collapse to a line — read the DotPlot instead",
      paste(sparseGenes, collapse = ", ")))
  }

  # ---- 3. DotPlot（簇在 y、基因在 x）-------------------------------------
  emit_progress("plot", 35, sprintf("DotPlot (%d genes)", length(genes)))
  dot <- tryCatch({
    Seurat::DotPlot(obj, features = unique(genes), group.by = "clusters") +
      # 点色 = 表达量（灰→红）。轴文字另用簇色，两种编码分工不同
      ggplot2::scale_colour_gradient(low = "lightgrey", high = "#b2182b") +
      ggplot2::labs(
        title = "Custom genes",
        subtitle = "dot colour = mean expression, dot size = % expressed, axis colour = cluster (same as UMAP)",
        x = NULL, y = "Cluster"
      ) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(
        axis.text.y = ggplot2::element_text(colour = unname(pal[groups]), size = 8),
        axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 7),
        panel.grid.minor = ggplot2::element_blank(),
        # 左侧留白：不加时 "cluster13" 会被裁成 "ster13"（实测）
        plot.margin = ggplot2::margin(8, 12, 8, 42, "pt")
      )
  }, error = function(e) {
    emit_log("warn", paste0("DotPlot failed: ", conditionMessage(e)))
    NULL
  })
  if (!is.null(dot) && .scrna_save(dot, file.path(ctx$runDir, "p04_dotplot_custom.png"),
                                   max(7, min(20, 3 + 0.32 * length(genes))),
                                   max(5, min(14, 2 + 0.34 * length(groups))), "dotplot")) {
    plots[[length(plots) + 1L]] <- list(
      id = "dotplot_custom", file = "p04_dotplot_custom.png",
      caption = sprintf("自选基因 DotPlot（%d 个；轴文字颜色 = 细胞群，与 UMAP 一致）", length(genes))
    )
  }

  # ---- 4. 小提琴（fill = 簇色 + 每簇「均值点 + 表达比例%」）----------------
  # ★ 为什么不用 `Seurat::VlnPlot()`：
  #   1. 它的描边是写死的黑色、没映射到数据，`scale_colour_manual()` 无效 ——
  #      26k 细胞 + 稀疏基因下每个簇只剩一根黑竖线，簇色只在 y=0 露一点。
  #   2. 不暴露 `geom_violin(scale="width")`，稀疏数据琴身宽度不可控。
  # ★ 为什么还要标「均值点 + 表达比例%」：
  #   稀疏基因（>50% 细胞为 0）的琴身必然缩成竖线，这是数据形态不是画错；
  #   但只要在每簇上标出「表达比例」和「均值」，线状图也照样能读出信息 ——
  #   哪一群表达得多、哪一群几乎不表达，一眼可见。
  # ★ **不**做「只画非零细胞」的开关：那样会把「这群只有 5% 细胞表达」这个
  #   最关键的信息抹掉，看起来像每群都高表达。
  emit_progress("plot", 65, sprintf("violin (%d genes)", length(genes)))
  vlnCols <- if (length(genes) <= 4L) length(genes) else 2L
  vlnRows <- ceiling(length(genes) / vlnCols)
  vln <- tryCatch({
    exprMat <- exprAll[unique(genes), , drop = FALSE]
    df <- data.frame(
      gene = factor(rep(rownames(exprMat), times = ncol(exprMat)), levels = unique(genes)),
      expr = as.numeric(as.matrix(exprMat)),
      group = rep(as.character(obj$clusters), each = nrow(exprMat)),
      stringsAsFactors = FALSE
    )
    df$group <- factor(df$group, levels = groups)

    # 每 (基因, 簇) 的均值 / 表达比例 / 最大值 —— 标签用
    m1 <- stats::aggregate(expr ~ gene + group, data = df, FUN = mean)
    names(m1)[3] <- "avg"
    m2 <- stats::aggregate(I(expr > 0) ~ gene + group, data = df, FUN = mean)
    names(m2)[3] <- "pct"
    m3 <- stats::aggregate(expr ~ gene + group, data = df, FUN = max)
    names(m3)[3] <- "top"
    agg <- merge(merge(m1, m2, by = c("gene", "group")), m3, by = c("gene", "group"))
    # 标签放在每簇顶部再往上一点；偏移量按每个基因的全局最大值算
    gmax <- stats::aggregate(top ~ gene, data = agg, FUN = max)
    agg$labelY <- agg$top + 0.09 * gmax$top[match(as.character(agg$gene), as.character(gmax$gene))]

    ggplot2::ggplot(df, ggplot2::aes(x = group, y = expr, fill = group)) +
      ggplot2::geom_violin(scale = "width", trim = TRUE, colour = NA) +
      # 均值点（黑）+ 表达比例（灰字）：琴身是线也读得出差异
      ggplot2::geom_point(data = agg, ggplot2::aes(x = group, y = avg), inherit.aes = FALSE,
                          size = 0.9, colour = "grey10") +
      ggplot2::geom_text(data = agg,
                         ggplot2::aes(x = group, y = labelY,
                                      label = sprintf("%.0f%%", pct * 100)),
                         inherit.aes = FALSE, size = 2.1, colour = "grey35") +
      ggplot2::facet_wrap(~gene, ncol = vlnCols, scales = "free_y") +
      ggplot2::scale_fill_manual(values = unname(pal[groups])) +
      ggplot2::labs(
        x = NULL, y = "Expression level (log-normalized)", fill = "Cluster",
        # caption 分两行：一行太长会被 ggsave 裁掉首尾（实测「xpression, % = ...」开头缺字）
        caption = paste0(
          "Colour = cell cluster (same as UMAP), not expression level.  ",
          "Dot = mean expression, % = fraction of cells expressing the gene.\n",
          "Sparse genes (>50% zeros) collapse to a thin line by nature - ",
          "judge them by dot size/colour in the DotPlot above."
        )
      ) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(
        axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 7),
        panel.grid.minor = ggplot2::element_blank(),
        legend.key.size = ggplot2::unit(0.35, "cm"),
        legend.text = ggplot2::element_text(size = 7),
        legend.title = ggplot2::element_text(size = 8)
      )
  }, error = function(e) {
    emit_log("warn", paste0("violin failed: ", conditionMessage(e)))
    NULL
  })
  # 宽：每个 panel 至少 3.2 英寸（3 个基因挤在 600px 里会读不出比例数字）
  if (!is.null(vln) && .scrna_save(vln, file.path(ctx$runDir, "p05_violin_custom.png"),
                                  max(7, 3.2 * min(length(genes), 4L)),
                                  max(4, 3.2 * vlnRows + 1.4), "violin_custom")) {
    plots[[length(plots) + 1L]] <- list(
      id = "violin_custom", file = "p05_violin_custom.png",
      caption = sprintf("自选基因小提琴（%d 个；fill = 细胞群颜色，点上标均值、数字为表达细胞比例）",
                        length(genes))
    )
  }

  # ---- 5. 一起失败：两张都没画出来就报错，别让界面显示半个结果 -----------
  if (length(plots) == 0) {
    deg_stop("E_R_GENERIC", "both DotPlot and VlnPlot failed; see the log for details", status = 1L)
  }
  for (pl in plots) emit_artifact("plot", pl$file)

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    genes = unname(genes),
    missingGenes = unname(missingGenes),
    geneStats = unname(geneStats),
    nCells = as.integer(ncol(obj)),
    nGroups = as.integer(length(groups)),
    groupBy = "clusters",
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
