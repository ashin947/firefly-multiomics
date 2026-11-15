# =============================================================================
# r/de/run_deseq2.R —— DESeq2 差异分析（PRD R-10 / ARCHITECTURE §8 第 5 行）
#
# ★ 为什么**分步**调用而不是一步 DESeq()：
#   DESeq() 是一个黑盒，进度只能上报「开始/结束」，用户会看到进度条卡在 30%
#   好几分钟（estimateDispersions 最慢）。拆成
#     estimateSizeFactors → estimateDispersions → nbinomWaldTest
#   后可以按 §5.2 的 dispersion 35-65 / fit 65-85 区间连续上报，体验完全不同。
#
# ★ 整数性双保险：TS 层（AnalysisRunner.assertIntegerCounts）已拦一次，
#   这里再拦一次并 exit 13 —— 因为 R 也可能被用户直接用脚本调用。
#
# ★ lfcShrink(apeglm) 默认关闭（产品决策）：开启后 logFC 与 vignette 不再逐位一致，
#   会让「与 DESeq2 官方示例比对误差 < 1e-6」的验收失败。作为高级选项暴露。
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

deg_main("de/run_deseq2.R", function(ctx) {
  deg_validate_common(ctx)
  deg_ensure_pkgs(c("DESeq2", "edgeR", "data.table"))
  startedAt <- Sys.time()

  # ---- 1. 读数据 ------------------------------------------------------------
  d <- deg_de_prepare(ctx)
  contrast <- deg_param_required(ctx, "contrast")
  deg_validate_contrast(contrast, NULL)
  emit_log("info", paste0("contrast: group ", contrast$numerator, " vs ",
                          contrast$denominator, "  (logFC > 0 => up in ",
                          contrast$numerator, ")"))

  # ---- 2. 整数性双保险（exit 13 → 主进程映射 E_DATA_NOT_INTEGER）------------
  vals <- d$expr[is.finite(d$expr)]
  if (length(vals) == 0) {
    deg_stop("E_DATA_EMPTY", "expression matrix contains no finite values", status = 13L)
  }
  if (any(vals < 0)) {
    deg_stop("E_DATA_NOT_INTEGER",
             paste0("counts contain ", sum(vals < 0), " negative value(s)"),
             status = 13L)
  }
  badCount <- sum(abs(vals - round(vals)) > 1e-8)
  if (badCount > 0) {
    deg_stop("E_DATA_NOT_INTEGER",
             paste0("counts contain ", badCount,
                    " non-integer value(s); DESeq2 requires raw integer counts"),
             detail = "consider using limma-voom instead",
             status = 13L)
  }

  # ---- 3. 过滤 --------------------------------------------------------------
  f <- deg_de_filter(d$expr, d$design, ctx)
  expr <- round(d$expr[f$keep, , drop = FALSE])
  # DESeq2 不接受全零行（会报 "every gene contains at least one zero" 之外的错误）
  nonzero <- rowSums(expr) > 0
  if (!any(nonzero)) {
    deg_stop("E_DATA_EMPTY", "all genes are zero after filtering", status = 13L)
  }
  expr <- expr[nonzero, , drop = FALSE]
  # ★ 记账必须完整：被「全零行」丢掉的基因也算「过滤掉的」，
  #   否则 nrow(de.csv) + filteredOut != 原始基因数，界面上「过滤掉 N 个」会对不上。
  filteredOut <- as.integer(f$filteredOut + sum(!nonzero))
  emit_progress("filter", 20, sprintf("%d genes kept (%d filtered out)",
                                      nrow(expr), filteredOut))

  # ---- 4. 构建对象 ----------------------------------------------------------
  emit_progress("normalize", 22, "building DESeqDataSet")
  colData <- data.frame(group = d$groupFactor, row.names = d$samples)
  dds <- DESeq2::DESeqDataSetFromMatrix(
    countData = expr,
    colData = colData,
    # 与 limma 保持同一套无截距设计，保证对比语义一致
    design = ~ 0 + group
  )

  emit_progress("normalize", 30, "estimating size factors")
  dds <- DESeq2::estimateSizeFactors(dds)
  emit_progress("normalize", 35, "size factors estimated")

  # ---- 5. 离散度（最慢的一步，单独占 35-65）---------------------------------
  emit_progress("dispersion", 38, "estimating dispersions (this may take a while)")
  dds <- DESeq2::estimateDispersions(dds, quiet = TRUE)
  emit_progress("dispersion", 65, "dispersion estimated")

  # ---- 6. 拟合 --------------------------------------------------------------
  emit_progress("fit", 70, "fitting negative binomial GLM (Wald test)")
  dds <- DESeq2::nbinomWaldTest(dds)
  emit_progress("fit", 85, "model fitted")

  # ---- 7. 提取结果 ----------------------------------------------------------
  emit_progress("test", 88, "extracting results")
  shrinkLfc <- isTRUE(deg_param(ctx, "shrinkLfc", FALSE))

  if (shrinkLfc) {
    # apeglm 只能收缩「单个系数」，无法直接作用在 contrast 上，
    # 因此这里用等价设计（有截距 + 对照组为参考水平）重跑一遍再收缩。
    # 结果数值会与未收缩版本不同 —— 这正是它默认关闭的原因。
    emit_progress("test", 90, "applying apeglm logFC shrinkage")
    deg_ensure_pkgs("apeglm")
    grp <- stats::relevel(factor(d$groupVec, levels = d$levels), ref = contrast$denominator)
    colData2 <- data.frame(group = grp, row.names = d$samples)
    dds2 <- DESeq2::DESeqDataSetFromMatrix(expr, colData2, design = ~ group)
    dds2 <- DESeq2::DESeq(dds2, quiet = TRUE)
    coefName <- paste0("group", contrast$numerator, "_vs_", contrast$denominator)
    res <- DESeq2::lfcShrink(dds2, coef = coefName, type = "apeglm", quiet = TRUE)
  } else {
    # 显式传 contrast：不写的话 results() 默认取「design 的最后一列」，
    # 一旦 design 列顺序变化，logFC 的符号就会悄悄反过来。
    res <- DESeq2::results(
      dds,
      contrast = c("group", contrast$numerator, contrast$denominator)
    )
  }
  # ★ pct 必须 <= 90：下一步 deg_de_write 从 92 开始，若这里报 94 会让进度条回退
  #   （主进程有单调钳制，但脚本自身也不该产生回退，冒烟脚本会断言这一点）
  emit_progress("test", 90, sprintf("%d genes tested", nrow(res)))

  # ---- 8. 组装 9 列（aveExpr = baseMean，b = null）--------------------------
  # logFC 为 NA 的行（某一组全零，DESeq2 无法估计）必须丢弃 ——
  # ResultLoader 的 schema 要求 logFC 是有限数。丢弃的基因同样计入 filteredOut，
  # 保证「结果行数 + 过滤数 == 原始基因数」这条账始终平。
  #
  # ★ 列名是 `log2FoldChange`，不是 `logFC`（limma 才叫 logFC）。
  #   这里曾经写成 `res$logFC` → 得到 NULL → `!is.na(NULL)` 是长度 0 的逻辑向量 →
  #   `any()` 为 FALSE → 直接报「DESeq2 returned no testable genes」并 exit 13。
  #   表现极具误导性：进度条明明已经报了「1400 genes tested」，紧接着说没有可测基因。
  #   只有真跑一遍 DESeq2 才会暴露（脚本写完没跑过时最典型的错）。
  keepRows <- !is.na(res$log2FoldChange)
  droppedByNA <- as.integer(sum(!keepRows))
  if (!any(keepRows)) {
    deg_stop("E_DATA_EMPTY", "DESeq2 returned no testable genes", status = 13L)
  }

  tt <- data.frame(
    logFC = as.numeric(res$log2FoldChange),
    AveExpr = as.numeric(res$baseMean),   # 占位：实际由 baseMean 参数覆盖
    t = as.numeric(res$stat),
    P.Value = as.numeric(res$pvalue),
    adj.P.Val = as.numeric(res$padj),
    B = NA_real_,
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
  rownames(tt) <- rownames(res)

  tt <- tt[keepRows, , drop = FALSE]
  # 与 limma 的 topTable(sort.by="P") 保持一致的排序，便于两份结果直接比对
  ord <- order(tt$P.Value, na.last = TRUE)
  tt <- tt[ord, , drop = FALSE]
  baseMean <- as.numeric(res$baseMean)[keepRows][ord]

  deg_de_write(
    ctx,
    tt,
    rownames(tt),
    filteredOut + droppedByNA,
    startedAt,
    baseMean = baseMean,
    b = rep(NA_real_, nrow(tt))
  )
})
