# =============================================================================
# r/scrna/run_scrna_prep.R —— 单细胞流程第 3 步：标准化 · 高变基因 · PCA · 批次校正
#
# ## 对照客户脚本（docs/reference/scrna-reference.txt:37-58）
#
#   pbmc <- NormalizeData(pbmc, normalization.method = "LogNormalize", scale.factor = 10000)
#   pbmc <- FindVariableFeatures(pbmc, selection.method = "vst", nfeatures = 2000)
#   pbmc <- ScaleData(pbmc)
#   pbmc <- RunPCA(pbmc, npcs = 30, pc.genes = VariableFeatures(pbmc))
#   combined2 <- IntegrateLayers(pbmc, method = HarmonyIntegration,
#                                orig.reduction = "pca", new.reduction = "harmony")
#
# 两处必须说明的差异：
#
# 1. **`pc.genes` 在 Seurat 5 已废弃**，等价写法是 `features =`。客户脚本是 Seurat 4 时代的
#    写法，直接照抄会报 unused argument。这里用 `RunPCA(npcs = nPcs, features = VariableFeatures(obj))`。
#
# 2. **`ScaleData()` 只对高变基因做**（客户脚本是 `ScaleData(pbmc)` = 全部基因）。
#    原因很实际：scale.data 是**稠密**矩阵，28525 基因 × 26571 细胞 × 8 字节 ≈ **5.6 GB**，
#    再加一份临时拷贝，普通办公机直接 OOM。而这一步之后唯一用到 scale.data 的地方就是
#    PCA 与 harmony —— 两者都只吃高变基因。所以限制在 2000 个 HVG ≈ 425 MB。
#    ⚠️ 后续若要做「用非高变基因画热图」，那份基因不在 scale.data 里，需要重新 ScaleData。
#    日志会明确打出这件事，不让人蒙在鼓里。
#
# ## 单样本必须跳过 harmony
#
# `IntegrateLayers` 是按**层**（merge 产生的 counts.<样本名>）分组的，只有一层时它既没有
# 可校正的对象，也会直接报错。所以样本数 < 2 时跳过，并把 `activeReduction` 设成 `"pca"`。
#
# ★ 下游一律读 `activeReduction`，**不要再各自判断样本数** —— 两处判断必然有一天分叉，
#   表现是「某张图空白」或「reduction not found」。
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

.scrna_int <- function(ctx, name, default, min = 1L, max = 1000L) {
  v <- suppressWarnings(as.integer(.scrna_param(ctx, name, default)))
  if (length(v) != 1L || is.na(v)) return(as.integer(default))
  max(as.integer(min), min(as.integer(max), v))
}

#' 保存一张图；失败只 warn，不让整步失败
.scrna_save <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

deg_main("scrna/run_scrna_prep.R", function(ctx) {
  deg_ensure_pkgs(c("Seurat", "Matrix", "ggplot2", "jsonlite"))
  startedAt <- Sys.time()

  objFile <- as.character(.scrna_param(ctx, "objectFile", "obj_step2.rds"))
  objPath <- if (grepl("^(/|[A-Za-z]:)", objFile)) objFile else file.path(ctx$runDir, objFile)
  if (!file.exists(objPath)) {
    deg_stop("E_DATA_MISSING",
             paste0("step-2 object not found: ", basename(objPath), " (run the QC filter first)"),
             status = 12L)
  }
  nFeatures <- .scrna_int(ctx, "nFeatures", 2000L, 200L, 20000L)
  nPcs <- .scrna_int(ctx, "nPcs", 30L, 5L, 200L)

  emit_progress("read", 3, "loading object")
  obj <- readRDS(objPath)
  samples <- unique(as.character(obj$orig.ident))
  nSamples <- length(samples)
  emit_log("info", sprintf("loaded %d genes x %d cells, %d sample(s): %s",
                           nrow(obj), ncol(obj), nSamples, paste(samples, collapse = ", ")))

  # ★ 多样本会在后面跑 harmony。它的**运行时**依赖 RhpcBLASctl 只在 harmony 的
  #   Suggests 里 —— 装 harmony 时不会被带上，`requireNamespace("harmony")` 也是 TRUE
  #   （命名空间能加载），所以不查的话会「NormalizeData/HVG/ScaleData/PCA 全过（44 秒），
  #   最后死在 harmony 调 RhpcBLASctl::blas_get_num_procs()」。
  #   实测客户机器上就是这个现象，报一条中文「不存在叫'RhpcBLASctl'这个名字的程辑包」。
  #   这里在读入对象后（约 2 秒）就检查，让它早失败、且错误码是 E_RT_PKG_MISSING。
  if (nSamples >= 2L) {
    deg_ensure_pkgs(c("harmony", "RhpcBLASctl"))
  }

  # ---- 1. 标准化 ----------------------------------------------------------
  emit_progress("normalize", 10, "NormalizeData (LogNormalize)")
  obj <- Seurat::NormalizeData(obj, normalization.method = "LogNormalize",
                               scale.factor = 10000, verbose = FALSE)
  emit_log("info", "NormalizeData: LogNormalize, scale.factor = 10000")

  # ---- 2. 高变基因 --------------------------------------------------------
  emit_progress("dispersion", 22, sprintf("FindVariableFeatures (vst, nfeatures=%d)", nFeatures))
  obj <- Seurat::FindVariableFeatures(obj, selection.method = "vst",
                                      nfeatures = nFeatures, verbose = FALSE)
  hvg <- Seurat::VariableFeatures(obj)
  emit_log("info", sprintf("FindVariableFeatures: vst, %d HVG selected", length(hvg)))

  # ---- 3. 缩放（只对 HVG，理由见文件头）----------------------------------
  emit_progress("fit", 35, "ScaleData (HVG only)")
  obj <- Seurat::ScaleData(obj, features = hvg, verbose = FALSE)
  emit_log("info", sprintf(
    "ScaleData: %d HVG only (all %d genes would need ~%.1f GB dense matrix)",
    length(hvg), nrow(obj), nrow(obj) * ncol(obj) * 8 / 1024^3))

  # ---- 4. PCA -------------------------------------------------------------
  emit_progress("test", 50, sprintf("RunPCA (npcs=%d)", nPcs))
  obj <- Seurat::RunPCA(obj, npcs = nPcs, features = hvg, verbose = FALSE)
  emit_log("info", sprintf("RunPCA: npcs = %d, features = %d HVG (pc.genes is deprecated in Seurat 5)",
                           nPcs, length(hvg)))

  # ---- 5. 批次校正 --------------------------------------------------------
  harmonyApplied <- nSamples >= 2L
  if (harmonyApplied) {
    emit_progress("test", 62, "IntegrateLayers (harmony)")
    # 依赖已在读入对象后检查过（harmony + RhpcBLASctl），这里不再重复
    t0 <- Sys.time()
    obj <- Seurat::IntegrateLayers(
      object = obj,
      method = Seurat::HarmonyIntegration,
      orig.reduction = "pca",
      new.reduction = "harmony",
      verbose = FALSE
    )
    harmonySeconds <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
    activeReduction <- "harmony"
    emit_log("info", sprintf("IntegrateLayers: harmony done in %.1f s (new.reduction = 'harmony')",
                             harmonySeconds))
  } else {
    activeReduction <- "pca"
    harmonySeconds <- 0
    # 单样本不是错误：没有批次可校正，直接用 pca 也是正确结果
    emit_log("warn", "only 1 sample: skipping batch correction (harmony); activeReduction = 'pca'")
  }

  # ---- 6. 出图 ------------------------------------------------------------
  emit_progress("plot", 78, "diagnostic plots")
  deg_ensure_pkgs("ggplot2")
  plots <- list()

  p1 <- tryCatch({
    p <- Seurat::VariableFeaturePlot(obj)
    top10 <- utils::head(hvg, 10)
    # ★ 水稻的基因 ID 很长（`Os01g0100100`），默认字号下 10 个标签会糊成一团。
    #   ggrepel 的相关参数通过 ... 传给 geom_text_repel：缩小字号 + 允许更多重叠尝试 +
    #   强制画引导线，标签才分散得开。图也放宽到 9 英寸。
    p <- Seurat::LabelPoints(
      plot = p, points = top10, repel = TRUE, xn = 0.85, yn = 0.5,
      size = 2.4, max.overlaps = 30, min.segment.length = 0, seed = 1
    ) +
      ggplot2::labs(title = sprintf("Top %d variable features (of %d)", length(top10), length(hvg))) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
    p
  }, error = function(e) { emit_log("warn", paste0("hvg plot build failed: ", conditionMessage(e))); NULL })
  if (!is.null(p1) && .scrna_save(p1, file.path(ctx$runDir, "p01_hvg.png"), 9, 5, "hvg")) {
    plots[[length(plots) + 1L]] <- list(id = "hvg", file = "p01_hvg.png",
                                        caption = sprintf("前 10 个高变基因（共选出 %d 个）", length(hvg)))
  }

  p2 <- tryCatch({
    Seurat::ElbowPlot(obj, ndims = nPcs) +
      ggplot2::labs(title = sprintf("PCA elbow (current ndims = %d)", nPcs)) +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
  }, error = function(e) { emit_log("warn", paste0("elbow plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p2) && .scrna_save(p2, file.path(ctx$runDir, "p02_elbow.png"), 6, 4, "elbow")) {
    plots[[length(plots) + 1L]] <- list(id = "elbow", file = "p02_elbow.png",
                                        caption = sprintf("PC 方差贡献（当前 PCA 维数 %d）；拐点之后趋平，通常够用", nPcs))
  }

  p3 <- tryCatch({
    Seurat::DimPlot(obj, reduction = "pca", group.by = "orig.ident", pt.size = 0.4) +
      ggplot2::labs(title = "PCA (before batch correction)") +
      ggplot2::theme_bw(base_size = 10) +
      ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
  }, error = function(e) { emit_log("warn", paste0("pca plot failed: ", conditionMessage(e))); NULL })
  if (!is.null(p3) && .scrna_save(p3, file.path(ctx$runDir, "p03_pca_by_sample.png"), 6.5, 4.5, "pca")) {
    plots[[length(plots) + 1L]] <- list(id = "pca", file = "p03_pca_by_sample.png",
                                        caption = "PCA（按样本着色，批次校正前）")
  }

  # 单样本没有 harmony，这张自然跳过
  if (harmonyApplied) {
    p4 <- tryCatch({
      deg_ensure_pkgs("patchwork")
      left <- Seurat::DimPlot(obj, reduction = "pca", group.by = "orig.ident", pt.size = 0.3) +
        ggplot2::labs(title = "PCA") + ggplot2::theme_bw(base_size = 9) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      right <- Seurat::DimPlot(obj, reduction = "harmony", group.by = "orig.ident", pt.size = 0.3) +
        ggplot2::labs(title = "Harmony") + ggplot2::theme_bw(base_size = 9) +
        ggplot2::theme(panel.grid.minor = ggplot2::element_blank())
      patchwork::wrap_plots(left, right, ncol = 2)
    }, error = function(e) { emit_log("warn", paste0("harmony compare plot failed: ", conditionMessage(e))); NULL })
    if (!is.null(p4) && .scrna_save(p4, file.path(ctx$runDir, "p04_harmony_before_after.png"), 10, 4.5, "harmony")) {
      plots[[length(plots) + 1L]] <- list(
        id = "harmony", file = "p04_harmony_before_after.png",
        caption = "批次校正前 / 后对比：若 harmony 之后各样本仍各占一半、完全不重叠，说明批次效应过强或分组有问题")
    }
  } else {
    emit_log("info", "skipping harmony before/after plot: single sample, nothing to compare")
  }

  for (pl in plots) emit_artifact("plot", pl$file)

  # ---- 7. 保存 ------------------------------------------------------------
  # ★ 把「下游该用哪个 reduction」「PCA 用了几维」写进对象的 misc：
  #   第 4 步及以后从这里读，而不是各自判断样本数或依赖界面传参 ——
  #   对象本身就应该自描述，否则换一个调用方（比如直接跑 R 脚本）就会漂移。
  obj@misc$activeReduction <- activeReduction
  obj@misc$nPcs <- as.integer(nPcs)
  obj@misc$nFeatures <- as.integer(nFeatures)
  obj@misc$harmonyApplied <- harmonyApplied

  emit_progress("write", 92, "saving obj_step3.rds")
  saveRDS(obj, file.path(ctx$runDir, "obj_step3.rds"))
  emit_artifact("scrna_object", "obj_step3.rds")

  perSample <- unname(lapply(samples, function(s) list(
    sample = s, cells = as.integer(sum(as.character(obj$orig.ident) == s))
  )))
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000

  emit_progress("write", 100, "done")
  emit_result(list(
    nCells = as.integer(ncol(obj)),
    nGenes = as.integer(nrow(obj)),
    nSamples = as.integer(nSamples),
    perSample = perSample,
    nFeatures = as.integer(nFeatures),
    nHVG = as.integer(length(hvg)),
    nPcs = as.integer(nPcs),
    harmonyApplied = harmonyApplied,
    harmonySeconds = round(harmonySeconds, 1),
    # ★ 下游一律读这个字段，不要再各自判断样本数
    activeReduction = activeReduction,
    reductions = unname(as.character(names(obj@reductions))),
    plots = unname(plots),
    objectFile = "obj_step3.rds",
    durationMs = as.integer(durationMs)
  ))
})
