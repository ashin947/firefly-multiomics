# =============================================================================
# r/timeseries/run_timecourse_curves.R —— 自选基因的时序曲线图
#
# 客户的原话：「用户可以输入基因 → 画出这些基因的曲线图」。
#
# ## 两类「画不出来」必须分开报
#
#   · 名字不存在      → 拼写 / ID 体系不对（数据里是 LOC_Os03g54160，用户写了别的）
#   · 存在但未过阈值  → 数据本身不支持当前阈值，**放宽 q / |d| 就能看到**
#
# 这两件事的处理方式完全不同，合成一句「部分基因无效」等于没说。
# 本脚本的处理：能找到的就画（哪怕没过阈值 —— 曲线本身有信息量），
# 然后把「找不到」和「没通过」分别放进 missingGenes / notSignificant 返回，
# 界面按两类提示。一个都找不到时才报 E_DATA_EMPTY。
#
# ## 图里不能有中文
#
# 内置 R 的 Windows 图形设备没有中文字体，中文会渲染成方块（□□）。
# 所以坐标轴/标题/图例一律英文；中文说明留给界面与 CSV。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))
source(file.path(.deg_root, "timeseries", "common_timeseries.R"))

.ts_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

deg_main("timeseries/run_timecourse_curves.R", function(ctx) {
  deg_ensure_pkgs(c("ggplot2", "jsonlite"))
  startedAt <- Sys.time()

  matrixFile <- as.character(.ts_param(ctx, "matrixFile", ""))
  samples <- .ts_param(ctx, "samples", NULL)
  genes <- .ts_param(ctx, "genes", NULL)
  genes <- if (is.null(genes)) character(0) else trimws(as.character(genes))
  genes <- unique(genes[nzchar(genes)])
  useLog2 <- isTRUE(.ts_param(ctx, "log2", TRUE))
  minSamplesExpr <- as.integer(.ts_param(ctx, "minSamplesExpr", 3L))

  if (length(genes) == 0) {
    deg_stop("E_VALIDATION", "no genes given", status = 11L)
  }
  if (length(genes) > 24) {
    deg_stop("E_VALIDATION",
             paste0("too many genes for one figure (", length(genes), "). Up to 24."),
             status = 11L)
  }

  # ---- 1. 读矩阵（与主脚本同一套过滤，保证「曲线里的基因」= 「SAM 里参与检验的基因」）
  emit_progress("read", 10, "reading matrix")
  read <- .ts_read_matrix(matrixFile)
  x <- read$matrix
  design <- .ts_build_design(samples, colnames(x))
  meta <- design$meta
  x <- x[, meta$name, drop = FALSE]

  keep <- rowSums(x > 1) >= minSamplesExpr
  x <- x[keep, , drop = FALSE]
  if (useLog2) x <- log2(x + 0.01)

  # ---- 2. 基因名容错 + 分类 ----------------------------------------------
  matched <- .ts_match_genes(genes, rownames(x))
  missingGenes <- matched$missing
  # ★ 去重：用户可能同时填了 `Os03g54160` 和 `LOC_Os03g54160`，两者会匹配到同一个基因，
  #   不去重的话 `factor(levels = found)` 会报 "factor level [n] is duplicated"。
  found <- unique(matched$found)
  if (length(missingGenes) > 0) {
    emit_log("warn", paste0("genes not in matrix: ", paste(missingGenes, collapse = ", ")))
  }
  if (length(found) == 0) {
    deg_stop("E_DATA_EMPTY", paste0(
      "none of the ", length(genes), " gene name(s) exist in this matrix (",
      paste(utils::head(genes, 8), collapse = ", "),
      if (length(genes) > 8) ", ..." else "",
      "). Gene ids here look like: ", paste(utils::head(rownames(x), 3), collapse = ", "),
      ". Check spelling, or whether the id system differs (LOC_Os03g54160 vs Os03g54160)."),
      status = 14L)
  }

  # 显著基因清单来自主分析（sam_sig.csv）；文件不存在时就不做这个区分
  sigPath <- file.path(ctx$runDir, "sam_sig.csv")
  sigGenes <- character(0)
  if (file.exists(sigPath)) {
    sigDf <- tryCatch(utils::read.csv(sigPath, stringsAsFactors = FALSE), error = function(e) NULL)
    if (!is.null(sigDf) && "gene" %in% colnames(sigDf)) sigGenes <- as.character(sigDf$gene)
  }
  notSignificant <- if (length(sigGenes) > 0) setdiff(found, sigGenes) else character(0)
  if (length(notSignificant) > 0) {
    emit_log("info", paste0("genes present but not significant at the current thresholds: ",
                            paste(notSignificant, collapse = ", ")))
  }

  # ---- 3. 组装长表：基因 × 时间（× 组）-----------------------------------
  emit_progress("aggregate", 40, "aggregating mean and SE")
  times <- design$times
  # 同一时间点是否有多组（如 ck/dt）—— 决定「画几条线」，而不是无脑上色
  grpPerTime <- tapply(meta$group, meta$time, function(g) length(unique(g)))
  multiGroup <- length(unique(meta$group)) > 1 && all(grpPerTime > 1)

  rows <- list()
  for (g in found) {
    for (t in times) {
      idxAll <- which(meta$time == t)
      if (length(idxAll) == 0) next
      groups <- if (multiGroup) sort(unique(meta$group[idxAll])) else ""
      for (gr in groups) {
        idx <- if (nzchar(gr)) idxAll[meta$group[idxAll] == gr] else idxAll
        if (length(idx) == 0) next
        vals <- as.numeric(x[g, meta$name[idx]])
        rows[[length(rows) + 1L]] <- data.frame(
          gene = g,
          time = t,
          group = if (nzchar(gr)) gr else "all",
          mean = mean(vals),
          sd = if (length(vals) > 1) stats::sd(vals) else 0,
          n = length(vals),
          stringsAsFactors = FALSE
        )
      }
    }
  }
  df <- do.call(rbind, rows)
  if (is.null(df) || nrow(df) == 0) {
    deg_stop("E_RESULT_INVALID", "no data points to plot", status = 13L)
  }
  df$se <- df$sd / sqrt(pmax(1, df$n))
  df$time <- factor(df$time, levels = times)
  df$gene <- factor(df$gene, levels = found)
  df$lo <- df$mean - df$se
  df$hi <- df$mean + df$se

  # ---- 4. 出图 ------------------------------------------------------------
  emit_progress("plot", 70, "drawing curves")
  nGenes <- length(found)
  ncol <- if (nGenes <= 3) nGenes else if (nGenes <= 8) 3 else 4
  nrow <- ceiling(nGenes / ncol)
  ylab <- if (useLog2) "Expression (log2)" else "Expression"

  p <- ggplot2::ggplot(df, ggplot2::aes(x = time, y = mean,
                                        colour = group, fill = group, group = group)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = lo, ymax = hi), alpha = 0.22, colour = NA) +
    ggplot2::geom_line(linewidth = 0.7) +
    ggplot2::geom_point(size = 1.1) +
    ggplot2::facet_wrap(~gene, ncol = ncol, scales = "free_y") +
    ggplot2::labs(
      x = "Time point", y = ylab, colour = NULL, fill = NULL,
      title = "Time-course expression (mean ± SE across replicates)",
      caption = paste0("Ribbon = ±1 SE. Points are means over ",
                       if (length(unique(meta$rep)) > 1) "replicates" else "samples", ".")
    ) +
    ggplot2::theme_bw(base_size = 10) +
    ggplot2::theme(
      axis.text.x = ggplot2::element_text(size = 8),
      panel.grid.minor = ggplot2::element_blank(),
      strip.background = ggplot2::element_rect(fill = "grey94", colour = "grey70"),
      legend.position = if (multiGroup) "top" else "none",
      plot.title = ggplot2::element_text(size = 10),
      plot.caption = ggplot2::element_text(size = 7, colour = "grey40")
    )
  if (!multiGroup) {
    # 单序列（或各组时间点不重叠）：一条线，用主色即可，别让「颜色」承载多余信息
    p <- p + ggplot2::scale_colour_manual(values = "#2F6F4F") +
      ggplot2::scale_fill_manual(values = "#2F6F4F")
  }

  plots <- list()
  file <- "curves_timecourse.png"
  if (.ts_save_plot(p, file.path(ctx$runDir, file),
                    max(7, 3.2 * ncol), max(3.2, 2.8 * nrow + 1.2), "curves")) {
    plots[[1]] <- list(
      id = "curves", file = file,
      caption = sprintf("自选基因时序曲线（%d 个基因；阴影 = ±1 SE）", nGenes)
    )
    emit_artifact("plot", file)
  }
  if (length(plots) == 0) {
    deg_stop("E_R_GENERIC", "curve figure could not be saved", status = 1L)
  }

  # ---- 5. 数值也落一份，方便对账 -----------------------------------------
  outDf <- data.frame(
    gene = as.character(df$gene), time = as.character(df$time), group = df$group,
    mean = round(df$mean, 4), se = round(df$se, 4), n = df$n,
    stringsAsFactors = FALSE
  )
  utils::write.csv(outDf, file.path(ctx$runDir, "curves_data.csv"), row.names = FALSE, quote = FALSE)

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    genes = unname(found),
    missingGenes = unname(missingGenes),
    notSignificant = unname(notSignificant),
    times = unname(times),
    multiGroup = multiGroup,
    groups = unname(sort(unique(meta$group))),
    nSamples = as.integer(nrow(meta)),
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
