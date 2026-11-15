# =============================================================================
# r/viz/plot_survival.R —— Kaplan-Meier 生存曲线（survminer::ggsurvplot）
#
# 输入：
#   clinicalPath  随访表，至少含 样本 / 时间 / 状态 三列（列名可自动识别）
#   matrixPath    分组方式为「按基因表达」时才需要
#
# 两种分组：
#   table  用随访表里自带的分组列（用户自己的组，可以 >2 组）
#   gene   按某个基因的表达量切分：中位数 / 三分位 / 四分位 / 最优截断
#
# ## 为什么状态列要单独归一化
#
# 临床表的状态写法五花八门：0/1、Dead/Alive、Yes/No、死亡/存活，还有 1/2 编码
# （2 表示删失）。`survival::Surv` 只认 0/1/2，其中 2 等于删失 —— 把 "Alive"
# 直接丢进去会得到 NA 然后整条曲线画不出来；把 Dead/Alive 当成字符因子又会
# 被当成两组。更糟的是把 1/2 当 0/1 用：事件和删失完全反了，图看起来完全正常。
# 所以这里只认能确定的写法，认不出就报错并列出实际出现的值。
#
# ## 为什么不用 ggsurvplot 的 palette 参数直接传字符串
#
# ggsurvplot 的 palette 接受函数或色值向量，不认 "lancet" 这种名字。
# 先用 resolve_palette 转成色值向量再传，界面才能统一提供「配色方案」下拉。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

.plot_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 按基因表达把样本切成分组
#'
#' `optimal` 用 survminer::surv_cutpoint 找最优截断点（基于 maxstat 统计量）。
#' 它需要至少 ~20 个样本和足够的事件数，样本少时会报错 —— 这里捕获后
#' 退回中位数切分并明确告知，而不是让用户对着一张空图猜。
.cut_by_expression <- function(values, time, status, method) {
  n <- length(values)
  if (identical(method, "optimal")) {
    cut <- tryCatch({
      dfTmp <- data.frame(time = time, status = status, expr = values)
      cp <- survminer::surv_cutpoint(dfTmp, time = "time", event = "status",
                                     variables = "expr", minprop = 0.2)
      as.numeric(cp$cutpoint[1, 1])
    }, error = function(e) {
      emit_log("warn", paste0("最优截断失败（样本量或事件数不足）：", conditionMessage(e),
                              "；改用中位数分组"))
      stats::median(values, na.rm = TRUE)
    })
    groups <- ifelse(values > cut, "High", "Low")
    return(list(groups = groups, cut = cut, method = "optimal"))
  }

  if (identical(method, "tertile")) {
    br <- stats::quantile(values, probs = c(0, 1 / 3, 2 / 3, 1), na.rm = TRUE)
    groups <- as.character(cut(values, breaks = br, labels = c("Low", "Medium", "High"),
                              include.lowest = TRUE))
    return(list(groups = groups, cut = br[2:3], method = "tertile"))
  }
  if (identical(method, "quartile")) {
    br <- stats::quantile(values, probs = seq(0, 1, 0.25), na.rm = TRUE)
    groups <- as.character(cut(values, breaks = br, labels = c("Q1", "Q2", "Q3", "Q4"),
                              include.lowest = TRUE))
    return(list(groups = groups, cut = br[2:4], method = "quartile"))
  }

  cut <- stats::median(values, na.rm = TRUE)
  list(groups = ifelse(values > cut, "High", "Low"), cut = cut, method = "median")
}

deg_main("viz/plot_survival.R", function(ctx) {
  deg_ensure_pkgs(c("data.table", "survival", "survminer"))
  startedAt <- Sys.time()

  clinicalPath <- as.character(.plot_param(ctx, "clinicalPath", ""))
  matrixPath <- as.character(.plot_param(ctx, "matrixPath", ""))
  groupBy <- as.character(.plot_param(ctx, "groupBy", "table"))
  groupColumn <- as.character(.plot_param(ctx, "groupColumn", ""))
  timeColumn <- as.character(.plot_param(ctx, "timeColumn", ""))
  statusColumn <- as.character(.plot_param(ctx, "statusColumn", ""))
  geneName <- as.character(.plot_param(ctx, "gene", ""))
  cutMethod <- as.character(.plot_param(ctx, "cutMethod", "median"))

  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 7.5))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 6.5))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))
  title <- as.character(.plot_param(ctx, "title", ""))

  paletteSpec <- as.character(.plot_param(ctx, "palette", "lancet"))
  confInt <- isTRUE(.plot_param(ctx, "confInt", TRUE))
  pval <- isTRUE(.plot_param(ctx, "pval", TRUE))
  pvalMethod <- isTRUE(.plot_param(ctx, "pvalMethod", TRUE))
  logRankWeights <- as.character(.plot_param(ctx, "logRankWeights", "1"))
  riskTable <- isTRUE(.plot_param(ctx, "riskTable", TRUE))
  riskTableHeight <- as.numeric(.plot_param(ctx, "riskTableHeight", 0.25))
  legendLabs <- as.character(.plot_param(ctx, "legendLabs", character(0)))
  xLabel <- as.character(.plot_param(ctx, "xLabel", ""))
  yLabel <- as.character(.plot_param(ctx, "yLabel", ""))

  if (!nzchar(outPath)) {
    deg_stop("E_VALIDATION", "missing required parameter: outPath", status = 11L)
  }

  emit_progress("read", 15, "reading follow-up table")
  clin <- read_viz_table(clinicalPath)
  cols <- names(clin)

  sampleColumn <- pick_column(
    cols,
    c("^(sample|sample_?id|sample_?name|patient|patient_?id|case|id|样本|样本id|病人|患者)$"),
    cols[1]
  )
  if (!nzchar(timeColumn)) {
    timeColumn <- pick_column(
      cols,
      c("^(time|os|os_?time|dfs|rfs|follow_?up|followup|survival_?time|months|days|生存时间|随访时间|时间)$"),
      ""
    )
  }
  if (!nzchar(statusColumn)) {
    statusColumn <- pick_column(
      cols,
      c("^(status|event|os_?status|censor|censored|dead|death|vital_?status|state|结局|状态|生存状态)$"),
      ""
    )
  }

  if (!nzchar(timeColumn) || !timeColumn %in% cols) {
    deg_stop("E_DATA_SCHEMA",
             paste0("找不到随访时间列。现有列：", paste(cols, collapse = ", "),
                    "；请指定哪一列是生存时间。"),
             status = 10L)
  }
  if (!nzchar(statusColumn) || !statusColumn %in% cols) {
    deg_stop("E_DATA_SCHEMA",
             paste0("找不到结局状态列。现有列：", paste(cols, collapse = ", "),
                    "；请指定哪一列表示是否发生事件。"),
             status = 10L)
  }

  df <- data.frame(
    sample = trimws(as.character(clin[[sampleColumn]])),
    time = suppressWarnings(as.numeric(clin[[timeColumn]])),
    status = normalize_status(clin[[statusColumn]], statusColumn),
    stringsAsFactors = FALSE
  )
  df <- df[!is.na(df$time) & is.finite(df$time) & df$time > 0 & !is.na(df$status), , drop = FALSE]
  if (nrow(df) < 5) {
    deg_stop("E_DATA_EMPTY",
             sprintf("有效随访记录只有 %d 条（需要时间>0 且状态可识别），无法做生存分析。",
                     nrow(df)),
             status = 13L)
  }

  # ---- 分组 ---------------------------------------------------------
  emit_progress("prepare", 35, "building groups")
  if (identical(groupBy, "gene")) {
    if (!nzchar(geneName)) {
      deg_stop("E_VALIDATION", "按基因表达分组时必须指定基因名。", status = 11L)
    }
    if (!nzchar(matrixPath) || !file.exists(matrixPath)) {
      deg_stop("E_VALIDATION",
               "按基因表达分组时必须提供表达矩阵。", status = 11L)
    }
    mat <- read_viz_table(matrixPath)
    matCols <- names(mat)
    geneColumn <- pick_column(
      matCols,
      c("^(gene|gene_?id|gene_?symbol|gene_?name|symbol|id|基因|基因id|基因名)$"),
      matCols[1]
    )
    geneIds <- trimws(as.character(mat[[geneColumn]]))
    idx <- which(geneIds == geneName)
    if (length(idx) == 0) {
      deg_stop("E_DATA_NOT_FOUND",
               paste0("矩阵里找不到基因 '", geneName, "'。"),
               status = 13L)
    }
    sampleCols <- setdiff(matCols, geneColumn)
    expr <- suppressWarnings(as.numeric(unlist(mat[idx[1], sampleCols, with = FALSE])))
    names(expr) <- sampleCols

    matched <- df$sample %in% names(expr)
    if (sum(matched) < 5) {
      deg_stop("E_DATA_SCHEMA",
               sprintf("随访表样本名与矩阵列名只对上了 %d 个，请检查两边的样本命名。",
                       sum(matched)),
               status = 10L)
    }
    df <- df[matched, , drop = FALSE]
    df$expr <- expr[df$sample]

    cutResult <- .cut_by_expression(df$expr, df$time, df$status, cutMethod)
    df$group <- cutResult$groups
    df <- df[!is.na(df$group), , drop = FALSE]
    cutInfo <- cutResult$cut
    emit_log("info", sprintf("grouped by %s expression (%s), cutpoint=%s",
                             geneName, cutResult$method,
                             paste(signif(cutInfo, 4), collapse = ",")))
    defaultXLabel <- "Time"
  } else {
    if (!nzchar(groupColumn)) {
      groupColumn <- pick_column(
        cols,
        c("^(group|group_?id|group_?name|condition|treat|treatment|class|分组|组别)$"),
        ""
      )
    }
    if (!nzchar(groupColumn) || !groupColumn %in% cols) {
      deg_stop("E_DATA_SCHEMA",
               paste0("找不到分组列。现有列：", paste(cols, collapse = ", "),
                      "；也可以改为「按基因表达分组」。"),
               status = 10L)
    }
    df$group <- trimws(as.character(clin[[groupColumn]]))[match(
      df$sample, trimws(as.character(clin[[sampleColumn]]))
    )]
    df <- df[!is.na(df$group) & nzchar(df$group), , drop = FALSE]
    cutInfo <- NULL
    defaultXLabel <- "Time"
  }

  # 分组顺序按首次出现顺序（与分组表/随访表的书写顺序一致）
  groupLevels <- unique(df$group)
  df$group <- factor(df$group, levels = groupLevels)
  groupSizes <- as.integer(table(df$group))
  if (length(groupLevels) < 2) {
    deg_stop("E_VALIDATION",
             "只有一个分组，无法比较生存曲线。", status = 11L)
  }
  if (any(groupSizes < 2)) {
    emit_log("warn", sprintf("有分组样本数不足 2（%s），置信区间会退化",
                             paste(groupLevels[groupSizes < 2], collapse = ", ")))
  }
  emit_log("info", sprintf("groups: %s", paste(sprintf("%s=%d", groupLevels, groupSizes),
                                               collapse = ", ")))

  # ---- 拟合与绘图 ---------------------------------------------------
  emit_progress("fit", 55, "fitting survival curves")
  fit <- survival::survfit(survival::Surv(time, status) ~ group, data = df)

  lrP <- tryCatch({
    d <- survival::survdiff(survival::Surv(time, status) ~ group, data = df)
    stats::pchisq(d$chisq, df = length(d$n) - 1, lower.tail = FALSE)
  }, error = function(e) NA_real_)
  emit_log("info", sprintf("log-rank p = %s", if (is.na(lrP)) "NA" else format_p(lrP)))

  colors <- resolve_palette(paletteSpec, length(groupLevels))
  labs <- legendLabs
  labs <- labs[nzchar(labs)]
  if (length(labs) != length(groupLevels)) {
    if (length(labs) > 0) {
      emit_log("warn", sprintf("图例标签给了 %d 个但实际有 %d 组，改用组名",
                               length(labs), length(groupLevels)))
    }
    labs <- groupLevels
  }

  emit_progress("render", 75, "drawing")
  plotArgs <- list(
    fit = fit,
    data = df,
    size = 1,
    palette = colors,
    conf.int = confInt,
    pval = pval,
    risk.table = riskTable,
    risk.table.col = "strata",
    risk.table.height = riskTableHeight,
    legend.labs = labs,
    legend.title = "",
    xlab = if (nzchar(xLabel)) xLabel else defaultXLabel,
    ylab = if (nzchar(yLabel)) yLabel else "Survival probability",
    ggtheme = ggpubr::theme_classic2(),
    # ggsurvplot 的 log.rank.weights 只在 pval=TRUE 时生效；给非法值会让
    # survdiff 直接报错，所以先校验一遍再传
    log.rank.weights = logRankWeights
  )
  if (pval && pvalMethod) plotArgs$pval.method <- TRUE
  if (!nzchar(title)) plotArgs$title <- NULL else plotArgs$title <- title

  ggs <- tryCatch(
    do.call(survminer::ggsurvplot, plotArgs),
    error = function(e) {
      deg_stop("E_R_PLOT",
               paste0("ggsurvplot failed: ", conditionMessage(e)),
               status = 13L)
    }
  )

  if (identical(format, "pdf")) deg_open_pdf(outPath, widthIn, heightIn)
  else deg_open_png(outPath, widthIn, heightIn, dpi)
  on.exit(deg_close_devices(), add = TRUE)
  # print.ggsurvplot 负责把主图与 risk table 用 grid 拼在一页上；
  # 直接 print(ggs$plot) 会把 risk table 丢掉
  print(ggs)
  deg_close_devices()

  if (!file.exists(outPath)) {
    deg_stop("E_IO_WRITE", paste0("image was not written: ", outPath), status = 14L)
  }

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  emit_result(list(
    groupBy = groupBy,
    gene = if (identical(groupBy, "gene")) geneName else NULL,
    cutMethod = if (identical(groupBy, "gene")) cutMethod else NULL,
    cutpoint = as.list(cutInfo),
    groups = as.list(groupLevels),
    groupSizes = as.list(groupSizes),
    events = as.list(as.integer(tapply(df$status, df$group, sum))),
    logRankP = lrP,
    logRankWeights = logRankWeights,
    medianSurvival = as.list(summary(fit)$table[, "median"]),
    nSamples = nrow(df),
    bytes = as.integer(file.size(outPath)),
    durationMs = as.integer(durationMs)
  ))
})
