# =============================================================================
# r/de/run_edger.R —— edgeR 差异分析（负二项 GLM + quasi-likelihood F 检验）
#
# 流程：DGEList → filterByExpr → calcNormFactors(TMM) → estimateDisp(robust)
#       → glmQLFit(robust) → makeContrasts → glmQLFTest → topTags
#
# 为什么用 QL F-test 而不是经典 exactTest / LRT：
#   1. exactTest 只支持两组、且假设离散度在组间共享，无法表达任意 contrast；
#   2. LRT 在小样本下对离散度估计的误差过于乐观，假阳性偏多；
#   3. QL F-test 用 quasi-likelihood 把「离散度本身的不确定性」也计入，
#      在每组 2~3 个样本时最稳，且天然支持任意 contrast —— 与 limma/DESeq2
#      共用同一套 design + contrast 语义（见 r/common/de.R 文件头）。
#
# ★ logFC 方向：与其它三个脚本共用 deg_de_contrast()，design 用 `~0 + group`，
#   contrast 用 "`实验组` - `对照组`"，因此 logFC > 0 = 在实验组上调。
#
# 阶段 pct 区间：read 0-15 / filter 15-25 / normalize 25-40 / dispersion 40-55 /
#               fit 55-75 / test 75-90 / write 90-100
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

deg_main("de/run_edger.R", function(ctx) {
  deg_validate_common(ctx)
  # ★ limma 必须一起声明：makeContrasts 来自 limma（edgeR 不导出它）。
  #   漏了会在用户机器上缺包时报成「R 错误」而不是「缺包」，用户根本不知道该装什么。
  deg_ensure_pkgs(c("edgeR", "limma", "data.table"))
  startedAt <- Sys.time()

  # ---- 1. 读数据 + 设计矩阵 --------------------------------------------------
  d <- deg_de_prepare(ctx)
  contrast <- deg_param_required(ctx, "contrast")
  contrastStr <- deg_de_contrast(contrast, d$levels)
  emit_log("info", paste0("contrast: ", contrastStr, "  (logFC > 0 => up in ",
                          contrast$numerator, ")"))

  # ---- 2. 低表达过滤（counts 语义，与 voom / DESeq2 完全一致）-----------------
  f <- deg_de_filter(d$expr, d$design, ctx)
  expr <- d$expr[f$keep, , drop = FALSE]
  emit_progress("filter", 25, sprintf("%d genes kept (%d filtered out)",
                                      nrow(expr), f$filteredOut))

  # ---- 3. 标准化 ------------------------------------------------------------
  emit_progress("normalize", 28, "building DGEList")
  dge <- edgeR::DGEList(counts = expr, group = d$groupFactor)
  emit_progress("normalize", 32, "calculating TMM normalization factors")
  dge <- edgeR::calcNormFactors(dge, method = "TMM")
  emit_progress("normalize", 40, "normalization factors estimated")

  # ---- 4. 离散度（最慢的一步，单独占 40-55）----------------------------------
  emit_progress("dispersion", 42, "estimating common/trended/tagwise dispersions")
  dge <- edgeR::estimateDisp(dge, d$design, robust = TRUE)
  emit_progress("dispersion", 55, "dispersion estimated")

  # ---- 5. 拟合 quasi-likelihood 模型 ----------------------------------------
  emit_progress("fit", 58, "fitting quasi-likelihood GLM")
  fit <- edgeR::glmQLFit(dge, d$design, robust = TRUE)

  # makeContrasts 返回的是「系数 × 对比」矩阵；glmQLFTest 要的是与 design 列对齐的
  # 数值向量，所以取第一列并把名字设成系数名（不设名字会报 "contrast must have names"）。
  cm <- limma::makeContrasts(contrasts = contrastStr, levels = d$design)
  contrastVec <- as.numeric(cm[, 1])
  names(contrastVec) <- rownames(cm)
  emit_progress("fit", 75, "model fitted")

  # ---- 6. QL F 检验 ---------------------------------------------------------
  emit_progress("test", 78, "running quasi-likelihood F-test")
  qlf <- edgeR::glmQLFTest(fit, contrast = contrastVec)
  fdrMethod <- as.character(deg_param(ctx, "fdrMethod", "BH"))

  # ★★ 这里是最容易静默出错的地方：topTags() 的列名与 limma 的 topTable() **完全不同**
  #
  #      deg_de_write 需要   | topTags()$table 实际列名
  #      --------------------+------------------------
  #      logFC               | logFC        （同名）
  #      AveExpr             | logCPM       ← 不同名
  #      t                   | F            ← 不同名（QL F 统计量）
  #      P.Value             | PValue       ← 不同名（少了点）
  #      adj.P.Val           | FDR          ← 不同名
  #      B                   | 没有这一列   ← 必须自己补
  #
  #   写错的后果不是报错，而是 `tbl$FDR` 得到 NULL → `as.numeric(NULL)` 是
  #   numeric(0) → data.frame 报「arguments imply differing number of rows」；
  #   更糟的是长度恰好兼容时静默产出全 NA 的 FDR 列，界面显示「0 个显著基因」。
  #   这与 DESeq2 的 `res$logFC`（实际叫 log2FoldChange）是同一类陷阱，
  #   所以这里显式构造 tt，不指望下游自己认列名。
  #
  # ★ sort.by 也必须传 "PValue"（limma 的 topTable 才是 "P"），传错会报
  #   'arg' should be one of "logFC", "logCPM", "PValue", "F", "FDR"。
  # ★ adjust.method = "none" 时 FDR 列等于 PValue，这是正常行为，不是 bug。
  tbl <- edgeR::topTags(qlf, n = Inf, sort.by = "PValue",
                        adjust.method = fdrMethod)$table

  # 防御：列名对不上就直接失败，绝不产出「全 NA 但看起来正常」的结果
  requiredCols <- c("logFC", "logCPM", "F", "PValue", "FDR")
  if (!all(requiredCols %in% colnames(tbl))) {
    deg_stop(
      "E_RUNTIME",
      paste0("unexpected topTags columns: ", paste(colnames(tbl), collapse = ",")),
      detail = paste0("expected: ", paste(requiredCols, collapse = ",")),
      status = 10L
    )
  }

  tt <- data.frame(
    logFC = as.numeric(tbl$logFC),
    AveExpr = as.numeric(tbl$logCPM),
    t = as.numeric(tbl$F),
    P.Value = as.numeric(tbl$PValue),
    adj.P.Val = as.numeric(tbl$FDR),
    # edgeR 的 QL F-test 不产出 limma 那种 log-odds（B），与 DESeq2 一样置 NA。
    # 不能省掉这一列：deg_de_write 会读 tt$B，缺列时 as.numeric(NULL) 是 numeric(0)。
    B = rep(NA_real_, nrow(tbl)),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
  rownames(tt) <- rownames(tbl)
  emit_progress("test", 90, sprintf("%d genes tested", nrow(tt)))

  # ---- 7. 写出 --------------------------------------------------------------
  deg_de_write(ctx, tt, rownames(tbl), f$filteredOut, startedAt)
})
