# =============================================================================
# r/timeseries/run_moanin_timecourse.R —— 两组 × 时间（moanin 样条模型）
#
# 与单序列的 SAM 是两套统计：SAM 问「这条序列随时间有没有变化」，
# moanin 问「**两组的时间曲线是否不同**」（时间 × 处理 交互）。所以单独一个脚本、
# 单独一个入口，不共用一个「模式」开关。
#
# ## 关键约定（照客户脚本）
#
#   data = log2(FPKM + 0.0001)          ← 客户用的是 0.0001，不是单序列那边的 0.01
#   MAD 过滤：vp > quantile(vp, varianceCutoff)
#   moanin::create_moanin_model(data, meta, degrees_of_freedom)
#   moanin::DE_timecourse(model, contrasts, use_voom_weights = FALSE)
#   moanin::pvalues_fisher_method(p) 多对比合并 → p.adjust(BH)
#   moanin::splines_kmeans(..., random_seed = 42, n_init = 20)   ← 固定种子保证可复现
#
# ## ★ df 必须硬校验（真数据上踩过）
#
# 时间点数 nTime=7 时：
#
#   df=2 → q<0.05 7,901     df=4 → 7,422     df=5 → 6,844
#   df=6 → **0**（q 全是 NA）
#
# 原因：`df = nTime - 1` 时样条基饱和、残差自由度被吃光，**所有 p/q 变成 NA**，
# 但 moanin 不报错 —— 界面会显示「0 个显著基因」，用户以为两组没差异。
# 所以这里做两件事：
#   1. 范围限制在 2 ~ nTime-2，超界直接 E_VALIDATION 并说明；
#   2. 若所有 q 都是 NA，返回 E_R_GENERIC「模型未收敛…」而不是 0 个基因。
#
# ## ★ lfc 的五个口径形状不同，不能混用
#
#   timely     基因 × 时间点 **矩阵**（每个时间点各自的 lfc）
#   timecourse mean(|lfc|) × sign(sum(lfc))  —— **带方向**，火山图用它
#   sum        净累积（正负会抵消）
#   max / min  max(|lfc|) / min(|lfc|) —— **非负、无方向**，不能当有符号 logFC 用
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

deg_main("timeseries/run_moanin_timecourse.R", function(ctx) {
  deg_ensure_pkgs(c("moanin", "ggplot2", "jsonlite"))
  startedAt <- Sys.time()

  matrixFile <- as.character(.ts_param(ctx, "matrixFile", ""))
  samples <- .ts_param(ctx, "samples", NULL)
  dfRequested <- as.integer(.ts_param(ctx, "degreesOfFreedom", 4L))
  varianceCutoff <- as.numeric(.ts_param(ctx, "varianceCutoff", 0.5))
  contrastSpec <- .ts_param(ctx, "contrasts", NULL)
  nClusters <- as.integer(.ts_param(ctx, "nClusters", 8L))
  fdrCutoff <- as.numeric(.ts_param(ctx, "fdr", 0.05))
  lfcCutoff <- as.numeric(.ts_param(ctx, "lfcCutoff", 2))
  seed <- 42L

  # ---- 1. 读矩阵 ----------------------------------------------------------
  emit_progress("read", 5, "reading matrix")
  read <- .ts_read_matrix(matrixFile)
  raw <- read$matrix
  emit_log("info", sprintf("matrix: %d genes x %d samples (encoding %s)",
                           nrow(raw), ncol(raw), read$encoding))

  # ★ 客户脚本原文（在 log2 之前）：rt <- rt[rowMeans(rt) > 0, ]
  #   漏掉这行会让 MAD 的中位数退化成 0 —— 全零基因占 56.6% 时
  #   quantile(vp, 0.5) == 0，`vp > 0` 等于「只要有方差就留」，阈值完全失去筛选力
  #   （实测：漏掉得 24,211；加上得 18,740）。
  #   drop = FALSE 不能省：只剩一个基因时矩阵会塌成向量。
  nGenesRaw <- nrow(raw)
  raw <- raw[rowMeans(raw) > 0, , drop = FALSE]
  nGenesNonZero <- nrow(raw)
  emit_log("info", sprintf("rowMeans > 0 filter: %d genes", nrow(raw)))

  # ★ 客户脚本用 log2(x + 0.0001)（单序列那边是 0.01，别串了）
  data <- log2(raw + 0.0001)

  # ---- 2. MAD 过滤 --------------------------------------------------------
  emit_progress("filter", 15, "MAD filtering")
  vp <- apply(data, 1, mad)
  madThreshold <- as.numeric(stats::quantile(vp, varianceCutoff))
  keep <- vp > madThreshold
  nGenesInput <- nrow(data)
  data <- data[keep, , drop = FALSE]
  if (nrow(data) < 50) {
    deg_stop("E_DATA_EMPTY", paste0(
      "MAD filtering kept only ", nrow(data), " genes (cutoff ", varianceCutoff,
      ", threshold ", round(madThreshold, 4), "). Lower varianceCutoff."), status = 14L)
  }
  emit_log("info", sprintf(
    "MAD filter: %d -> %d genes (quantile %.2f, threshold %.4f)",
    nGenesInput, nrow(data), varianceCutoff, madThreshold))

  # ---- 3. 样本设计（复用单序列那套解析，不另做一份）----------------------
  design <- .ts_build_design(samples, colnames(data))
  meta <- design$meta
  data <- data[, meta$name, drop = FALSE]
  nTime <- length(design$times)
  groups <- sort(unique(meta$group))
  if (length(groups) < 2) {
    deg_stop("E_VALIDATION", paste0(
      "this mode needs at least 2 groups, got ", length(groups), " (",
      paste(groups, collapse = ", "), "). Single-series data should use the SAM mode."),
      status = 11L)
  }
  if (nTime < 4) {
    deg_stop("E_VALIDATION", paste0("need at least 4 time points for a spline model, got ", nTime),
             status = 11L)
  }

  # ★ 组名必须是合法的 R 名字：moanin 用 `make.names()` 校验 Group levels，
  #   `IR09-D` 这类含连字符的名字会直接报
  #     "The levels must by syntactically valid names in R, see help(make.names)"
  #   而且 `-` 还是我们对比例分符的分隔符（`IR09-D-IR09-W` 会被 strsplit 拆成 4 段）。
  #   挡在这里，报错才能指名道姓说「该改组名」而不是让用户去改对比。
  badGroupNames <- groups[!grepl("^[A-Za-z0-9_.]{1,40}$", groups)]
  if (length(badGroupNames) > 0) {
    deg_stop("E_VALIDATION", paste0(
      "invalid group name(s): ", paste0('"', badGroupNames, '"', collapse = ", "),
      ". R factor levels must be syntactic names (letters, digits, '_' and '.'), ",
      "and '-' is the contrast separator ('<group1>-<group2>'). ",
      "Rename them in the group-name mapping (e.g. IR09_D or IR109DT)."), status = 11L)
  }

  # ---- 4. df 硬校验 -------------------------------------------------------
  maxDf <- nTime - 2L
  if (dfRequested < 2L || dfRequested > maxDf) {
    deg_stop("E_VALIDATION", paste0(
      "degrees_of_freedom must be between 2 and ", maxDf, " for ", nTime,
      " time points (got ", dfRequested, "). df >= ", nTime - 1L,
      " saturates the spline basis and turns every p-value into NA."), status = 11L)
  }

  metaDf <- data.frame(
    Timepoint = as.numeric(match(meta$time, design$times)),
    Group = factor(meta$group, levels = groups),
    row.names = meta$name
  )
  emit_log("info", sprintf(
    "design: %d samples, %d time points (%s), groups: %s, df=%d (max %d)",
    nrow(metaDf), nTime, paste(design$times, collapse = ","),
    paste(groups, collapse = "/"), dfRequested, maxDf))

  # ---- 5. 模型与差异检验 --------------------------------------------------
  emit_progress("model", 25, sprintf("fitting spline model (df=%d)", dfRequested))
  model <- moanin::create_moanin_model(
    data = as.data.frame(data), meta = metaDf, degrees_of_freedom = dfRequested
  )

  # 对比：用户勾选的优先，否则所有组的两两组合（默认「前一组 − 后一组」）
  allContrasts <- if (length(groups) >= 2) {
    utils::combn(groups, 2, FUN = function(p) paste0(p[1], "-", p[2]), simplify = TRUE)
  } else character(0)
  contrasts <- if (is.null(contrastSpec)) character(0) else trimws(as.character(contrastSpec))
  contrasts <- contrasts[nzchar(contrasts)]
  if (length(contrasts) == 0) contrasts <- as.character(allContrasts)

  # ★ 校验放宽：**任一方向**都合法（`A-B` 与 `B-A` 都收）。
  #   客户脚本的四个对比里有两个是「后减前」（ZS97DT-IR109DT、ZS97WW-IR109WW），
  #   如果只接受预生成的方向，用户点出来会被拒绝 —— 而统计上两者只是 lfc 取负，
  #   q 值完全相同。拒绝没有任何道理，只会逼用户自己去改矩阵列名。
  # ★ 这个实现**依赖「组名里不含 -」**这个前提（上面已强制校验）：
  #   按 "-" 拆两段即可。如果以后放宽组名校验，这里必须先改成按「已知组名」匹配，
  #   否则 `IR09-D-IR09-W` 会被拆成 4 段，报出的错误会和真实原因（组名非法）错位。
  is_valid_contrast <- function(ct) {
    parts <- strsplit(ct, "-", fixed = TRUE)[[1]]
    length(parts) == 2 && all(parts %in% groups) && parts[1] != parts[2]
  }
  badContrasts <- contrasts[!vapply(contrasts, is_valid_contrast, logical(1))]
  if (length(badContrasts) > 0) {
    deg_stop("E_VALIDATION", paste0(
      "invalid contrast(s): ", paste(badContrasts, collapse = ", "),
      ". Each contrast must be '<group1>-<group2>' with both groups in: ",
      paste(groups, collapse = ", ")), status = 11L)
  }
  emit_log("info", paste0("contrasts: ", paste(contrasts, collapse = ", ")))

  emit_progress("de", 40, sprintf("DE_timecourse (%d contrast(s))", length(contrasts)))
  de <- moanin::DE_timecourse(model, contrasts = contrasts, use_voom_weights = FALSE)

  # ---- 6. NA 全满 = 模型没收敛，必须报错而不是「0 个显著基因」-------------
  qCols <- paste0(contrasts, "_qval")
  qMatrix <- as.matrix(de[, qCols, drop = FALSE])
  nAllNa <- sum(apply(qMatrix, 1, function(r) all(is.na(r))))
  if (nAllNa == nrow(qMatrix)) {
    deg_stop("E_R_GENERIC", paste0(
      "the model did not converge: all q-values are NA (n=", nrow(qMatrix), "). ",
      "This usually means degrees_of_freedom is too large for the number of time points (",
      nTime, "), or there are no replicates. Try a smaller degrees_of_freedom (2~", maxDf, ")."),
      status = 1L)
  }
  if (nAllNa > 0) {
    emit_log("warn", sprintf("%d of %d genes have NA q-values (singular fits), dropped",
                             nAllNa, nrow(qMatrix)))
  }

  # ---- 7. 五种 lfc --------------------------------------------------------
  emit_progress("lfc", 60, "log fold changes")
  lfcOf <- function(method) {
    out <- moanin::estimate_log_fold_change(model, contrasts = contrasts, method = method)
    if (is.null(dim(out))) {
      out <- matrix(out, ncol = length(contrasts),
                    dimnames = list(rownames(data), contrasts))
    } else if (length(contrasts) == 1 && ncol(out) == 1) {
      colnames(out) <- contrasts
    }
    out
  }
  lfcTimely <- lfcOf("timely")      # 基因 × 时间点（单对比）
  lfcTimecourse <- lfcOf("timecourse")
  lfcSum <- lfcOf("sum")
  lfcMax <- lfcOf("max")
  lfcMin <- lfcOf("min")

  # ---- 8. 多对比 Fisher 合并 + 基因筛选 -----------------------------------
  emit_progress("filter", 70, "Fisher combined p-values")
  pMatrix <- as.matrix(de[, paste0(contrasts, "_pval"), drop = FALSE])
  fisherP <- if (ncol(pMatrix) > 1) {
    moanin::pvalues_fisher_method(pMatrix)
  } else {
    as.numeric(pMatrix[, 1])
  }
  fisherQ <- stats::p.adjust(fisherP, method = "BH")

  # 客户口径：任一对比 |lfc_max| > 2 且 Fisher q < 0.05
  selected <- rowSums(lfcMax > lfcCutoff, na.rm = TRUE) > 0 & !is.na(fisherQ) & fisherQ < fdrCutoff
  genes <- rownames(data)[selected]
  emit_log("info", sprintf(
    "gene selection: |lfc_max| > %s & Fisher q < %s -> %d genes (of %d tested)",
    lfcCutoff, fdrCutoff, length(genes), nrow(data)))

  # ---- 9. 聚类（固定种子，可复现）----------------------------------------
  clusterOf <- NULL
  clusterSizes <- integer(0)
  clusterCentroids <- NULL
  if (length(genes) >= nClusters * 2) {
    emit_progress("cluster", 78, sprintf("k-means (%d clusters, seed=%d)", nClusters, seed))
    km <- moanin::splines_kmeans(model[genes, ], n_clusters = nClusters,
                                 random_seed = seed, n_init = 20)
    labels <- as.integer(km$clusters)
    clusterOf <- labels
    names(clusterOf) <- genes
    clusterSizes <- as.integer(table(factor(labels, levels = seq_len(nClusters))))
    # 质心 = 该簇基因在各样本上的平均表达（用原始 log 数据，可解释）
    clusterCentroids <- t(vapply(seq_len(nClusters), function(k) {
      idx <- which(labels == k)
      if (length(idx) == 0) return(rep(NA_real_, ncol(data)))
      colMeans(data[genes[idx], , drop = FALSE])
    }, numeric(ncol(data))))
    rownames(clusterCentroids) <- paste0("cluster_", seq_len(nClusters))
    colnames(clusterCentroids) <- colnames(data)
    emit_log("info", paste0("cluster sizes: ", paste(clusterSizes, collapse = "/")))
  } else {
    emit_log("warn", sprintf(
      "only %d genes passed the filter (< %d needed for %d clusters); clustering skipped",
      length(genes), nClusters * 2, nClusters))
  }

  # ---- 10. 落盘 -----------------------------------------------------------
  emit_progress("write", 85, "writing tables")
  nTimeCol <- length(design$times)

  # 差异表（长表：一行 = 基因 × 对比）
  deRows <- list()
  for (ct in contrasts) {
    deRows[[ct]] <- data.frame(
      gene = rownames(data),
      contrast = ct,
      stat = as.numeric(de[[paste0(ct, "_stat")]]),
      pval = as.numeric(de[[paste0(ct, "_pval")]]),
      qval = as.numeric(de[[paste0(ct, "_qval")]]),
      lfc_timecourse = as.numeric(lfcTimecourse[, ct]),
      lfc_sum = as.numeric(lfcSum[, ct]),
      lfc_max = as.numeric(lfcMax[, ct]),
      lfc_min = as.numeric(lfcMin[, ct]),
      fisher_q = as.numeric(fisherQ),
      cluster = if (!is.null(clusterOf)) clusterOf[rownames(data)] else NA_integer_,
      stringsAsFactors = FALSE
    )
  }
  deAll <- do.call(rbind, deRows)
  utils::write.csv(deAll, file.path(ctx$runDir, "de_all.csv"), row.names = FALSE, quote = FALSE)
  utils::write.csv(deAll[deAll$gene %in% genes, , drop = FALSE],
                   file.path(ctx$runDir, "de_sig.csv"), row.names = FALSE, quote = FALSE)

  # timely：基因 × 时间点（单对比时就是矩阵；多对比逐列展开）
  timelyRows <- list()
  for (ct in contrasts) {
    m <- if (length(contrasts) == 1) lfcTimely else NULL
    if (is.null(m)) next
    timelyRows[[ct]] <- data.frame(
      gene = rownames(m),
      contrast = ct,
      timepoint = rep(design$times, each = nrow(m)),
      lfc = as.numeric(m)
    )
  }
  if (length(timelyRows) > 0) {
    utils::write.csv(do.call(rbind, timelyRows), file.path(ctx$runDir, "lfc_timely.csv"),
                     row.names = FALSE, quote = FALSE)
  }
  if (!is.null(clusterOf)) {
    utils::write.csv(
      data.frame(gene = names(clusterOf), cluster = as.integer(clusterOf), stringsAsFactors = FALSE),
      file.path(ctx$runDir, "gene_clusters.csv"), row.names = FALSE, quote = FALSE)
  }

  # ---- 11. 出图 -----------------------------------------------------------
  emit_progress("plot", 90, "plots")
  plots <- list()
  groupColors <- .ts_group_palette(groups)

  # 11.1–11.3 逐个对比出图：火山 + 样条（top p / top |lfc|）
  #
  # ★ 每个对比各出一套：4 组时客户要的是 4 个对比各自的图，
  #   只画第一个对比等于让另外三个「有数字没图」。
  #   单对比时文件名不带后缀（与旧结果保持兼容）。
  drawSplines <- function(geneSet, file, title) {
    if (length(geneSet) == 0) return(NULL)
    # ★ deg_save_drawer 会把这个闭包**调用两次**（PNG 一次、PDF 一次）。
    #   不能改成传表达式：R 的形参是 promise，第二次拿到的会是缓存结果，
    #   PDF 会是空白的（enrich/run_gsea.R 里踩过同样的事）。
    ok <- deg_save_drawer(
      file.path(ctx$runDir, file),
      width = 10, height = 7.6,
      drawer = function() {
        # ★ 先留出上外边距：moanin 每个 panel 自己的标题就在顶部，
        #   不留 oma 直接把大标题 mtext 上去会**压在 panel 标题上**（截图为证）
        graphics::par(oma = c(0, 0, 2.2, 0))
        moanin::plot_splines_data(model[geneSet, , drop = FALSE],
                                  data = data[geneSet, , drop = FALSE],
                                  # ★ colors 必须**带名字**：moanin 内部用 names(colors)
                                  #   当图例标签，传 unname() 会报 "'legend' is of length 0"
                                  colors = groupColors, legend = TRUE,
                                  ylab = "log2 expression")
        graphics::mtext(title, side = 3, outer = TRUE, line = 0.4, cex = 0.85, font = 2)
      },
      label = file
    )
    if (isTRUE(ok) && file.exists(file.path(ctx$runDir, file))) file else NULL
  }

  for (ci in seq_along(contrasts)) {
    ct <- contrasts[ci]
    suffix <- if (length(contrasts) > 1) paste0("_", ci) else ""

    volcanoDf <- data.frame(
      gene = rownames(data),
      lfc = as.numeric(lfcTimecourse[, ct]),
      p = as.numeric(de[[paste0(ct, "_pval")]]),
      selected = rownames(data) %in% genes,
      stringsAsFactors = FALSE
    )
    volcanoDf <- volcanoDf[is.finite(volcanoDf$p) & is.finite(volcanoDf$lfc), , drop = FALSE]
    if (nrow(volcanoDf) > 0) {
      sel <- volcanoDf[volcanoDf$selected, , drop = FALSE]
      topLab <- utils::head(sel[order(-abs(sel$lfc)), , drop = FALSE], 8)
      p1 <- ggplot2::ggplot(volcanoDf, ggplot2::aes(x = lfc, y = -log10(p))) +
        ggplot2::geom_point(ggplot2::aes(colour = selected), size = 0.45, alpha = 0.5) +
        ggplot2::scale_colour_manual(values = c(`TRUE` = "#C4552E", `FALSE` = "grey78"),
                                     labels = c(`TRUE` = "selected", `FALSE` = "other"),
                                     name = NULL) +
        ggplot2::geom_vline(xintercept = c(-lfcCutoff, lfcCutoff), linetype = "dashed",
                            colour = "grey55", linewidth = 0.3) +
        ggplot2::labs(
          x = "Signed mean fold-change over time (log2)",
          y = "-log10(p-value)",
          title = sprintf("Volcano: %s", ct),
          # ★ 必须写清：x 不是「某个时间点的 log2FC」，而是「逐周 |lfc| 的均值 × 方向」。
          caption = paste0(
            "x = mean(|per-week logFC|) x sign - an overall magnitude with direction, ",
            "NOT a single time-point log2FC.\n",
            "Selected = |lfc_max| > ", lfcCutoff, " & Fisher q < ", fdrCutoff)
        ) +
        ggplot2::theme_bw(base_size = 10) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      if (nrow(topLab) > 0) {
        p1 <- p1 + ggplot2::geom_text(data = topLab,
                                      ggplot2::aes(x = lfc, y = -log10(p), label = gene),
                                      size = 2.1, vjust = -0.5, colour = "grey20")
      }
      f1 <- paste0("p01_volcano", suffix, ".png")
      if (.ts_save_plot(p1, file.path(ctx$runDir, f1), 7, 5.2, "volcano")) {
        plots[[length(plots) + 1L]] <- list(
          id = "volcano", file = f1, contrast = ct,
          caption = sprintf("火山图（%s；x = timecourse lfc，带方向）", ct))
      }
    }

    pv <- as.numeric(de[[paste0(ct, "_pval")]])
    topP <- rownames(data)[order(pv)][1:min(10, nrow(data))]
    f2 <- paste0("p02_splines_top_pval", suffix, ".png")
    if (!is.null(drawSplines(topP, f2, sprintf("Top 10 genes by p-value (%s)", ct)))) {
      plots[[length(plots) + 1L]] <- list(
        id = "splines_p", file = f2, contrast = ct,
        caption = sprintf("按 p 值 top10 的样条曲线（%s）", ct))
    }

    lfcVals <- abs(as.numeric(lfcTimecourse[, ct]))
    topLfc <- rownames(data)[order(-lfcVals)][1:min(10, nrow(data))]
    f3 <- paste0("p03_splines_top_lfc", suffix, ".png")
    if (!is.null(drawSplines(topLfc, f3, sprintf("Top 10 genes by |lfc| (%s)", ct)))) {
      plots[[length(plots) + 1L]] <- list(
        id = "splines_lfc", file = f3, contrast = ct,
        caption = sprintf("按 |lfc| top10 的样条曲线（%s)", ct))
    }
  }

  # 11.4 聚类质心（每簇两条线：各组均值）
  if (!is.null(clusterCentroids)) {
    centDf <- do.call(rbind, lapply(seq_len(nClusters), function(k) {
      data.frame(
        cluster = sprintf("cluster %d (n=%d)", k, clusterSizes[k]),
        name = colnames(clusterCentroids),
        time = match(meta$time, design$times),
        group = meta$group,
        value = as.numeric(clusterCentroids[k, ]),
        stringsAsFactors = FALSE
      )
    }))
    centMean <- stats::aggregate(value ~ cluster + time + group, data = centDf, FUN = mean)
    p4 <- ggplot2::ggplot(centMean, ggplot2::aes(x = time, y = value, colour = group)) +
      ggplot2::geom_line(linewidth = 0.7) +
      ggplot2::geom_point(size = 0.9) +
      ggplot2::facet_wrap(~cluster, ncol = 4, scales = "free_y") +
      ggplot2::scale_x_continuous(breaks = seq_len(nTime), labels = design$times) +
      ggplot2::scale_colour_manual(values = groupColors, name = "Group") +
      ggplot2::labs(x = "Time point", y = "Mean expression (log2)",
                    title = "Cluster centroids (mean expression per group)",
                    subtitle = sprintf("%d clusters, %d genes, seed=%d", nClusters,
                                       length(genes), seed)) +
      ggplot2::theme_bw(base_size = 9) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank(),
                     strip.background = ggplot2::element_rect(fill = "grey94", colour = "grey70"))
    if (.ts_save_plot(p4, file.path(ctx$runDir, "p04_cluster_centroids.png"), 10,
                      max(3, 2.2 * ceiling(nClusters / 4) + 1), "centroids")) {
      plots[[length(plots) + 1L]] <- list(id = "cluster_centroids",
                                          file = "p04_cluster_centroids.png",
                                          contrast = "",
                                          caption = "各 cluster 的质心曲线（按组着色）")
    }

    # 11.5 热图：每簇按 |lfc| 取前 25 个基因，按簇分块
    capped <- unlist(lapply(seq_len(nClusters), function(k) {
      idx <- names(which(clusterOf == k))
      idx[order(-abs(as.numeric(lfcTimecourse[match(idx, rownames(lfcTimecourse)), ct])))][
        1:min(25, length(idx))]
    }), use.names = FALSE)
    capped <- capped[!is.na(capped)]
    if (length(capped) > 1) {
      # 基因是行、样本是列（第一版写成 data[, capped] 直接下标越界）
      hm <- data[capped, , drop = FALSE]
      z <- t(scale(t(hm)))
      z[!is.finite(z)] <- 0
      nTimePoints <- length(design$times)
      # 每个基因按 (组, 时间) 求均值，热图的列是「组 × 时间」容易读
      combo <- paste(meta$group, match(meta$time, design$times), sep = "|")
      comboLevels <- unique(combo[order(match(meta$time, design$times), meta$group)])
      zm <- t(vapply(seq_len(nrow(z)), function(i) {
        as.numeric(tapply(z[i, ], combo, mean)[comboLevels])
      }, numeric(length(comboLevels))))
      rownames(zm) <- rownames(z)
      hmDf <- data.frame(
        gene = rep(rownames(zm), times = ncol(zm)),
        col = rep(comboLevels, each = nrow(zm)),
        value = as.numeric(zm),
        cluster = rep(clusterOf[rownames(zm)], times = ncol(zm)),
        stringsAsFactors = FALSE
      )
      hmDf$gene <- factor(hmDf$gene, levels = rev(capped))
      hmDf$cluster <- factor(sprintf("cluster %d", hmDf$cluster),
                             levels = sprintf("cluster %d", seq_len(nClusters)))
      p5 <- ggplot2::ggplot(hmDf, ggplot2::aes(x = col, y = gene, fill = value)) +
        ggplot2::geom_tile() +
        ggplot2::facet_grid(cluster ~ ., scales = "free_y", space = "free_y") +
        ggplot2::scale_fill_gradient2(low = "#3B6FA0", mid = "white", high = "#C4552E",
                                      midpoint = 0, name = "z-score") +
        ggplot2::labs(x = NULL, y = NULL,
                      title = "Clustered genes across time points (row z-score)",
                      subtitle = sprintf("up to 25 genes per cluster, %s", ct)) +
        ggplot2::theme_bw(base_size = 8) +
        ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 7),
                       axis.text.y = ggplot2::element_text(size = 5),
                       panel.grid = ggplot2::element_blank(),
                       strip.text.y = ggplot2::element_text(size = 7))
      if (.ts_save_plot(p5, file.path(ctx$runDir, "p05_cluster_heatmap.png"), 8,
                        max(5, min(24, 1.2 + 0.09 * nrow(zm))), "heatmap")) {
        plots[[length(plots) + 1L]] <- list(id = "cluster_heatmap",
                                            file = "p05_cluster_heatmap.png",
                                            contrast = "",
                                            caption = sprintf("聚类热图（%d 个基因，按 cluster 分块）", nrow(zm)))
      }
    }
  }

  # ---- 11.9 把模型与绘图所需的数据存下来 ----
  # 「自选基因曲线」不该为了画 3 个基因把整套 20 秒流程重跑一遍：
  # 这里把 model（含样条基与分组）、log2 表达、组色、已筛基因一起打包。
  tryCatch({
    saveRDS(
      list(
        model = model,
        data = data,
        groups = groups,
        groupColors = groupColors,
        times = design$times,
        contrasts = contrasts,
        selectedGenes = genes,
        lfcCutoff = lfcCutoff,
        fdr = fdrCutoff,
        nTime = nTime
      ),
      file.path(ctx$runDir, "moanin_bundle.rds")
    )
    emit_log("info", "moanin model bundle saved (moanin_bundle.rds); custom curves reuse it")
  }, error = function(e) {
    emit_log("warn", paste0("could not save moanin bundle: ", conditionMessage(e)))
  })

  for (pl in plots) emit_artifact("plot", pl$file)
  emit_artifact("table", "de_all.csv", rows = nrow(deAll), schema = "MoaninRow[]")

  # ---- 12. summary --------------------------------------------------------
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    matrixFile = basename(matrixFile),
    encoding = read$encoding,
    nGenesRaw = as.integer(nGenesRaw),
    nGenesNonZero = as.integer(nGenesNonZero),
    nGenesFiltered = as.integer(nrow(data)),
    madThreshold = round(madThreshold, 6),
    varianceCutoff = varianceCutoff,
    degreesOfFreedom = dfRequested,
    maxDegreesOfFreedom = as.integer(maxDf),
    nTime = as.integer(nTime),
    times = unname(design$times),
    groups = unname(groups),
    nSamples = as.integer(nrow(metaDf)),
    contrasts = unname(contrasts),
    # 每个对比的 q<0.05 / q<0.01 基因数（界面统计条直接用，避免前端再算一遍）
    qCounts = unname(lapply(contrasts, function(ct) {
      qv <- as.numeric(de[[paste0(ct, "_qval")]])
      list(contrast = ct,
           q05 = as.integer(sum(qv < 0.05, na.rm = TRUE)),
           q01 = as.integer(sum(qv < 0.01, na.rm = TRUE)))
    })),
    nNaQ = as.integer(nAllNa),
    nSelected = as.integer(length(genes)),
    nClusters = as.integer(nClusters),
    clusterSizes = unname(clusterSizes),
    seed = seed,
    lfcCutoff = lfcCutoff,
    fdr = fdrCutoff,
    files = list(deAll = "de_all.csv", deSig = "de_sig.csv",
                 timely = "lfc_timely.csv", clusters = "gene_clusters.csv"),
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
