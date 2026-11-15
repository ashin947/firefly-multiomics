# =============================================================================
# r/scrna/run_scrna_qc.R —— 单细胞流程第 2 步 · 段 A：质控分布预览
#
# ## 为什么「先出图再过滤」（这一段只画图，不改对象）
#
# 客户原话是「画出 nFeature_RNA、nCount_RNA、mt 过滤的图」+「用户选择参数」。
# 也就是说阈值是**看完分布之后**由人定的，不是软件替他拍。所以这一段：
#   · 只算指标、只画图、只统计「按当前阈值会过多少」；
#   · **一个细胞都不删**（对象原样存成 obj_qc.rds 供段 B 用）。
# 用户改阈值后重跑这一段即可（几秒），不用重建对象。
#
# ## 线粒体基因的匹配：`^mt-` 不区分大小写
#
# 三个物种的写法各不相同：人 `MT-ND1`、鼠 `mt-Nd1`、水稻 `Mt-nad1`。
# `grep("^mt-", ignore.case = TRUE)` 一条就能全命中（本批水稻实测 52 个 `Mt-*`）。
#
# ★ 匹配到 0 个基因时**不报错**：有些物种/注释根本没有线粒体基因命名，
#   这时 percent.mt 这一列不存在，mt 相关的图与过滤都要跳过 —— 而不是让整步挂掉。
#   但也不能默默跳过：summary 里给 `mtGeneCount: 0`，界面据此隐藏 mt 图并说明原因。
#
# ## 为什么要单独存 obj_qc.rds
#
# percent.mt 算一次要遍历整个稀疏矩阵（几秒）。段 B 若重算，用户每调一次阈值
# 都要再等一遍；存下来后段 B 只做取子集。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

.scrna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 数值参数：null / 空串 / 非数字 一律当成「不启用这条」
.scrna_threshold <- function(ctx, name) {
  v <- .scrna_param(ctx, name, NULL)
  if (is.null(v)) return(NULL)
  if (is.character(v) && !nzchar(trimws(v))) return(NULL)
  n <- suppressWarnings(as.numeric(v))
  if (length(n) != 1L || is.na(n)) return(NULL)
  n
}

#' 线粒体基因比例
#'
#' 直接按 counts 算：`colSums(mt) / colSums(all) * 100`。
#' 不用 `PercentageFeatureSet` 是因为它把正则交给内部参数，命中 0 个基因时
#' 报错还是静默取决于版本；这里自己 grep，命中数拿来直接用。
.scrna_percent_mt <- function(obj, pattern = "^mt-") {
  genes <- rownames(obj)
  mt <- grepl(pattern, genes, ignore.case = TRUE)
  n <- sum(mt)
  if (n == 0L) return(NULL)

  # ★★ merge 之后的对象在 Seurat v5 里是**多层**的：`counts.MD` / `counts.WW`。
  #    直接取 `obj[["RNA"]]$counts` 只会拿到**第一层**（实测只剩 MD 的 13889 个细胞），
  #    于是这一层的行数（27930）小于合并后的基因数（28525），
  #    `counts[mt, ]` 用长度为 28525 的逻辑向量去索引 27930 行 →
  #    "logical subscript too long"，整步直接失败。
  #    所以先 JoinLayers 把多层拼成完整的 counts。
  joined <- tryCatch(SeuratObject::JoinLayers(obj), error = function(e) obj)
  counts <- tryCatch(
    SeuratObject::LayerData(joined, assay = "RNA", layer = "counts"),
    error = function(e) Seurat::GetAssayData(joined, assay = "RNA", layer = "counts")
  )

  total <- Matrix::colSums(counts)
  mtSum <- Matrix::colSums(counts[mt, , drop = FALSE])
  # 总 counts 为 0 的细胞（空液滴）会给出 NaN —— 置 0，别让它污染中位数
  ratio <- ifelse(total > 0, mtSum / total * 100, 0)
  # 按**细胞名**对齐：JoinLayers 拼出来的顺序理论上与 colnames(obj) 一致，
  # 但元数据是按位置赋值的，用名字取一次更稳妥（取不到会变成 NA，不会错位）。
  names(ratio) <- colnames(counts)
  list(values = ratio, geneCount = as.integer(n),
       examples = utils::head(genes[mt], 3))
}

#' 每样本 QC 摘要（含按当前阈值能过多少）
.scrna_qc_summary <- function(obj, minFeature, minCount, maxMt) {
  md <- obj@meta.data
  samples <- unique(as.character(md$orig.ident))
  passFeature <- if (is.null(minFeature)) rep(TRUE, nrow(md)) else md$nFeature_RNA > minFeature
  passCount <- if (is.null(minCount)) rep(TRUE, nrow(md)) else md$nCount_RNA > minCount
  # ★ 单位：`percent.mt` 存的是 **0–100** 的百分数，而用户输入的 maxMt 是 **0–1**
  #   的小数（0.2 = 20%）。这里必须乘 100 —— 直接拿 0.2 去比 33.97 会把**所有**
  #   细胞判成不合格，而界面上看起来只是「阈值有点严」。
  passMt <- if (is.null(maxMt) || is.null(md$percent.mt)) {
    rep(TRUE, nrow(md))
  } else {
    md$percent.mt < maxMt * 100
  }
  passAll <- passFeature & passCount & passMt

  lapply(samples, function(s) {
    idx <- md$orig.ident == s
    list(
      sample = s,
      cells = as.integer(sum(idx)),
      medianFeature = as.integer(stats::median(md$nFeature_RNA[idx])),
      medianCount = as.integer(stats::median(md$nCount_RNA[idx])),
      medianMt = if (is.null(md$percent.mt)) NA_real_ else round(stats::median(md$percent.mt[idx]), 2),
      passFeature = as.integer(sum(idx & passFeature)),
      passCount = as.integer(sum(idx & passCount)),
      passMt = as.integer(sum(idx & passMt)),
      passAll = as.integer(sum(idx & passAll))
    )
  })
}

#' 小提琴图：横轴=样本，纵轴=指标，画阈值红线
#'
#' 样本多时横着排不下 —— `facet_wrap` 的列数按样本数自适应，并旋转标签。
.scrna_violin <- function(obj, metric, ylab, file, threshold, title) {
  ok <- tryCatch({
    deg_ensure_pkgs("ggplot2")
    df <- data.frame(
      sample = factor(as.character(obj$orig.ident)),
      value = as.numeric(obj@meta.data[[metric]])
    )
    n <- length(levels(df$sample))
    p <- ggplot2::ggplot(df, ggplot2::aes(x = sample, y = value)) +
      ggplot2::geom_violin(fill = "#46bac2", alpha = 0.55, scale = "width", linewidth = 0.3) +
      ggplot2::geom_boxplot(width = 0.12, outlier.shape = NA, linewidth = 0.25) +
      ggplot2::labs(x = NULL, y = ylab, title = title) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(
        panel.grid.minor = ggplot2::element_blank(),
        axis.text.x = ggplot2::element_text(angle = if (n > 3) 35 else 0,
                                            hjust = if (n > 3) 1 else 0.5)
      )
    if (!is.null(threshold)) {
      p <- p + ggplot2::geom_hline(yintercept = threshold, colour = "#d64545",
                                   linetype = "dashed", linewidth = 0.6)
    }
    deg_save_ggplot(p, file, max(5, min(12, 1.1 * n + 2.5)), 3.6, metric)
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("plot failed (", metric, "): ", conditionMessage(e)))
    FALSE
  })
  isTRUE(ok) && file.exists(file)
}

deg_main("scrna/run_scrna_qc.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "data.table", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step1.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING", paste0("step-1 object not found: ", basename(objPath)), status = 12L)
  }

  minFeature <- .scrna_threshold(ctx, "minFeature")
  minCount <- .scrna_threshold(ctx, "minCount")
  maxMt <- .scrna_threshold(ctx, "maxMt")

  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)
  emit_log("info", sprintf("loaded %d genes x %d cells from %s",
                           nrow(obj), ncol(obj), basename(objPath)))

  # ---- percent.mt ---------------------------------------------------------
  emit_progress("filter", 20, "computing percent.mt")
  mt <- .scrna_percent_mt(obj)
  mtGeneCount <- if (is.null(mt)) 0L else mt$geneCount
  if (is.null(mt)) {
    emit_log("warn",
             "no mitochondrial gene matched '^mt-': percent.mt not computed, mt plots and mt filtering are skipped")
  } else {
    obj$percent.mt <- as.numeric(mt$values[colnames(obj)])
    emit_log("info", sprintf("percent.mt from %d gene(s), e.g. %s",
                             mt$geneCount, paste(mt$examples, collapse = ", ")))
  }

  # ---- 阈值回显（null 表示该条不启用）------------------------------------
  emit_log("info", sprintf(
    "thresholds: minFeature=%s minCount=%s maxMt=%s (preview only, nothing is removed here)",
    if (is.null(minFeature)) "off" else minFeature,
    if (is.null(minCount)) "off" else minCount,
    if (is.null(maxMt)) "off" else maxMt
  ))

  # ---- 四张图 -------------------------------------------------------------
  emit_progress("plot", 45, "qc distributions")
  plots <- list()
  p1 <- .scrna_violin(obj, "nFeature_RNA", "Detected genes per cell",
                      file.path(ctx$runDir, "p01_violin_nFeature.png"), minFeature,
                      "nFeature_RNA per sample")
  if (p1) plots[[length(plots) + 1L]] <- list(id = "nFeature", file = "p01_violin_nFeature.png",
                                              caption = "每样本检出基因数（红虚线 = 当前阈值）")
  p2 <- .scrna_violin(obj, "nCount_RNA", "UMI counts per cell",
                      file.path(ctx$runDir, "p02_violin_nCount.png"), minCount,
                      "nCount_RNA per sample")
  if (p2) plots[[length(plots) + 1L]] <- list(id = "nCount", file = "p02_violin_nCount.png",
                                              caption = "每样本 UMI 总数（红虚线 = 当前阈值）")

  p3 <- FALSE
  if (mtGeneCount > 0L) {
    p3 <- .scrna_violin(obj, "percent.mt", "Mitochondrial %",
                        file.path(ctx$runDir, "p03_violin_percent_mt.png"),
                        if (is.null(maxMt)) NULL else maxMt * 100,
                        "percent.mt per sample")
    if (p3) plots[[length(plots) + 1L]] <- list(id = "percentMt", file = "p03_violin_percent_mt.png",
                                                caption = "每样本线粒体比例（红虚线 = 当前阈值）")
  } else {
    emit_log("info", "skipping mt violin plot: no mitochondrial genes in this dataset")
  }

  # ---- 散点：nCount vs nFeature ------------------------------------------
  p4 <- tryCatch({
    deg_ensure_pkgs("ggplot2")
    md <- obj@meta.data
    nSamples <- length(unique(as.character(md$orig.ident)))
    # 点数上限：两万多个点画进 png 只会糊成一团，且 ggsave 会明显变慢
    idx <- seq_len(nrow(md))
    if (length(idx) > 20000L) idx <- sample(idx, 20000L)
    df <- data.frame(
      nCount = md$nCount_RNA[idx],
      nFeature = md$nFeature_RNA[idx],
      sample = factor(as.character(md$orig.ident)[idx])
    )
    if (!is.null(md$percent.mt)) df$percent.mt <- md$percent.mt[idx]

    # 样本 ≤6：分面 + 按 mt 着色；>6：分面会挤成一条条，改成不分面、按样本着色
    if (nSamples <= 6 && !is.null(df$percent.mt)) {
      p <- ggplot2::ggplot(df, ggplot2::aes(x = nCount, y = nFeature, colour = percent.mt)) +
        ggplot2::geom_point(size = 0.35, alpha = 0.5) +
        ggplot2::scale_colour_gradient(low = "#cfe3e6", high = "#d64545") +
        ggplot2::facet_wrap(~sample, ncol = 3) +
        ggplot2::labs(colour = "MT %")
    } else {
      p <- ggplot2::ggplot(df, ggplot2::aes(x = nCount, y = nFeature, colour = sample)) +
        ggplot2::geom_point(size = 0.35, alpha = 0.5) +
        ggplot2::labs(colour = "Sample") +
        ggplot2::theme(legend.position = "right")
    }
    if (!is.null(minCount)) p <- p + ggplot2::geom_vline(xintercept = minCount, colour = "#d64545", linetype = "dashed", linewidth = 0.5)
    if (!is.null(minFeature)) p <- p + ggplot2::geom_hline(yintercept = minFeature, colour = "#d64545", linetype = "dashed", linewidth = 0.5)
    p <- p + ggplot2::labs(x = "nCount_RNA", y = "nFeature_RNA",
                           title = sprintf("QC scatter (%s cells shown)", format(length(idx), big.mark = ","))) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    deg_save_ggplot(p, file.path(ctx$runDir, "p04_scatter_qc.png"), 8, 5.2, "scatter")
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("scatter plot failed: ", conditionMessage(e)))
    FALSE
  })
  if (isTRUE(p4)) plots[[length(plots) + 1L]] <- list(id = "scatter", file = "p04_scatter_qc.png",
                                                     caption = "nCount × nFeature（颜色 = 线粒体比例）")

  # ---- 每样本摘要 ---------------------------------------------------------
  emit_progress("write", 80, "summarising")
  qcSummary <- .scrna_qc_summary(obj, minFeature, minCount, maxMt)
  stats <- data.frame(
    sample = vapply(qcSummary, function(x) x$sample, character(1)),
    cells = vapply(qcSummary, function(x) x$cells, integer(1)),
    median_feature = vapply(qcSummary, function(x) x$medianFeature, integer(1)),
    median_count = vapply(qcSummary, function(x) x$medianCount, integer(1)),
    median_mt = vapply(qcSummary, function(x) as.numeric(x$medianMt), numeric(1)),
    pass_feature = vapply(qcSummary, function(x) x$passFeature, integer(1)),
    pass_count = vapply(qcSummary, function(x) x$passCount, integer(1)),
    pass_mt = vapply(qcSummary, function(x) x$passMt, integer(1)),
    pass_all = vapply(qcSummary, function(x) x$passAll, integer(1)),
    stringsAsFactors = FALSE
  )
  data.table::fwrite(stats, file.path(ctx$runDir, "qc_preview.csv"))
  emit_artifact("table", "qc_preview.csv", rows = nrow(stats), schema = "ScrnaQcSampleStat[]")
  for (pl in plots) emit_artifact("plot", pl$file)

  # 存下来给段 B（含 percent.mt，避免重算）
  emit_progress("write", 92, "saving obj_qc.rds")
  saveRDS(obj, file.path(ctx$runDir, "obj_qc.rds"))
  emit_artifact("scrna_object", "obj_qc.rds")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_log("info", sprintf("QC preview: %d cells, %d genes, mt genes=%d",
                           ncol(obj), nrow(obj), mtGeneCount))

  emit_result(list(
    nCells = as.integer(ncol(obj)),
    nGenes = as.integer(nrow(obj)),
    mtGeneCount = as.integer(mtGeneCount),
    mtExamples = unname(if (is.null(mt)) character(0) else mt$examples),
    qcSummary = unname(qcSummary),
    plots = unname(plots),
    minFeature = if (is.null(minFeature)) NULL else minFeature,
    minCount = if (is.null(minCount)) NULL else minCount,
    maxMt = if (is.null(maxMt)) NULL else maxMt,
    summaryFile = "qc_preview.csv",
    objectFile = "obj_qc.rds",
    durationMs = as.integer(durationMs)
  ))
})
