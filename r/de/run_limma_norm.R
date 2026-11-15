# =============================================================================
# r/de/run_limma_norm.R —— limma 线性模型（两个分支，由 inputIsLog2 决定）
#
# 分支一 inputIsLog2 = TRUE（默认，芯片 / 已归一化的 log2 表达值）：
#   直接把表达值当 log2 强度做 lmFit → contrasts.fit → eBayes()。
#   **不带 trend**：芯片数据的均值-方差关系不像 counts 派生数据那样依赖均值，
#   这是 limma 用户指南对 log2 强度数据的标准做法。
#
# 分支二 inputIsLog2 = FALSE（原始 counts，limma-trend）：
#   TMM 标准化 → cpm(log = TRUE, prior.count) 转 log2-CPM → lmFit → eBayes(trend = TRUE)。
#   ★ trend 必须开：counts 派生数据的方差随表达量下降，不建模这条趋势会低估
#     高表达基因的方差、假阳性偏多。
#
# ★ 两个分支的误用防护（这是本脚本最容易让用户拿到「看起来正常但全错」结果的地方）：
#   - inputIsLog2 = FALSE 但矩阵含负值 → 不可能是 counts，直接 E_DATA_NEGATIVE_LOG；
#   - inputIsLog2 = TRUE 但数值整体偏大（99 分位 > 50）→ warn 提示可能是 raw counts；
#   - inputIsLog2 = FALSE 但最大值 < 50 → warn 提示「看起来不像原始 counts」。
#     后两条只警告不阻断：它们都是启发式，判错了不该拦着用户干活。
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

deg_main("de/run_limma_norm.R", function(ctx) {
  deg_validate_common(ctx)
  # filterByExpr / cpm 来自 edgeR；即使用户关掉过滤也不要因缺包而在别的分支炸掉
  deg_ensure_pkgs(c("limma", "edgeR", "data.table"))
  startedAt <- Sys.time()

  d <- deg_de_prepare(ctx)
  contrast <- deg_param_required(ctx, "contrast")
  contrastStr <- deg_de_contrast(contrast, d$levels)
  emit_log("info", paste0("contrast: ", contrastStr, "  (logFC > 0 => up in ",
                          contrast$numerator, ")"))

  # ---- 0. 分支参数 ----------------------------------------------------------
  inputIsLog2 <- isTRUE(deg_param(ctx, "inputIsLog2", TRUE))
  priorCount <- as.numeric(deg_param(ctx, "priorCount", 2))
  # 防御：配置里给了 null / NA / 负数 / 向量时退回 limma-trend 的常用值 2
  if (length(priorCount) != 1 || !is.finite(priorCount) || priorCount < 0) priorCount <- 2
  emit_log("info", paste0("inputIsLog2 = ", inputIsLog2,
                          "; priorCount = ", priorCount))

  # ---- 0.1 误用防护 --------------------------------------------------------
  if (inputIsLog2) {
    # 启发式提示：数值整体偏大时，用户很可能是拿 raw counts 走了这个分支
    finiteVals <- d$expr[is.finite(d$expr)]
    if (length(finiteVals) > 0 && stats::quantile(finiteVals, 0.99, names = FALSE) > 50) {
      emit_log("warn", paste0(
        "expression values look like raw counts (99th percentile = ",
        round(stats::quantile(finiteVals, 0.99, names = FALSE), 1),
        "); turn OFF 'data already log2-transformed' to use limma-trend, ",
        "or use limma+voom / DESeq2 / edgeR for raw counts"
      ))
    }
  } else {
    # ★ 负值不可能是 counts。继续跑不会报错，只会得到一堆垃圾结果，
    #   而用户没有任何线索能看出「我选错了开关」。直接停，并把该怎么改说清楚。
    if (any(d$expr < 0, na.rm = TRUE)) {
      deg_stop(
        "E_DATA_NEGATIVE_LOG",
        paste0(
          "expression matrix contains negative values (min = ",
          signif(min(d$expr, na.rm = TRUE), 4),
          "), which cannot be raw counts; please turn ON 'data already log2-transformed'"
        ),
        status = 13L
      )
    }
    # 反向启发式：原始 counts 的最大值通常远大于 50。若远小于，多半是已经 log2 的数据
    maxVal <- suppressWarnings(max(d$expr, na.rm = TRUE))
    if (is.finite(maxVal) && maxVal < 50) {
      emit_log("warn", paste0(
        "max expression value is only ", signif(maxVal, 4),
        ", which does not look like raw counts; if this matrix is already log2, ",
        "turn ON 'data already log2-transformed'"
      ))
    }
  }

  # ---- 1. 低表达过滤 --------------------------------------------------------
  # ★ countsLike = !inputIsLog2：filterByExpr 只对 counts 有意义。
  #   已 log2 的数据走「log2 >= 1 且在 >= 50% 样本中检出」的降级规则（见 common/de.R）。
  f <- deg_de_filter(d$expr, d$design, ctx, countsLike = !inputIsLog2)
  expr <- d$expr[f$keep, , drop = FALSE]
  emit_progress("filter", 25, sprintf("%d genes kept (%d filtered out)",
                                      nrow(expr), f$filteredOut))

  if (inputIsLog2) {
    # ---- 2a. 已 log2：不标准化，直接拟合 ------------------------------------
    # 已归一化数据没有 normalize 动作，但仍然报一个阶段名，让进度条不停在原地
    emit_progress("normalize", 30, "input already log2; skipping normalization")

    emit_progress("fit", 40, "fitting linear model")
    fit <- limma::lmFit(expr, d$design)
    cm <- limma::makeContrasts(contrasts = contrastStr, levels = d$design)
    fit2 <- limma::contrasts.fit(fit, cm)
    emit_progress("fit", 65, "applying empirical Bayes moderation")
    fit2 <- limma::eBayes(fit2)
    emit_progress("fit", 75, "model fitted")
  } else {
    # ---- 2b. 原始 counts：TMM → log2-CPM → limma-trend ---------------------
    emit_progress("normalize", 28, "calculating TMM normalization factors")
    dge <- edgeR::DGEList(counts = expr)
    dge <- edgeR::calcNormFactors(dge, method = "TMM")

    emit_progress("normalize", 36, "converting counts to log2-CPM (limma-trend)")
    logCPM <- edgeR::cpm(dge, log = TRUE, prior.count = priorCount)
    emit_progress("normalize", 45, "log2-CPM conversion completed")

    emit_progress("fit", 50, "fitting linear model")
    fit <- limma::lmFit(logCPM, d$design)
    cm <- limma::makeContrasts(contrasts = contrastStr, levels = d$design)
    fit2 <- limma::contrasts.fit(fit, cm)
    emit_progress("fit", 70, "applying empirical Bayes moderation (trend)")
    fit2 <- limma::eBayes(fit2, trend = TRUE)
    emit_progress("fit", 75, "model fitted")
  }

  # ---- 3. 检验 --------------------------------------------------------------
  emit_progress("test", 80, "extracting moderated t-statistics")
  fdrMethod <- as.character(deg_param(ctx, "fdrMethod", "BH"))
  tt <- limma::topTable(fit2, number = Inf, sort.by = "P", adjust.method = fdrMethod)
  emit_progress("test", 90, sprintf("%d genes tested", nrow(tt)))

  # ---- 4. 写出 --------------------------------------------------------------
  deg_de_write(ctx, tt, rownames(tt), f$filteredOut, startedAt)
})
