# =============================================================================
# r/viz/plot_venn.R —— 多组基因列表的 Venn 图
#
# 输入：sets.csv（两列 set / gene，由主进程从界面粘贴的内容写出）
# 输出：PNG 或 PDF
#
# ## 为什么 2~5 组和 6~7 组用两套画法
#
# VennDiagram 只支持到 5 组（draw.quintuple.venn 是它的上限）。6 组以上
# 用椭圆 / 圆形硬凑，必然出现「某个交集区域画不出来或位置重叠」——图看着像
# Venn，实际读数是错的，这比画不出来更糟。
# 所以 6~7 组改用 ggVennDiagram 的矩形布局：形状不再是圆，但**每个交集都被
# 真实画出并标注**。这个取舍会写进 summary$method，界面据此提示用户。
#
# ## print.mode
#
# VennDiagram 原生支持 "raw" / "percent" / c("raw","percent")，
# 不需要自己算百分比再叠文字。
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

#' 默认配色（与 resources/plotTheme.json 的强调色系接近，深色版更耐看）
.viz_palette <- function(n, palette) {
  fallback <- c("#4C72B0", "#DD8452", "#55A868", "#C44E52",
                "#8172B3", "#937860", "#DA8BC3")
  cols <- as.character(palette)
  cols <- cols[nzchar(cols)]
  if (length(cols) == 0) return(rep(fallback, length.out = n))
  rep(cols, length.out = n)
}

#' 计算每个「专有区域」的元素及其个数
#'
#' 专有区域 = 恰好属于这一组集合、不属于其余任何集合的部分。
#' 直接 intersect 得到的是「包含」而不是「仅包含」，会把上层区域重复计数，
#' 所以必须再 setdiff 掉其它所有集合的并集。
#'
#' 组数上限 7 → 最多 127 个非空组合，对几千个基因来说是毫秒级；
#' 不做「只算相邻两层」那种优化，因为那需要另一套容易写错的递推。
#'
#' ## 为什么连基因列表一起返回
#'
#' 客户要求「点图上的数字，看这个交集里到底有哪些基因」。所以每个区域必须带上
#' 成员，光有 count 没法回答他。
#' 别担心体积：这些**专有区域是互斥的**，它们恰好把并集切开，所以全部区域的
#' 基因总数 = 并集大小（不是 组数 × 基因数）。7 组各 5000 个基因、完全不重叠
#' 也就是 35000 个字符串，JSON 约 300KB，IPC 扛得住。
.compute_regions <- function(sets) {
  n <- length(sets)
  labels <- names(sets)
  out <- list()
  for (mask in seq_len(2^n - 1)) {
    members <- which(bitwAnd(mask, 2^(seq_len(n) - 1)) > 0)
    inside <- Reduce(intersect, sets[members])
    outside <- setdiff(seq_len(n), members)
    if (length(outside) > 0) {
      inside <- setdiff(inside, Reduce(union, sets[outside]))
    }
    out[[length(out) + 1]] <- list(
      region = paste(labels[members], collapse = " & "),
      sets = as.list(labels[members]),
      count = length(inside),
      # 排序让前端展示稳定（同样的数据两次打开顺序一致，方便对照）。
      # ★ 必须包成 as.list：协议的 toJSON 用了 auto_unbox = TRUE，会把**长度为 1
      #   的原子向量**展开成标量。某个交集恰好只有 1 个基因时，genes 就会从
      #   ["TP53"] 变成 "TP53"，前端 `genes.join()` 直接 TypeError 白屏
      #   （客户就是这么撞上的）。as.list 之后它永远序列化成数组。
      genes = as.list(sort(inside))
    )
  }
  out
}

deg_main("viz/plot_venn.R", function(ctx) {
  deg_ensure_pkgs(c("data.table", "grid"))
  startedAt <- Sys.time()

  dataPath <- as.character(.plot_param(ctx, "dataPath", ""))
  outPath <- as.character(.plot_param(ctx, "outPath", ""))
  format <- as.character(.plot_param(ctx, "format", "png"))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 7))
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 6))
  dpi <- as.numeric(.plot_param(ctx, "dpi", 300))
  title <- as.character(.plot_param(ctx, "title", ""))

  fillOn <- isTRUE(.plot_param(ctx, "fill", TRUE))
  showCount <- isTRUE(.plot_param(ctx, "showCount", TRUE))
  showPercent <- isTRUE(.plot_param(ctx, "showPercent", FALSE))
  palette <- .plot_param(ctx, "palette", character(0))
  labelSize <- as.numeric(.plot_param(ctx, "labelSize", 0))

  if (!nzchar(dataPath) || !file.exists(dataPath)) {
    deg_stop("E_VALIDATION", paste0("sets file not found: ", dataPath), status = 11L)
  }
  if (!nzchar(outPath)) {
    deg_stop("E_VALIDATION", "missing required parameter: outPath", status = 11L)
  }

  emit_progress("read", 15, "reading gene lists")
  dt <- data.table::fread(dataPath, encoding = "UTF-8")
  if (!all(c("set", "gene") %in% names(dt))) {
    deg_stop("E_DATA_SCHEMA",
             paste0("sets file must have columns set,gene; got: ",
                    paste(names(dt), collapse = ",")),
             status = 10L)
  }

  setOrder <- as.character(.plot_param(ctx, "setOrder", character(0)))
  if (length(setOrder) == 0) setOrder <- unique(as.character(dt$set))

  sets <- lapply(setOrder, function(name) {
    unique(trimws(as.character(dt$gene[as.character(dt$set) == name])))
  })
  sets <- lapply(sets, function(x) x[nzchar(x)])
  names(sets) <- setOrder
  sets <- sets[lengths(sets) > 0]

  n <- length(sets)
  if (n < 2) {
    deg_stop("E_VALIDATION",
             sprintf("need at least 2 non-empty gene sets, got %d", n), status = 11L)
  }
  if (n > 7) {
    deg_stop("E_VALIDATION",
             sprintf("at most 7 gene sets are supported, got %d", n), status = 11L)
  }

  emit_log("info", sprintf("sets: %d (%s)",
                           n, paste(sprintf("%s=%d", names(sets), lengths(sets)), collapse = ", ")))

  colors <- .viz_palette(n, palette)

  # print.mode 直接决定区域里印什么，不需要自己算百分比
  printMode <- if (showCount && showPercent) {
    c("raw", "percent")
  } else if (showPercent) {
    "percent"
  } else if (showCount) {
    "raw"
  } else {
    "none"
  }

  emit_progress("render", 45, "drawing venn diagram")

  if (n <= 5) {
    deg_ensure_pkgs(c("VennDiagram", "futile.logger"))
    # VennDiagram 默认把每一步写进 stdout（形如 INFO [2026-..] ...），
    # 那会污染 R 协议通道的日志，必须压到 ERROR 级
    futile.logger::flog.threshold(futile.logger::ERROR, name = "VennDiagramLogger")

    # cex 是「相对默认字号的倍数」，默认大约 12pt
    countCex <- if (labelSize > 0) labelSize / 12 else max(0.7, min(1.8, 3.2 / n))
    catCex <- if (labelSize > 0) labelSize / 11 else max(0.75, min(1.6, 3.0 / n))

    grob <- tryCatch(
      VennDiagram::venn.diagram(
        x = sets,
        filename = NULL,
        disable.logging = TRUE,
        fill = if (fillOn) colors else rep("transparent", n),
        alpha = if (fillOn) 0.45 else 0,
        col = colors,
        lwd = 1.6,
        lty = 1,
        cex = countCex,
        fontfamily = "sans",
        cat.cex = catCex,
        cat.col = colors,
        cat.fontfamily = "sans",
        cat.default.pos = "outer",
        margin = 0.12,
        print.mode = printMode,
        sigdigs = 3,
        # ★ 必须是 FALSE：这两个参数一开，VennDiagram 会按**面积比例**画欧拉图。
        #   集合很小（比如每组只有 1~3 个基因）或彼此有包含关系时，比例布局会退化：
        #   实测 3 组各 1 个基因 → 只画出 2 个圈、两个圈名压在同一个位置、第三组
        #   直接消失，而图本身看起来「挺正常」。Venn 图要的是固定布局（n 组永远
        #   画 n 个圈、2^n 个区域都在），不是面积成比例的欧拉图 —— 后者是另一种图。
        scaled = FALSE,
        euler.d = FALSE
      ),
      error = function(e) {
        deg_stop("E_R_PLOT",
                 paste0("VennDiagram failed: ", conditionMessage(e),
                        " —— 常见原因：某组的基因几乎全部包含在另一组里（退化情形），",
                        "这种数据建议改看具体的交集数量表。"),
                 status = 13L)
      }
    )

    openDevice <- function() {
      if (identical(format, "pdf")) deg_open_pdf(outPath, widthIn, heightIn)
      else deg_open_png(outPath, widthIn, heightIn, dpi)
    }
    openDevice()
    on.exit(deg_close_devices(), add = TRUE)
    grid::grid.newpage()
    grid::grid.draw(grob)
    if (nzchar(title)) {
      grid::grid.text(title, x = 0.5, y = 0.985,
                      gp = grid::gpar(fontsize = 13, fontface = 2, fontfamily = "sans"))
    }
    deg_close_devices()
    method <- "venn-diagram"
    warningsOut <- character(0)
  } else {
    # 6~7 组：矩形布局，保证每个交集都真的画出来
    deg_ensure_pkgs(c("ggVennDiagram", "ggplot2"))
    labelMode <- if (showCount && showPercent) {
      "both"
    } else if (showPercent) {
      "percent"
    } else if (showCount) {
      "count"
    } else {
      "none"
    }

    p <- ggVennDiagram::ggVennDiagram(
      sets,
      set_color = colors,
      set_size = if (labelSize > 0) labelSize / 3 else 3.2,
      label = labelMode,
      label_alpha = 0,
      edge_lty = "solid",
      edge_size = 0.9
    ) +
      ggplot2::scale_fill_gradient(low = "white", high = colors[1]) +
      ggplot2::theme(
        legend.position = "none",
        plot.title = ggplot2::element_text(hjust = 0.5, size = 13, face = "bold"),
        plot.margin = ggplot2::margin(12, 12, 12, 12)
      )

    if (nzchar(title)) p <- p + ggplot2::ggtitle(title)

    openDevice <- function() {
      if (identical(format, "pdf")) deg_open_pdf(outPath, widthIn, heightIn)
      else deg_open_png(outPath, widthIn, heightIn, dpi)
    }
    openDevice()
    on.exit(deg_close_devices(), add = TRUE)
    print(p)
    deg_close_devices()
    method <- "ggvenn-rect"
    warningsOut <- "6 组以上改用矩形布局：圆形排布在 6 组时无法保证每个交集都被画出"
  }

  emit_progress("write", 90, "finalizing image")

  if (!file.exists(outPath)) {
    deg_stop("E_IO_WRITE", paste0("image was not written: ", outPath), status = 14L)
  }

  regions <- .compute_regions(sets)
  nonEmpty <- Filter(function(r) r$count > 0, regions)
  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000

  if (length(warningsOut) > 0) emit_log("warn", warningsOut)
  emit_progress("write", 100, "done")

  emit_result(list(
    method = method,
    sets = n,
    totalUnique = length(unique(unlist(sets))),
    setSizes = as.list(lengths(sets)),
    regions = nonEmpty,
    emptyRegions = length(regions) - length(nonEmpty),
    bytes = as.integer(file.size(outPath)),
    durationMs = as.integer(durationMs)
  ))
})
