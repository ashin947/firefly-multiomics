# =============================================================================
# r/scrna/run_scrna_import.R —— 单细胞流程第 1 步：数据导入与对象构建
#
# 这一步只做「把 10x 矩阵读进来、合并成一个 Seurat 对象、把家底报给用户」。
# 质控/标准化/聚类等后续步骤由后面的脚本接着做，**不要**在这里顺手加过滤，
# 否则第 2 步的质控阈值就没有原始分布可看了。
#
# ## 为什么同时兼容 CellRanger v2 与 v3
#
# 客户这批数据（GSE313726）是 **v2 风格**：目录里是 `genes.tsv.gz` 而不是
# `features.tsv.gz`。两种在磁盘上只差一个文件名，但 Seurat 的 `Read10X()`
# 对两者都能自动识别 —— 前提是别自己去拼路径。所以这里**只探测、不拼**：
# 找到哪种就把整个目录交给 Read10X，让它自己决定。
#
# ## 为什么 min.cells / min.features 写死
#
# 客户明确指定 `min.cells = 3`、`min.features = 100`，并且要求「不要做成可调」。
# 这不是我们能替客户拍的参数：它决定了下游所有细胞数，改一次等于换一个数据集。
# 所以只记录进 summary（`minCells` / `minFeatures`），不读配置。
#
# ## 出图约定
#
# 图内文字一律英文（标题/轴标签），中文只出现在返回给界面的 caption 里 ——
# 与 run_gsea.R / run_wgcna_prepare.R 一致，彻底绕开 Windows 字体注册问题。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

#' 客户指定的固定过滤参数（不要参数化）
SCR_MIN_CELLS <- 3L
SCR_MIN_FEATURES <- 100L

.scrna_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 把 JSON 的 `samples` 参数统一成 data.frame(name, dir)
#'
#' `fromJSON(simplifyVector = TRUE, simplifyDataFrame = FALSE)` 会把
#' `[{name,dir}, ...]` 解析成**列表的列表**而不是 data.frame，
#' 而长度 1 时又可能被简化成一个普通 list。两种都要能接住。
.scrna_samples <- function(ctx) {
  raw <- .scrna_param(ctx, "samples", NULL)
  if (is.null(raw)) {
    deg_stop("E_VALIDATION", "missing required parameter: samples", status = 11L)
  }
  if (is.data.frame(raw)) {
    names_ <- as.character(raw$name)
    dirs_ <- as.character(raw$dir)
  } else if (is.list(raw) && !is.null(raw$name)) {
    # 长度 1 被简化成单个 list
    names_ <- as.character(raw$name)
    dirs_ <- as.character(raw$dir)
  } else if (is.list(raw)) {
    pick <- function(x, key) {
      v <- x[[key]]
      if (is.null(v) || length(v) == 0) "" else as.character(v)[1]
    }
    names_ <- vapply(raw, pick, character(1), key = "name")
    dirs_ <- vapply(raw, pick, character(1), key = "dir")
  } else {
    deg_stop("E_VALIDATION", "samples must be an array of {name, dir}", status = 11L)
  }

  ok <- nzchar(names_) & nzchar(dirs_)
  names_ <- names_[ok]
  dirs_ <- dirs_[ok]
  if (length(names_) == 0) {
    deg_stop("E_VALIDATION", "samples is empty: nothing to import", status = 11L)
  }
  if (anyDuplicated(names_)) {
    deg_stop("E_VALIDATION",
             paste0("duplicated sample names: ", paste(unique(names_[duplicated(names_)]), collapse = ", ")),
             status = 11L)
  }
  data.frame(name = names_, dir = dirs_, stringsAsFactors = FALSE)
}

#' 一个目录是不是 10x 矩阵目录？是的话返回 v2/v3 与三件套文件名
#'
#' 只做**存在性**判断，不读内容 —— 扫描阶段要快，40 MB 的 mtx 留到构建时再读。
.detect_10x_dir <- function(dir) {
  pick <- function(candidates) {
    for (f in candidates) {
      full <- file.path(dir, f)
      if (file.exists(full)) return(f)
    }
    ""
  }
  matrix_file <- pick(c("matrix.mtx.gz", "matrix.mtx"))
  barcodes_file <- pick(c("barcodes.tsv.gz", "barcodes.tsv"))
  features_file <- pick(c("features.tsv.gz", "features.tsv", "genes.tsv.gz", "genes.tsv"))
  if (!nzchar(matrix_file) || !nzchar(barcodes_file) || !nzchar(features_file)) return(NULL)
  list(
    dir = dir,
    layout = if (grepl("^features", features_file)) "v3" else "v2",
    matrix = matrix_file,
    barcodes = barcodes_file,
    features = features_file
  )
}

#' 读第一行（兼容 .gz），用来数列数
.first_line_of <- function(path) {
  con <- if (grepl("\\.gz$", path, ignore.case = TRUE)) gzfile(path, "rt") else file(path, "rt")
  on.exit(close(con), add = TRUE)
  out <- tryCatch(readLines(con, n = 1L, warn = FALSE), error = function(e) character(0))
  if (length(out) == 0) "" else out[1]
}

#' 读一个 10x 目录，返回 dgCMatrix（gene × cell）
#'
#' ## ★ 为什么不用 `Read10X(data.dir=)`（实测踩过）
#'
#' 团队里原本的认知是「Seurat 的 Read10X 能自动识别 v2 老目录」。**在 Seurat 5 上
#' 这是错的**，本批数据（GSE313726，`genes.tsv.gz`）实测直接失败：
#'
#'     Read10X failed for MD: Gene name or features file missing. Expecting features.tsv.gz
#'
#' 加 `gene.column = 2` 也一样 —— 它压根不去找 `genes.tsv.gz`。
#' 所以改成 `ReadMtx()` 显式传三件套：文件名由 `.detect_10x_dir()` 已经探好了，
#' 反而比依赖内部规则更可靠（v2/v3 同一套代码）。
#'
#' ## 为什么 `feature.column` 取第 2 列
#'
#' v2 的 `genes.tsv` 是「第 1 列基因号 + 第 2 列 symbol」（如 `ENSG00000… / TP53`），
#' v3 的 `features.tsv` 是「id / symbol / type」三列。**取第 1 列会拿到 Ensembl 号**：
#' 本批水稻数据两列恰好相同（`Os01g0100100`），看不出差别；但换成人或小鼠，
#' 下游所有按 symbol 的注释、marker、富集都会失效，而且**不会报错**。
#' 只在文件真的只有 1 列时才退回第 1 列。
.scrna_read_10x <- function(dir) {
  det <- .detect_10x_dir(dir)
  if (is.null(det)) {
    deg_stop("E_DATA_INVALID",
             paste0("not a 10x matrix directory: ", basename(dir)), status = 13L)
  }
  ncols <- length(strsplit(.first_line_of(file.path(dir, det$features)), "\t", fixed = TRUE)[[1]])
  featureColumn <- if (ncols >= 2L) 2L else 1L

  counts <- tryCatch(
    suppressWarnings(Seurat::ReadMtx(
      mtx = file.path(dir, det$matrix),
      cells = file.path(dir, det$barcodes),
      features = file.path(dir, det$features),
      cell.column = 1,
      feature.column = featureColumn
    )),
    error = function(e) {
      deg_stop("E_DATA_INVALID",
               paste0("ReadMtx failed for ", basename(dir), ": ", conditionMessage(e)),
               status = 13L)
    }
  )
  if (is.null(counts) || nrow(counts) == 0 || ncol(counts) == 0) {
    deg_stop("E_DATA_EMPTY", paste0("empty matrix in ", basename(dir)), status = 13L)
  }
  if (!inherits(counts, "dgCMatrix")) {
    counts <- tryCatch(as(counts, "CsparseMatrix"), error = function(e) counts)
  }
  counts
}

#' 画每样本细胞数柱状图
.scrna_plot_cells <- function(stats, outFile) {
  ok <- tryCatch({
    deg_ensure_pkgs("ggplot2")
    df <- stats
    df$sample <- factor(df$sample, levels = df$sample)
    p <- ggplot2::ggplot(df, ggplot2::aes(x = sample, y = cells)) +
      ggplot2::geom_col(fill = "#46bac2", width = 0.7) +
      # 柱子很少时写数值；样本多时标签会糊成一片，只留坐标轴
      (if (nrow(df) <= 15) {
        ggplot2::geom_text(ggplot2::aes(label = cells), vjust = -0.4, size = 3)
      } else {
        ggplot2::theme()
      }) +
      ggplot2::labs(x = NULL, y = "Cells", title = "Cells per sample") +
      ggplot2::theme_bw(base_size = 11) +
      ggplot2::theme(
        panel.grid.minor = ggplot2::element_blank(),
        axis.text.x = ggplot2::element_text(angle = if (nrow(df) > 6) 35 else 0,
                                            hjust = if (nrow(df) > 6) 1 else 0.5)
      )
    deg_save_ggplot(p, outFile, max(4, 1.1 * nrow(df) + 2), 3.6, "cells_per_sample")
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("cells-per-sample plot failed: ", conditionMessage(e)))
    FALSE
  })
  isTRUE(ok) && file.exists(outFile)
}

deg_main("scrna/run_scrna_import.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "data.table", "jsonlite"))
  startedAt <- Sys.time()

  dataDir <- as.character(.scrna_param(ctx, "dataDir", ""))
  samples <- .scrna_samples(ctx)

  if (!nzchar(dataDir) || !dir.exists(dataDir)) {
    deg_stop("E_DATA_MISSING", paste0("data directory not found: ", dataDir), status = 12L)
  }
  missingDirs <- samples$dir[!vapply(samples$dir, dir.exists, logical(1))]
  if (length(missingDirs) > 0) {
    deg_stop("E_DATA_MISSING",
             paste0("sample directory not found: ", paste(utils::head(missingDirs, 3), collapse = ", ")),
             status = 12L)
  }

  emit_log("info", sprintf("import %d sample(s) from %s", nrow(samples), basename(dataDir)))
  emit_progress("read", 5, sprintf("reading %d 10x matrices", nrow(samples)))

  # ---- 逐个读入并建对象 ----------------------------------------------------
  objs <- vector("list", nrow(samples))
  rawCells <- integer(nrow(samples))
  # CreateSeuratObject 会把基因名里的下划线替换成短横线（见下面的检测与 warn）
  renamedExamples <- character(0)
  renamedCount <- 0L
  for (i in seq_len(nrow(samples))) {
    name <- samples$name[i]
    dir <- samples$dir[i]
    det <- .detect_10x_dir(dir)
    if (is.null(det)) {
      deg_stop("E_DATA_INVALID",
               paste0("not a 10x matrix directory (need matrix.mtx + barcodes + genes/features): ",
                      basename(dir)),
               status = 13L)
    }
    emit_progress("read", 5 + round(60 * (i - 1) / nrow(samples)),
                  sprintf("reading %s (%s)", name, det$layout))
    emit_log("info", sprintf("  %s: %s layout, %s", name, det$layout, det$features))

    counts <- .scrna_read_10x(dir)
    rawCells[i] <- ncol(counts)
    emit_log("info", sprintf("  %s: %d genes x %d cells (before filtering)",
                             name, nrow(counts), ncol(counts)))

    objs[[i]] <- Seurat::CreateSeuratObject(
      counts = counts,
      project = name,
      min.cells = SCR_MIN_CELLS,
      min.features = SCR_MIN_FEATURES
    )
    # ★ Seurat 的 CreateSeuratObject 会把基因名里的 `_` 换成 `-`
    #   （`LOC_Os01g01010` → `LOC-Os01g01010`），而且**连 counts 的行名一起改**。
    #   本批水稻数据（`Os01g0100100`）没有下划线，看不出来；但 MSU 的 `LOC_Os*`
    #   基因名一定会中招 —— 后续任何「按原始 ID 去匹配注释表」的步骤都会 0 命中，
    #   而且不报错。所以这里必须把这件事**说出来**，不能让它悄悄发生。
    rawGenes <- rownames(counts)
    objGenes <- rownames(objs[[i]])
    underscoresIn <- sum(grepl("_", rawGenes))
    if (underscoresIn > 0 && !any(grepl("_", objGenes))) {
      renamedCount <- renamedCount + underscoresIn
      if (length(renamedExamples) < 3) {
        renamedExamples <- c(renamedExamples,
                             utils::head(rawGenes[grepl("_", rawGenes)], 3 - length(renamedExamples)))
      }
      emit_log("warn", sprintf(
        "  %s: Seurat rewrote %d feature name(s): '_' -> '-' (e.g. %s). Matching any annotation by the original id will fail silently.",
        name, underscoresIn, paste(utils::head(rawGenes[grepl("_", rawGenes)], 2), collapse = ", ")))
    }

    emit_log("info", sprintf("  %s: %d genes x %d cells (after min.cells=%d / min.features=%d)",
                             name, nrow(objs[[i]]), ncol(objs[[i]]),
                             SCR_MIN_CELLS, SCR_MIN_FEATURES))
    # merge 用 add.cell.ids 加前缀，但 orig.ident 要等于用户确认后的样本名。
    # CreateSeuratObject 的 project 已设成 name，merge 后 orig.ident 会保留 ——
    # 这里再显式写一次，避免 merge 在某些版本上把 orig.ident 改成 "SeuratProject"。
    objs[[i]]$orig.ident <- name
  }

  # ---- 样本间基因重叠率 ----------------------------------------------------
  # 为什么要查这个：6 个样本若来自不同注释版本（甚至不同物种），merge 出来的对象
  # 表面上「合并成功」，实际每个样本的基因几乎不重叠 —— 后续整合/cluster 会得到
  # 一堆按样本劈开的簇，而没有任何一步会报错。所以这里先算出来并警告。
  # 口径：两两「交集 / 较小方基因数」，< 0.5 视为可疑（不阻断，只提示）。
  if (length(objs) >= 2L) {
    geneSets <- lapply(objs, rownames)
    overlap <- list()
    for (i in seq_len(length(objs) - 1L)) {
      for (j in seq.int(i + 1L, length(objs))) {
        inter <- length(intersect(geneSets[[i]], geneSets[[j]]))
        denom <- min(length(geneSets[[i]]), length(geneSets[[j]]))
        ratio <- if (denom > 0L) inter / denom else 0
        overlap[[length(overlap) + 1L]] <- list(
          a = samples$name[i], b = samples$name[j],
          overlap = round(ratio, 4L), shared = as.integer(inter), smaller = as.integer(denom)
        )
        if (ratio < 0.5) {
          emit_log("warn", sprintf(
            "low gene overlap between %s and %s: %.1f%% (%d shared / %d smaller set) — check whether the samples use the same annotation",
            samples$name[i], samples$name[j], 100 * ratio, inter, denom))
        }
      }
    }
    emit_log("info", sprintf("gene overlap checked for %d sample pair(s)", length(overlap)))
  } else {
    overlap <- list()
  }

  emit_progress("read", 70, "merging samples")
  # ★★ merge 之前先记下「各样本过滤后细胞数之和」，merge 之后拿它硬对一次。
  #
  #   为什么必须对：`merge(x, y = list())` 在 Seurat 里**不报任何错**，直接返回 x ——
  #   表现就是「合并成功、但只剩第一个样本」。实测踩到过（客户演示时只剩 MD）。
  #   这类失败没有任何异常可捕，只能靠总数对照发现。
  # ncol() 在 Seurat 对象上返回 double，vapply 到 integer 会直接报错 —— 显式转一次
  expectedCells <- sum(vapply(objs, function(o) as.integer(ncol(o)), integer(1)))
  obj <- if (length(objs) == 1L) {
    objs[[1]]
  } else {
    merge(objs[[1]], y = objs[-1], add.cell.ids = samples$name, project = "scrna")
  }
  rm(objs)

  if (ncol(obj) != expectedCells) {
    deg_stop("E_RESULT_INVALID",
             sprintf("merge lost cells: expected %d (sum of %d sample(s)) but the merged object has %d",
                     expectedCells, nrow(samples), ncol(obj)),
             status = 13L)
  }
  emit_log("info", sprintf("merge check passed: %d cell(s) = sum of per-sample cells", ncol(obj)))

  nCells <- ncol(obj)
  nGenes <- nrow(obj)
  if (nCells == 0) {
    deg_stop("E_DATA_EMPTY",
             "no cell passed the filters (min.cells = 3, min.features = 100)", status = 13L)
  }

  # ---- 每样本统计 ----------------------------------------------------------
  idents <- as.character(obj$orig.ident)
  perSample <- lapply(samples$name, function(s) {
    cells <- sum(idents == s)
    feats <- obj$nFeature_RNA[idents == s]
    list(
      sample = s,
      cells = as.integer(cells),
      genesMedian = if (cells > 0) as.integer(stats::median(feats)) else 0L
    )
  })
  stats <- data.frame(
    sample = vapply(perSample, function(x) x$sample, character(1)),
    cells = vapply(perSample, function(x) x$cells, integer(1)),
    genes_median = vapply(perSample, function(x) x$genesMedian, integer(1)),
    stringsAsFactors = FALSE
  )
  data.table::fwrite(stats, file.path(ctx$runDir, "sample_stats.csv"))
  emit_artifact("table", "sample_stats.csv", rows = nrow(stats), schema = "ScrnaSampleStat[]")

  emit_log("info", sprintf("merged object: %d genes x %d cells across %d sample(s)",
                           nGenes, nCells, nrow(samples)))

  # ---- 出图 ----------------------------------------------------------------
  emit_progress("plot", 80, "cells per sample")
  plotFile <- "p01_cells_per_sample.png"
  plotted <- .scrna_plot_cells(stats, file.path(ctx$runDir, plotFile))
  if (plotted) emit_artifact("plot", plotFile)

  # ---- 保存对象 ------------------------------------------------------------
  emit_progress("write", 90, "saving Seurat object")
  objFile <- "obj_step1.rds"
  saveRDS(obj, file.path(ctx$runDir, objFile))
  emit_artifact("scrna_object", objFile)

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  # ★ perSample 必须 unname(lapply(...))：jsonlite::toJSON(auto_unbox = TRUE)
  #   会把长度 1 的数组塌成标量，前端 `.map` 直接崩。
  emit_result(list(
    nSamples = as.integer(nrow(samples)),
    nCells = as.integer(nCells),
    nGenes = as.integer(nGenes),
    perSample = unname(perSample),
    filteredByMinFeatures = as.integer(sum(rawCells) - nCells),
    rawCells = as.integer(sum(rawCells)),
    minCells = SCR_MIN_CELLS,
    minFeatures = SCR_MIN_FEATURES,
    plotFile = if (plotted) plotFile else "",
    objectFile = objFile,
    # 前 5 个基因名：用来一眼确认 feature.column 有没有取错列
    # （取错时这里会是一串 Ensembl 号）。冒烟脚本就断在这上面。
    firstGenes = unname(as.character(utils::head(rownames(obj), 5))),
    # 被 Seurat 改写过的基因名数量（`_` → `-`）。> 0 就意味着后续按原始 ID 匹配注释会失败
    featureNamesRewritten = as.integer(renamedCount),
    # 两两基因重叠率（交集 / 较小方）。<0.5 时上面已经 warn 过
    sampleOverlap = unname(overlap),
    renamedExamples = unname(renamedExamples),
    durationMs = as.integer(durationMs)
  ))
})
