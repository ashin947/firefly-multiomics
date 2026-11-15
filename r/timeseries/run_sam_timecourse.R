# =============================================================================
# r/timeseries/run_sam_timecourse.R —— 单序列时序分析（SAM, One class timecourse）
#
# ============================================================================
# ★ 本文件最关键的一件事：**不要调用 `samr::SAM()`**
# ============================================================================
#
# 用 `SAM(data, resp.type = "One class timecourse")` 会**必崩**（与数据无关，
# 模拟数据同样复现）：
#
#   Error in 1:nres : argument of length 0
#   或
#   Error in y[rang[1]:rang[2]] : 参数长度为零
#
# 原因在 samr 包内部：`SAM()` 对 "One class timecourse" 分支里把
# `rang = 4:8` 写死了（见 samr 源码 SAM.R 里 `if(resp.type == "One class timecourse")`
# 那段），而时序的 `samr.compute.siggenes.table()` 结果表只有 **7 列**
# （Row / Gene ID / Gene Name / Score(d) / Numerator(r) / Denominator(s+s0) / q-value(%)），
# 4:8 越界直接取到 NULL。
#
# 正确做法是**只用内核，不要用 SAM() 这层壳**：
#
#   data <- list(x = x, y = y, geneid = ..., genenames = ..., logged2 = TRUE,
#                eigengene.number = 1)
#   obj <- samr::samr(data, resp.type = "One class timecourse", ...)   # 计算
#   dt  <- samr::samr.compute.delta.table(obj)                          # delta-FDR
#   sg  <- samr::samr.compute.siggenes.table(obj, 0, data, dt, all.genes = TRUE)
#
# 这样既绕开坏掉的排序/阈值那层，又拿到**逐基因** q-value。
#
# ★ `del = 0` 与 `all.genes = TRUE` 都不能省：
#   客户要求「逐基因 q ≤ 5%」，不是「整组 median FDR ≤ 5%」。后者是 SAM 的
#   默认口径（delta 阈值下整组 FDR），两者的基因数能差好几倍。
#   `all.genes = TRUE` 保证每个基因都出一行、且带自己的 q-value，
#   之后再由我们按 q 与 |d| 过滤 —— 阈值改起来也不用重跑置换。
#
# ★ samr 会往 stderr 刷 `cat(i)` 进度（每次置换一行），200 次就是一屏。
#   这里用 `sink(type = "message")` 吞掉，避免把界面日志刷成滚屏。
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

deg_main("timeseries/run_sam_timecourse.R", function(ctx) {
  deg_ensure_pkgs(c("samr", "jsonlite"))
  startedAt <- Sys.time()

  matrixFile <- as.character(.ts_param(ctx, "matrixFile", ""))
  samples <- .ts_param(ctx, "samples", NULL)
  useLog2 <- isTRUE(.ts_param(ctx, "log2", TRUE))
  minSamplesExpr <- as.integer(.ts_param(ctx, "minSamplesExpr", 3L))
  nperm <- as.integer(.ts_param(ctx, "nperm", 200L))
  fdrPct <- as.numeric(.ts_param(ctx, "fdr", 0.05)) * 100
  absD <- as.numeric(.ts_param(ctx, "absD", 2))
  seed <- as.integer(.ts_param(ctx, "seed", 1L))

  if (is.null(samples) || length(samples) == 0) {
    deg_stop("E_VALIDATION", "no sample metadata given (parse the header first)", status = 11L)
  }

  # ---- 1. 读矩阵 ----------------------------------------------------------
  emit_progress("read", 5, "reading matrix")
  read <- .ts_read_matrix(matrixFile)
  x <- read$matrix
  emit_log("info", sprintf("matrix: %d genes x %d samples (encoding %s)",
                           nrow(x), ncol(x), read$encoding))

  # ---- 2. 样本设计（时间索引 + 重复序列 + SAM 的 y）-----------------------
  design <- .ts_build_design(samples, colnames(x))
  meta <- design$meta
  x <- x[, meta$name, drop = FALSE]
  emit_log("info", sprintf("design: %d samples, %d time points (%s), %d replicate series",
                           nrow(meta), length(design$times),
                           paste(design$times, collapse = ","), design$nSeries))
  emit_log("info", paste0("y = ", paste(utils::head(design$y, 10), collapse = ", "),
                          if (length(design$y) > 10) ", ..." else ""))

  # ---- 3. 过滤 + log ------------------------------------------------------
  emit_progress("filter", 20, "filtering low-expression genes")
  keep <- rowSums(x > 1) >= minSamplesExpr
  nGenesBefore <- nrow(x)
  x <- x[keep, , drop = FALSE]
  if (nrow(x) < 10) {
    deg_stop("E_DATA_EMPTY", paste0(
      "only ", nrow(x), " of ", nGenesBefore, " genes have >1 expression in at least ",
      minSamplesExpr, " samples. Lower minSamplesExpr or check the matrix scale."), status = 14L)
  }
  emit_log("info", sprintf("gene filter: %d -> %d (need >1 in >=%d samples)",
                           nGenesBefore, nrow(x), minSamplesExpr))
  if (useLog2) {
    x <- log2(x + 0.01)
    emit_log("info", "values log2(x + 0.01) transformed")
  } else {
    emit_log("info", "log2 skipped (values treated as already logged)")
  }

  # ---- 4. SAM 内核 --------------------------------------------------------
  emit_progress("sam", 40, sprintf("SAM core (%d permutations)", nperm))
  samData <- list(
    x = x,
    y = design$y,
    geneid = rownames(x),
    genenames = rownames(x),
    logged2 = TRUE,
    eigengene.number = 1
  )

  # samr 的置换进度写在 stderr（cat(i)），200 次会刷满日志面板 —— 吞掉
  sinkFile <- tempfile()
  con <- file(sinkFile, open = "wt")
  sink(con, type = "message")
  obj <- tryCatch(
    samr::samr(samData, resp.type = "One class timecourse", assay.type = "array",
               nperms = nperm, random.seed = seed),
    error = function(e) {
      sink(type = "message")
      close(con)
      deg_stop("E_R_GENERIC", paste0("samr core failed: ", conditionMessage(e)), status = 1L)
    }
  )
  sink(type = "message")
  close(con)
  unlink(sinkFile)
  emit_log("info", "SAM core finished")

  # ---- 5. delta 表与全基因表 ---------------------------------------------
  emit_progress("collect", 70, "collecting per-gene statistics")
  deltaTable <- tryCatch(samr::samr.compute.delta.table(obj), error = function(e) NULL)
  sig <- samr::samr.compute.siggenes.table(obj, 0, samData, deltaTable, all.genes = TRUE)

  # 结果表 7 列：Row / Gene ID / Gene Name / Score(d) / Numerator(r) / Denominator(s+s0) / q-value(%)
  asDf <- function(m, direction) {
    if (is.null(m) || length(m) == 0 || nrow(as.matrix(m)) == 0) {
      return(data.frame(gene = character(0), direction = character(0), d = numeric(0),
                        numerator = numeric(0), denominator = numeric(0), q = numeric(0),
                        stringsAsFactors = FALSE))
    }
    m <- as.matrix(m)
    if (ncol(m) < 7) {
      deg_stop("E_RESULT_INVALID", paste0(
        "unexpected samr table shape: ", ncol(m), " columns (expected 7). ",
        "Did samr change its output format?"), status = 13L)
    }
    data.frame(
      gene = as.character(m[, 2]),
      direction = direction,
      d = suppressWarnings(as.numeric(m[, 4])),
      numerator = suppressWarnings(as.numeric(m[, 5])),
      denominator = suppressWarnings(as.numeric(m[, 6])),
      q = suppressWarnings(as.numeric(m[, 7])),
      stringsAsFactors = FALSE
    )
  }
  allTbl <- rbind(asDf(sig$genes.up, "up"), asDf(sig$genes.lo, "down"))
  allTbl <- allTbl[!is.na(allTbl$d), , drop = FALSE]
  # 以 d 的正负重判方向：samr 的 up/lo 是按符号分的，但外部表的排序可能不稳
  allTbl$direction <- ifelse(allTbl$d >= 0, "up", "down")
  allTbl <- allTbl[order(-abs(allTbl$d)), , drop = FALSE]

  sigTbl <- allTbl[abs(allTbl$d) >= absD & !is.na(allTbl$q) & allTbl$q <= fdrPct, , drop = FALSE]
  nUp <- sum(sigTbl$direction == "up")
  nDown <- sum(sigTbl$direction == "down")
  emit_log("info", sprintf(
    "at |Score(d)| >= %s and q <= %s%%: %d genes (%d up / %d down) out of %d tested",
    absD, fdrPct, nrow(sigTbl), nUp, nDown, nrow(allTbl)))

  # ---- 6. 落盘 ------------------------------------------------------------
  emit_progress("write", 90, "writing tables")
  outAll <- data.frame(
    gene = allTbl$gene,
    direction = allTbl$direction,
    score_d = round(allTbl$d, 4),
    q_value = allTbl$q,
    numerator_r = round(allTbl$numerator, 4),
    denominator_s_s0 = round(allTbl$denominator, 4),
    stringsAsFactors = FALSE
  )
  utils::write.csv(outAll, file.path(ctx$runDir, "sam_all.csv"), row.names = FALSE, quote = FALSE)
  # quote = FALSE：客户会直接拿 csv 去 Excel / 自己的脚本，加引号只会碍事
  utils::write.csv(outAll[abs(outAll$score_d) >= absD & outAll$q_value <= fdrPct, , drop = FALSE],
                   file.path(ctx$runDir, "sam_sig.csv"), row.names = FALSE, quote = FALSE)

  if (!is.null(deltaTable) && nrow(deltaTable) > 0) {
    utils::write.csv(deltaTable, file.path(ctx$runDir, "delta_table.csv"), row.names = FALSE, quote = FALSE)
  }
  emit_artifact("table", "sam_all.csv", rows = nrow(outAll), schema = "TimeSeriesRow[]")
  emit_artifact("table", "sam_sig.csv", rows = nrow(sigTbl), schema = "TimeSeriesRow[]")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    matrixFile = basename(matrixFile),
    encoding = read$encoding,
    nGenesInput = as.integer(nGenesBefore),
    nGenes = as.integer(nrow(outAll)),
    nSig = as.integer(nrow(sigTbl)),
    nUp = as.integer(nUp),
    nDown = as.integer(nDown),
    times = unname(design$times),
    nSamples = as.integer(nrow(meta)),
    nSeries = as.integer(design$nSeries),
    log2 = useLog2,
    minSamplesExpr = minSamplesExpr,
    nperm = nperm,
    fdr = fdrPct / 100,
    absD = absD,
    dRange = unname(round(range(allTbl$d), 3)),
    qRange = unname(round(range(allTbl$q, na.rm = TRUE), 3)),
    durationMs = as.integer(durationMs)
  ))
})
