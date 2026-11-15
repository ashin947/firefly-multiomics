# =============================================================================
# r/common/de.R —— 差异分析的公共逻辑（四个 run_*.R 共用：voom / lm / deseq2 / edger）
#
# 为什么集中：limma-voom / limma-lm / DESeq2 / edgeR 四个脚本在「读数据 → 对齐分组 →
# 建设计矩阵 → 过滤 → 写 9 列结果」这几步完全一致。若各写一遍，最危险的
# logFC 方向（实验组 vs 对照）就有四份实现，任何一处写反都是"结果看起来正常
# 但结论完全相反"的灾难性 bug。
#
# ★ logFC 方向的唯一约定（务必理解后再改）：
#     design <- model.matrix(~ 0 + group)   # 无截距，每列 = 一个组的均值
#     makeContrasts(contrasts = "`实验组` - `对照组`", levels = design)
#   这样 logFC = mean(实验组) - mean(对照组)，
#   即 **logFC > 0 表示在实验组上调**，与界面「实验组 / 对照（基线）」的语义严格一致。
#   若写成 ~ group（有截距），基线组会被吸收进截距，对比含义随 factor levels 变化，
#   是这类脚本最经典的符号错误来源。
# =============================================================================

#' 读入表达矩阵 + 分组表，构造设计矩阵
#'
#' @return list(expr, geneIds, samples, groupVec, groupFactor, design, levels)
deg_de_prepare <- function(ctx) {
  matrixPath <- deg_abs_path(ctx, deg_param_required(ctx, "matrixPath"))
  groupsPath <- deg_abs_path(ctx, deg_param_required(ctx, "groupsPath"))
  sampleColumn <- as.character(deg_param(ctx, "sampleColumn", "sample"))
  groupColumn <- as.character(deg_param(ctx, "groupColumn", "group"))

  emit_progress("read", 3, "reading expression matrix")
  mat <- deg_read_matrix(matrixPath)

  geneIds <- as.character(mat[[1]])
  if (anyDuplicated(geneIds) > 0) {
    # clean.csv 应当已经聚合过重复基因；走到这里说明上游清洗有 bug
    deg_stop("E_DATA_DUP_GENE",
             paste0("duplicated gene ids in clean matrix: ", anyDuplicated(geneIds, value = TRUE)),
             status = 13L)
  }

  expr <- as.matrix(mat[, -1, drop = FALSE])
  storage.mode(expr) <- "double"
  rownames(expr) <- geneIds
  samples <- colnames(expr)
  emit_log("info", sprintf("expression matrix: %d genes x %d samples", nrow(expr), ncol(expr)))
  emit_progress("read", 15, "reading groups table")

  groups <- deg_read_groups(groupsPath, sampleColumn, groupColumn)
  # 双向严格校验：任一边多出样本都直接报错（PRD §8.2）
  deg_validate_samples(samples, groups$sample)

  idx <- match(samples, groups$sample)
  groupVec <- as.character(groups$group[idx])
  if (any(is.na(groupVec) | !nzchar(groupVec))) {
    deg_stop("E_DATA_SAMPLE_MISMATCH", "some samples have empty group label", status = 13L)
  }

  levelsOrder <- unique(groupVec)
  if (length(levelsOrder) < 2) {
    deg_stop("E_DATA_GROUP_TOO_FEW",
             paste0("only one group detected: ", paste(levelsOrder, collapse = ", ")),
             status = 13L)
  }

  # ---- 组内样本数 -----------------------------------------------------------
  # limma 与 DESeq2 都需要 ≥2 个样本才能估计组内方差。
  # ★ 这条检查原本只写在 deg_validate_contrast() 里，而该函数全项目都只以
  #   groups = NULL 调用（见下方 deg_de_contrast），于是组内样本数分支是**死代码**：
  #   「每组 1 个样本」会一路走到 voom / DESeq 才崩，退出码是读不出语义的 10，
  #   而契约（§5.5）说这属于「数据不满足前置条件」= 13。
  #   前移到 prepare（三个 run_*.R 的第一步）之后，exit 13 才真的可达。
  groupSizes <- table(groupVec)
  tooSmall <- names(groupSizes)[groupSizes < 2]
  if (length(tooSmall) > 0) {
    deg_stop(
      "E_DATA_GROUP_TOO_SMALL",
      paste0(
        "group(s) with fewer than 2 samples: ",
        paste(sprintf("%s(%d)", tooSmall, as.integer(groupSizes[tooSmall])), collapse = ", "),
        "; at least 2 are needed to estimate within-group variance"
      ),
      status = 13L
    )
  }

  # ★ 无截距设计矩阵：每列直接对应一个组的均值，见文件头的方向约定
  groupFactor <- factor(groupVec, levels = levelsOrder)
  design <- stats::model.matrix(~ 0 + groupFactor)
  colnames(design) <- levelsOrder
  rownames(design) <- samples

  emit_log("info", paste0("groups: ", paste(sprintf("%s(%d)", levelsOrder,
    as.integer(table(groupFactor))), collapse = ", ")))

  list(
    expr = expr,
    geneIds = geneIds,
    samples = samples,
    groupVec = groupVec,
    groupFactor = groupFactor,
    design = design,
    levels = levelsOrder
  )
}

#' 低表达过滤（PRD R-11）
#'
#' @param countsLike 输入是否是**原始 counts**。
#'   `filterByExpr()` 内部按 CPM 与文库大小计算，只对 counts 有意义；
#'   对已 log2 的数据它会把几乎所有基因都留下（CPM 无从谈起）。
#'   默认 TRUE，因此 limma-voom / DESeq2 / edgeR 三个脚本的行为一字不变；
#'   只有 `run_limma_norm.R` 的「已 log2」分支传 FALSE 走降级规则。
#' @return list(keep = logical 向量, filteredOut = 被过滤掉的基因数)
deg_de_filter <- function(expr, design, ctx, countsLike = TRUE) {
  keepAll <- isTRUE(deg_param(ctx, "keepAllGenes", FALSE))
  filterCfg <- deg_param(ctx, "filter", list(enabled = TRUE, mode = "filterByExpr"))
  enabled <- if (is.null(filterCfg$enabled)) TRUE else isTRUE(filterCfg$enabled)

  if (keepAll || !enabled) {
    emit_progress("filter", 25, "expression filter disabled")
    return(list(keep = rep(TRUE, nrow(expr)), filteredOut = 0L))
  }

  mode <- if (is.null(filterCfg$mode)) "filterByExpr" else as.character(filterCfg$mode)
  if (identical(mode, "custom")) {
    minCount <- as.numeric(if (is.null(filterCfg$minCount)) 10 else filterCfg$minCount)
    minPct <- as.numeric(if (is.null(filterCfg$minSamplesPct)) 50 else filterCfg$minSamplesPct)
    need <- max(1L, ceiling(ncol(expr) * minPct / 100))
    keep <- rowSums(expr >= minCount) >= need
    emit_log("info", sprintf("custom filter: >= %g in >= %d samples", minCount, need))
  } else if (!countsLike) {
    # ★ 这里曾经是一个真 bug：run_limma_norm.R 对已 log2 的数据调用 filterByExpr，
    #   而 filterByExpr 按 CPM 与文库大小算阈值，喂给它 log2 值毫无意义
    #   （实测会保留几乎所有基因，等于没过滤）。
    #   降级为 log2 表达量的常识阈值：>= 1（即 CPM >= 2）且在 >= 50% 样本中检出。
    minCount <- 1
    minPct <- 50
    need <- max(1L, ceiling(ncol(expr) * minPct / 100))
    keep <- rowSums(expr >= minCount) >= need
    emit_log("warn",
             "filterByExpr is designed for counts; using log2 expression >= 1 in >= 50% samples instead")
  } else {
    deg_ensure_pkgs("edgeR")
    keep <- edgeR::filterByExpr(expr, design = design)
    emit_log("info", "filterByExpr applied")
  }

  if (!any(keep)) {
    deg_stop("E_DATA_EMPTY",
             "low-expression filter removed every gene; please relax the filter thresholds",
             status = 13L)
  }
  list(keep = keep, filteredOut = as.integer(sum(!keep)))
}

#' 生成对比表达式（带反引号，兼容含空格/连字符的组名）
deg_de_contrast <- function(contrast, levels) {
  deg_validate_contrast(contrast, NULL)
  num <- as.character(contrast$numerator)
  den <- as.character(contrast$denominator)
  for (g in c(num, den)) {
    if (!g %in% levels) {
      deg_stop("E_DATA_SAMPLE_MISMATCH",
               paste0("group not found in design: ", g,
                      " (available: ", paste(levels, collapse = ", "), ")"),
               status = 13L)
    }
  }
  # 反引号是必须的：组名可能是 "Tumor stage III" 这种含空格的字符串
  sprintf("`%s` - `%s`", num, den)
}

#' 取基因名（gene_name 列）
#'
#' 只有用户开启 outputGeneName 且 ID 不是 SYMBOL 时才查注释库；
#' 查不到就 NA（不阻断：gene_name 只是展示用，gene_id 才是主键）。
deg_de_gene_names <- function(geneIds, species, geneIdType, outputGeneName) {
  if (!isTRUE(outputGeneName)) return(rep(NA_character_, length(geneIds)))
  if (identical(geneIdType, "SYMBOL")) return(geneIds)

  orgPkg <- if (identical(species, "mouse")) "org.Mm.eg.db" else "org.Hs.eg.db"
  result <- rep(NA_character_, length(geneIds))
  ok <- tryCatch({
    suppressPackageStartupMessages(
      library(orgPkg, character.only = TRUE, quietly = TRUE, warn.conflicts = FALSE)
    )
    db <- get(orgPkg)
    from <- switch(geneIdType,
      ENSEMBL = "ENSEMBL",
      ENTREZ = "ENTREZID",
      "SYMBOL"
    )
    sel <- suppressMessages(AnnotationDbi::select(
      db, keys = geneIds, columns = c("SYMBOL"), keytype = from
    ))
    hit <- match(geneIds, as.character(sel[[from]]))
    result <- as.character(sel$SYMBOL[hit])
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("gene name lookup failed: ", conditionMessage(e)))
    FALSE
  })
  if (!isTRUE(ok)) return(rep(NA_character_, length(geneIds)))
  result
}

#' 统一写结果：9 列固定顺序 + de.csv/de.json + artifact + result
#'
#' @param tt data.frame，至少含 logFC / AveExpr / t / P.Value / adj.P.Val
#' @param baseMean 可选：DESeq2 用 baseMean 替代 AveExpr，B 置 NA
deg_de_write <- function(ctx, tt, geneIds, filteredOut, startedAt, baseMean = NULL, b = NULL) {
  emit_progress("write", 92, "writing de.csv")

  geneName <- deg_de_gene_names(
    geneIds,
    as.character(deg_param(ctx, "species", "human")),
    as.character(deg_param(ctx, "geneIdType", "SYMBOL")),
    isTRUE(deg_param(ctx, "outputGeneName", TRUE))
  )

  logFC <- as.numeric(tt$logFC)
  pValue <- as.numeric(tt$P.Value)
  adjP <- as.numeric(tt$adj.P.Val)

  # regulation 列按**分析时配置的阈值**判定，谓词与前端 utils/threshold.ts 的
  # isSignificant 逐字相同：
  #   pValue 有限且 < 1  且  |logFC| >= logFCThreshold  且  adjPValue < fdrThreshold
  #
  # 为什么 R 也要按阈值判（而不是只标个符号 + p<0.05）：
  #   用户会把 de.csv 发给导师、放进论文附表。如果 CSV 里的 up/down 用的是另一套口径，
  #   他数出来的行数和界面统计卡对不上 —— 不报错，但结论不一致，比崩溃更难发现。
  #   实测案例：同一份 limma-voom 结果，旧口径写出 118/98，界面是 75/48。
  #
  # 界面**仍然不读**这一列（拖动滑块时按新阈值现算），所以
  # 「火山图显著点数 == 结果表行数」严格相等这条不受影响。
  logFCThreshold <- as.numeric(deg_param(ctx, "logFCThreshold", 1.0))
  fdrThreshold <- as.numeric(deg_param(ctx, "fdrThreshold", 0.05))
  # 防御：配置里给了 null/NA/向量时退回 PRD 默认值，不要静默产出全 "ns"
  if (length(logFCThreshold) != 1 || !is.finite(logFCThreshold)) logFCThreshold <- 1.0
  if (length(fdrThreshold) != 1 || !is.finite(fdrThreshold)) fdrThreshold <- 0.05

  usable <- is.finite(pValue) & is.finite(adjP) & is.finite(logFC)
  significant <- usable & pValue < 1 & abs(logFC) >= logFCThreshold & adjP < fdrThreshold
  regulation <- ifelse(significant, ifelse(logFC > 0, "up", "down"), "ns")

  emit_log("info", paste0(
    "regulation thresholds: |logFC| >= ", logFCThreshold,
    " & FDR < ", fdrThreshold,
    " -> up=", sum(regulation == "up"),
    " down=", sum(regulation == "down"),
    " ns=", sum(regulation == "ns")
  ))

  out <- data.frame(
    gene_id = geneIds,
    gene_name = geneName,
    logFC = logFC,
    aveExpr = if (is.null(baseMean)) as.numeric(tt$AveExpr) else as.numeric(baseMean),
    t = as.numeric(tt$t),
    pValue = pValue,
    adjPValue = adjP,
    b = if (is.null(b)) as.numeric(tt$B) else as.numeric(b),
    regulation = regulation,
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  csvPath <- file.path(ctx$runDir, "de.csv")
  jsonPath <- file.path(ctx$runDir, "de.json")
  deg_write_csv(out, csvPath)
  deg_write_json(out, jsonPath)

  emit_artifact("de_table", "de.csv", rows = nrow(out), schema = "DEResultRow[]")
  emit_artifact("de_table", "de.json", rows = nrow(out), schema = "DEResultRow[]")
  emit_progress("write", 100, "done")

  up <- sum(regulation == "up")
  down <- sum(regulation == "down")
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000

  emit_result(list(
    genesAfterFilter = nrow(out),
    up = up,
    down = down,
    ns = nrow(out) - up - down,
    filteredOut = as.integer(filteredOut),
    durationMs = as.integer(durationMs),
    contrast = as.character(deg_param(ctx, "contrast", list())$numerator %||% ""),
    # 把实际使用的阈值回传：summary 里的 up/down/ns 只在这一对阈值下有意义，
    # 不回传的话「这个 123 是怎么来的」以后没人说得清。
    logFCThreshold = logFCThreshold,
    fdrThreshold = fdrThreshold
  ))
}

#' R 没有内置的 %||%（R 4.4 才有），这里自带一个
`%||%` <- function(a, b) if (is.null(a)) b else a
