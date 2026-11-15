# =============================================================================
# r/common/viz.R —— 绘图模块（venn / violin / survival）共用的小工具
#
# 放这里而不是各自脚本里复制：`resolve_palette` 和状态列归一化是**两个脚本都要用**
# 且必须行为一致的东西。各写一份的话，同一个 "lancet" 迟早出现
# 「小提琴图是 9 色、生存曲线报错」这种没法向用户解释的差异。
#
# 注意：本文件由 bootstrap.R 统一 source，只定义函数，不产生副作用。
# =============================================================================

#' 解析配色：ggsci 名称 / RColorBrewer 名称 / 逗号分隔的自定义色值
#'
#' @param spec 形如 "lancet"、"jco"、"Set1"、"#E64B35,#4DBBD5,#00A087"
#' @param n    需要几种颜色
#' @return 长度 n 的色值向量（不足时循环补齐）
resolve_palette <- function(spec, n) {
  fallback <- c("#4C72B0", "#DD8452", "#55A868", "#C44E52",
                "#8172B3", "#937860", "#DA8BC3", "#8C8C8C")
  spec <- trimws(paste(as.character(spec), collapse = ""))
  if (!nzchar(spec)) return(rep(fallback, length.out = n))

  # 自定义色值：含 # 就当成逗号分隔的色值列表
  if (grepl("#", spec, fixed = TRUE)) {
    cols <- trimws(strsplit(spec, ",")[[1]])
    cols <- cols[nzchar(cols)]
    if (length(cols) > 0) return(rep(cols, length.out = n))
  }

  # ggsci：pal_<name>() 返回一个 function(n)
  if (requireNamespace("ggsci", quietly = TRUE)) {
    gen <- tryCatch(get(paste0("pal_", spec), envir = asNamespace("ggsci")),
                    error = function(e) NULL)
    if (is.function(gen)) {
      cols <- tryCatch(gen()(n), error = function(e) NULL)
      if (length(cols) >= 1) return(rep(as.character(cols), length.out = n))
    }
  }

  # RColorBrewer（"Set1"、"Dark2" 这类）
  if (requireNamespace("RColorBrewer", quietly = TRUE) &&
      spec %in% rownames(RColorBrewer::brewer.pal.info)) {
    maxCols <- RColorBrewer::brewer.pal.info[spec, "maxcolors"]
    cols <- tryCatch(RColorBrewer::brewer.pal(min(max(n, 3), maxCols), spec),
                     error = function(e) NULL)
    if (length(cols) > 0) return(rep(as.character(cols), length.out = n))
  }

  emit_log("warn", paste0("unknown palette '", spec, "', falling back to default colors"))
  rep(fallback, length.out = n)
}

#' p 值的科学计数法显示
#'
#' 太小的直接写成 "<1e-300"：`formatC` 会给出一串 "0.00e+00"，
#' 在括号上既占地方又没有信息量。
format_p <- function(p) {
  if (!is.finite(p)) return("NA")
  if (p < 1e-300) return("<1e-300")
  formatC(p, format = "e", digits = 2)
}

#' 按一组候选模式挑列名；挑不到就用 fallback
#'
#' 全部 `^...$` 锚定。宽松匹配（写成 `/group/i`）会把 `group_size`、
#' `subgroup_note` 这类列也认成分组列，用户拿到一张静默错位的图。
pick_column <- function(cols, patterns, fallback = "") {
  for (pattern in patterns) {
    hit <- cols[grepl(pattern, cols, ignore.case = TRUE)]
    if (length(hit) > 0) return(hit[1])
  }
  fallback
}

#' 生存状态列归一化成 0/1（1 = 事件发生 / 死亡 / 复发）
#'
#' 临床表的写法五花八门：`1/0`、`Dead/Alive`、`dead/alive`、`Dead/Alive`、
#' `Yes/No`、`是/否`、`死亡/存活`、`1/2`（部分数据库把 2 当删失）。
#' 只认能确定的写法，认不出就报错并列出实际出现的值 —— 猜错的代价是
#' 生存曲线的方向反了，而图看起来完全正常。
normalize_status <- function(values, columnName = "status") {
  raw <- trimws(as.character(values))
  out <- rep(NA_real_, length(raw))

  numericLike <- suppressWarnings(as.numeric(raw))
  if (sum(is.finite(numericLike)) >= length(raw) * 0.8) {
    uniq <- sort(unique(stats::na.omit(numericLike)))
    if (all(uniq %in% c(0, 1))) {
      out <- numericLike
    } else if (all(uniq %in% c(1, 2))) {
      # 1/2 编码：多数数据库里 1 = 事件、2 = 删失
      out <- ifelse(numericLike == 1, 1, 0)
      emit_log("warn", "状态列按 1/2 编码解读（1=事件，2=删失）")
    } else {
      deg_stop("E_DATA_SCHEMA",
               paste0("状态列 '", columnName, "' 的取值无法识别：",
                      paste(utils::head(uniq, 6), collapse = ", "),
                      "（期望 0/1 或 1/2）"),
               status = 10L)
    }
    return(out)
  }

  lower <- tolower(raw)
  eventWords <- c("1", "dead", "death", "deceased", "event", "yes", "true",
                  "死亡", "是", "事件", "复发")
  censorWords <- c("0", "alive", "living", "censor", "censored", "no", "false",
                   "存活", "否", "删失", "截尾")

  out[lower %in% eventWords] <- 1
  out[lower %in% censorWords] <- 0

  unknown <- unique(raw[is.na(out) & nzchar(raw)])
  if (length(unknown) > 0) {
    deg_stop("E_DATA_SCHEMA",
             paste0("状态列 '", columnName, "' 里有无法识别的取值：",
                    paste(utils::head(unknown, 6), collapse = ", "),
                    "（可用 0/1、Dead/Alive、Yes/No、死亡/存活）"),
             status = 10L)
  }
  out
}

#' 读一个分隔符表格（与主进程 VizSourceReader 的判断口径保持一致）
read_viz_table <- function(path) {
  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_VALIDATION", paste0("file not found: ", path), status = 11L)
  }
  data.table::fread(path, encoding = "UTF-8")
}
