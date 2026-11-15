# =============================================================================
# r/scrna/run_scrna_inspect.R —— 检查一个外部 .rds 能不能作为某一步的输入
#
# ## 为什么要单独一步「检查」而不是直接复制
#
# 用户手里的 rds 五花八门：可能是别的项目的对象、可能是旧版 Seurat 存的、
# 也可能根本不是 Seurat 对象（比如一个 list 或 matrix）。如果直接复制进 runDir 再等
# 第 4 步报错，用户看到的是一条与「导入」无关的错误，很难把它和刚选的文件联系起来。
#
# ## 三种「读不了」必须分开说
#
#   · 路径不存在          → E_DATA_MISSING
#   · readRDS 失败（损坏）→ E_DATA_INVALID「文件无法读取（可能已损坏）」
#   · 读出来了但不是 Seurat 对象 → E_DATA_INVALID「不是 Seurat 对象（class: ...）」
#
# 一律「读取失败」等于什么都没说。
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

#' 猜物种（只用于界面提示「SingleR 能不能用」，不参与计算）
#'
#' 人：`MT-ND1`（全大写 + 连字符）；鼠：`Mt-Nd1`（首字母大写）。
#' 水稻 `Os01g0100100` 两边都不像 → other。
.scrna_guess_strain <- function(genes) {
  probe <- utils::head(genes, 2000)
  humanMt <- sum(grepl("^MT-", probe))
  mouseMt <- sum(grepl("^Mt-", probe))
  if (humanMt >= 5 && mouseMt == 0) return("human")
  if (mouseMt >= 5 && humanMt == 0) return("mouse")
  "other"
}

deg_main("scrna/run_scrna_inspect.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "jsonlite"))
  startedAt <- Sys.time()

  path <- as.character(.scrna_param(ctx, "path", ""))
  targetStep <- suppressWarnings(as.integer(.scrna_param(ctx, "targetStep", 4L)))
  if (is.na(targetStep) || !targetStep %in% c(4L, 5L, 6L)) targetStep <- 4L

  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_MISSING", paste0("file not found: ", basename(path)), status = 12L)
  }

  emit_progress("read", 20, "reading object")
  obj <- tryCatch(
    readRDS(path),
    error = function(e) {
      deg_stop("E_DATA_INVALID",
               paste0("cannot read this .rds (it may be corrupted or saved by an incompatible R): ",
                      basename(path), " — ", substr(conditionMessage(e), 1, 200)),
               status = 13L)
    }
  )
  if (!inherits(obj, "Seurat")) {
    deg_stop("E_DATA_INVALID",
             paste0("this is not a Seurat object (class: ", paste(class(obj), collapse = "/"), ")"),
             status = 13L)
  }

  emit_progress("filter", 60, "inspecting")
  reductions <- tryCatch(as.character(names(obj@reductions)), error = function(e) character(0))
  metaCols <- tryCatch(colnames(obj@meta.data), error = function(e) character(0))
  clusterColumn <- if ("clusters" %in% metaCols) {
    "clusters"
  } else if ("seurat_clusters" %in% metaCols) {
    "seurat_clusters"
  } else {
    ""
  }
  hvg <- tryCatch(length(Seurat::VariableFeatures(obj)), error = function(e) 0L)
  scaleRows <- tryCatch(nrow(SeuratObject::LayerData(obj, assay = "RNA", layer = "scale.data")),
                        error = function(e) 0L)

  # 第 4 步及以后用哪个降维：与第 4 步脚本**同一套**推断规则（misc 优先，其次 harmony→pca）
  activeReduction <- tryCatch(obj@misc$activeReduction, error = function(e) NULL)
  if (is.null(activeReduction) || !nzchar(as.character(activeReduction))) {
    activeReduction <- if ("harmony" %in% reductions) "harmony" else if ("pca" %in% reductions) "pca" else ""
  }
  activeReduction <- as.character(activeReduction)
  nPcs <- tryCatch(obj@misc$nPcs, error = function(e) NULL)
  if (is.null(nPcs) && nzchar(activeReduction)) {
    nPcs <- tryCatch(ncol(Seurat::Embeddings(obj, activeReduction)), error = function(e) 0L)
  }
  if (is.null(nPcs)) nPcs <- 0L

  # ---- 每一步的要求 -------------------------------------------------------
  hasReduction <- nzchar(activeReduction)
  hasClusters <- nzchar(clusterColumn)

  # ---- 每簇细胞数 ---------------------------------------------------------
  # 为什么检查阶段就顺手算出来：第 6 步的「填表」界面要显示每簇多少细胞，
  # 而用户如果是从 obj_step5.rds 直接开始的，runDir 里没有第 4 步写的
  # cluster_summary.csv。不在这里带上，第 6 步就只能为了一个数字再起一次 R
  # （读几百 MB 的 rds，40 秒）。顺序按簇号数字排，与 UMAP 图例一致。
  clusterSizes <- list()
  if (hasClusters) {
    tab <- table(as.character(obj@meta.data[[clusterColumn]]))
    lv <- names(tab)
    num <- suppressWarnings(as.integer(lv))
    lv <- if (all(!is.na(num))) lv[order(num)] else sort(lv)
    clusterSizes <- unname(lapply(lv, function(nm) list(
      cluster = nm, cells = as.integer(tab[[nm]])
    )))
  }


  readyFor <- list(
    `4` = hasReduction,
    `5` = hasClusters,
    `6` = hasClusters
  )
  missing <- character(0)
  if (!readyFor[[as.character(targetStep)]]) {
    if (targetStep == 4L) {
      missing <- c(missing, "dim reduction (pca/harmony)")
    } else {
      missing <- c(missing, "clusters column")
    }
  }
  message <- if (length(missing) == 0) {
    "ok"
  } else if (targetStep == 4L) {
    "this object has no dimension reduction (pca/harmony); start from step 3 instead"
  } else {
    "this object has no clustering result (clusters column); start from step 4 instead"
  }
  if (length(missing) == 0 && targetStep == 6L && !file.exists(file.path(ctx$runDir, "markers_top10.csv"))) {
    # 第 6 步人工注释不依赖 marker：只提示，不阻断
    message <- "ok (no marker table found; manual annotation still works)"
  }

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    nCells = as.integer(ncol(obj)),
    nGenes = as.integer(nrow(obj)),
    reductions = unname(reductions),
    hasClusters = hasClusters,
    clusterColumn = clusterColumn,
    clusterSizes = unname(clusterSizes),
    hasVariableFeatures = hvg > 0L,
    nVariableFeatures = as.integer(hvg),
    hasScaleData = scaleRows > 0L,
    scaleRows = as.integer(scaleRows),
    suggestedReduction = activeReduction,
    suggestedNpcs = as.integer(nPcs),
    strain = .scrna_guess_strain(rownames(obj)),
    targetStep = as.integer(targetStep),
    ok = length(missing) == 0L,
    readyFor = readyFor,
    missing = unname(missing),
    message = message,
    durationMs = as.integer(durationMs)
  ))
})
