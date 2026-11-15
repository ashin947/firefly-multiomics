# =============================================================================
# r/wgcna/run_wgcna_prepare.R —— WGCNA 第一段：读矩阵 + 质控 + 软阈值
#
# 为什么拆成两段（prepare → network）：
#   WGCNA 的软阈值 β 不是随便选的 —— 它是让网络接近「无标度拓扑」的那个幂次。
#   客户实验室的流程就是先跑 pickSoftThreshold、看 R² 曲线、人工点头之后才建网络。
#   更实际的原因：第二段（TOM + 层次聚类）在上万基因时很慢，而 TOM 与模块粒度
#   参数无关，拆开之后用户改 minModuleSize 不用重算 TOM。
#
# 与客户原始脚本（docs/reference/wgcna-reference.R）的差异：
#   1. 不 setwd、不 sizeGrWindow、不 load("sft.RData") —— 全部参数化 + 相对 runDir；
#   2. 客户脚本对已经是 logCPM 的数据又做了一次 log2(x+1)（重复取对数），
#      这里 transform="auto" 按数值范围判断，已是 log 尺度就跳过，并写进日志；
#   3. 中间态用 saveRDS(stage1.rds)，不用 .RData/load()，避免变量名撞车；
#   4. 每张图独立 tryCatch —— 一张图画失败不能让整次分析白跑。
#
# 出图约定：图内文字一律英文（标题/轴标签/图例），中文只出现在返回给界面的
# caption 里。这样彻底绕开 Windows 的字体注册问题（与 run_gsea.R 的 skipFonts 一致）。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

#' 参数读取：把 JSON 里的 null / 空数组统一折叠成默认值
.wgcna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 读表达矩阵（行=基因，列=样本，第一列基因 ID）
#'
#' 为什么不用 deg_read_matrix：那个函数把「文件不存在」映射成 E_DATA_EMPTY，
#' 而 WGCNA 这里要求明确区分「文件根本没找到」(E_DATA_MISSING) 与
#' 「文件在但内容不可用」(E_DATA_INVALID)。
.wgcna_read_matrix <- function(path) {
  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_MISSING", paste0("expression matrix file not found: ", path), status = 12L)
  }
  # 分隔符按扩展名猜：.csv 用逗号，其余按 Tab（客户数据都是 .tsv/.txt）
  sep <- if (grepl("\\.csv$", path, ignore.case = TRUE)) "," else "\t"
  deg_ensure_pkgs("data.table")
  df <- tryCatch(
    data.table::fread(path, data.table = FALSE, check.names = FALSE,
                      sep = sep, quote = "", encoding = "UTF-8"),
    error = function(e) NULL
  )
  if (is.null(df) || nrow(df) < 2 || ncol(df) < 2) {
    deg_stop("E_DATA_INVALID",
             paste0("cannot parse expression matrix (need >= 2 rows and >= 2 columns): ",
                    basename(path)),
             status = 13L)
  }
  df
}

#' 把除第一列之外的列转成数值矩阵
#'
#' ★ 必须显式 matrix(as.numeric(...)) 再检查 NA 比例。
#'   如果某一列混进了字符（比如基因名误入样本列），as.numeric 会把它整列
#'   静默变成 NA —— 不检查的话后面 max()/var() 全是 NA，报错位置离真正原因很远。
.wgcna_to_numeric <- function(df, path) {
  mat <- as.matrix(df[, -1, drop = FALSE])
  num <- suppressWarnings(matrix(as.numeric(mat), nrow = nrow(mat), ncol = ncol(mat),
                                 dimnames = dimnames(mat)))
  naFrac <- if (length(num) == 0) 1 else mean(!is.finite(num))
  if (!is.finite(naFrac) || naFrac > 0.2) {
    deg_stop("E_DATA_INVALID",
             sprintf(paste0("expression matrix is not numeric: %.1f%% of values cannot be ",
                            "parsed as numbers (columns must be samples, first column gene ids)"),
                     naFrac * 100),
             detail = basename(path), status = 13L)
  }
  num
}

#' 读性状表：第一列样本名，其余列性状（数值）
#' @param known 表达矩阵里的样本名（用来判断这张表是不是转置的）
#' @return list(df = data.frame(rownames 为样本名), samples = 字符向量)
.wgcna_read_traits <- function(path, known = character(0)) {
  sep <- if (grepl("\\.csv$", path, ignore.case = TRUE)) "," else "\t"
  deg_ensure_pkgs("data.table")
  raw <- tryCatch(
    data.table::fread(path, data.table = FALSE, check.names = FALSE,
                      sep = sep, quote = "", encoding = "UTF-8"),
    error = function(e) NULL
  )
  if (is.null(raw) || nrow(raw) < 1 || ncol(raw) < 2) {
    deg_stop("E_DATA_INVALID",
             paste0("cannot parse trait table (need a sample column + >= 1 trait column): ",
                    basename(path)),
             status = 13L)
  }
  names(raw) <- trimws(names(raw))

  # 转置的性状表（行=性状、列=样本）。
  # 客户口头描述的 time.txt 就是「行名是基因/性状、列是样本」这种方向，
  # 而 WGCNA 的 cor(MEs, datTraits) 要求行=样本，方向错了整张相关图都是空的。
  # 判据用「表头里的样本名命中率 vs 第一列的命中率」—— 比看维度稳，
  # 也不会把「第一列恰好是 0/1」的宽表误判（那种表头不会命中样本名）。
  if (length(known) > 0) {
    headHit <- mean(names(raw)[-1] %in% known)
    cellHit <- mean(trimws(as.character(raw[[1]])) %in% known)
    if (headHit > 0.5 && headHit > cellHit) {
      emit_log("info", sprintf(
        "trait table looks transposed (%d%% of its column headers are sample names); transposing so that rows are samples",
        round(headHit * 100)))
      mat <- as.data.frame(t(as.matrix(raw[, -1, drop = FALSE])), stringsAsFactors = FALSE)
      names(mat) <- trimws(as.character(raw[[1]]))
      mat <- cbind(sample = names(raw)[-1], mat)
      names(mat)[1] <- "sample"
      raw <- mat
      names(raw) <- trimws(names(raw))
      rownames(raw) <- NULL
    }
  }

  # 第一列是不是样本 ID：列名像 id/sample，或者取值里有非数值内容
  first <- trimws(as.character(raw[[1]]))
  looksId <- grepl("^(sample|sample_?id|id|name)$", names(raw)[1], ignore.case = TRUE) ||
    any(is.na(suppressWarnings(as.numeric(first))))
  if (!looksId) {
    deg_stop("E_DATA_INVALID",
             paste0("trait table has no sample id column: the first column must contain sample names"),
             detail = basename(path), status = 13L)
  }

  traitDf <- raw[, -1, drop = FALSE]
  traitDf <- as.data.frame(
    lapply(traitDf, function(x) suppressWarnings(as.numeric(x))),
    check.names = FALSE
  )
  names(traitDf) <- trimws(names(raw)[-1])
  rownames(traitDf) <- first

  # 同一列全不可解析 → 直接剔掉（否则 cor 会整列 NA，用户看不懂为什么）
  usable <- vapply(traitDf, function(x) any(is.finite(x)), logical(1))
  if (!all(usable)) {
    emit_log("warn", sprintf("trait column(s) dropped (all values non-numeric / missing): %s",
                             paste(names(traitDf)[!usable], collapse = ", ")))
    traitDf <- traitDf[, usable, drop = FALSE]
  }
  if (ncol(traitDf) == 0) {
    deg_stop("E_DATA_INVALID", "no usable numeric trait column in trait table", status = 13L)
  }

  # 样本级缺失：整行删掉（客户脚本也是 na.omit(traitData)），并把删了多少写进日志
  okRows <- stats::complete.cases(traitDf)
  if (!all(okRows)) {
    emit_log("warn", sprintf("%d trait row(s) with missing values were dropped",
                             sum(!okRows)))
    traitDf <- traitDf[okRows, , drop = FALSE]
  }
  list(df = traitDf, samples = trimws(rownames(traitDf)))
}

#' 保存一张诊断图（同时出 PNG 与矢量 PDF）；失败只 warn、返回 NULL，不中断分析
#'
#' ## 为什么同一张图要画两遍
#'
#' 客户要的是**投稿能用的 PDF**。把已经生成好的 png 塞进 pdf 容器也能得到
#' 一个 .pdf 文件，但那是位图，放到 A4 上就是马赛克 —— 等于白做。
#' 唯一正确的做法是用 `grDevices::pdf()` 这个**矢量设备**把同一段绘图代码
#' 再执行一次。所以这里两个设备各跑一遍 drawer()：
#'   · png 给界面预览（200 dpi 位图，加载快、体积可控）
#'   · pdf 给导出（矢量，论文排版随便缩放）
#' 多花的只是绘图时间（矢量输出比 200 dpi 栅格化还快），换来的是导出时
#' 不用重跑整个分析 —— 那才是真的贵（上万基因要重算 TOM）。
#'
#' @param drawer 接收 file 路径、内部自己调绘图函数的闭包
#' @return list(id,title,caption,file,pdf) 或 NULL
.wgcna_draw <- function(ctx, id, title, caption, file, width, height, drawer) {
  path <- file.path(ctx$runDir, file)
  opened <- FALSE
  ok <- tryCatch({
    grDevices::png(path, width = width, height = height, units = "in", res = 200)
    opened <- TRUE
    drawer()
    TRUE
  }, error = function(e) {
    emit_log("warn", sprintf("plot '%s' failed and was skipped: %s", id, conditionMessage(e)))
    FALSE
  }, finally = {
    if (opened) try(grDevices::dev.off(), silent = TRUE)
  })
  if (!isTRUE(ok) || !file.exists(path) || isTRUE(file.info(path)$size < 1024)) {
    if (isTRUE(ok)) emit_log("warn", sprintf("plot '%s' produced an empty file and was skipped", id))
    if (file.exists(path)) try(unlink(path), silent = TRUE)
    return(NULL)
  }

  # ---- 矢量 PDF：同一段抽屉代码，换个设备再来一遍 ----
  # useDingbats = FALSE：默认的 Dingbats 会把 • 之类的字符编成符号字体，
  # 在投稿系统/部分预览器里常表现为乱码方框；关掉后走标准字体，跨设备一致。
  pdfFile <- sub("\\.png$", ".pdf", file, ignore.case = TRUE)
  pdfPath <- file.path(ctx$runDir, pdfFile)
  pdfOk <- tryCatch({
    grDevices::pdf(pdfPath, width = width, height = height, onefile = FALSE,
                   useDingbats = FALSE, bg = "white")
    drawer()
    TRUE
  }, error = function(e) {
    emit_log("warn", sprintf("vector PDF for '%s' failed (PNG is still available): %s",
                             id, conditionMessage(e)))
    FALSE
  }, finally = {
    # dev.cur() > 1 才关：pdf 设备没开成功时乱关会把别的设备关掉
    if (grDevices::dev.cur() > 1L) try(grDevices::dev.off(), silent = TRUE)
  })
  if (!isTRUE(pdfOk) || !file.exists(pdfPath) || isTRUE(file.info(pdfPath)$size < 1024)) {
    if (file.exists(pdfPath)) try(unlink(pdfPath), silent = TRUE)
    pdfFile <- NULL
  }

  list(id = id, title = title, caption = caption, file = file, pdf = pdfFile)
}

deg_main("wgcna/run_wgcna_prepare.R", function(ctx) {
  startedAt <- Sys.time()
  deg_ensure_pkgs(c("WGCNA", "limma", "data.table", "jsonlite"))

  matrixPath <- as.character(.wgcna_param(ctx, "matrixPath", ""))
  traitPath <- as.character(.wgcna_param(ctx, "traitPath", ""))
  varianceFilter <- as.character(.wgcna_param(ctx, "varianceFilter", "top50"))
  transform <- as.character(.wgcna_param(ctx, "transform", "auto"))
  minSamples <- as.integer(.wgcna_param(ctx, "minSamples", 8))
  wgcnaId <- as.character(.wgcna_param(ctx, "wgcnaId", ""))

  cutRaw <- deg_param(ctx, "sampleCutHeight", NULL)
  sampleCutHeight <- if (is.null(cutRaw) || length(cutRaw) == 0) NULL else {
    suppressWarnings(as.numeric(cutRaw)[1])
  }
  if (!is.null(sampleCutHeight) && !is.finite(sampleCutHeight)) sampleCutHeight <- NULL

  if (!nzchar(matrixPath)) {
    deg_stop("E_VALIDATION", "matrixPath is required", status = 11L)
  }
  # 相对路径按 projectRoot 解释（主进程一般直接给绝对路径）
  matrixPath <- deg_abs_path(ctx, matrixPath)
  if (nzchar(traitPath)) traitPath <- deg_abs_path(ctx, traitPath)
  deg_assert_in(varianceFilter, c("top25", "top50", "all"), "varianceFilter")
  deg_assert_in(transform, c("auto", "log2", "none"), "transform")
  if (is.na(minSamples) || minSamples < 3) minSamples <- 3L

  # WGCNA 的多线程开关：nThreads 必须 >= 2，否则 enableWGCNAThreads 直接报错；
  # 单核机器上退回 allowWGCNAThreads()，再不行就静默串行（不影响正确性）。
  tryCatch({
    nCores <- parallel::detectCores()
    if (!is.na(nCores) && nCores >= 2) {
      WGCNA::enableWGCNAThreads(nThreads = min(nCores, 8L))
    } else {
      WGCNA::allowWGCNAThreads()
    }
  }, error = function(e) {
    try(WGCNA::allowWGCNAThreads(), silent = TRUE)
    emit_log("warn", paste0("WGCNA threading disabled: ", conditionMessage(e)))
  })

  # ---- 1. 读矩阵 --------------------------------------------------------
  emit_progress("read", 5, "reading expression matrix")
  df <- .wgcna_read_matrix(matrixPath)
  ids <- trimws(as.character(df[[1]]))
  colNames <- trimws(names(df)[-1])
  num <- .wgcna_to_numeric(df, matrixPath)
  emit_log("info", sprintf("matrix loaded: %d rows x %d columns (first column treated as gene ids)",
                           nrow(num), ncol(num)))

  # ---- 2. 方向判定 ------------------------------------------------------
  # 两种来源：标准「行=基因」（客户 count.gene.TMM.logCPM.tsv）与
  # 转置过的「行=样本」（GEO / 部分公司交付表）。判错方向会让后面全崩，
  # 所以给了性状表时优先用「第一列取值能否匹配性状表样本名」来判 —— 这是
  # 最可靠的证据，比行列数启发式稳。
  traits <- NULL
  traitSampleNames <- character(0)
  if (nzchar(traitPath)) {
    if (!file.exists(traitPath)) {
      deg_stop("E_DATA_MISSING", paste0("trait file not found: ", traitPath), status = 12L)
    }
    # 把矩阵里出现过的所有样本名（行名候选 + 列名候选）都传进去，
    # 性状表方向判错时靠它救回来
    traitInfo <- .wgcna_read_traits(traitPath, known = unique(c(ids, colNames)))
    traits <- traitInfo$df
    traitSampleNames <- traitInfo$samples
    emit_log("info", sprintf("trait table loaded: %d samples x %d traits (%s)",
                             nrow(traits), ncol(traits), paste(names(traits), collapse = ", ")))
  }

  needTranspose <- FALSE
  if (length(traitSampleNames) > 0) {
    idHit <- mean(ids %in% traitSampleNames)
    colHit <- mean(colNames %in% traitSampleNames)
    if (idHit > colHit && idHit > 0) {
      needTranspose <- TRUE
      emit_log("info", sprintf(paste0("matrix looks transposed (row labels match %.0f%% of trait ",
                                      "samples), transposing genes/samples"), idHit * 100))
    }
  } else if (ncol(num) > nrow(num) && nrow(num) <= 200) {
    # 无性状表时的启发式：列比行多、且行数很少（<200），几乎只可能是样本在行
    needTranspose <- TRUE
    emit_log("info", "matrix has more columns than rows and few rows; assuming samples are rows and transposing")
  }

  if (needTranspose) {
    num <- t(num)
    genes <- colNames
    samples <- ids
  } else {
    genes <- ids
    samples <- colNames
  }
  rownames(num) <- genes
  colnames(num) <- samples

  # ---- 3. 同名基因合并 + 去全零 -----------------------------------------
  emit_progress("filter", 15, "merging duplicate genes")
  if (anyDuplicated(genes) > 0) {
    num <- limma::avereps(num)
    emit_log("info", sprintf("avereps merged duplicate gene ids: %d -> %d rows",
                             length(genes), nrow(num)))
  }
  keepNonZero <- is.finite(rowMeans(num, na.rm = TRUE)) & rowMeans(num, na.rm = TRUE) > 0
  if (!all(keepNonZero)) {
    emit_log("info", sprintf("removed %d gene(s) whose mean expression is zero or not finite",
                             sum(!keepNonZero)))
    num <- num[keepNonZero, , drop = FALSE]
  }
  # 个别 NA 留在矩阵里会让 goodSamplesGenes / pickSoftThreshold 直接失败，
  # 提前剔掉含 NA 的基因比让用户看一个 "missing value where TRUE/FALSE needed" 强
  finiteRows <- apply(num, 1, function(r) all(is.finite(r)))
  if (!all(finiteRows)) {
    emit_log("warn", sprintf("removed %d gene(s) containing NA / Inf", sum(!finiteRows)))
    num <- num[finiteRows, , drop = FALSE]
  }
  nGenesInput <- nrow(num)
  if (nGenesInput < 30) {
    deg_stop("E_DATA_EMPTY",
             sprintf("only %d genes remain after merging/filtering; WGCNA needs at least a few hundred",
                     nGenesInput),
             status = 13L)
  }
  emit_log("info", sprintf("gene matrix ready: %d genes x %d samples", nrow(num), ncol(num)))

  # ---- 4. 性状与样本取交集 ----------------------------------------------
  unmatchedSamples <- 0L
  datTraits <- NULL
  if (!is.null(traits)) {
    traitLookup <- trimws(rownames(traits))
    keepSample <- samples %in% traitLookup
    unmatchedSamples <- sum(!keepSample)
    if (unmatchedSamples > 0) {
      emit_log("warn", sprintf("%d sample(s) in the matrix have no matching row in the trait table and were dropped: %s",
                               unmatchedSamples,
                               paste(utils::head(samples[!keepSample], 10), collapse = ", ")))
    }
    if (sum(keepSample) < minSamples) {
      deg_stop("E_DATA_SAMPLE_MISMATCH",
               sprintf("only %d sample(s) match between matrix and trait table; need >= %d",
                       sum(keepSample), minSamples),
               status = 13L)
    }
    samples <- samples[keepSample]
    num <- num[, keepSample, drop = FALSE]
    datTraits <- traits[match(samples, traitLookup), , drop = FALSE]
    rownames(datTraits) <- samples
  }

  if (ncol(num) < minSamples) {
    deg_stop("E_DATA_SAMPLE_MISMATCH",
             sprintf("only %d samples available; WGCNA needs at least %d", ncol(num), minSamples),
             status = 13L)
  }

  # ---- 5. 数值变换 ------------------------------------------------------
  emit_progress("normalize", 30, "transforming expression values")
  maxVal <- suppressWarnings(max(as.numeric(num), na.rm = TRUE))
  transformUsed <- "none"
  if (identical(transform, "log2")) {
    num <- log2(num + 1)
    transformUsed <- "log2"
    emit_log("info", "transform=log2: applied log2(x + 1)")
  } else if (identical(transform, "auto")) {
    if (is.finite(maxVal) && maxVal > 50) {
      num <- log2(num + 1)
      transformUsed <- "log2"
      emit_log("info", sprintf("transform=auto: max value %.1f > 50, looks like raw counts/TPM -> applied log2(x + 1)",
                               maxVal))
    } else {
      transformUsed <- "none"
      emit_log("info", sprintf(paste0("transform=auto: max value %.1f <= 50, input already looks log-scaled; ",
                                      "skipped log2 (the original customer script would log it twice - this one does not)"),
                               maxVal))
    }
  } else {
    emit_log("info", "transform=none: values used as-is")
  }

  # ---- 6. 方差过滤 ------------------------------------------------------
  emit_progress("filter", 40, "filtering low-variance genes")
  m.vars <- apply(num, 1, stats::var)
  varianceCutoff <- 0
  if (identical(varianceFilter, "top50")) {
    varianceCutoff <- as.numeric(stats::quantile(m.vars, probs = 0.5, na.rm = TRUE))
  } else if (identical(varianceFilter, "top25")) {
    varianceCutoff <- as.numeric(stats::quantile(m.vars, probs = 0.75, na.rm = TRUE))
  }
  if (varianceCutoff > 0) {
    keepVar <- is.finite(m.vars) & m.vars > varianceCutoff
    expro <- num[keepVar, , drop = FALSE]
    emit_log("info", sprintf("variance filter '%s': kept %d of %d genes (cutoff = %.4g)",
                             varianceFilter, nrow(expro), nrow(num), varianceCutoff))
  } else {
    expro <- num
    emit_log("info", sprintf("variance filter 'all': kept all %d genes", nrow(expro)))
  }
  nGenesUsed <- nrow(expro)
  if (nGenesUsed < 30) {
    deg_stop("E_DATA_EMPTY",
             sprintf(paste0("after variance filtering only %d genes remain, WGCNA needs at least ",
                            "a few hundred; try 'all genes'"), nGenesUsed),
             status = 13L)
  }

  # ---- 7. 转成「行=样本、列=基因」 --------------------------------------
  datExpr <- as.data.frame(t(expro), check.names = FALSE)
  rm(num, expro)

  # ---- 8. goodSamplesGenes 质控 ----------------------------------------
  gsg <- WGCNA::goodSamplesGenes(datExpr, verbose = 0)
  if (!isTRUE(gsg$allOK)) {
    badSamples <- sum(!gsg$goodSamples)
    badGenes <- sum(!gsg$goodGenes)
    emit_log("warn", sprintf("goodSamplesGenes flagged %d sample(s) and %d gene(s); removed",
                             badSamples, badGenes))
    datExpr <- datExpr[gsg$goodSamples, gsg$goodGenes, drop = FALSE]
    if (!is.null(datTraits)) datTraits <- datTraits[gsg$goodSamples, , drop = FALSE]
    nGenesUsed <- ncol(datExpr)
    if (nrow(datExpr) < minSamples) {
      deg_stop("E_DATA_SAMPLE_MISMATCH",
               sprintf("only %d usable samples remain after QC; need >= %d", nrow(datExpr), minSamples),
               status = 13L)
    }
  }

  # ---- 9. 样本聚类树 + 可选剔除离群样本 --------------------------------
  emit_progress("fit", 50, "clustering samples")
  sampleTree <- stats::hclust(stats::dist(datExpr), method = "average")
  nSamplesRemoved <- 0L
  if (!is.null(sampleCutHeight)) {
    clust <- WGCNA::cutreeStatic(sampleTree, cutHeight = sampleCutHeight, minSize = minSamples)
    keepSamples <- clust == 1
    nSamplesRemoved <- sum(!keepSamples)
    emit_log("info", sprintf("sample cut at height %.4g removed %d outlier sample(s), %d kept",
                             sampleCutHeight, nSamplesRemoved, sum(keepSamples)))
    datExpr <- datExpr[keepSamples, , drop = FALSE]
    if (!is.null(datTraits)) datTraits <- datTraits[keepSamples, , drop = FALSE]
    nGenesUsed <- ncol(datExpr)
    if (nrow(datExpr) < minSamples) {
      deg_stop("E_DATA_EMPTY",
               sprintf("only %d samples remain after outlier removal; need >= %d and try a higher cut height",
                       nrow(datExpr), minSamples),
               status = 13L)
    }
    # 注意：p01 仍然画**剔除前**的完整树 —— 那张图的意义就是让用户看见
    # 被剔除的样本离得有多远，画剪完的树反而看不到离群点了。
  }
  nSamples <- nrow(datExpr)
  geneNames <- colnames(datExpr)

  # 上万基因时把内存代价说清楚。
  # TOM 是 n×n 稠密矩阵、8 字节一个数：1 万基因 0.8 GB，2 万基因 3.2 GB，
  # 叠加 adjacency 与 dissTOM 的峰值还能翻倍。客户的真实数据常是「全部基因」，
  # 不提前提示就是跑到一半内存耗尽 —— 界面上另有一条同样的警告，这里补在日志里，
  # 便于事后从运行日志倒查「那次为什么那么慢」。
  if (nGenesUsed > 10000) {
    emit_log("warn", sprintf(
      paste0("%d genes entered the network; the TOM matrix alone needs about %.1f GB of RAM ",
             "and the second stage can take tens of minutes. Consider variance filter 'top25'/'top50' ",
             "if you only need the module structure."),
      nGenesUsed, (nGenesUsed^2 * 8) / 1024^3))
  }

  # ---- 10. 软阈值拟合 ---------------------------------------------------
  emit_progress("fit", 60, "choosing soft threshold")
  powers <- c(1:10, seq(12, 20, 2))
  sft <- tryCatch(
    WGCNA::pickSoftThreshold(datExpr, powerVector = powers, networkType = "signed", verbose = 0),
    error = function(e) {
      deg_stop("E_R_GENERIC", paste0("pickSoftThreshold failed: ", conditionMessage(e)), status = 10L)
    }
  )
  fi <- sft$fitIndices
  if (is.null(fi) || nrow(fi) == 0) {
    deg_stop("E_DATA_EMPTY", "pickSoftThreshold returned no fit indices", status = 13L)
  }
  # 不同 WGCNA 版本 fitIndices 列数不同：1.73 是 7 列
  # (Power, SFT.R.sq, slope, truncated.R.sq, mean.k., median.k., max.k.)，
  # 老版本没有 truncated.R.sq（6 列）。按列数选偏移，避免拿到 truncated.R.sq 当 mean.k。
  kOffset <- if (ncol(fi) >= 7) 4L else 3L
  powerRows <- data.frame(
    power = as.integer(fi[, 1]),
    signedR2 = as.numeric(-sign(fi[, 3]) * fi[, 2]),
    slope = as.numeric(fi[, 3]),
    meanK = as.numeric(fi[, kOffset + 1L]),
    medianK = as.numeric(fi[, kOffset + 2L]),
    maxK = as.numeric(fi[, kOffset + 3L]),
    stringsAsFactors = FALSE
  )
  # 保证不带行号列（data.table::fwrite 天然不写 row.names）
  deg_write_csv(powerRows, file.path(ctx$runDir, "wgcna_powers.csv"))

  hit <- which(powerRows$signedR2 >= 0.85)
  recommendedPower <- if (length(hit) > 0) powerRows$power[hit[1]] else NULL
  if (is.null(recommendedPower)) {
    emit_log("warn", "no power reached signed R^2 >= 0.85; pick the soft threshold manually from the plot")
  } else {
    emit_log("info", sprintf("recommended soft power: %d (first power with signed R^2 >= 0.85)",
                             recommendedPower))
  }

  # ---- 11. 保存中间态 ---------------------------------------------------
  saveRDS(list(
    datExpr = datExpr,
    datTraits = datTraits,
    traits = if (is.null(datTraits)) character(0) else colnames(datTraits),
    geneNames = geneNames,
    transformUsed = transformUsed,
    varianceCutoff = varianceCutoff,
    nGenesUsed = nGenesUsed,
    nGenesInput = nGenesInput,
    nSamples = nSamples,
    params = list(
      matrixPath = matrixPath,
      traitPath = traitPath,
      varianceFilter = varianceFilter,
      transform = transform,
      transformUsed = transformUsed,
      minSamples = minSamples,
      sampleCutHeight = sampleCutHeight,
      varianceCutoff = varianceCutoff,
      wgcnaId = wgcnaId
    )
  ), file.path(ctx$runDir, "stage1.rds"))

  # ---- 12. 出图 ---------------------------------------------------------
  emit_progress("plot", 75, "drawing QC plots")
  plots <- list()

  p1 <- .wgcna_draw(ctx, "sampleTree",
                    "Sample clustering to detect outliers",
                    "样本层次聚类树。看是否存在与其它样本距离明显拉开的离群样本；如有，可回到第一步设置剪切高度把它们剔除后重跑。",
                    "p01_sample_tree.png", 12, 7, function() {
                      graphics::par(mar = c(3.5, 4.2, 3, 1), cex = 0.7)
                      plot(sampleTree, main = "Sample clustering to detect outliers",
                           sub = "", xlab = "", cex.lab = 1.2, cex.axis = 1.2, cex.main = 1.5)
                      if (!is.null(sampleCutHeight)) {
                        graphics::abline(h = sampleCutHeight, col = "red", lty = 2, lwd = 2)
                      }
                    })
  if (!is.null(p1)) plots[[length(plots) + 1L]] <- p1

  p2 <- .wgcna_draw(ctx, "scaleIndependence",
                    "Scale independence",
                    "无标度拓扑拟合指数随软阈值 β 的变化。红线是 R²=0.85 的经验门槛，蓝虚线是系统推荐的 β；通常取第一个越过 0.85 的幂次。",
                    "p02_scale_independence.png", 7, 7, function() {
                      graphics::par(mar = c(4.5, 4.8, 3, 1))
                      x <- powerRows$power
                      y <- powerRows$signedR2
                      plot(x, y, type = "n", xlab = "Soft Threshold (power)",
                           ylab = "Scale Free Topology Model Fit, signed R^2",
                           main = "Scale independence")
                      # 浅色网格：beta 与 R² 的读数全靠肉眼估，有网格才读得准
                      graphics::abline(h = graphics::axTicks(2), v = graphics::axTicks(1),
                                       col = "grey90", lty = 1)
                      graphics::text(x, y, labels = x, cex = 0.85, col = "red")
                      graphics::abline(h = 0.85, col = "red", lty = 2, lwd = 2)
                      if (!is.null(recommendedPower)) {
                        graphics::abline(v = recommendedPower, col = "blue", lty = 3, lwd = 2)
                      }
                    })
  if (!is.null(p2)) plots[[length(plots) + 1L]] <- p2

  p3 <- .wgcna_draw(ctx, "meanConnectivity",
                    "Mean connectivity",
                    "平均连接度随 β 的变化。β 越大连接度越低；结合 R² 曲线选一个既满足无标度、连接度又不至于过低的幂次。",
                    "p03_mean_connectivity.png", 7, 7, function() {
                      graphics::par(mar = c(4.5, 4.8, 3, 1))
                      x <- powerRows$power
                      y <- powerRows$meanK
                      plot(x, y, type = "n", xlab = "Soft Threshold (power)",
                           ylab = "Mean Connectivity", main = "Mean connectivity")
                      graphics::abline(h = graphics::axTicks(2), v = graphics::axTicks(1),
                                       col = "grey90", lty = 1)
                      graphics::text(x, y, labels = x, cex = 0.85, col = "red")
                    })
  if (!is.null(p3)) plots[[length(plots) + 1L]] <- p3

  # ---- 13. 返回 ---------------------------------------------------------
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    wgcnaId = wgcnaId,
    runDir = ctx$runDir,
    nGenesInput = as.integer(nGenesInput),
    nGenesUsed = as.integer(nGenesUsed),
    nSamples = as.integer(nSamples),
    nSamplesRemoved = as.integer(nSamplesRemoved),
    transformUsed = transformUsed,
    varianceCutoff = as.numeric(varianceCutoff),
    # ★ as.list：jsonlite(auto_unbox=TRUE) 会把长度 1 的字符向量塌成标量，
    #   前端调用 .join 会崩页。显式转 list 保证永远是 JSON 数组。
    traits = as.list(if (is.null(datTraits)) character(0) else colnames(datTraits)),
    unmatchedSamples = as.integer(unmatchedSamples),
    powers = unname(lapply(seq_len(nrow(powerRows)), function(i) {
      list(
        power = as.integer(powerRows$power[i]),
        signedR2 = as.numeric(powerRows$signedR2[i]),
        slope = as.numeric(powerRows$slope[i]),
        meanK = as.numeric(powerRows$meanK[i]),
        medianK = as.numeric(powerRows$medianK[i]),
        maxK = as.numeric(powerRows$maxK[i])
      )
    })),
    recommendedPower = if (is.null(recommendedPower)) NULL else as.integer(recommendedPower),
    plots = unname(plots),
    durationMs = as.integer(durationMs)
  ))
})
