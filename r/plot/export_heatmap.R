# =============================================================================
# r/plot/export_heatmap.R —— 差异基因热图（pheatmap）
#
# 数据来源：
#   - 表达矩阵：项目里的 data/expression.clean.csv（基因 × 样本）
#   - 分组表  ：data/groups.csv（样本 → 分组），用于 annotation_col
#   - 差异结果：主进程传进来的临时 de.csv，用于挑 top N 基因
#
# 两种选基因方式（优先级：geneList > topN）：
#   1. geneList 非空 → 完全按用户给的列表画，**不受 top40 限制**
#      （用户的场景：文献里看到的基因集，想单独看它们在样本间的模式）
#   2. geneList 为空 → 显著基因按 FDR 升序取前 topN（默认 40）
#
# 输出：与火山图一致 —— params$outPath + params$format，PNG 用 ragg、PDF 用 cairo_pdf。
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

deg_main("plot/export_heatmap.R", function(ctx) {
  deg_validate_common(ctx)
  deg_ensure_pkgs(c("pheatmap", "ragg", "data.table"))
  startedAt <- Sys.time()

  matrixPath <- as.character(.plot_param(ctx, "matrixPath", ""))
  groupsPath <- as.character(.plot_param(ctx, "groupsPath", ""))
  dePath <- as.character(.plot_param(ctx, "dePath", ""))
  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 8))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 6))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))

  topN <- as.integer(.plot_param(ctx, "topN", 40))
  clusterRows <- isTRUE(.plot_param(ctx, "clusterRows", TRUE))
  clusterCols <- isTRUE(.plot_param(ctx, "clusterCols", TRUE))
  scaleMode <- as.character(.plot_param(ctx, "scale", "row"))
  showGeneNames <- isTRUE(.plot_param(ctx, "showGeneNames", TRUE))
  showSampleNames <- isTRUE(.plot_param(ctx, "showSampleNames", TRUE))
  showGroupAnnotation <- isTRUE(.plot_param(ctx, "showGroupAnnotation", TRUE))
  lfcTh <- as.numeric(.plot_param(ctx, "logFC", 1))
  fdrTh <- as.numeric(.plot_param(ctx, "fdr", 0.05))
  basis <- as.character(.plot_param(ctx, "basis", "adjPValue"))

  colors <- .plot_param(ctx, "colors", list())
  colLow <- as.character(if (is.null(colors$low)) "#2166AC" else colors$low)
  colMid <- as.character(if (is.null(colors$mid)) "#FFFFFF" else colors$mid)
  colHigh <- as.character(if (is.null(colors$high)) "#B2182B" else colors$high)

  geneList <- as.character(.plot_param(ctx, "geneList", character(0)))
  geneList <- geneList[nzchar(geneList)]

  if (!nzchar(matrixPath) || !file.exists(matrixPath)) {
    deg_stop("E_DATA_EMPTY", paste0("expression matrix not found: ", matrixPath), status = 13L)
  }
  if (!nzchar(outPath)) deg_stop("E_IO_PERMISSION", "outPath is empty", status = 11L)
  if (!is.finite(widthIn) || widthIn <= 0) widthIn <- 8
  if (!is.finite(heightIn) || heightIn <= 0) heightIn <- 6
  if (!is.finite(dpi) || dpi < 72) dpi <- 300
  if (!is.finite(topN) || topN < 1) topN <- 40
  if (!scaleMode %in% c("none", "row", "column")) scaleMode <- "row"

  # ---- 1. 读表达矩阵 ----
  emit_progress("read", 10, "reading expression matrix")
  mat <- data.table::fread(matrixPath, data.table = FALSE, check.names = FALSE)
  if (ncol(mat) < 2) {
    deg_stop("E_DATA_EMPTY", "expression matrix has no sample columns", status = 13L)
  }
  geneIds <- as.character(mat[[1]])
  expr <- as.matrix(mat[, -1, drop = FALSE])
  storage.mode(expr) <- "double"
  rownames(expr) <- geneIds
  # 表达矩阵里可能出现 NA（原始数据缺失）：pheatmap 遇到 NA 会画白块，
  # 这里显式填成该基因的中位数，并在日志里说明填了多少。
  naCount <- sum(!is.finite(expr))
  if (naCount > 0) {
    for (i in seq_len(nrow(expr))) {
      bad <- !is.finite(expr[i, ])
      if (any(bad)) expr[i, bad] <- stats::median(expr[i, !bad], na.rm = TRUE)
    }
    emit_log("warn", sprintf("filled %d missing values with per-gene median", naCount))
  }
  emit_log("info", sprintf("matrix: %d genes x %d samples", nrow(expr), ncol(expr)))
  samples <- colnames(expr)

  # ---- 2. 选基因 ----
  if (length(geneList) > 0) {
    # 用户给定的列表：先按 gene_id 匹配，再按 gene_name 兜底
    hit <- intersect(geneList, rownames(expr))
    if (length(hit) < length(geneList) && nzchar(dePath) && file.exists(dePath)) {
      de <- data.table::fread(dePath, data.table = FALSE, check.names = FALSE)
      if (all(c("gene_id", "gene_name") %in% names(de))) {
        nameMap <- de[!is.na(de$gene_name) & nzchar(de$gene_name), c("gene_id", "gene_name")]
        extra <- nameMap$gene_id[match(setdiff(geneList, hit), nameMap$gene_name)]
        hit <- unique(c(hit, extra[!is.na(extra)]))
      }
    }
    missing <- setdiff(geneList, hit)
    if (length(missing) > 0) {
      emit_log("warn", sprintf("%d requested genes not found in matrix: %s",
                               length(missing), paste(utils::head(missing, 10), collapse = ", ")))
    }
    if (length(hit) == 0) {
      deg_stop("E_DATA_EMPTY",
               paste0("none of the requested genes were found in the expression matrix (",
                      length(geneList), " requested)"),
               status = 13L)
    }
    selected <- hit
    emit_log("info", sprintf("using user gene list: %d of %d found", length(hit), length(geneList)))
  } else {
    if (!nzchar(dePath) || !file.exists(dePath)) {
      deg_stop("E_DATA_EMPTY", "differential result not found; cannot pick top genes", status = 13L)
    }
    de <- data.table::fread(dePath, data.table = FALSE, check.names = FALSE)
    if (!all(c("gene_id", "logFC", "pValue", "adjPValue") %in% names(de))) {
      deg_stop("E_RESULT_INVALID", "unexpected columns in differential result", status = 13L)
    }
    pForTest <- if (identical(basis, "pValue")) de$pValue else de$adjPValue
    sig <- is.finite(de$pValue) & de$pValue < 1 &
      is.finite(pForTest) & pForTest < fdrTh & abs(de$logFC) >= lfcTh
    pool <- de[sig, , drop = FALSE]
    if (nrow(pool) == 0) {
      deg_stop("E_DATA_EMPTY",
               sprintf("no significant genes at |logFC|>=%g and %s<%g; relax the threshold or provide a gene list",
                       lfcTh, basis, fdrTh),
               status = 13L)
    }
    pool <- pool[order(pForTest[sig]), , drop = FALSE]
    want <- utils::head(as.character(pool$gene_id), topN)
    selected <- intersect(want, rownames(expr))
    if (length(selected) == 0) {
      deg_stop("E_DATA_EMPTY",
               "the top significant genes are not present in the expression matrix", status = 13L)
    }
    emit_log("info", sprintf("picked top %d significant genes (of %d) by %s",
                             length(selected), nrow(pool), basis))
  }
  emit_progress("filter", 35, sprintf("%d genes selected", length(selected)))

  # ---- 3. 组装矩阵 ----
  # 行序：`selected` 已是目标顺序（用户列表原序 / top N 按显著性），
  # intersect() 会保持左侧参数的顺序，所以这里直接取即可
  sub <- expr[selected, , drop = FALSE]

  annotation <- NULL
  if (showGroupAnnotation && nzchar(groupsPath) && file.exists(groupsPath)) {
    grp <- data.table::fread(groupsPath, data.table = FALSE, check.names = FALSE)
    if (all(c("sample", "group") %in% names(grp))) {
      idx <- match(samples, as.character(grp$sample))
      groupVec <- as.character(grp$group[idx])
      groupVec[is.na(groupVec)] <- "NA"
      annotation <- data.frame(Group = groupVec, row.names = samples, check.names = FALSE)
      emit_log("info", sprintf("annotation: %d samples, %d groups",
                               length(groupVec), length(unique(groupVec))))
    } else {
      emit_log("warn", "groups table missing sample/group columns; annotation skipped")
    }
  }

  # ---- 4. 字体与几何自适应 ----
  # 基因数 40 时 8pt 够用；200 个基因再 8pt 就糊成一条，必须缩小
  nR <- nrow(sub)
  nC <- ncol(sub)
  fontRow <- max(4.5, min(9, 220 / max(nR, 1)))
  fontCol <- max(5.5, min(9, 260 / max(nC, 1)))
  # 样本多时横排会重叠，统一转 45°
  angleCol <- if (nC > 12) 45 else 0

  colorFun <- grDevices::colorRampPalette(c(colLow, colMid, colHigh))(100)

  emit_progress("render", 60, "drawing heatmap")
  ph <- pheatmap::pheatmap(
    sub,
    cluster_rows = clusterRows,
    cluster_cols = clusterCols,
    color = colorFun,
    scale = scaleMode,
    annotation_col = annotation,
    show_rownames = showGeneNames,
    show_colnames = showSampleNames,
    fontsize_row = fontRow,
    fontsize_col = fontCol,
    angle_col = angleCol,
    border_color = NA,
    silent = TRUE,
    main = if (nzchar(as.character(.plot_param(ctx, "title", "")))) {
      as.character(.plot_param(ctx, "title", ""))
    } else {
      NA
    }
  )

  # ---- 5. 写出 ----
  emit_progress("write", 85, paste0("rendering ", format))
  outDir <- dirname(outPath)
  if (!dir.exists(outDir)) dir.create(outDir, recursive = TRUE, showWarnings = FALSE)

  # 留 4% 边距：pheatmap 的 gtable 宽度贴着设备边缘，直接 grid.draw 会把
  # 行聚类树状图最外侧的枝条切掉（实测 7 英寸图上很明显）
  draw <- function() {
    grid::grid.newpage()
    grid::pushViewport(grid::viewport(width = 0.96, height = 0.96))
    grid::grid.draw(ph$gtable)
    grid::popViewport()
  }

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

  sizeBytes <- file.info(outPath)$size
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
    genes = length(selected),
    samples = nC,
    durationMs = as.integer(durationMs)
  ))
})
