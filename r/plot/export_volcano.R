# =============================================================================
# r/plot/export_volcano.R —— 出版级火山图（ggplot2）
#
# 为什么导出不用前端的 ECharts：
#   交互预览要快、要能 hover，所以用 ECharts；但投稿用的图需要
#   theme_bw + 黑框 + 精确的 pt 字号 + 真矢量 PDF，这些 ggplot2 更专业。
#   ARCHITECTURE §4.5 一开始就是这么分工的（预览 ECharts / 导出 R）。
#
# 风格参照客户提供的样例脚本：
#   theme_bw() + panel.border 黑框 + 去次网格 + 白底
#   axis.title 10pt / axis.text 9pt / 图例内嵌右上
#   **配色与是否标注基因都不照抄** —— 配色由界面传入，基因标注按需求关闭。
#
# 输入：run_config.json 的 params（见 build_config 的字段说明）
# 输出：把图写到 params$outPath，格式由 params$format 决定
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
# ★ 加载 loader.R 而不是 bootstrap.R：后者由 loader.R 以与 locale 无关的方式加载，
#   否则 Windows + LC_CTYPE=C 会「source 半途返回 → 找不到 deg_main」。见 loader.R 文件头。
source(file.path(.deg_root, "common", "loader.R"))

#' 取参数并给默认值
.plot_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

deg_main("plot/export_volcano.R", function(ctx) {
  deg_validate_common(ctx)
  # ragg 出 PNG（比 png() 抗锯齿好得多）；PDF 用 grDevices 自带设备
  deg_ensure_pkgs(c("ggplot2", "ragg", "data.table"))
  startedAt <- Sys.time()

  dataPath <- as.character(.plot_param(ctx, "dataPath", ""))
  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 8))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 6))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))
  lfcTh <- as.numeric(.plot_param(ctx, "logFC", 1))
  fdrTh <- as.numeric(.plot_param(ctx, "fdr", 0.05))
  basis <- as.character(.plot_param(ctx, "basis", "adjPValue"))
  title <- as.character(.plot_param(ctx, "title", ""))

  colors <- .plot_param(ctx, "colors", list())
  colUp <- as.character(if (is.null(colors$up)) "#FC6882" else colors$up)
  colDown <- as.character(if (is.null(colors$down)) "#54BCD1" else colors$down)
  colNs <- as.character(if (is.null(colors$ns)) "#B0B7C3" else colors$ns)

  if (!nzchar(dataPath)) deg_stop("E_IO_PERMISSION", "dataPath is empty", status = 11L)
  if (!nzchar(outPath)) deg_stop("E_IO_PERMISSION", "outPath is empty", status = 11L)
  if (!file.exists(dataPath)) {
    deg_stop("E_IO_PERMISSION", paste0("data file not found: ", dataPath), status = 11L)
  }
  if (!is.finite(widthIn) || widthIn <= 0) widthIn <- 8
  if (!is.finite(heightIn) || heightIn <= 0) heightIn <- 6
  if (!is.finite(dpi) || dpi < 72) dpi <- 300

  emit_progress("read", 15, "reading differential result")
  df <- data.table::fread(dataPath, data.table = FALSE, check.names = FALSE)
  if (!all(c("logFC", "pValue", "adjPValue") %in% names(df))) {
    deg_stop("E_RESULT_INVALID",
             paste0("unexpected columns: ", paste(names(df), collapse = ", ")),
             status = 13L)
  }
  emit_log("info", sprintf("result table: %d rows", nrow(df)))

  # ---- 判定依据：与前端 isSignificant 逐字同源 ----
  # basis='pValue' 时用原始 P，'adjPValue' 时用校正 P；两者都要求 pValue < 1 的守卫，
  # 因为那一列非有限值的行根本没被检验过。
  pForTest <- if (identical(basis, "pValue")) df$pValue else df$adjPValue
  usable <- is.finite(df$pValue) & df$pValue < 1 & is.finite(pForTest) & is.finite(df$logFC)
  significant <- usable & abs(df$logFC) >= lfcTh & pForTest < fdrTh

  df$change <- ifelse(significant, ifelse(df$logFC > 0, "up", "down"), "stable")
  df$change <- factor(df$change, levels = c("up", "down", "stable"))

  # y 轴同样用判定依据那一列：否则又会出现「虚线以上的点却不显著」
  safeP <- ifelse(is.finite(pForTest) & pForTest > 0, pForTest, 1e-300)
  df$negLogP <- pmin(300, -log10(safeP))

  nUp <- sum(df$change == "up")
  nDown <- sum(df$change == "down")
  nStable <- sum(df$change == "stable")
  emit_log("info", sprintf("up=%d down=%d stable=%d (|logFC|>=%g, %s<%g)",
                           nUp, nDown, nStable, lfcTh, basis, fdrTh))
  emit_progress("enrich", 45, sprintf("%d up / %d down", nUp, nDown))

  # ---- 组装图 ----
  yLabel <- if (identical(basis, "pValue")) "-log10(P value)" else "-log10(adjusted P value)"

  # 刻度向上取整，避免出现 13.78984 这种标签把画布顶破
  yMax <- max(c(df$negLogP[is.finite(df$negLogP)], -log10(fdrTh)), na.rm = TRUE)
  yMax <- max(1, ceiling(yMax))
  xAbs <- max(c(abs(df$logFC[is.finite(df$logFC)]), lfcTh), na.rm = TRUE)
  xAbs <- max(1, ceiling(xAbs))

  # 点大小按「图宽」缩放。
  #
  # ggplot 的 size 是毫米直径，在 3.5 英寸的单栏图上 2mm 会显得像气球
  # （实测导出时点互相粘连、把数据分布糊住）；7 英寸图又需要 2mm 才看得清。
  # 以 6 英寸为基准线性缩放，并夹在 [1.1, 2.6]。
  pointMm <- max(1.1, min(2.6, 1.9 * (widthIn / 6) + 0.6))
  # 图例里的示例点比实际点稍大一点，否则在图例里几乎看不见
  legendMm <- pointMm * 1.45
  emit_log("info", sprintf("point size = %.2f mm (width %.1f in)", pointMm, widthIn))

  p <- ggplot2::ggplot(df, ggplot2::aes(x = .data$logFC, y = .data$negLogP)) +
    ggplot2::geom_point(ggplot2::aes(color = .data$change), alpha = 0.65, shape = 16, size = pointMm) +
    ggplot2::geom_hline(yintercept = -log10(fdrTh), linetype = "dashed", colour = "grey40", linewidth = 0.4) +
    ggplot2::geom_vline(xintercept = c(-lfcTh, lfcTh), linetype = "dashed", colour = "grey40", linewidth = 0.4) +
    ggplot2::scale_color_manual(
      values = c(up = colUp, down = colDown, stable = colNs),
      labels = c(
        up = sprintf("up %d", nUp),
        down = sprintf("down %d", nDown),
        stable = sprintf("stable %d", nStable)
      ),
      drop = FALSE
    ) +
    ggplot2::scale_x_continuous(limits = c(-xAbs, xAbs)) +
    ggplot2::scale_y_continuous(limits = c(0, yMax)) +
    ggplot2::labs(
      x = "log2(fold change)",
      y = yLabel,
      colour = "Expression change",
      title = if (nzchar(title)) title else NULL
    ) +
    # 图例不显示标题：up/down/stable 已经自明，而「Expression change」在
    # 3.5 英寸的图上会占掉图例近一半宽度，把绘图区挤得很窄
    ggplot2::guides(
      colour = ggplot2::guide_legend(
        title = NULL,
        override.aes = list(size = legendMm, alpha = 1)
      )
    ) +
    ggplot2::theme_bw() +
    ggplot2::theme(
      # 与样例脚本一致：黑框、去次网格、透明背景（PDF 里靠设备白底）
      panel.border = ggplot2::element_rect(colour = "black", fill = NA, linewidth = 0.5),
      panel.grid.minor = ggplot2::element_blank(),
      panel.background = ggplot2::element_blank(),
      plot.background = ggplot2::element_blank(),
      axis.title = ggplot2::element_text(colour = "black", size = 10),
      axis.text = ggplot2::element_text(colour = "black", size = 9),
      # 图例移到绘图区**外**的右侧。
      #
      # 最初照参考脚本做成内嵌右上 + 白底，实测两个问题：
      # ① 白底会把右上角的点切掉一半（图上有半截红点）；
      # ② 3.5 英寸的单栏图上，内嵌图例占掉近 1/4 的绘图面积，数据被压扁。
      # 挪到图外后两个问题一起消失，也是期刊里常见的排法。
      legend.background = ggplot2::element_blank(),
      legend.key = ggplot2::element_blank(),
      legend.text = ggplot2::element_text(colour = "black", size = 9),
      legend.spacing.x = grid::unit(0, "cm"),
      # key 默认 1.2 lines 太大，点在图例里像两颗纽扣
      legend.key.size = grid::unit(0.9, "lines"),
      legend.margin = ggplot2::margin(0, 2, 0, 2),
      legend.position = "right",
      legend.direction = "vertical",
      plot.title = ggplot2::element_text(size = 11, hjust = 0.5, colour = "black")
    )

  # ---- 写出 ----
  emit_progress("write", 80, paste0("rendering ", format))
  outDir <- dirname(outPath)
  if (!dir.exists(outDir)) dir.create(outDir, recursive = TRUE, showWarnings = FALSE)

  ok <- tryCatch({
    if (identical(format, "pdf")) {
      # cairo_pdf 支持较完整的字体与透明度；失败退回 base pdf（英文标签没问题）
      rendered <- tryCatch({
        grDevices::cairo_pdf(outPath, width = widthIn, height = heightIn, bg = "white")
        print(p)
        grDevices::dev.off()
        TRUE
      }, error = function(e) {
        if (!is.null(grDevices::dev.list())) try(grDevices::dev.off(), silent = TRUE)
        emit_log("warn", paste0("cairo_pdf failed, falling back to pdf(): ", conditionMessage(e)))
        grDevices::pdf(outPath, width = widthIn, height = heightIn, bg = "white", useDingbats = FALSE)
        print(p)
        grDevices::dev.off()
        TRUE
      })
      rendered
    } else {
      # ragg 的 agg_png：抗锯齿与字体渲染明显好于 png()
      ragg::agg_png(outPath, width = widthIn, height = heightIn, units = "in",
                    res = dpi, background = "white")
      print(p)
      grDevices::dev.off()
      TRUE
    }
  }, error = function(e) {
    if (!is.null(grDevices::dev.list())) try(grDevices::dev.off(), silent = TRUE)
    deg_stop("E_IO_PERMISSION", paste0("render failed: ", conditionMessage(e)), status = 14L)
  })

  if (!isTRUE(ok) || !file.exists(outPath)) {
    deg_stop("E_IO_PERMISSION", paste0("figure was not written: ", outPath), status = 14L)
  }
  sizeBytes <- file.info(outPath)$size
  # emit_artifact 只接受 kind/path/rows/schema，字节数走 result 的 summary
  emit_artifact("figure", basename(outPath))

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    outPath = outPath,
    bytes = as.integer(sizeBytes),
    format = format,
    widthIn = widthIn,
    heightIn = heightIn,
    dpi = dpi,
    up = nUp,
    down = nDown,
    stable = nStable,
    durationMs = as.integer(durationMs)
  ))
})
