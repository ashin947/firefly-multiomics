# =============================================================================
# r/timeseries/common_timeseries.R —— 时序模块的公共读取/解析/出图工具
#
# 单独一个文件的原因与单细胞那边一样：冒烟脚本要能 `source()` 它来单测函数，
# 而不触发 `deg_main()`。
# =============================================================================

#' 按 BOM 探测文本编码
#'
#' 客户的 `.txt` 是 **UTF-16LE + BOM**（前两字节 FF FE）。`data.table::fread()`
#' 直接读会报 `Embedded nul character in a string: "g\0e\0n\0e\0..."`
#' （它按字节切分，UTF-16 里每个 ASCII 字符后面都跟着 \0）。
#' `read.table(fileEncoding = "UTF-16LE")` 可以，但**必须显式给编码**，
#' 而用户不会知道自己的文件是什么编码 —— 所以这里先读 BOM 判断。
#'
#' @return "UTF-16LE" / "UTF-16BE" / "UTF-8"
.ts_detect_encoding <- function(path) {
  con <- file(path, "rb")
  on.exit(close(con), add = TRUE)
  b <- readBin(con, "raw", n = 3)
  if (length(b) >= 2 && b[1] == as.raw(0xFF) && b[2] == as.raw(0xFE)) return("UTF-16LE")
  if (length(b) >= 2 && b[1] == as.raw(0xFE) && b[2] == as.raw(0xFF)) return("UTF-16BE")
  # UTF-8 带 BOM（EF BB BF）与无 BOM 都按 UTF-8 处理
  "UTF-8"
}

#' 读表达矩阵（tab 分隔，第一列基因名）
#'
#' 读不了时抛 E_DATA_INVALID 并说明「编码无法识别 / 不是 tab 分隔」，
#' 而不是把 read.table 的原始报错（`line 1 did not have 22 elements`）丢给用户。
.ts_read_matrix <- function(path) {
  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_MISSING", paste0("matrix file not found: ", basename(path)), status = 12L)
  }
  enc <- .ts_detect_encoding(path)
  emit_log("info", sprintf("matrix encoding detected: %s", enc))

  df <- tryCatch(
    utils::read.table(
      path,
      sep = "\t",
      header = TRUE,
      row.names = 1,
      check.names = FALSE,
      comment.char = "",
      quote = "",
      fileEncoding = enc,
      stringsAsFactors = FALSE
    ),
    error = function(e) {
      deg_stop("E_DATA_INVALID", paste0(
        "cannot read the matrix (encoding ", enc, "): ", substr(conditionMessage(e), 1, 220),
        ". Expected a tab-separated table whose first column is the gene id and the ",
        "remaining columns are samples."), status = 13L)
    }
  )
  if (ncol(df) < 2) {
    deg_stop("E_DATA_INVALID", paste0(
      "the matrix has only ", ncol(df), " sample column(s). ",
      "Is the file tab-separated with a header row?"), status = 13L)
  }
  m <- as.matrix(df)
  storage.mode(m) <- "double"
  if (anyNA(m)) {
    deg_stop("E_DATA_INVALID",
             "the matrix contains non-numeric values (NA after conversion)", status = 13L)
  }
  list(matrix = m, encoding = enc)
}

#' 时间点的排序权重：有数字就按数字（1d/3d/7d → 1,3,7），否则按字母
.ts_time_order <- function(times) {
  times <- unique(as.character(times))
  num <- suppressWarnings(as.numeric(gsub("[^0-9.]+", "", times)))
  if (length(times) > 0 && all(!is.na(num))) {
    return(times[order(num)])
  }
  sort(times)
}

#' 把 config 里的 samples 元数据对齐到矩阵的列
#'
#' 返回按「重复序列（rep）→ 时间点」排好序的下标、时间索引与 SAM 用的 y。
#'
#' ## y 的构造（SAM 的 One class timecourse 约定）
#'
#' 每个样本的标签形如 `1Time3`：
#'   · 前缀 `1` 是「类」，单序列模式恒为 1
#'   · `Time3` 表示该样本属于第 3 个时间点
#' 同一「重复序列」的**第一个**样本追加 `Start`、**最后一个**追加 `End`，
#' 中间不加。SAM 靠这两个标记把一条时间序列切开，否则会把不同重复当成一条。
#'
#' 不这么写 y 会得到 `SAM() 报 "Error in 1:nres: argument of length 0"` 之类的怪错。
#' 把 config 里的 samples 规整成 data.frame
#'
#' ★ 不能直接 `as.data.frame(samples)`：config 是
#'   `jsonlite::fromJSON(simplifyDataFrame = FALSE)` 读的，数组里的对象会变成
#'   **list of lists**，`as.data.frame()` 之后是 list 列，`as.character()` 取到的
#'   不是字符串。第一版就是这么错的：21 个样本只匹配上 3 个（还都是第一组），
#'   然后报「时间点只有 1 个」—— 报错位置离真正原因隔了三层。
.ts_samples_df <- function(samples) {
  take <- function(s, key) {
    v <- if (is.list(s)) s[[key]] else NULL
    if (is.null(v) || length(v) == 0) "" else as.character(v)[1]
  }
  if (is.data.frame(samples)) {
    col <- function(key) {
      v <- samples[[key]]
      if (is.null(v)) rep("", nrow(samples)) else as.character(v)
    }
    out <- data.frame(
      name = col("name"), group = col("group"), time = col("time"), rep = col("rep"),
      stringsAsFactors = FALSE
    )
  } else {
    n <- length(samples)
    out <- data.frame(
      name = vapply(samples, take, character(1), key = "name"),
      group = vapply(samples, take, character(1), key = "group"),
      time = vapply(samples, take, character(1), key = "time"),
      rep = vapply(samples, take, character(1), key = "rep"),
      stringsAsFactors = FALSE
    )
    if (n == 0) out <- out[0, , drop = FALSE]
  }
  out$name <- trimws(out$name)
  out$group <- trimws(out$group)
  out$time <- trimws(out$time)
  out$rep <- trimws(out$rep)
  out[!is.na(out$name) & nzchar(out$name), , drop = FALSE]
}

.ts_build_design <- function(samples, sampleNames) {
  meta <- .ts_samples_df(samples)
  for (col in c("name", "group", "time", "rep")) {
    if (!col %in% colnames(meta)) meta[[col]] <- ""
    meta[[col]] <- as.character(meta[[col]])
  }
  # 只保留矩阵里真的有的列（用户可能在预览表里删过行）
  keep <- meta$name %in% sampleNames
  dropped <- meta$name[!keep]
  if (length(dropped) > 0) {
    emit_log("warn", paste0("samples not found in matrix, ignored: ",
                            paste(utils::head(dropped, 8), collapse = ", ")))
  }
  meta <- meta[keep, , drop = FALSE]
  if (nrow(meta) == 0) {
    deg_stop("E_DATA_INVALID",
             "none of the parsed sample names exist in the matrix header", status = 13L)
  }
  if (any(!nzchar(meta$time))) {
    bad <- meta$name[!nzchar(meta$time)]
    deg_stop("E_VALIDATION", paste0(
      "some samples have no time point: ", paste(utils::head(bad, 8), collapse = ", "),
      ". Fill the time column in the preview table."), status = 11L)
  }
  # rep 缺省时全部当作同一条序列
  if (any(!nzchar(meta$rep))) meta$rep[!nzchar(meta$rep)] <- "1"

  times <- .ts_time_order(meta$time)
  if (length(times) < 3) {
    deg_stop("E_VALIDATION", paste0(
      "a time course needs at least 3 time points, got ", length(times), " (",
      paste(times, collapse = ", "), ")"), status = 11L)
  }
  meta$timeIndex <- match(meta$time, times)

  ord <- order(suppressWarnings(as.integer(factor(meta$rep))), meta$timeIndex, meta$name)
  meta <- meta[ord, , drop = FALSE]

  # 每条重复序列的首尾打标
  tag <- rep("", nrow(meta))
  for (r in unique(meta$rep)) {
    idx <- which(meta$rep == r)
    idx <- idx[order(meta$timeIndex[idx])]
    tag[idx[1]] <- "Start"
    if (length(idx) > 1) tag[idx[length(idx)]] <- "End"
  }
  meta$tag <- tag
  meta$y <- paste0("1Time", meta$timeIndex, meta$tag)

  list(
    meta = meta,
    times = times,
    nSeries = length(unique(meta$rep)),
    y = meta$y
  )
}

#' 基因名容错：数据里是 `LOC_Os03g54160`，用户可能写 `Os03g54160`
#'
#' 双向试（补 `LOC_` / 去 `LOC_`），都不中就报「找不到」。
#' 不做模糊匹配：`Os03g5416` 这种少一位的写法如果被匹配上，用户会看到另一个基因的曲线。
.ts_match_genes <- function(requested, available) {
  req <- trimws(as.character(requested))
  req <- req[nzchar(req)]
  req <- unique(req)
  hit <- character(length(req))
  for (i in seq_along(req)) {
    g <- req[i]
    if (g %in% available) {
      hit[i] <- g
    } else if (paste0("LOC_", g) %in% available) {
      hit[i] <- paste0("LOC_", g)
    } else if (startsWith(g, "LOC_") && sub("^LOC_", "", g) %in% available) {
      hit[i] <- sub("^LOC_", "", g)
    } else {
      hit[i] <- NA_character_
    }
  }
  list(found = hit[!is.na(hit)], missing = req[is.na(hit)])
}

#' 图里**不能出现中文**
#'
#' 内置 R 的 Windows 图形设备没有中文字体，中文会渲染成一串方块（□），
#' 单细胞模块已经踩过这个坑。所以坐标轴、标题、图例一律英文，
#' 中文说明放在「界面」与 CSV/返回值里。
.ts_save_plot <- function(plot, file, width, height, label) {
  # 统一走 r/common/save_plot.R：PNG（预览）+ 同名 PDF（投稿矢量）
  deg_save_ggplot(plot, file, width, height, label)
}

#' 分组配色：暖色给第一组、冷色给第二组（与客户脚本 DT 暖 / WW 冷 的语义一致）
#'
#' 所有图（火山图、样条图、质心图、热图）都从这里取色，
#' 保证「同一组在所有图里同一个颜色」——颜色有两份来源时，两张图放在一起就会对不上。
.ts_group_palette <- function(groups) {
  base <- c("#C4552E", "#3B6FA0", "#6E8B3D", "#8B5FBF", "#B8860B", "#2F8F8F")
  n <- length(groups)
  if (n > length(base)) {
    base <- c(base, grDevices::hcl.colors(n - length(base), "Dark 3"))
  }
  stats::setNames(base[seq_len(n)], as.character(groups))
}

#' 分组配色：暖色给第一组、冷色给第二组（与客户脚本 DT 暖 / WW 冷 的语义一致）
#'
#' 所有图（火山图、样条图、质心图、热图）都从这里取色，
#' 保证「同一组在所有图里同一个颜色」——颜色有两份来源时，两张图放在一起就会对不上。
.ts_group_palette <- function(groups) {
  base <- c("#C4552E", "#3B6FA0", "#6E8B3D", "#8B5FBF", "#B8860B", "#2F8F8F")
  n <- length(groups)
  if (n > length(base)) {
    base <- c(base, grDevices::hcl.colors(n - length(base), "Dark 3"))
  }
  stats::setNames(base[seq_len(n)], as.character(groups))
}
