# =============================================================================
# r/enrich/export_enrich_plot.R —— 富集结果气泡图
#
# 图形规格参考客户给的样例：
#   - 横向（coord_flip）：富集条目名很长，竖排会把 x 轴挤成一团
#   - 气泡：x=条目名，y=GeneRatio，填充=-log10(pvalue)，大小=Count
#   - GO 按 BP/MF/CC 分面，每面各取前 N（不同 ontology 的条目数差很多，
#     不分面直接取前 N 会被条目最多的那一类垄断）
#   - 配色沿用样例的黄-青-紫（#f7ca64 → #46bac2 → #7e62a3）
#
# 输入：enrich_result.csv（run_ora.R 产出，11 列统一格式）
# 输出：params$outPath
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

.plot_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 把长条目名折行，否则横向图上标签会把绘图区挤没
.wrap_label <- function(x, width = 48) {
  vapply(x, function(s) paste(strwrap(s, width = width), collapse = "\n"), character(1), USE.NAMES = FALSE)
}

deg_main("enrich/export_enrich_plot.R", function(ctx) {
  # 本脚本只读 enrich_result.csv，全程不碰 species / 注释库，所以不能让默认的
  # human/mouse 白名单卡住它：水稻富集跑完后接着画气泡图，会因为 species='rice'
  # 在这里被判非法，表现为「富集成功但图出不来」，且错误信息指向物种校验，
  # 跟真正的原因（画图根本不需要物种）完全无关。
  deg_validate_common(ctx, speciesAllowed = c("human", "mouse", "rice"))
  deg_ensure_pkgs(c("ggplot2", "ragg", "data.table", "stringr"))
  startedAt <- Sys.time()

  dataPath <- as.character(.plot_param(ctx, "dataPath", file.path(ctx$runDir, "enrich_result.csv")))
  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 8))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 6))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))
  topN <- as.integer(.plot_param(ctx, "topN", 10))
  splitByOntology <- isTRUE(.plot_param(ctx, "splitByOntology", TRUE))
  title <- as.character(.plot_param(ctx, "title", ""))
  palette <- as.character(.plot_param(ctx, "palette", c("#f7ca64", "#46bac2", "#7e62a3")))

  if (!nzchar(outPath)) deg_stop("E_IO_PERMISSION", "outPath is empty", status = 11L)
  if (!file.exists(dataPath)) {
    deg_stop("E_RESULT_INVALID", paste0("enrichment result not found: ", dataPath), status = 13L)
  }
  if (!is.finite(widthIn) || widthIn <= 0) widthIn <- 8
  if (!is.finite(heightIn) || heightIn <= 0) heightIn <- 6
  if (!is.finite(dpi) || dpi < 72) dpi <- 300
  if (!is.finite(topN) || topN < 1) topN <- 10

  emit_progress("read", 15, "reading enrichment result")
  df <- data.table::fread(dataPath, data.table = FALSE, check.names = FALSE)
  if (nrow(df) == 0) deg_stop("E_DATA_EMPTY", "enrichment result is empty", status = 13L)
  if (!all(c("description", "gene_ratio", "pvalue", "count") %in% names(df))) {
    deg_stop("E_RESULT_INVALID",
             paste0("unexpected columns: ", paste(names(df), collapse = ", ")), status = 10L)
  }

  df$description[is.na(df$description) | !nzchar(df$description)] <- df$term_id[is.na(df$description) | !nzchar(df$description)]
  df$negLogP <- -log10(pmax(df$pvalue, 1e-300))
  df$count <- as.integer(df$count)

  # ---- 取 top N -------------------------------------------------------
  hasOntology <- "ontology" %in% names(df) && any(!is.na(df$ontology) & nzchar(df$ontology))
  faceted <- splitByOntology && hasOntology && length(unique(stats::na.omit(df$ontology))) > 1

  if (faceted) {
    # ontology 为空的条目必须显式给个分组名。
    # `split()` 会直接丢弃 NA 组，`factor(levels=)` 也会把不在 levels 里的值变成 NA
    # 再被 facet 丢掉 —— 两者都不报错。自定义背景一次跑出 GO(有 BP/MF/CC) + 通路
    # (没有 ontology) 时，表现就是「气泡图里通路条目凭空消失，但结果表里有」。
    #
    # 分组名优先用 database（KEGG / Pathway），因为分面条上写着「KEGG」比写「其他」
    # 更能说明这些条目是什么；取不到才退回「其他」。
    blank <- is.na(df$ontology) | !nzchar(df$ontology)
    fallback <- if ("database" %in% names(df)) as.character(df$database) else rep(NA_character_, nrow(df))
    fallback[is.na(fallback) | !nzchar(fallback)] <- "其他"
    df$ontology[blank] <- fallback[blank]
  }

  pick_top <- function(d) {
    d <- d[order(d$p_adjust, d$pvalue), , drop = FALSE]
    utils::head(d, topN)
  }
  if (faceted) {
    parts <- split(df, df$ontology)
    df <- do.call(rbind, lapply(parts, pick_top))
  } else {
    df <- pick_top(df)
  }
  rownames(df) <- NULL
  emit_log("info", sprintf("plotting %d terms (topN=%d, faceted=%s)", nrow(df), topN, faceted))

  # 条目名折行 + 按 gene_ratio 排序（小的在下，大的在上，横向图从下往上读）
  df$label <- .wrap_label(df$description, 48)
  df$label <- factor(df$label, levels = unique(df$label[order(df$gene_ratio)]))
  if (faceted) {
    # 顺序：固定 BP → MF → CC，其余（KEGG / Pathway / 其他）按出现顺序排在后面
    ontologyLevels <- c("BP", "MF", "CC")
    present <- unique(df$ontology)
    df$ontology <- factor(df$ontology,
                          levels = c(intersect(ontologyLevels, present),
                                     setdiff(present, ontologyLevels)))
  }

  # ---- 字体按条目数自适应 ---------------------------------------------
  nTerm <- nrow(df)
  axisText <- max(6.5, min(11, 120 / max(nTerm / max(1, length(unique(df$ontology))), 1)))
  baseSize <- max(8, min(11, axisText))

  emit_progress("render", 55, "drawing bubble plot")
  p <- ggplot2::ggplot(df, ggplot2::aes(x = .data$label, y = .data$gene_ratio)) +
    ggplot2::geom_point(ggplot2::aes(size = .data$count, fill = .data$negLogP),
                        shape = 21, colour = "black", stroke = 0.3) +
    ggplot2::scale_fill_gradientn(colours = palette) +
    ggplot2::scale_size_continuous(range = c(1.2, 5.5)) +
    ggplot2::coord_flip() +
    ggplot2::labs(
      x = NULL,
      y = "Gene Ratio",
      title = if (nzchar(title)) title else "Enrichment",
      fill = bquote("-" ~ Log[10] ~ "(P value)"),
      size = "Gene Count"
    ) +
    ggplot2::theme_bw() +
    ggplot2::theme(
      panel.grid.minor = ggplot2::element_blank(),
      panel.border = ggplot2::element_rect(colour = "black", linewidth = 0.5),
      axis.text.x = ggplot2::element_text(size = baseSize, colour = "black"),
      axis.text.y = ggplot2::element_text(size = axisText, colour = "black"),
      axis.title = ggplot2::element_text(size = baseSize + 1, colour = "black"),
      plot.title = ggplot2::element_text(hjust = 0.5, size = baseSize + 3, face = "bold"),
      legend.title = ggplot2::element_text(size = baseSize),
      legend.text = ggplot2::element_text(size = baseSize - 1),
      legend.key.height = grid::unit(0.9, "lines"),
      strip.text = ggplot2::element_text(size = baseSize + 1, face = "bold"),
      strip.background = ggplot2::element_rect(fill = "grey92", colour = "black", linewidth = 0.3)
    )

  if (faceted) {
    p <- p + ggplot2::facet_grid(ontology ~ ., scales = "free_y", space = "free_y")
  }

  # ---- 写出 ------------------------------------------------------------
  emit_progress("write", 85, paste0("rendering ", format))
  outDir <- dirname(outPath)
  if (!dir.exists(outDir)) dir.create(outDir, recursive = TRUE, showWarnings = FALSE)

  draw <- function() print(p)

  tryCatch({
    if (identical(format, "pdf")) {
      tryCatch({
        grDevices::cairo_pdf(outPath, width = widthIn, height = heightIn, bg = "white")
        draw()
        grDevices::dev.off()
      }, error = function(e) {
        if (!is.null(grDevices::dev.list())) try(grDevices::dev.off(), silent = TRUE)
        emit_log("warn", paste0("cairo_pdf failed, falling back: ", conditionMessage(e)))
        grDevices::pdf(outPath, width = widthIn, height = heightIn, bg = "white", useDingbats = FALSE)
        draw()
        grDevices::dev.off()
      })
    } else {
      ragg::agg_png(outPath, width = widthIn, height = heightIn, units = "in",
                    res = dpi, background = "white")
      draw()
      grDevices::dev.off()
    }
  }, error = function(e) {
    if (!is.null(grDevices::dev.list())) try(grDevices::dev.off(), silent = TRUE)
    deg_stop("E_IO_PERMISSION", paste0("render failed: ", conditionMessage(e)), status = 14L)
  })

  if (!file.exists(outPath)) {
    deg_stop("E_IO_PERMISSION", paste0("figure was not written: ", outPath), status = 14L)
  }

  emit_artifact("figure", basename(outPath))
  sizeBytes <- file.info(outPath)$size
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    outPath = outPath,
    bytes = as.integer(sizeBytes),
    terms = nrow(df),
    faceted = faceted,
    durationMs = as.integer(durationMs)
  ))
})
