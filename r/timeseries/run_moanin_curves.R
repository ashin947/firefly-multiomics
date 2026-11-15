# =============================================================================
# r/timeseries/run_moanin_curves.R —— 两组模式的「自选基因曲线」
#
# 与单序列的 run_timecourse_curves.R 对应：输入几个基因，画它们随时间的走势。
# 区别在**画什么**：
#   · 单序列：每簇的均值 ± SE 折线（同一个组）
#   · 两组：moanin 的 `plot_splines_data()` —— 每个基因一格，
#     **每组一条拟合样条 + 该组的实际观测点**。这才是「两组曲线是否不同」该有的样子。
#
# 不自己拼 ggplot：样条基、每组的置信带、观测点的位置都在 model 里，
# 自己重画一遍等于把 moanin 的拟合逻辑复制一份，迟早对不上。
#
# ★ 复用 `moanin_bundle.rds`：主分析已经把 model / log2 表达 / 组色存下来了，
#   这里不再读矩阵、不再拟合（否则画 3 个基因要等 20 秒）。
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

deg_main("timeseries/run_moanin_curves.R", function(ctx) {
  deg_ensure_pkgs(c("moanin", "ggplot2", "jsonlite"))
  startedAt <- Sys.time()

  bundlePath <- as.character(.ts_param(ctx, "bundleFile", ""))
  genes <- .ts_param(ctx, "genes", NULL)
  genes <- if (is.null(genes)) character(0) else trimws(as.character(genes))
  genes <- unique(genes[nzchar(genes)])
  if (length(genes) == 0) deg_stop("E_VALIDATION", "no genes given", status = 11L)
  if (length(genes) > 24) {
    deg_stop("E_VALIDATION", paste0("too many genes for one figure (", length(genes), "). Up to 24."),
             status = 11L)
  }
  if (!nzchar(bundlePath) || !file.exists(bundlePath)) {
    deg_stop("E_RESULT_INVALID",
             "moanin_bundle.rds not found; re-run the two-group analysis first", status = 13L)
  }

  emit_progress("read", 10, "loading moanin model")
  bundle <- readRDS(bundlePath)
  model <- bundle$model
  data <- bundle$data
  groupColors <- bundle$groupColors
  selectedGenes <- bundle$selectedGenes

  # ---- 基因名容错（与单序列一致）：Os03g54160 ↔ LOC_Os03g54160 ----------
  matched <- .ts_match_genes(genes, rownames(data))
  missingGenes <- matched$missing
  found <- unique(matched$found)
  if (length(missingGenes) > 0) {
    emit_log("warn", paste0("genes not in matrix: ", paste(missingGenes, collapse = ", ")))
  }
  if (length(found) == 0) {
    deg_stop("E_DATA_EMPTY", paste0(
      "none of the ", length(genes), " gene name(s) exist in this dataset (",
      paste(utils::head(genes, 8), collapse = ", "), "). Gene ids here look like: ",
      paste(utils::head(rownames(data), 3), collapse = ", "),
      ". Check spelling, or whether the id system differs (LOC_Os03g54160 vs Os03g54160)."),
      status = 14L)
  }

  # 存在但没过阈值：曲线照样画，只是提示「放宽阈值可进显著表」
  notSignificant <- if (length(selectedGenes) > 0) setdiff(found, selectedGenes) else character(0)
  if (length(notSignificant) > 0) {
    emit_log("info", paste0(
      "genes present but not significant at the current thresholds: ",
      paste(notSignificant, collapse = ", ")))
  }

  # ---- 出图：每基因一格，每组一条拟合样条 + 观测点 ----------------------
  emit_progress("plot", 45, sprintf("drawing %d gene(s)", length(found)))
  nGenes <- length(found)
  # plot_splines_data 的 legend 也占一个 panel：
  # 基因少时把 ncol 一起收窄，否则图例单独占一格、右边留一大片空白（截图为证）
  ncol <- min(4L, nGenes + 1L)
  nPanel <- nGenes + 1L
  nrow <- ceiling(nPanel / ncol)
  widthIn <- max(8, 3.2 * ncol)
  heightIn <- max(4.5, 2.6 * nrow)

  ok <- deg_save_drawer(
    file.path(ctx$runDir, "curves_custom.png"),
    width = widthIn, height = heightIn,
    drawer = function() {
      graphics::par(oma = c(0, 0, 1.6, 0))
      moanin::plot_splines_data(
        model[found, , drop = FALSE],
        data = data[found, , drop = FALSE],
        # colors 必须带名字：moanin 用 names(colors) 当图例标签
        colors = groupColors,
        smooth = TRUE,
        legend = TRUE,
        mfrow = c(nrow, ncol),
        ylab = "log2 expression"
      )
      graphics::mtext(
        sprintf("Spline fit per group (line) + observed samples (points): %d gene(s)", nGenes),
        side = 3, outer = TRUE, line = 0.2, cex = 0.85, font = 2
      )
    },
    label = "curves_custom"
  )
  if (!isTRUE(ok)) {
    deg_stop("E_R_GENERIC", "curve figure could not be saved", status = 1L)
  }

  # ---- 数值落盘：每基因 × 每组 × 每个时间点的均值与 SE ------------------
  emit_progress("write", 85, "writing curves_data.csv")
  # Moanin 没有 meta.data 槽：时间/分组要经 accessor 拿（顺序与 data 的列一致）
  timeVar <- as.character(moanin::time_variable(model))
  groupVar <- as.character(moanin::group_variable(model))
  rows <- list()
  for (g in found) {
    for (grp in names(groupColors)) {
      idxG <- which(groupVar == grp)
      for (tv in unique(timeVar)) {
        idx <- idxG[timeVar[idxG] == tv]
        if (length(idx) == 0) next
        vals <- as.numeric(data[g, idx])
        rows[[length(rows) + 1L]] <- data.frame(
          gene = g, group = grp, timepoint = tv,
          mean = round(mean(vals), 4),
          se = round(if (length(vals) > 1) stats::sd(vals) / sqrt(length(vals)) else 0, 4),
          n = length(vals),
          stringsAsFactors = FALSE
        )
      }
    }
  }
  utils::write.csv(do.call(rbind, rows), file.path(ctx$runDir, "curves_data.csv"),
                   row.names = FALSE, quote = FALSE)

  plots <- list(list(
    id = "curves_custom", file = "curves_custom.png",
    caption = sprintf("自选基因曲线（%d 个基因；每组一条拟合样条 + 观测点）", nGenes)
  ))
  emit_artifact("plot", "curves_custom.png")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    genes = unname(found),
    missingGenes = unname(missingGenes),
    notSignificant = unname(notSignificant),
    groups = unname(names(groupColors)),
    times = unname(bundle$times),
    nGenes = as.integer(nGenes),
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
