# =============================================================================
# r/wgcna/run_wgcna_network.R —— WGCNA 第二段：建网络 + 切模块 + 合并 + 关联性状
#
# 输入是第一段落盘的 stage1.rds（datExpr / datTraits / geneNames ...），
# 参数里的 softPower 由用户在界面上确认后传进来。
#
# 为什么第二段要带 TOM 缓存：
#   TOMsimilarity 是 O(n²) 的稠密矩阵运算，上万基因要跑几分钟、占几百 MB。
#   而 TOM 只依赖「表达矩阵 + 软阈值」，跟 minModuleSize / mergeHeight 完全无关。
#   用户调模块粒度时如果每次都重算 TOM，体验就是「改一个数字等十分钟」。
#   所以把 dissTOM 落盘，并用 softPower + 基因数 + 基因名指纹三重校验。
#
# 缓存只对 nGenes <= 8000 生效：8000² × 8 字节 = 512 MB，再大就别往磁盘写了，
# 用户的工作目录会被一个几个 G 的 rds 撑爆。
#
# 出图约定同第一段：图内文字全英文，中文只放在 caption 里。
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

#' heatmapPalette → labeledHeatmap 的 colors（固定 50 档）
#'
#' 全部是发散型配色：相关系数有正负、有零点，单色渐变会把「无关」画成浅色，
#' 读图的人容易把 0.05 当成强相关。
.wgcna_palette <- function(name) {
  switch(name,
    blueWhiteRed = WGCNA::blueWhiteRed(50),
    greenWhiteRed = WGCNA::greenWhiteRed(50),
    rdbu = grDevices::colorRampPalette(c("#2166AC", "#F7F7F7", "#B2182B"))(50),
    rdylbu = grDevices::colorRampPalette(c("#313695", "#FFFFFB", "#A50026"))(50),
    coolwarm = grDevices::colorRampPalette(c("#3B4CC0", "#DDDDDD", "#B40426"))(50),
    puor = grDevices::colorRampPalette(c("#542788", "#F7F7F7", "#B35806"))(50),
    {
      emit_log("warn", sprintf("unknown heatmapPalette '%s', falling back to blueWhiteRed", name))
      WGCNA::blueWhiteRed(50)
    }
  )
}

#' 表达矩阵指纹（用于判断 TOM 缓存是否还能用）
#'
#' 指纹里同时包含**基因名**和**每个样本的列和**。只哈希基因名是不够的：
#' 用户改了 transform（none ↔ log2）或重新导出了一份数值不同的矩阵时，
#' 基因集合完全可能一模一样，只按基因名判断会命中旧 TOM —— 模块结果
#' 会和新表达值对不上，而且不会有任何报错，属于最难发现的那类错误。
#'
#' 用 digest::digest 的 md5。没有 digest 包时退回「基因数 + 前 50 个基因名 +
#' 总量级」的启发式指纹 —— 这是**去重判断，不是加密**，理论上可能碰撞，
#' 但足以拦住「换了输入却命中旧缓存」。
.wgcna_gene_hash <- function(datExpr) {
  genes <- sort(colnames(datExpr))
  checksum <- as.numeric(colSums(datExpr))
  if (requireNamespace("digest", quietly = TRUE)) {
    return(digest::digest(list(genes = genes, colSums = checksum), algo = "md5"))
  }
  sprintf("len%d:sum%.6g:%s", length(genes), sum(checksum),
          paste(utils::head(genes, 50), collapse = ","))
}

deg_main("wgcna/run_wgcna_network.R", function(ctx) {
  startedAt <- Sys.time()
  deg_ensure_pkgs(c("WGCNA", "dynamicTreeCut", "data.table", "jsonlite", "gplots"))

  wgcnaId <- as.character(.wgcna_param(ctx, "wgcnaId", ""))
  softPower <- as.integer(.wgcna_param(ctx, "softPower", 6))
  minModuleSize <- as.integer(.wgcna_param(ctx, "minModuleSize", 100))
  mergeHeight <- as.numeric(.wgcna_param(ctx, "mergeHeight", 0.25))
  heatmapPalette <- as.character(.wgcna_param(ctx, "heatmapPalette", "blueWhiteRed"))
  profileModule <- trimws(as.character(.wgcna_param(ctx, "profileModule", "")))
  tomSampleSize <- as.integer(.wgcna_param(ctx, "tomSampleSize", 1000))

  if (is.na(softPower) || softPower < 1 || softPower > 30) {
    deg_stop("E_VALIDATION", "softPower must be an integer between 1 and 30", status = 11L)
  }
  if (is.na(minModuleSize) || minModuleSize < 10) minModuleSize <- 10L
  if (is.na(mergeHeight) || mergeHeight < 0) mergeHeight <- 0.25
  if (is.na(tomSampleSize) || tomSampleSize < 50) tomSampleSize <- 1000L

  # ---- 1. 读第一段的中间态 ---------------------------------------------
  emit_progress("read", 5, "loading prepared data")
  stage1Path <- file.path(ctx$runDir, "stage1.rds")
  if (!file.exists(stage1Path)) {
    deg_stop("E_DATA_MISSING",
             paste0("stage1.rds not found in run directory; run the prepare step first"),
             detail = stage1Path, status = 12L)
  }
  stage1 <- readRDS(stage1Path)
  if (is.null(stage1$datExpr) || ncol(stage1$datExpr) < 30 || nrow(stage1$datExpr) < 3) {
    deg_stop("E_DATA_EMPTY", "stage1.rds does not contain a usable expression matrix", status = 13L)
  }
  datExpr <- as.data.frame(stage1$datExpr, check.names = FALSE)
  datTraits <- stage1$datTraits
  if (!is.null(datTraits)) datTraits <- as.data.frame(datTraits, check.names = FALSE)
  nGenes <- ncol(datExpr)
  nSamples <- nrow(datExpr)
  emit_log("info", sprintf("stage1 loaded: %d genes x %d samples (softPower = %d, minModuleSize = %d)",
                           nGenes, nSamples, softPower, minModuleSize))

  # WGCNA 多线程：nThreads 必须 >= 2，单核机器要 fallback，否则 enableWGCNAThreads 直接报错
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

  # ---- 2. TOM（带缓存）--------------------------------------------------
  emit_progress("fit", 15, "computing topological overlap")
  cachePath <- file.path(ctx$runDir, "cache_disstom.rds")
  metaPath <- file.path(ctx$runDir, "cache_meta.json")
  geneHash <- .wgcna_gene_hash(datExpr)
  dissTOM <- NULL
  tomCached <- FALSE

  if (file.exists(cachePath) && file.exists(metaPath)) {
    meta <- tryCatch(jsonlite::fromJSON(metaPath, simplifyVector = TRUE), error = function(e) NULL)
    if (!is.null(meta) &&
        isTRUE(all.equal(as.numeric(meta$softPower), as.numeric(softPower))) &&
        isTRUE(all.equal(as.integer(meta$nGenes), as.integer(nGenes))) &&
        identical(as.character(meta$geneHash), as.character(geneHash))) {
      cached <- tryCatch(readRDS(cachePath), error = function(e) NULL)
      if (!is.null(cached) && is.matrix(cached) &&
          all(dim(cached) == c(nGenes, nGenes))) {
        dissTOM <- cached
        tomCached <- TRUE
        emit_log("info", sprintf("TOM cache hit: reused %dx%d dissimilarity matrix (%s)",
                                 nGenes, nGenes, basename(cachePath)))
      } else {
        emit_log("warn", "TOM cache file is corrupted or has the wrong dimensions; recomputing")
      }
    } else {
      emit_log("info", "TOM cache invalidated (softPower / gene set changed); recomputing")
    }
  }

  if (is.null(dissTOM)) {
    # softConnectivity 只是诊断量，但它内部也要算一遍邻接，先算掉
    k <- as.numeric(WGCNA::softConnectivity(datE = datExpr, power = softPower))
    emit_log("info", sprintf("soft connectivity: mean %.1f, median %.1f, max %.1f",
                             mean(k), stats::median(k), max(k)))

    adjacencyMat <- WGCNA::adjacency(datExpr, power = softPower, type = "signed")
    TOM <- WGCNA::TOMsimilarity(adjacencyMat, TOMType = "signed")
    dissTOM <- 1 - TOM
    # 上万基因时 TOM 一个矩阵就 800MB，必须立刻释放再做后续聚类
    rm(adjacencyMat, TOM)
    gc()
    emit_log("info", "topological overlap matrix computed")

    if (nGenes <= 8000) {
      tryCatch({
        saveRDS(dissTOM, cachePath)
        deg_write_json(list(
          softPower = as.integer(softPower),
          nGenes = as.integer(nGenes),
          geneHash = as.character(geneHash),
          createdAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"),
          rVersion = as.character(getRversion()),
          wgcnaVersion = as.character(utils::packageVersion("WGCNA"))
        ), metaPath)
        emit_log("info", sprintf("TOM cache written (%d genes)", nGenes))
      }, error = function(e) {
        emit_log("warn", paste0("failed to write TOM cache: ", conditionMessage(e)))
      })
    } else {
      emit_log("info", sprintf(paste0("TOM not cached: %d genes > 8000, the rds would be ",
                                      "several hundred MB and slow down the next run more than it saves"),
                               nGenes))
    }
  } else {
    k <- as.numeric(WGCNA::softConnectivity(datE = datExpr, power = softPower))
  }

  # ---- 3. 基因聚类 + 动态切模块 ----------------------------------------
  emit_progress("fit", 40, "clustering genes and cutting modules")
  geneTree <- stats::hclust(stats::as.dist(dissTOM), method = "average")
  dynamicMods <- dynamicTreeCut::cutreeDynamic(
    dendro = geneTree, distM = dissTOM,
    deepSplit = 2, pamRespectsDendro = FALSE,
    minClusterSize = minModuleSize
  )
  dynamicColors <- WGCNA::labels2colors(dynamicMods)

  # 全部落进 0 / grey 时不报错：用户把 minModuleSize 调小就能改善，
  # 直接失败等于逼他重新跑一遍 TOM。
  if (length(unique(dynamicMods)) == 1 && all(dynamicMods == 0)) {
    emit_log("warn", "dynamic tree cut found no module at all (everything is grey); try a smaller minModuleSize")
  } else {
    emit_log("info", sprintf("dynamic tree cut: %d module(s) before merging (%s)",
                             length(unique(dynamicColors[dynamicColors != "grey"])),
                             paste(names(sort(table(dynamicColors), decreasing = TRUE)),
                                   sort(table(dynamicColors), decreasing = TRUE),
                                   sep = "=", collapse = ", ")))
  }

  # ---- 4. 模块特征向量聚类 + 合并相似模块 -------------------------------
  MEsDynamic <- WGCNA::moduleEigengenes(datExpr, colors = dynamicColors)$eigengenes
  METree <- NULL
  if (ncol(MEsDynamic) >= 2) {
    MEDiss <- 1 - stats::cor(MEsDynamic, use = "p")
    METree <- stats::hclust(stats::as.dist(MEDiss), method = "average")
  } else {
    emit_log("warn", "only one eigengene available; skipping module eigengene clustering")
  }

  # ★ 全 grey 时不能调 mergeCloseModules：它内部对「只有一个颜色且是 grey」
  #   会抛 "Color levels are empty"。这里直接沿用动态剪枝结果，保证流程不中断
  #   —— 用户把 minModuleSize 调小重跑就能改善，不该看到一次崩栈。
  if (sum(dynamicColors != "grey") == 0) {
    mergedColors <- dynamicColors
    mergedMEs <- MEsDynamic
    emit_log("warn", "no non-grey module to merge; keeping the all-grey result")
  } else {
    mergeRes <- WGCNA::mergeCloseModules(datExpr, dynamicColors, cutHeight = mergeHeight, verbose = 0)
    mergedColors <- mergeRes$colors
    mergedMEs <- mergeRes$newMEs
  }
  emit_log("info", sprintf("module merging at cutHeight %.2f: %d module(s) remain",
                           mergeHeight, length(unique(mergedColors[mergedColors != "grey"]))))

  # ---- 5. 写基因归属表 / 模块大小表 -------------------------------------
  emit_progress("write", 55, "writing module tables")
  colorOrder <- c("grey", WGCNA::standardColors(50))
  moduleLabels <- match(mergedColors, colorOrder) - 1L

  genesDf <- data.frame(
    gene = colnames(datExpr),
    dynamicMods = as.integer(dynamicMods),
    dynamicColors = as.character(dynamicColors),
    moduleLabels = as.integer(moduleLabels),
    mergedColor = as.character(mergedColors),
    stringsAsFactors = FALSE
  )
  deg_write_csv(genesDf, file.path(ctx$runDir, "wgcna_genes.csv"))

  sizeTab <- table(mergedColors)
  sizesDf <- data.frame(
    module = names(sizeTab),
    genes = as.integer(sizeTab),
    stringsAsFactors = FALSE
  )
  # 规范里 module_sizes 不含 grey（未分配基因没有生物学意义）
  sizesDf <- sizesDf[sizesDf$module != "grey", , drop = FALSE]
  sizesDf <- sizesDf[order(-sizesDf$genes), , drop = FALSE]
  rownames(sizesDf) <- NULL
  deg_write_csv(sizesDf, file.path(ctx$runDir, "wgcna_module_sizes.csv"))

  # 模块特征向量表：第一列 sample，其余 MExxx
  meOut <- data.frame(sample = rownames(datExpr), mergedMEs, check.names = FALSE)
  rownames(meOut) <- NULL
  deg_write_csv(meOut, file.path(ctx$runDir, "wgcna_eigengenes.csv"))

  # ---- 6. 模块-性状相关 -------------------------------------------------
  emit_progress("test", 65, "relating modules to traits")
  moduleTraitCor <- NULL
  moduleTraitPvalue <- NULL
  moduleTraitFdr <- NULL
  traitLong <- data.frame(
    module = character(0), trait = character(0),
    cor = numeric(0), pvalue = numeric(0), fdr = numeric(0),
    stringsAsFactors = FALSE
  )
  MEsTrait <- NULL

  if (!is.null(datTraits) && ncol(datTraits) > 0) {
    # 常数列的 cor 是 NaN（sd=0，分母为 0），提前剔掉并在日志里说清楚
    traitSd <- apply(datTraits, 2, stats::sd, na.rm = TRUE)
    keepTrait <- is.finite(traitSd) & traitSd > 0
    if (!all(keepTrait)) {
      emit_log("warn", sprintf("constant trait column(s) dropped (correlation would be NaN): %s",
                               paste(colnames(datTraits)[!keepTrait], collapse = ", ")))
      datTraits <- datTraits[, keepTrait, drop = FALSE]
    }
  }

  if (!is.null(datTraits) && ncol(datTraits) > 0) {
    MEs0 <- WGCNA::moduleEigengenes(datExpr, colors = mergedColors)$eigengenes
    MEsTrait <- MEs0[, setdiff(colnames(MEs0), "MEgrey"), drop = FALSE]
    if (ncol(MEsTrait) == 0) {
      emit_log("warn", "no non-grey module eigengene available; skipping module-trait correlation")
    } else {
      moduleTraitCor <- stats::cor(MEsTrait, datTraits, use = "p")
      moduleTraitPvalue <- WGCNA::corPvalueStudent(moduleTraitCor, nSamples)
      moduleTraitFdr <- matrix(
        stats::p.adjust(as.numeric(moduleTraitPvalue), method = "BH"),
        nrow = nrow(moduleTraitPvalue),
        ncol = ncol(moduleTraitPvalue),
        dimnames = dimnames(moduleTraitPvalue)
      )
      # 长表：一行一个（模块, 性状）组合，便于用户直接导 CSV 排序
      rows <- list()
      for (mi in seq_len(nrow(moduleTraitCor))) {
        for (ti in seq_len(ncol(moduleTraitCor))) {
          cv <- moduleTraitCor[mi, ti]
          if (!is.finite(cv)) next
          rows[[length(rows) + 1L]] <- list(
            # module 用纯颜色名（blue 而非 MEblue）：和 modules[] / 模块色条
            # 保持同一套词汇，前端可以直接拿它去取模块配色。
            # 热图上的 y 轴仍然按 WGCNA 惯例显示 MExxx。
            module = sub("^ME", "", rownames(moduleTraitCor)[mi]),
            trait = colnames(moduleTraitCor)[ti],
            cor = as.numeric(cv),
            pvalue = as.numeric(moduleTraitPvalue[mi, ti]),
            fdr = as.numeric(moduleTraitFdr[mi, ti])
          )
        }
      }
      if (length(rows) > 0) {
        traitLong <- data.frame(
          module = vapply(rows, function(r) r$module, character(1)),
          trait = vapply(rows, function(r) r$trait, character(1)),
          cor = vapply(rows, function(r) r$cor, numeric(1)),
          pvalue = vapply(rows, function(r) r$pvalue, numeric(1)),
          fdr = vapply(rows, function(r) r$fdr, numeric(1)),
          stringsAsFactors = FALSE
        )
      }
      emit_log("info", sprintf("module-trait correlation: %d module(s) x %d trait(s), %d row(s)",
                               nrow(moduleTraitCor), ncol(moduleTraitCor), nrow(traitLong)))
    }
  } else {
    emit_log("info", "no trait table for this run; module-trait analysis skipped")
  }
  # 无性状表时也要写只有表头的空文件，否则主进程找不到文件会报错
  deg_write_csv(traitLong, file.path(ctx$runDir, "wgcna_module_trait.csv"))

  # ---- 7. 出图 ----------------------------------------------------------
  emit_progress("plot", 75, "drawing network plots")
  plots <- list()

  # 7.1 样本聚类树 + 性状热图
  if (!is.null(datTraits) && ncol(datTraits) > 0) {
    p <- .wgcna_draw(ctx, "sampleTraitTree",
                     "Sample dendrogram and trait heatmap",
                     "样本聚类树与性状色条。色条越整齐说明该性状与样本结构越一致；如果某个性状的颜色在树的两大分支间明显分层，后面模块-性状相关通常也会显著。",
                     "p04_sample_trait_tree.png", 12, 8, function() {
                       sampleTree2 <- stats::hclust(stats::dist(datExpr), method = "average")
                       datTraitsColor <- WGCNA::numbers2colors(datTraits, signed = FALSE)
                       WGCNA::plotDendroAndColors(
                         sampleTree2, datTraitsColor,
                         groupLabels = names(datTraits),
                         colorHeight = 0.2,
                         cex.colorLabels = 0.8,
                         cex.dendroLabels = 0.7,
                         marAll = c(1, 5, 3, 1),
                         main = "Sample dendrogram and trait heatmap"
                       )
                     })
    if (!is.null(p)) plots[[length(plots) + 1L]] <- p
  }

  # 7.2 连接度分布 + 无标度检验
  p <- .wgcna_draw(ctx, "scaleFree",
                   "Connectivity distribution and scale-free check",
                   "左：每个基因的连接度分布；右：log10(p(k)) 对 log10(k) 的拟合，点越贴近直线越接近无标度拓扑。右图明显弯曲说明软阈值偏小。",
                   "p05_scale_free.png", 10, 5, function() {
                     graphics::par(mfrow = c(1, 2), mar = c(4.5, 4.5, 3, 1), cex.main = 0.85)
                     graphics::hist(k, main = "Connectivity distribution", xlab = "k",
                                    col = "grey80", border = "white")
                     WGCNA::scaleFreePlot(k, main = "Check scale free topology")
                   })
  if (!is.null(p)) plots[[length(plots) + 1L]] <- p

  # 7.3 基因聚类树
  p <- .wgcna_draw(ctx, "geneTree",
                   "Gene clustering on TOM-based dissimilarity",
                   "基于 TOM 相异度的基因层次聚类树。分支越靠下越相似；这张图只看整体结构，模块划分看下一张。",
                   "p06_gene_tree.png", 10, 10, function() {
                     graphics::par(mar = c(2, 4, 3, 1))
                     plot(geneTree, labels = FALSE, hang = 0.04, xlab = "", sub = "",
                          main = "Gene clustering on TOM-based dissimilarity")
                   })
  if (!is.null(p)) plots[[length(plots) + 1L]] <- p

  # 7.4 动态剪枝后的模块色条
  p <- .wgcna_draw(ctx, "moduleTree",
                   "Gene dendrogram and module colors",
                   "动态树剪切得到的初始模块（未合并）。色条上方的分支与颜色对应，颜色越连贯说明模块越干净。",
                   "p07_module_tree.png", 12, 8, function() {
                     graphics::par(mar = c(2, 4, 3, 1))
                     WGCNA::plotDendroAndColors(
                       geneTree, dynamicColors, "Dynamic Tree Cut",
                       dendroLabels = FALSE, hang = 0.03,
                       addGuide = TRUE, guideHang = 0.05,
                       main = "Gene dendrogram and module colors"
                     )
                   })
  if (!is.null(p)) plots[[length(plots) + 1L]] <- p

  # 7.5 模块特征向量聚类树（合并的依据）
  if (!is.null(METree)) {
    p <- .wgcna_draw(ctx, "meTree",
                     "Clustering of module eigengenes",
                     "模块特征向量的聚类树。红线是合并高度；红线以下相连的模块会被合并成一个（相似模块没有必要分开讲）。",
                     "p08_me_tree.png", 7, 6, function() {
                       graphics::par(mar = c(4.5, 5.2, 3.4, 1), cex.axis = 1.15,
                                     cex.lab = 1.15, cex.main = 1.3, lwd = 1.5)
                       plot(METree, main = "Clustering of module eigengenes",
                            xlab = "", sub = "", ylab = "Module eigengene dissimilarity")
                       # 细网格：合并高度经常要在两条分支之间目测取整，有刻度参考更好读
                       graphics::abline(h = seq(0, 1, by = 0.05), col = "grey92", lty = 1)
                       graphics::abline(h = mergeHeight, col = "red", lty = 2, lwd = 2)
                       graphics::mtext(
                         sprintf("%d modules | merge cutHeight = %.2f",
                                 length(unique(mergedColors[mergedColors != "grey"])), mergeHeight),
                         side = 3, line = 0.1, cex = 0.8, col = "grey30"
                       )
                     })
    if (!is.null(p)) plots[[length(plots) + 1L]] <- p
  }

  # 7.6 合并前后的模块对比
  p <- .wgcna_draw(ctx, "mergedTree",
                   "Merged module colors",
                   "上色条是动态剪枝的初始模块，下色条是合并后的最终模块。两行颜色差别越大，说明合并掉的冗余模块越多。",
                   "p09_merged_tree.png", 12, 8, function() {
                     graphics::par(mar = c(2, 4, 3, 1))
                     WGCNA::plotDendroAndColors(
                       geneTree, cbind(dynamicColors, mergedColors),
                       c("Dynamic Tree", "Merged dynamic"),
                       dendroLabels = FALSE, hang = 0.03,
                       addGuide = TRUE, guideHang = 0.05,
                       main = "Merged module colors"
                     )
                   })
  if (!is.null(p)) plots[[length(plots) + 1L]] <- p

  # 7.7 TOM 热图（抽样；全量画不动也看不清）
  p <- .wgcna_draw(ctx, "tomHeatmap",
                   "Network heatmap plot, selected genes",
                   "随机抽样的基因间 TOM 热图。对角线上的亮块对应模块：块越黄、边界越清楚，模块划分越可靠。",
                   "p10_tom_heatmap.png", 8, 8, function() {
                     nSelect <- min(tomSampleSize, nGenes)
                     set.seed(1234)   # 固定抽样，保证同一份数据两次出图一致
                     select <- sample(nGenes, size = nSelect)
                     selectTOM <- dissTOM[select, select]
                     selectTree <- stats::hclust(stats::as.dist(selectTOM), method = "average")
                     selectColors <- mergedColors[select]
                     plotDiss <- selectTOM ^ softPower
                     diag(plotDiss) <- NA
                     myheatcol <- gplots::colorpanel(250, "red", "orange", "lemonchiffon")
                     WGCNA::TOMplot(plotDiss, selectTree, selectColors, col = myheatcol,
                                    main = "Network heatmap plot, selected genes")
                   })
  if (!is.null(p)) plots[[length(plots) + 1L]] <- p

  # 7.8 模块-性状关系热图
  if (!is.null(moduleTraitCor)) {
    nTraits <- ncol(moduleTraitCor)
    nModules <- nrow(moduleTraitCor)
    hmWidth <- min(12, 6 + 1.2 * nTraits)
    hmHeight <- min(14, max(4, 0.9 * nModules + 2))
    paletteColors <- .wgcna_palette(heatmapPalette)
    p <- .wgcna_draw(ctx, "traitHeatmap",
                     "Module-trait relationships",
                     "模块特征向量与性状的相关性。每格上行是相关系数、括号里是 p 值；颜色越深相关越强，白色接近无关。重点看有没有 |r| 大且 p 小的格子。",
                     "p11_trait_heatmap.png", hmWidth, hmHeight, function() {
                       textMatrix <- paste(signif(moduleTraitCor, 2), "\n(",
                                           signif(moduleTraitPvalue, 1), ")", sep = "")
                       dim(textMatrix) <- dim(moduleTraitCor)
                       graphics::par(mar = c(4.5, 10, 2, 2))
                       WGCNA::labeledHeatmap(
                         Matrix = moduleTraitCor,
                         xLabels = colnames(datTraits),
                         yLabels = rownames(moduleTraitCor),
                         ySymbols = rownames(moduleTraitCor),
                         colorLabels = FALSE,
                         colors = paletteColors,
                         yColorWidth = 0.05,
                         textMatrix = textMatrix,
                         setStdMargins = FALSE,
                         cex.text = 1,
                         zlim = c(-1, 1),
                         main = "Module-trait relationships"
                       )
                     })
    if (!is.null(p)) plots[[length(plots) + 1L]] <- p
  }

  # 7.9 单模块表达热图 + 特征向量柱状图
  # 默认取基因数最多的模块；用户指定了就按指定的来，不存在时回退并警告
  whichModule <- ""
  if (nrow(sizesDf) > 0) {
    whichModule <- sizesDf$module[1]
  }
  if (nzchar(profileModule)) {
    if (profileModule %in% mergedColors) {
      whichModule <- profileModule
    } else {
      emit_log("warn", sprintf("profileModule '%s' does not exist in this network; falling back to '%s'",
                               profileModule, whichModule))
    }
  }
  if (nzchar(whichModule)) {
    moduleGenes <- which(mergedColors == whichModule)
    if (length(moduleGenes) >= 2) {
      p <- .wgcna_draw(ctx, "moduleProfile",
                       sprintf("Module profile: %s", whichModule),
                       sprintf("模块 %s 内每个基因标准化后的表达（上）与模块特征向量（下）。上图行间越整齐、下图柱形起伏越明显，说明该模块越紧凑、越值得后续做通路富集。", whichModule),
                       "p12_module_profile.png", 8, 7, function() {
                         subExpr <- datExpr[, moduleGenes, drop = FALSE]
                         # 零方差基因 scale 后会整行 NaN，先剔掉
                         keepGene <- vapply(subExpr, function(x) stats::sd(x) > 0, logical(1))
                         subExpr <- subExpr[, keepGene, drop = FALSE]
                         if (ncol(subExpr) < 2) stop("module has < 2 non-constant genes")
                         meName <- paste0("ME", whichModule)
                         if (!meName %in% colnames(mergedMEs)) stop("module eigengene not found")
                         ME <- mergedMEs[, meName]
                         graphics::par(mfrow = c(2, 1), mar = c(0.3, 5.5, 3, 2))
                         WGCNA::plotMat(t(scale(subExpr)), nrgcols = 30, rlabels = TRUE,
                                        rcols = whichModule, main = whichModule, cex.main = 2)
                         graphics::par(mar = c(5, 4.2, 2, 0.7))
                         graphics::barplot(ME, col = whichModule, ylab = "eigengene expression", xlab = "")
                       })
      if (!is.null(p)) plots[[length(plots) + 1L]] <- p
    }
  }

  # ---- 8. 结果表清单 ----------------------------------------------------
  tableRows <- function(file) {
    path <- file.path(ctx$runDir, file)
    if (!file.exists(path)) return(0L)
    n <- tryCatch({
      if (requireNamespace("data.table", quietly = TRUE)) {
        nrow(data.table::fread(path, data.table = FALSE, showProgress = FALSE))
      } else {
        length(readLines(path, warn = FALSE)) - 1L
      }
    }, error = function(e) 0L)
    as.integer(max(0L, n))
  }

  tables <- list()
  addTable <- function(id, label, file, rows, columns) {
    if (!file.exists(file.path(ctx$runDir, file))) return(invisible(NULL))
    tables[[length(tables) + 1L]] <<- list(
      id = id, label = label, file = file,
      rows = as.integer(rows), columns = columns
    )
    invisible(NULL)
  }
  addTable("powers", "软阈值拟合表", "wgcna_powers.csv",
           tableRows("wgcna_powers.csv"), "power, signedR2, slope, meanK, medianK, maxK")
  addTable("genes", "基因模块归属", "wgcna_genes.csv",
           nrow(genesDf), "gene, dynamicMods, dynamicColors, moduleLabels, mergedColor")
  addTable("modules", "模块大小", "wgcna_module_sizes.csv",
           nrow(sizesDf), "module, genes")
  addTable("traits", "模块-性状相关", "wgcna_module_trait.csv",
           nrow(traitLong), "module, trait, cor, pvalue, fdr")
  addTable("eigengenes", "模块特征向量", "wgcna_eigengenes.csv",
           nrow(meOut), "sample, MExxx (one column per module)")

  # ---- 9. 可选：保存第二段中间态（便于恢复，不强制）----------------------
  tryCatch({
    saveRDS(list(
      mergedColors = mergedColors,
      moduleLabels = moduleLabels,
      geneTree = geneTree,
      mergedMEs = mergedMEs,
      softPower = softPower,
      minModuleSize = minModuleSize,
      mergeHeight = mergeHeight
    ), file.path(ctx$runDir, "stage2.rds"))
  }, error = function(e) emit_log("warn", paste0("failed to save stage2.rds: ", conditionMessage(e))))

  # ---- 10. 返回 ---------------------------------------------------------
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    wgcnaId = wgcnaId,
    runDir = ctx$runDir,
    geneCount = as.integer(nGenes),
    # 空数组时也必须是 JSON []：unname(lapply(...)) 保证不会被 auto_unbox 塌成对象
    modules = unname(lapply(seq_len(nrow(sizesDf)), function(i) {
      list(module = as.character(sizesDf$module[i]), genes = as.integer(sizesDf$genes[i]))
    })),
    traitRows = unname(lapply(seq_len(nrow(traitLong)), function(i) {
      list(
        module = as.character(traitLong$module[i]),
        trait = as.character(traitLong$trait[i]),
        cor = as.numeric(traitLong$cor[i]),
        pvalue = as.numeric(traitLong$pvalue[i]),
        fdr = as.numeric(traitLong$fdr[i])
      )
    })),
    plots = unname(plots),
    tables = unname(tables),
    tomCached = isTRUE(tomCached),
    softPower = as.integer(softPower),
    minModuleSize = as.integer(minModuleSize),
    mergeHeight = as.numeric(mergeHeight),
    profileModule = whichModule,
    durationMs = as.integer(durationMs)
  ))
})
