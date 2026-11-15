# =============================================================================
# r/scrna/run_scrna_singleR.R —— 第 6 步（B 路）：SingleR 自动注释预览
#
# 只出**建议**，不写对象：用户看过建议、改完再走 run_scrna_annotate.R 应用。
# 这与第 2 步「先出图再过滤」是同一个原则 —— 自动注释的错误率不低，
# 直接落盘会让用户以为那是「结果」。
#
# ## 为什么按 cluster 注释
#
# `SingleR(test=, ref=, labels=, clusters=)` 传 clusters 时会先在簇内取平均再比对，
# 比逐细胞更稳、也快得多（2.6 万细胞逐细胞要几十分钟）。客户脚本也是按簇做的。
#
# ## 参考集
#
#   1. celldex 的四个常用参考集（首次使用需联网下载几百 MB，之后缓存复用）
#   2. 用户自己的 .rds（客户脚本里是 ref_Human_all.RData）
#      —— 必须能取到 label 列：优先 `label.main`，其次 `label.fine`，或用户指定。
#
# ★ 离线时**明确报错**（网络错误往往是一长串 curl 信息，用户看不出是网络问题）。
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

#' celldex 参考集名 → 构造函数
.singler_ref_builder <- function(name) {
  switch(name,
    HumanPrimaryCellAtlasData = celldex::HumanPrimaryCellAtlasData,
    MonacoImmuneData = celldex::MonacoImmuneData,
    MouseRNAseqData = celldex::MouseRNAseqData,
    ImmGenData = celldex::ImmGenData,
    NULL
  )
}

deg_main("scrna/run_scrna_singleR.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step5.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("step-5 object not found: ", basename(objPath)), status = 12L)
  }
  refName <- as.character(.scrna_param(ctx, "refName", "HumanPrimaryCellAtlasData"))
  refRds <- as.character(.scrna_param(ctx, "refRds", ""))
  labelColumn <- as.character(.scrna_param(ctx, "labelColumn", ""))

  emit_progress("read", 5, "loading object")
  obj <- readRDS(objPath)
  if (!"clusters" %in% colnames(obj@meta.data)) {
    deg_stop("E_DATA_INVALID", "the object has no 'clusters' column", status = 13L)
  }
  clusters <- as.character(obj$clusters)
  emit_log("info", sprintf("object: %d genes x %d cells, %d cluster(s)",
                           nrow(obj), ncol(obj), length(unique(clusters))))

  # ---- 依赖 ---------------------------------------------------------------
  if (!requireNamespace("SingleR", quietly = TRUE)) {
    deg_stop("E_RT_PKG_MISSING",
             "missing R packages: SingleR (needed for automatic annotation)", status = 12L)
  }

  # ---- 参考集 -------------------------------------------------------------
  ref <- NULL
  refLabel <- ""
  if (nzchar(refRds)) {
    if (!file.exists(refRds)) {
      deg_stop("E_DATA_MISSING", paste0("reference not found: ", basename(refRds)), status = 12L)
    }
    emit_progress("read", 20, "loading user reference")
    ref <- tryCatch(readRDS(refRds), error = function(e) {
      deg_stop("E_DATA_INVALID", paste0("cannot read reference: ", conditionMessage(e)), status = 13L)
    })
    # 参考对象可能是 SummarizedExperiment 或 data.frame/matrix
    cols <- tryCatch(colnames(SummarizedExperiment::colData(ref)), error = function(e) character(0))
    pick <- if (nzchar(labelColumn) && labelColumn %in% cols) {
      labelColumn
    } else if ("label.main" %in% cols) {
      "label.main"
    } else if ("label.fine" %in% cols) {
      "label.fine"
    } else {
      ""
    }
    if (!nzchar(pick)) {
      # 最常见的两种「选错文件」要能被区分出来：一是拿普通 Seurat 对象当参考集
      # （colData 里什么都没有），二是参考集有列但没有 label 列（物种/版本不同）。
      deg_stop("E_DATA_INVALID", paste0(
        "reference has no usable label column (looked for label.main / label.fine",
        if (nzchar(labelColumn)) paste0(" / ", labelColumn) else "",
        "). ",
        if (length(cols) == 0) {
          paste0("This file has no cell metadata at all — it looks like a Seurat object ",
                 "instead of a SingleR reference. A reference is a SummarizedExperiment ",
                 "(e.g. celldex::HumanPrimaryCellAtlasData saved with saveRDS) or a matrix ",
                 "with a cell-type column.")
        } else {
          paste0("Available columns: ", paste(utils::head(cols, 12), collapse = ", "),
                 ". Pick the column that holds the cell type in the 'label column' box.")
        }), status = 13L)
    }
    refLabel <- pick
    emit_log("info", sprintf("user reference: %s (labels from '%s')",
                             basename(refRds), refLabel))
  } else {
    if (!requireNamespace("celldex", quietly = TRUE)) {
      deg_stop("E_RT_PKG_MISSING",
               "missing R packages: celldex (needed to fetch reference datasets)", status = 12L)
    }
    builder <- .singler_ref_builder(refName)
    if (is.null(builder)) {
      deg_stop("E_VALIDATION", paste0("unknown reference dataset: ", refName), status = 11L)
    }
    emit_progress("read", 20, sprintf("loading reference %s (first run downloads it)", refName))
    emit_log("info", sprintf(
      "fetching celldex::%s — first use needs network (a few hundred MB), later runs use the cache",
      refName))
    ref <- tryCatch(
      suppressMessages(builder()),
      error = function(e) {
        msg <- conditionMessage(e)
        # 网络问题在 R 里长得像一长串 curl 报错，用户看不出是「需要联网」
        deg_stop("E_RT_NETWORK", paste0(
          "failed to fetch reference '", refName, "'. ",
          "This is usually a network issue (or you are offline); the reference is downloaded ",
          "once and cached afterwards. You can also import your own reference .rds. ",
          "Detail: ", substr(msg, 1, 300)), status = 15L)
      }
    )
    refLabel <- "label.main"
  }

  # ---- 跑 SingleR（按 cluster）-------------------------------------------
  emit_progress("test", 45, "running SingleR (cluster-level)")
  test <- tryCatch(
    SeuratObject::LayerData(obj, assay = "RNA", layer = "data"),
    error = function(e) Seurat::GetAssayData(obj, assay = "RNA", layer = "data")
  )
  t0 <- Sys.time()
  pred <- tryCatch(
    SingleR::SingleR(test = test, ref = ref, labels = ref[[refLabel]],
                     clusters = clusters),
    error = function(e) {
      deg_stop("E_R_GENERIC", paste0("SingleR failed: ", conditionMessage(e)), status = 1L)
    }
  )
  singleRSeconds <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  emit_log("info", sprintf("SingleR done in %.1f s", singleRSeconds))

  # pruned.labels 里是 NA 的表示「低置信度」
  labels <- as.character(pred$labels)
  pruned <- if (!is.null(pred$pruned.labels)) as.character(pred$pruned.labels) else labels
  scores <- tryCatch({
    m <- pred$scores
    apply(m, 1, function(r) r[which.max(r)])
  }, error = function(e) rep(NA_real_, length(labels)))
  clusterNames <- rownames(pred)

  rows <- lapply(seq_along(clusterNames), function(i) list(
    cluster = as.character(clusterNames[i]),
    celltype = labels[i],
    pruned = pruned[i],
    score = round(as.numeric(scores[i]), 4)
  ))

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 95, "done")
  emit_result(list(
    refName = if (nzchar(refRds)) basename(refRds) else refName,
    refLabel = refLabel,
    nClusters = as.integer(length(clusterNames)),
    suggestions = unname(rows),
    singleRSeconds = round(singleRSeconds, 1),
    durationMs = as.integer(durationMs)
  ))
})
