# =============================================================================
# r/viz/plot_violin.R —— 多基因 × 多组的分面分布图（小提琴 / 箱线 / 蜂群）
#
# 输入：
#   matrixPath  表达矩阵（行=基因，列=样本，第一列是基因 ID）
#   groupsPath  分组表（两列：样本、分组）
#   genes       要画的基因，顺序即分面顺序
#
# 输出：PNG / PDF，每个基因一个分面，组间两两比较画括号 + FDR
#
# ## 为什么自己算检验、自己画括号，不用 ggpubr::stat_compare_means
#
# 1. `stat_compare_means` 在 **facet** 里做「所有组两两比较」时，需要把
#    comparisons 交给 `ggsignif`，而 ggsignif 的图层是按整个数据集算的 ——
#    多分面时括号会被画到每个分面上、y 位置互相打架。
# 2. FDR 的校正范围是个**统计决策**，必须能说清楚。这里统一在
#    「所有基因 × 所有两两比较」上做一次 BH 校正，而不是每个基因各校正一次：
#    一张图里 4 个基因 × 1 个比较只差一点，但 40 个基因时会明显高估显著性。
#    自己算才能把这件事写成代码里的定论，也才能写进 summary 让用户看到。
#
# ## y 轴留白
#
# 括号是数据坐标里画的，所以分面的 y 范围必须容得下它们。先在数据层把
# 每个基因的 (最小值, 括号总高度) 算出来，再按比例加 headroom；
# 不能等画完再调 ylim —— facet 各自独立缩放时 ylim 会互相干涉。
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

#' 读表达矩阵，并对「表头被判成数据」做兜底
#'
#' data.table::fread 的表头自动判定看的是第一行内容：当样本列名全是 `"1"`
#' `"2"` 这种纯数字字符串时（手工导出的矩阵很常见），它会把表头当成数据行，
#' 列名退化成 V1/V2/…，于是界面传下来的 `geneColumn` 找不到 —— 报的还是
#' 「找不到基因列 'gene'」，看起来像用户选错了列，其实是我们读错了。
#' 这里显式重试一次 `header=TRUE`，比让用户去猜要靠谱。
.read_matrix <- function(path, geneColumn) {
  mat <- read_viz_table(path)
  if (!nzchar(geneColumn) || geneColumn %in% names(mat)) return(mat)

  retry <- tryCatch(
    data.table::fread(path, encoding = "UTF-8", header = TRUE),
    error = function(e) NULL
  )
  if (!is.null(retry) && geneColumn %in% names(retry)) {
    emit_log("warn", "表头被自动识别成数据行，已按 header=TRUE 重新读取")
    return(retry)
  }
  deg_stop("E_DATA_SCHEMA",
           paste0("矩阵里找不到基因列 '", geneColumn, "'（识别到的列：",
                  paste(utils::head(names(mat), 8), collapse = ","), " ...）"),
           status = 10L)
}

#' 读分组表：两列（样本、分组）
#'
#' 列名不写死：`sample`/`样本`、`group`/`分组` 都认，认不出就取前两列。
#' 手工统计表里这两种列名混用极其常见，逼用户改名是不必要的摩擦。
.read_groups <- function(path, sampleColumn = "", groupColumn = "") {
  dt <- data.table::fread(path, encoding = "UTF-8")
  cols <- names(dt)
  if (length(cols) < 2) {
    deg_stop("E_DATA_SCHEMA",
             paste0("分组表至少需要两列（样本, 分组），实际只有 ", length(cols), " 列"),
             status = 10L)
  }
  if (!nzchar(sampleColumn)) {
    hit <- cols[grepl("^(sample|sample_?id|sample_?name|lib|library|样本|样本id|样本编号)$",
                      cols, ignore.case = TRUE)]
    sampleColumn <- if (length(hit) > 0) hit[1] else cols[1]
  }
  if (!nzchar(groupColumn)) {
    hit <- cols[grepl("^(group|condition|treat|treatment|class|分组|组别)$",
                      cols, ignore.case = TRUE)]
    groupColumn <- if (length(hit) > 0) hit[1] else cols[2]
  }
  if (!all(c(sampleColumn, groupColumn) %in% cols)) {
    deg_stop("E_DATA_SCHEMA",
             paste0("分组表缺少列：", sampleColumn, " / ", groupColumn,
                    "（现有：", paste(cols, collapse = ","), "）"),
             status = 10L)
  }
  out <- data.frame(
    sample = trimws(as.character(dt[[sampleColumn]])),
    group = trimws(as.character(dt[[groupColumn]])),
    stringsAsFactors = FALSE
  )
  out[nzchar(out$sample) & nzchar(out$group), , drop = FALSE]
}

deg_main("viz/plot_violin.R", function(ctx) {
  deg_ensure_pkgs(c("data.table", "ggplot2"))
  startedAt <- Sys.time()

  matrixPath <- as.character(.plot_param(ctx, "matrixPath", ""))
  groupsPath <- as.character(.plot_param(ctx, "groupsPath", ""))
  geneColumn <- as.character(.plot_param(ctx, "geneColumn", ""))
  genes <- as.character(.plot_param(ctx, "genes", character(0)))
  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 9))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 5))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))
  title <- as.character(.plot_param(ctx, "title", ""))

  plotType <- as.character(.plot_param(ctx, "plotType", "violin"))
  inputIsLog2 <- isTRUE(.plot_param(ctx, "inputIsLog2", TRUE))
  testMethod <- as.character(.plot_param(ctx, "testMethod", "wilcox"))
  # 图上括号标 p 还是 FDR。客户要的是 p 值（能和「两组 Wilcoxon 得 p=0.0002」
  # 一一对上）；FDR 仍然算、仍然在 summary 里，只是默认不标在图上。
  pLabel <- as.character(.plot_param(ctx, "pLabel", "p"))
  refGroup <- as.character(.plot_param(ctx, "refGroup", ""))
  showPoints <- isTRUE(.plot_param(ctx, "showPoints", FALSE))
  showMean <- isTRUE(.plot_param(ctx, "showMean", TRUE))
  paletteSpec <- as.character(.plot_param(ctx, "palette", "lancet"))
  facetFreeY <- isTRUE(.plot_param(ctx, "facetFreeY", TRUE))
  yLabel <- as.character(.plot_param(ctx, "yLabel", ""))
  xLabel <- as.character(.plot_param(ctx, "xLabel", ""))

  if (!nzchar(matrixPath) || !file.exists(matrixPath)) {
    deg_stop("E_VALIDATION", paste0("matrix file not found: ", matrixPath), status = 11L)
  }
  if (!nzchar(groupsPath) || !file.exists(groupsPath)) {
    deg_stop("E_VALIDATION",
             "缺少分组表：小提琴图必须知道每个样本属于哪一组，请选择分组文件。",
             status = 11L)
  }
  if (length(genes) == 0) {
    deg_stop("E_VALIDATION", "未指定要绘制的基因。", status = 11L)
  }

  emit_progress("read", 15, "reading expression matrix")
  mat <- .read_matrix(matrixPath, geneColumn)
  cols <- names(mat)

  if (!nzchar(geneColumn)) {
    hit <- cols[grepl("^(gene|gene_?id|gene_?symbol|gene_?name|symbol|id|基因|基因id|基因名)$",
                      cols, ignore.case = TRUE)]
    geneColumn <- if (length(hit) > 0) hit[1] else cols[1]
  }
  if (!geneColumn %in% cols) {
    deg_stop("E_DATA_SCHEMA",
             paste0("矩阵里找不到基因列 '", geneColumn, "'（现有列：",
                    paste(utils::head(cols, 8), collapse = ","), " ...）"),
             status = 10L)
  }

  geneIds <- trimws(as.character(mat[[geneColumn]]))
  sampleCols <- setdiff(cols, geneColumn)
  if (length(sampleCols) == 0) {
    deg_stop("E_DATA_SCHEMA", "矩阵里只有基因列，没有任何样本列。", status = 10L)
  }

  emit_progress("read", 25, "reading groups")
  groups <- .read_groups(groupsPath)
  # 分组顺序按文件里首次出现的顺序，而不是字母序 —— 用户写对照在前就是对照在前
  groupLevels <- unique(groups$group)
  emit_log("info", sprintf("groups: %d (%s)", length(groupLevels),
                           paste(sprintf("%s=%d", groupLevels,
                                         as.integer(table(factor(groups$group, levels = groupLevels)))),
                                 collapse = ", ")))
  if (length(groupLevels) < 2) {
    deg_stop("E_VALIDATION",
             "分组表里只有 1 个组，无法做组间比较。", status = 11L)
  }

  # 只保留矩阵里真的存在的样本，缺样本要如实报告，不能默默少画
  keep <- groups$sample %in% sampleCols
  if (!all(keep)) {
    missing <- groups$sample[!keep]
    emit_log("warn", sprintf("%d 个分组样本在矩阵里不存在（如 %s），已忽略",
                             length(missing), paste(utils::head(missing, 5), collapse = ", ")))
  }
  groups <- groups[keep, , drop = FALSE]
  if (nrow(groups) == 0) {
    deg_stop("E_VALIDATION",
             "分组表里的样本名与矩阵列名一个都对不上，请检查样本命名是否一致。",
             status = 11L)
  }

  emit_progress("prepare", 40, "building long table")
  # 长表：每行一个 (基因, 样本, 组, 值)
  rows <- list()
  missingGenes <- character(0)
  for (gene in genes) {
    idx <- which(geneIds == gene)
    if (length(idx) == 0) {
      missingGenes <- c(missingGenes, gene)
      next
    }
    if (length(idx) > 1) {
      emit_log("warn", sprintf("基因 '%s' 在矩阵里出现 %d 次，取第一行", gene, length(idx)))
      idx <- idx[1]
    }
    values <- suppressWarnings(as.numeric(unlist(mat[idx, sampleCols, with = FALSE])))
    names(values) <- sampleCols
    picked <- values[groups$sample]
    rows[[length(rows) + 1]] <- data.frame(
      gene = gene,
      sample = groups$sample,
      group = groups$group,
      value = picked,
      stringsAsFactors = FALSE
    )
  }

  if (length(missingGenes) > 0) {
    emit_log("warn", sprintf("矩阵里找不到这些基因，已跳过：%s",
                             paste(missingGenes, collapse = ", ")))
  }
  if (length(rows) == 0) {
    deg_stop("E_DATA_EMPTY",
             "选中的基因在矩阵里一个都没有，请检查基因名是否与矩阵第一列一致。",
             status = 13L)
  }

  df <- do.call(rbind, rows)
  df <- df[!is.na(df$value), , drop = FALSE]
  if (nrow(df) == 0) {
    deg_stop("E_DATA_EMPTY", "所选基因在所有样本上都是缺失值。", status = 13L)
  }
  presentGenes <- unique(df$gene)
  df$gene <- factor(df$gene, levels = presentGenes)
  emit_log("info", sprintf("facet order: %s | levels: %s",
                           paste(presentGenes, collapse = " | "),
                           paste(levels(df$gene), collapse = " | ")))
  df$group <- factor(df$group, levels = intersect(groupLevels, unique(as.character(df$group))))

  # ---- 分面网格尺寸 ---------------------------------------------------
  #
  # 列数**按画幅宽度算**，不是按基因个数拍一个固定值。
  # 原来写的是「<=4 个基因排一行」。问题出在窗口很窄时：4 个分面挤在 4.9 英寸里，
  # 每格只有约 110px —— 括号上那句话（"FDR=6.85e-01"）居中放在两组中间会向两侧
  # 各溢出 0.7 个类别宽度，超出去就被面板裁掉，屏幕上只剩下 "DR=6.85e-01"；
  # x 轴的 normal/cancer/treated 也叠在一起。
  # 每个分面至少留 2.2 英寸，装不下就自动换行 —— 图变高总比信息被裁掉强。
  #
  # ★ 这段必须在「括号坐标」之前算：括号文字的字号依赖 panelWidthIn。
  #   一开始把它写在 facet_wrap 附近（后面），结果 bracketTextSize 引用了
  #   还没定义的变量，直接 object not found。
  panelMinWidth <- 2.2
  ncolWanted <- max(1L, min(length(presentGenes), floor(widthIn / panelMinWidth)))
  panelWidthIn <- widthIn / ncolWanted
  emit_log("info", sprintf("facet grid: %d genes, %d per row, %.2f in per panel",
                           length(presentGenes), ncolWanted, panelWidthIn))

  # ---- 组间检验 -------------------------------------------------------
  emit_progress("test", 55, "running pairwise tests")
  groupsPresent <- levels(df$group)
  if (nzchar(refGroup) && refGroup %in% groupsPresent) {
    comparisons <- lapply(setdiff(groupsPresent, refGroup), function(g) c(refGroup, g))
  } else {
    if (nzchar(refGroup)) {
      emit_log("warn", paste0("指定的参照组 '", refGroup, "' 不在数据里，改为全部两两比较"))
    }
    comparisons <- utils::combn(groupsPresent, 2, simplify = FALSE)
  }

  testRows <- list()
  for (gene in presentGenes) {
    sub <- df[df$gene == gene, , drop = FALSE]
    for (pair in comparisons) {
      a <- sub$value[sub$group == pair[1]]
      b <- sub$value[sub$group == pair[2]]
      p <- NA_real_
      if (length(a) >= 2 && length(b) >= 2) {
        p <- tryCatch({
          if (identical(testMethod, "t")) {
            stats::t.test(a, b)$p.value
          } else {
            suppressWarnings(stats::wilcox.test(a, b, exact = FALSE)$p.value)
          }
        }, error = function(e) NA_real_)
      }
      testRows[[length(testRows) + 1]] <- data.frame(
        gene = gene, group1 = pair[1], group2 = pair[2], p = p,
        stringsAsFactors = FALSE
      )
    }
  }
  tests <- do.call(rbind, testRows)
  # ★ 统一校正范围：所有基因 × 所有两两比较，而不是每个基因各校正一次
  tests$fdr <- stats::p.adjust(tests$p, method = "BH")
  nTested <- sum(is.finite(tests$fdr))
  emit_log("info", sprintf("pairwise tests: %d (BH across all genes; %d with n>=2 per group)",
                           nrow(tests), nTested))

  # ---- 括号坐标 -------------------------------------------------------
  # 每个分面单独算：数据最大值 → 第一条括号在 10% 处，每加一条抬 16%。
  #
  # 括号按**跨度从窄到宽**排序后再往上叠：窄的在下、宽的在上，这样横线不会互相
  # 穿过（按 FDR 排序时，两条跨度不同的括号会交叉，看起来像画错了）。
  bracketDf <- NULL
  maxY <- max(df$value, na.rm = TRUE)
  minY <- min(df$value, na.rm = TRUE)
  span <- max(maxY - minY, 1e-9)

  # 每个分面最多画几条括号：5 个组就是 10 个两两比较，全画出来会把分面塞满，
  # 括号和文字互相压住反而看不出显著性。超出时只保留 FDR 最小的几条并告警。
  maxBracketsPerGene <- 6

  for (gene in presentGenes) {
    sub <- df[df$gene == gene, , drop = FALSE]
    geneMax <- max(sub$value, na.rm = TRUE)
    geneMin <- min(sub$value, na.rm = TRUE)
    geneSpan <- max(geneMax - geneMin, 1e-9)
    valueColumn <- if (identical(pLabel, "fdr")) "fdr" else "p"
    tt <- tests[tests$gene == gene & is.finite(tests[[valueColumn]]), , drop = FALSE]
    if (nrow(tt) == 0) next
    tt$x1 <- as.integer(factor(tt$group1, levels = groupsPresent))
    tt$x2 <- as.integer(factor(tt$group2, levels = groupsPresent))
    tt$width <- abs(tt$x2 - tt$x1)
    tt <- tt[order(tt$width, tt[[valueColumn]]), , drop = FALSE]
    if (nrow(tt) > maxBracketsPerGene) {
      # 先按 FDR 选出要保留的几条，再重新按跨度排序（否则保留下来的几条
      # 会按 FDR 顺序往上叠，横线互相穿过）
      tt <- utils::head(tt[order(tt$fdr), , drop = FALSE], maxBracketsPerGene)
      tt$width <- abs(tt$x2 - tt$x1)
      tt <- tt[order(tt$width, tt[[valueColumn]]), , drop = FALSE]
    }
    for (i in seq_len(nrow(tt))) {
      y <- geneMax + geneSpan * (0.12 + 0.26 * (i - 1))
      bracketDf <- rbind(bracketDf, data.frame(
        gene = gene,
        x1 = tt$x1[i],
        x2 = tt$x2[i],
        y = y,
        label = paste0(if (identical(pLabel, "fdr")) "FDR=" else "p=",
                       format_p(if (identical(pLabel, "fdr")) tt$fdr[i] else tt$p[i])),
        stringsAsFactors = FALSE
      ))
    }
  }

  # 括号抬高后 y 上限要跟着涨，否则最上面一条会被切掉
  yUpper <- maxY
  if (!is.null(bracketDf) && nrow(bracketDf) > 0) {
    yUpper <- max(bracketDf$y) + span * 0.06
    # ★ 括号数据的 gene 必须转成**同一个因子**。
    #   facet_wrap 的分面变量不是只看主数据：它会把所有图层的 facet 变量取并集。
    #   这里 geom_segment/geom_text 的 data 是另一个 data.frame，gene 是字符型，
    #   合并后整个分面变量退化成字符型 —— 因子水平被丢掉，分面顺序变成字母序。
    #   表现是「日志里 levels 明明是对的，图上却按 a-z 排」，非常容易误判成
    #   facet_wrap 不认 levels。
    bracketDf$gene <- factor(bracketDf$gene, levels = presentGenes)
  }
  yLower <- minY - span * 0.04

  emit_progress("render", 70, "drawing")
  colors <- resolve_palette(paletteSpec, length(groupsPresent))

  p <- ggplot2::ggplot(df, ggplot2::aes(x = .data$group, y = .data$value,
                                        fill = .data$group, color = .data$group))

  if (identical(plotType, "box")) {
    p <- p + ggplot2::geom_boxplot(width = 0.62, outlier.shape = NA,
                                   alpha = 0.85, linewidth = 0.45)
  } else if (identical(plotType, "beeswarm")) {
    deg_ensure_pkgs(c("ggbeeswarm"))
    p <- p + ggplot2::geom_boxplot(width = 0.55, outlier.shape = NA,
                                   alpha = 0.25, linewidth = 0.4) +
      ggbeeswarm::geom_quasirandom(size = 0.9, alpha = 0.8, width = 0.32)
  } else {
    p <- p + ggplot2::geom_violin(trim = FALSE, alpha = 0.85, linewidth = 0.45,
                                  scale = "width")
  }

  if (showPoints && !identical(plotType, "beeswarm")) {
    p <- p + ggplot2::geom_jitter(width = 0.12, size = 0.7, alpha = 0.5)
  }

  if (showMean) {
    p <- p + ggplot2::stat_summary(
      fun = mean, geom = "errorbar",
      ggplot2::aes(ymax = ggplot2::after_stat(y), ymin = ggplot2::after_stat(y)),
      width = 0.36, linewidth = 0.6, color = "black"
    )
  }

  # 标签字号按**每格实际宽度**算（上面算出的 panelWidthIn）：
  # 2.2 英寸宽的格子约 2.3pt，1.2 英寸的窄格子退到 1.7pt 下限。
  bracketTextSize <- max(1.7, min(2.8, 1.15 * panelWidthIn - 0.25))

  if (!is.null(bracketDf) && nrow(bracketDf) > 0) {
    # 括号：横线 + 两端小竖线；文字压在横线上方
    p <- p +
      ggplot2::geom_segment(
        data = bracketDf,
        ggplot2::aes(x = .data$x1, xend = .data$x2, y = .data$y, yend = .data$y),
        inherit.aes = FALSE, linewidth = 0.4, color = "black"
      ) +
      ggplot2::geom_segment(
        data = bracketDf,
        ggplot2::aes(x = .data$x1, xend = .data$x1, y = .data$y, yend = .data$y - span * 0.015),
        inherit.aes = FALSE, linewidth = 0.4, color = "black"
      ) +
      ggplot2::geom_segment(
        data = bracketDf,
        ggplot2::aes(x = .data$x2, xend = .data$x2, y = .data$y, yend = .data$y - span * 0.015),
        inherit.aes = FALSE, linewidth = 0.4, color = "black"
      ) +
      ggplot2::geom_text(
        data = bracketDf,
        ggplot2::aes(x = (.data$x1 + .data$x2) / 2, y = .data$y + span * 0.022, label = .data$label),
        inherit.aes = FALSE, size = bracketTextSize, vjust = 0, color = "black"
      )
  }

  facetArgs <- list(facets = ggplot2::vars(.data$gene), strip.position = "top",
                    ncol = ncolWanted)
  if (facetFreeY) facetArgs$scales <- "free_y"

  yLab <- if (nzchar(yLabel)) yLabel else if (inputIsLog2) "Expression (log2)" else "Expression"
  xLab <- if (nzchar(xLabel)) xLabel else ""

  p <- p +
    do.call(ggplot2::facet_wrap, facetArgs) +
    ggplot2::scale_fill_manual(values = colors) +
    ggplot2::scale_color_manual(values = colors) +
    # ★ 不要用 coord_cartesian(ylim=...) 来腾出括号的位置：
    #   coord_cartesian 对所有分面统一生效，会直接把 facet 的 scales="free_y"
    #   顶掉 —— 每个分面都被拉成同一个 y 范围，"y 轴各自独立" 这个开关就失效了
    #   （看起来图还是画出来了，只是每张小图都被压扁）。正确做法是给 y 轴加
    #   留白系数：各分面仍按自己的数据范围缩放，但上下各留一点空。
    # x 轴两侧留白：括号标签居中在相邻两组的中间，靠边的标签会顶到面板边缘。
    # add 给的是「类别单位」，0.7 相当于把绘图区左右各放宽 0.7 个组宽。
    ggplot2::scale_x_discrete(expand = ggplot2::expansion(add = 0.8)) +
    ggplot2::scale_y_continuous(
      expand = ggplot2::expansion(mult = c(0.05, 0.12))
    ) +
    ggplot2::labs(title = title, y = yLab, x = xLab) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(
      legend.position = "none",
      panel.grid.minor = ggplot2::element_blank(),
      panel.grid.major.x = ggplot2::element_blank(),
      panel.border = ggplot2::element_rect(color = "black", linewidth = 0.5),
      strip.background = ggplot2::element_rect(fill = "white", color = "black", linewidth = 0.4),
      strip.text = ggplot2::element_text(face = "italic", size = 10),
      axis.text.x = ggplot2::element_text(
        size = max(6.5, min(9, 1.1 * panelWidthIn + 5)),
        # 窄格里三个组名横排一定叠在一起，斜 35° 是最省空间又还能读的角度
        # 2.5 英寸以下的格子放三个组名（normal / cancer / treated）就会挤在一起，
        # 2.5 以上横排还读得舒服。阈值卡在 2.5 而不是 2.4，是因为实测 2.45 时
        # 横排已经明显贴在一起了。
        angle = if (panelWidthIn < 2.5) 35 else 0,
        hjust = if (panelWidthIn < 2.5) 1 else 0.5,
        vjust = if (panelWidthIn < 2.5) 1 else 0.5
      ),
      plot.title = ggplot2::element_text(hjust = 0.5, face = "bold", size = 12)
    )

  if (identical(format, "pdf")) deg_open_pdf(outPath, widthIn, heightIn)
  else deg_open_png(outPath, widthIn, heightIn, dpi)
  on.exit(deg_close_devices(), add = TRUE)
  print(p)
  deg_close_devices()

  if (!file.exists(outPath)) {
    deg_stop("E_IO_WRITE", paste0("image was not written: ", outPath), status = 14L)
  }

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  groupSizes <- as.list(table(df$group))
  emit_result(list(
    genes = length(presentGenes),
    missingGenes = as.list(missingGenes),
    groups = as.list(groupsPresent),
    groupSizes = groupSizes,
    plotType = plotType,
    testMethod = testMethod,
    fdrScope = "BH across all genes and all pairwise comparisons",
    pLabel = pLabel,
    tests = lapply(seq_len(nrow(tests)), function(i) {
      list(gene = tests$gene[i], group1 = tests$group1[i], group2 = tests$group2[i],
           p = tests$p[i], fdr = tests$fdr[i])
    }),
    brackets = if (is.null(bracketDf)) 0L else nrow(bracketDf),
    yRange = c(yLower, yUpper),
    bytes = as.integer(file.size(outPath)),
    durationMs = as.integer(durationMs)
  ))
})
