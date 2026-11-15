# =============================================================================
# r/common/io.R —— 配置读取、原子写、出图设备
#
# 约定（ARCHITECTURE §8 末尾）：
#   - 业务参数一律从 `params$xxx` 取，禁止读环境变量或命令行；
#   - 所有产物路径都相对 runDir（= 进程 cwd）；
#   - 写 JSON/CSV 一律原子写（.tmp + rename），避免断电留下半截文件。
# =============================================================================

#' 读取 run_config.json
deg_read_config <- function(path) {
  if (!file.exists(path)) {
    deg_stop("E_VALIDATION", paste0("config file not found: ", path), status = 11L)
  }
  cfg <- tryCatch(
    jsonlite::fromJSON(path, simplifyVector = TRUE, simplifyDataFrame = FALSE),
    error = function(e) {
      deg_stop("E_VALIDATION",
               paste0("config file is not valid JSON: ", conditionMessage(e)),
               status = 11L)
    }
  )
  cfg
}

#' 取参数：优先 params$name，其次顶层 name，最后 default
deg_param <- function(ctx, name, default = NULL) {
  if (!is.null(ctx$params) && !is.null(ctx$params[[name]])) return(ctx$params[[name]])
  if (!is.null(ctx$config) && !is.null(ctx$config[[name]])) return(ctx$config[[name]])
  default
}

#' 取必需参数，缺失即报 E_VALIDATION（exit 11）
deg_param_required <- function(ctx, name) {
  value <- deg_param(ctx, name, default = NULL)
  if (is.null(value) || (is.character(value) && length(value) == 1 && !nzchar(value))) {
    deg_stop("E_VALIDATION", paste0("missing required parameter: ", name), status = 11L)
  }
  value
}

#' 把参数里的相对路径解析为绝对路径（相对 projectRoot）
deg_abs_path <- function(ctx, p) {
  if (is.null(p) || !nzchar(p)) return(p)
  if (grepl("^(/|[A-Za-z]:[/\\\\])", p)) return(p)
  root <- if (!is.null(ctx$config$projectRoot)) ctx$config$projectRoot else getwd()
  file.path(root, p)
}

#' 原子写 JSON
deg_write_json <- function(obj, file, pretty = FALSE) {
  dir.create(dirname(file), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(file, ".tmp")
  json <- jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null", na = "null",
                           digits = NA, pretty = pretty)
  ok <- tryCatch({
    con <- file(tmp, open = "wb")
    writeBin(charToRaw(enc2utf8(as.character(json))), con)
    close(con)
    TRUE
  }, error = function(e) {
    deg_stop("E_IO_PERMISSION",
             paste0("failed to write json: ", file, " (", conditionMessage(e), ")"),
             status = 14L)
  })
  if (!isTRUE(ok)) return(invisible(file))

  # Windows 上 file.rename 对已存在目标会失败，先删再改名
  if (!suppressWarnings(file.rename(tmp, file))) {
    if (file.exists(file)) unlink(file)
    if (!suppressWarnings(file.rename(tmp, file))) {
      file.copy(tmp, file, overwrite = TRUE)
      unlink(tmp)
    }
  }
  invisible(file)
}

#' 原子写 CSV
#' @param bom 是否写 UTF-8 BOM。中间产物（de.csv 等）不写 BOM，
#'            避免表头首列带 \ufeff 导致后续解析对不上；面向用户的导出由
#'            TableExporter 负责加 BOM。
deg_write_csv <- function(df, file, bom = FALSE) {
  dir.create(dirname(file), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(file, ".tmp")

  if (requireNamespace("data.table", quietly = TRUE)) {
    ok <- tryCatch({
      data.table::fwrite(df, tmp, na = "NA", bom = bom)
      TRUE
    }, error = function(e) FALSE)
  } else {
    ok <- tryCatch({
      utils::write.csv(df, tmp, row.names = FALSE, na = "NA", fileEncoding = "UTF-8")
      TRUE
    }, error = function(e) FALSE)
  }

  if (!isTRUE(ok) || !file.exists(tmp)) {
    deg_stop("E_IO_PERMISSION", paste0("failed to write csv: ", file), status = 14L)
  }
  if (!suppressWarnings(file.rename(tmp, file))) {
    if (file.exists(file)) unlink(file)
    if (!suppressWarnings(file.rename(tmp, file))) {
      file.copy(tmp, file, overwrite = TRUE)
      unlink(tmp)
    }
  }
  invisible(file)
}

#' 读表达矩阵（行=基因，列=样本，第一列是基因 ID）
deg_read_matrix <- function(path, ...) {
  if (!file.exists(path)) {
    deg_stop("E_DATA_EMPTY", paste0("matrix file not found: ", path), status = 13L)
  }
  deg_ensure_pkgs("data.table")
  dt <- tryCatch(
    data.table::fread(path, data.table = FALSE, check.names = FALSE,
                      encoding = "UTF-8", ...),
    error = function(e) {
      deg_stop("E_DATA_EMPTY",
               paste0("failed to read matrix: ", conditionMessage(e)),
               status = 13L)
    }
  )
  if (nrow(dt) == 0 || ncol(dt) < 2) {
    deg_stop("E_DATA_EMPTY",
             "matrix has no usable data columns (need >= 1 gene column + 1 sample column)",
             status = 13L)
  }
  dt
}

#' 读分组表，返回 data.frame(sample, group)
deg_read_groups <- function(path, sampleColumn = "sample", groupColumn = "group") {
  if (is.null(path) || !nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_SAMPLE_MISMATCH", paste0("groups file not found: ", path), status = 13L)
  }
  deg_ensure_pkgs("data.table")
  dt <- data.table::fread(path, data.table = FALSE, check.names = FALSE, encoding = "UTF-8")
  names(dt) <- trimws(names(dt))
  if (!sampleColumn %in% names(dt) || !groupColumn %in% names(dt)) {
    deg_stop("E_DATA_SAMPLE_MISMATCH",
             paste0("groups file must contain columns '", sampleColumn, "' and '", groupColumn,
                    "', found: ", paste(names(dt), collapse = ", ")),
             status = 13L)
  }
  out <- data.frame(
    sample = trimws(as.character(dt[[sampleColumn]])),
    group = trimws(as.character(dt[[groupColumn]])),
    stringsAsFactors = FALSE
  )
  out
}

#' 打开 PNG 设备（优先 ragg：自带字体渲染，跨平台最稳，见 §6.4）
deg_open_png <- function(file, width, height, dpi = 300, bg = "white") {
  dir.create(dirname(file), showWarnings = FALSE, recursive = TRUE)
  if (requireNamespace("ragg", quietly = TRUE)) {
    ragg::agg_png(filename = file, width = width, height = height,
                  units = "in", res = dpi, background = bg)
    return(invisible(TRUE))
  }
  grDevices::png(filename = file, width = round(width * dpi), height = round(height * dpi),
                 res = dpi, bg = bg)
  invisible(TRUE)
}

#' 打开 PDF 设备（优先 cairo_pdf，中文字体支持更好）
deg_open_pdf <- function(file, width, height, bg = "white") {
  dir.create(dirname(file), showWarnings = FALSE, recursive = TRUE)
  if (isTRUE(capabilities("cairo"))) {
    res <- try(grDevices::cairo_pdf(filename = file, width = width, height = height,
                                    bg = bg), silent = TRUE)
    if (!inherits(res, "try-error")) return(invisible(TRUE))
  }
  grDevices::pdf(file = file, width = width, height = height, bg = bg, useDingbats = FALSE)
  invisible(TRUE)
}

#' 关闭所有已打开的设备（导出脚本结束前调用）
deg_close_devices <- function() {
  while (grDevices::dev.cur() > 1) {
    try(grDevices::dev.off(), silent = TRUE)
  }
  invisible(NULL)
}
