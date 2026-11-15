# =============================================================================
# r/scrna/run_scrna_filter.R —— 单细胞流程第 2 步 · 段 B：按阈值真正过滤
#
# ## 为什么和段 A 分开
#
# 段 A 只画图不改对象，用户看完分布、调好阈值，再单独点「应用过滤」。
# 这样「预览」可以反复跑（几秒），而对象只在用户明确同意时才被裁掉一次。
# 输入是段 A 存下的 obj_qc.rds —— percent.mt 已经算好，这里只做取子集。
#
# ## 三个阈值都可以为 null
#
# null = 不启用该条（不是「用默认值」）。三条全 null 时不报错，等于原样输出，
# 前后细胞数相等 —— 用户可能只想先看看现在有多少细胞。
#
# ## 边界
#
#   · 某个样本被清空 → **不报错**，warn 指出是哪个样本，summary 里带去；
#     6 个样本里死掉 1 个是常见的，不该让整步失败。
#   · 总细胞数被清空 → E_DATA_EMPTY，提示放宽阈值。
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

.scrna_threshold <- function(ctx, name) {
  v <- .scrna_param(ctx, name, NULL)
  if (is.null(v)) return(NULL)
  if (is.character(v) && !nzchar(trimws(v))) return(NULL)
  n <- suppressWarnings(as.numeric(v))
  if (length(n) != 1L || is.na(n)) return(NULL)
  n
}

deg_main("scrna/run_scrna_filter.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "data.table", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_qc.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("QC object not found: ", basename(objPath), " (run the QC preview first)"),
             status = 12L)
  }

  minFeature <- .scrna_threshold(ctx, "minFeature")
  minCount <- .scrna_threshold(ctx, "minCount")
  maxMt <- .scrna_threshold(ctx, "maxMt")

  emit_progress("read", 5, "loading QC object")
  obj <- readRDS(objPath)
  md <- obj@meta.data
  cellsBefore <- nrow(md)
  beforeBySample <- table(as.character(md$orig.ident))

  emit_log("info", sprintf("filtering %d cells with minFeature=%s minCount=%s maxMt=%s",
                           cellsBefore,
                           if (is.null(minFeature)) "off" else minFeature,
                           if (is.null(minCount)) "off" else minCount,
                           if (is.null(maxMt)) "off" else maxMt))

  # ---- 组装 keep ----------------------------------------------------------
  # 直接对 meta.data 算逻辑向量，不用 `subset(obj, subset = ...)` 的 NSE 写法：
  # 后者要把条件拼成字符串再 parse，多一层注入风险，也不便于把「某条为 null」表达清楚。
  emit_progress("filter", 25, "applying thresholds")
  keep <- rep(TRUE, cellsBefore)
  usedMt <- !is.null(maxMt)
  if (!is.null(minFeature)) keep <- keep & md$nFeature_RNA > minFeature
  if (!is.null(minCount)) keep <- keep & md$nCount_RNA > minCount
  if (!is.null(maxMt)) {
    if (is.null(md$percent.mt)) {
      # 段 A 没算出 percent.mt（数据里没有线粒体基因）→ mt 过滤无从执行
      usedMt <- FALSE
      emit_log("warn", "maxMt was set but percent.mt is unavailable (no mt genes): mt filter skipped")
    } else {
      # ★ maxMt 是 0–1 的小数（0.2 = 20%），percent.mt 是 0–100 的百分数。
      #   这里漏乘 100 的话，默认 0.2 会把全部细胞滤掉 —— 而且不报错，
      #   用户只会看到「过滤后 0 个细胞」并以为数据有问题。
      keep <- keep & md$percent.mt < maxMt * 100
    }
  }

  # ★ 必须**先**判空再取子集：Seurat 在 0 细胞时自己会抛 "No cells found"，
  #   那个错误没有 code，会被翻译成 E_R_GENERIC —— 用户看到的是「R 运行失败」，
  #   而不是「阈值过严，请放宽」。
  if (sum(keep, na.rm = TRUE) == 0L) {
    deg_stop("E_DATA_EMPTY",
             sprintf("no cell passed the thresholds (minFeature=%s, minCount=%s, maxMt=%s); relax them and preview again",
                     if (is.null(minFeature)) "off" else minFeature,
                     if (is.null(minCount)) "off" else minCount,
                     if (is.null(maxMt)) "off" else maxMt),
             status = 13L)
  }
  obj2 <- obj[, keep]
  cellsAfter <- ncol(obj2)
  if (cellsAfter == 0L) {
    deg_stop("E_DATA_EMPTY",
             sprintf("no cell passed the thresholds (minFeature=%s, minCount=%s, maxMt=%s); relax them and preview again",
                     if (is.null(minFeature)) "off" else minFeature,
                     if (is.null(minCount)) "off" else minCount,
                     if (is.null(maxMt)) "off" else maxMt),
             status = 13L)
  }

  afterBySample <- table(as.character(obj2$orig.ident))
  allSamples <- names(beforeBySample)
  emptySamples <- allSamples[!(allSamples %in% names(afterBySample))]
  if (length(emptySamples) > 0) {
    emit_log("warn", sprintf(
      "these sample(s) lost ALL cells and are dropped from the object: %s",
      paste(emptySamples, collapse = ", ")))
  }
  emit_log("info", sprintf("kept %d / %d cells (%.1f%% removed)",
                           cellsAfter, cellsBefore, 100 * (cellsBefore - cellsAfter) / cellsBefore))

  # ---- 前后对比图 ---------------------------------------------------------
  emit_progress("plot", 55, "before/after")
  plotted <- tryCatch({
    deg_ensure_pkgs("ggplot2")
    df <- do.call(rbind, lapply(allSamples, function(s) {
      data.frame(
        sample = s,
        stage = c("before", "after"),
        cells = c(as.integer(beforeBySample[[s]]),
                  if (s %in% names(afterBySample)) as.integer(afterBySample[[s]]) else 0L)
      )
    }))
    df$sample <- factor(df$sample, levels = allSamples)
    df$stage <- factor(df$stage, levels = c("before", "after"))
    p <- ggplot2::ggplot(df, ggplot2::aes(x = sample, y = cells, fill = stage)) +
      ggplot2::geom_col(position = ggplot2::position_dodge(width = 0.75), width = 0.68) +
      ggplot2::scale_fill_manual(values = c(before = "#c9d6d8", after = "#46bac2"),
                                 labels = c("before", "after")) +
      ggplot2::labs(x = NULL, y = "Cells", fill = NULL,
                    title = sprintf("Cells before / after filtering (%d -> %d)",
                                    cellsBefore, cellsAfter)) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(
        panel.grid.minor = ggplot2::element_blank(),
        legend.position = "top",
        axis.text.x = ggplot2::element_text(angle = if (length(allSamples) > 3) 35 else 0,
                                            hjust = if (length(allSamples) > 3) 1 else 0.5)
      )
    # PNG + PDF（投稿矢量），统一走公共函数
    deg_save_ggplot(p, file.path(ctx$runDir, "p05_filter_before_after.png"),
                    max(5, min(12, 1.1 * length(allSamples) + 2.5)), 3.6, "filter_before_after")
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("before/after plot failed: ", conditionMessage(e)))
    FALSE
  })
  if (isTRUE(plotted)) emit_artifact("plot", "p05_filter_before_after.png")

  # ---- qc_summary.csv -----------------------------------------------------
  emit_progress("write", 80, "writing summary")
  statRow <- function(s) {
    idxB <- as.character(md$orig.ident) == s
    # meta.data 是**槽位**不是列：`obj2$meta.data` 会去找名为 meta.data 的列而报错
    idxA <- as.character(obj2@meta.data$orig.ident) == s
    before <- as.integer(sum(idxB))
    after <- as.integer(sum(idxA))
    list(
      sample = s,
      cells_before = before,
      cells_after = after,
      removed = before - after,
      removed_pct = if (before > 0) round(100 * (before - after) / before, 2) else 0,
      median_feature_before = as.integer(stats::median(md$nFeature_RNA[idxB])),
      median_feature_after = if (after > 0) as.integer(stats::median(obj2$nFeature_RNA[idxA])) else NA_integer_,
      median_count_before = as.integer(stats::median(md$nCount_RNA[idxB])),
      median_count_after = if (after > 0) as.integer(stats::median(obj2$nCount_RNA[idxA])) else NA_integer_,
      median_mt_before = if (is.null(md$percent.mt)) NA_real_ else round(stats::median(md$percent.mt[idxB]), 2),
      median_mt_after = if (is.null(obj2@meta.data$percent.mt) || after == 0) NA_real_ else round(stats::median(obj2@meta.data$percent.mt[idxA]), 2)
    )
  }
  rows <- lapply(allSamples, statRow)
  stats <- do.call(rbind.data.frame, c(rows, stringsAsFactors = FALSE))
  data.table::fwrite(stats, file.path(ctx$runDir, "qc_summary.csv"))
  emit_artifact("table", "qc_summary.csv", rows = nrow(stats), schema = "ScrnaFilterSampleStat[]")

  # ---- 保存对象 -----------------------------------------------------------
  emit_progress("write", 92, "saving obj_step2.rds")
  saveRDS(obj2, file.path(ctx$runDir, "obj_step2.rds"))
  emit_artifact("scrna_object", "obj_step2.rds")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  perSample <- unname(lapply(allSamples, function(s) list(
    sample = s,
    before = as.integer(beforeBySample[[s]]),
    after = if (s %in% names(afterBySample)) as.integer(afterBySample[[s]]) else 0L
  )))

  emit_progress("write", 100, "done")
  emit_result(list(
    cellsBefore = as.integer(cellsBefore),
    cellsAfter = as.integer(cellsAfter),
    removed = as.integer(cellsBefore - cellsAfter),
    removedPct = round(100 * (cellsBefore - cellsAfter) / cellsBefore, 2),
    perSample = perSample,
    nSamplesAfter = as.integer(length(afterBySample)),
    emptySamples = unname(as.character(emptySamples)),
    minFeature = if (is.null(minFeature)) NULL else minFeature,
    minCount = if (is.null(minCount)) NULL else minCount,
    maxMt = if (is.null(maxMt)) NULL else maxMt,
    mtFilterApplied = usedMt,
    plots = if (isTRUE(plotted)) list(list(id = "beforeAfter", file = "p05_filter_before_after.png")) else list(),
    summaryFile = "qc_summary.csv",
    objectFile = "obj_step2.rds",
    durationMs = as.integer(durationMs)
  ))
})
