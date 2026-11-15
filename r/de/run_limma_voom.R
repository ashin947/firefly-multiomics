# =============================================================================
# r/de/run_limma_voom.R —— limma + voom 差异分析（PRD R-09 / ARCHITECTURE §8 第 3 行）
#
# 流程：DGEList → filterByExpr → calcNormFactors(TMM) → voom → lmFit(design)
#       → makeContrasts → contrasts.fit → eBayes → topTable
#
# ★ logFC 方向：见 r/common/de.R 文件头。design 用 `~0 + group`，
#   contrast 用 "`实验组` - `对照组`"，因此 logFC > 0 = 在实验组上调。
#   这是全项目唯一的方向约定，改这里之前请先读那段注释。
#
# 阶段 pct 区间（§5.2）：read 0-15 / filter 15-25 / normalize 25-45 / fit 45-75 / test 75-90 / write 90-100
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

deg_main("de/run_limma_voom.R", function(ctx) {
  deg_validate_common(ctx)
  deg_ensure_pkgs(c("limma", "edgeR", "data.table"))
  startedAt <- Sys.time()

  # ---- 1. 读数据 + 设计矩阵 --------------------------------------------------
  d <- deg_de_prepare(ctx)
  contrast <- deg_param_required(ctx, "contrast")
  contrastStr <- deg_de_contrast(contrast, d$levels)
  emit_log("info", paste0("contrast: ", contrastStr, "  (logFC > 0 => up in ",
                          contrast$numerator, ")"))

  # ---- 2. 低表达过滤 --------------------------------------------------------
  f <- deg_de_filter(d$expr, d$design, ctx)
  expr <- d$expr[f$keep, , drop = FALSE]
  emit_progress("filter", 25, sprintf("%d genes kept (%d filtered out)",
                                      nrow(expr), f$filteredOut))

  # ---- 3. 标准化：TMM + voom ------------------------------------------------
  emit_progress("normalize", 28, "calculating TMM normalization factors")
  dge <- edgeR::DGEList(counts = expr)
  dge <- edgeR::calcNormFactors(dge, method = "TMM")

  emit_progress("normalize", 36, "running voom (mean-variance modelling)")
  v <- limma::voom(dge, d$design, plot = FALSE)
  emit_progress("normalize", 45, "voom completed")

  # ---- 4. 拟合 --------------------------------------------------------------
  emit_progress("fit", 50, "fitting weighted linear model")
  fit <- limma::lmFit(v, d$design)
  cm <- limma::makeContrasts(contrasts = contrastStr, levels = d$design)
  fit2 <- limma::contrasts.fit(fit, cm)
  emit_progress("fit", 70, "applying empirical Bayes moderation")
  fit2 <- limma::eBayes(fit2)
  emit_progress("fit", 75, "model fitted")

  # ---- 5. 检验 --------------------------------------------------------------
  emit_progress("test", 80, "extracting moderated t-statistics")
  fdrMethod <- as.character(deg_param(ctx, "fdrMethod", "BH"))
  tt <- limma::topTable(fit2, number = Inf, sort.by = "P", adjust.method = fdrMethod)
  emit_progress("test", 90, sprintf("%d genes tested", nrow(tt)))

  # ---- 6. 写出 --------------------------------------------------------------
  deg_de_write(ctx, tt, rownames(tt), f$filteredOut, startedAt)
})
