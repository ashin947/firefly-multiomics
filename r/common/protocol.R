# =============================================================================
# r/common/protocol.R —— R 侧行协议（ARCHITECTURE §5.2 / 附录 A.2）
#
# 每条消息同时写两个通道：
#   1. stdout：`@@DEG@@ ` + 单行紧凑 JSON   —— 实时通道
#   2. runDir/events.jsonl                  —— 兜底通道
#
# 为什么要有兜底：Windows 下 R 的 stdout 在非 ASCII 用户目录 / 非 UTF-8 locale 下
# 可能被转成本地编码，导致主进程 JSON.parse 失败。events.jsonl 用文件写入，
# 编码可控，进程结束后主进程可重放它重建结果。
# =============================================================================

.deg_state <- new.env(parent = emptyenv())

#' 初始化协议通道。必须在任何 emit_* 之前调用（bootstrap.R 已代劳）。
deg_init_protocol <- function(runDir, scriptName) {
  .deg_state$seq <- 0L
  .deg_state$script <- scriptName
  .deg_state$runDir <- runDir
  .deg_state$closed <- FALSE
  .deg_state$con <- NULL

  dir.create(runDir, showWarnings = FALSE, recursive = TRUE)
  path <- file.path(runDir, "events.jsonl")
  .deg_state$con <- tryCatch(
    file(path, open = "a", encoding = "UTF-8"),
    error = function(e) NULL
  )
  invisible(NULL)
}

#' 内部：发出任意消息对象
.deg_emit <- function(obj) {
  if (isTRUE(.deg_state$closed)) return(invisible(NULL))

  .deg_state$seq <- .deg_state$seq + 1L
  obj$v <- 1L
  obj$seq <- .deg_state$seq
  obj$ts <- floor(as.numeric(Sys.time()) * 1000)

  # 稳定字段顺序：v/type/seq/ts 在前，便于人工阅读与排查
  ordered <- obj[c("v", "type", "seq", "ts",
                   setdiff(names(obj), c("v", "type", "seq", "ts")))]

  line <- paste0(
    "@@DEG@@ ",
    jsonlite::toJSON(ordered, auto_unbox = TRUE, null = "null", na = "null", digits = NA)
  )

  # 通道 1：stdout（用 useBytes 避免二次转码）
  try(writeLines(line, con = stdout(), sep = "\n", useBytes = TRUE), silent = TRUE)
  try(flush(stdout()), silent = TRUE)

  # 通道 2：events.jsonl（兜底）
  if (!is.null(.deg_state$con)) {
    try(writeLines(line, con = .deg_state$con, sep = "\n"), silent = TRUE)
  }

  invisible(NULL)
}

#' hello：进程握手，主进程据此确认协议版本与 R 版本
emit_hello <- function(ctx = NULL) {
  script <- if (!is.null(ctx) && !is.null(ctx$script)) ctx$script else .deg_state$script
  .deg_emit(list(
    type = "hello",
    script = if (is.null(script)) "" else as.character(script),
    rVersion = as.character(getRversion()),
    pid = Sys.getpid()
  ))
}

#' log：结构化日志。level ∈ debug|info|warn|error
emit_log <- function(level, msg) {
  lvl <- as.character(level)
  if (!lvl %in% c("debug", "info", "warn", "error")) lvl <- "info"
  .deg_emit(list(type = "log", level = lvl, msg = paste(msg, collapse = " ")))
}

#' progress：阶段进度。stage 必须属于约定的 9 个阶段之一。
emit_progress <- function(stage, pct, msg = "") {
  valid <- c("read", "filter", "normalize", "dispersion", "fit", "test",
             "enrich", "plot", "write")
  st <- as.character(stage)
  if (!st %in% valid) st <- "read"
  p <- suppressWarnings(as.numeric(pct))
  if (is.na(p)) p <- 0
  p <- max(0, min(100, p))
  o <- list(type = "progress", stage = st, pct = p)
  if (nzchar(msg)) o$msg <- as.character(msg)
  .deg_emit(o)
}

#' artifact：产物文件（路径相对 runDir）
emit_artifact <- function(kind, path, rows = NULL, schema = NULL) {
  o <- list(type = "artifact", kind = as.character(kind), path = as.character(path))
  if (!is.null(rows)) o$rows <- as.integer(rows)
  if (!is.null(schema)) o$schema <- as.character(schema)
  .deg_emit(o)
}

#' result：成功结束，summary 会被主进程原样保留
emit_result <- function(summary) {
  if (is.null(summary)) summary <- list()
  .deg_emit(list(type = "result", ok = TRUE, summary = summary))
}

#' error：失败。code 用 errors.ts 里的错误码，message 用英文/中性描述
#' （中文文案由主进程翻译层统一产出，见 ARCHITECTURE §11.2 第 7 条）
emit_error <- function(code, message, detail = "") {
  o <- list(type = "error", code = as.character(code), message = as.character(message))
  if (!is.null(detail) && nzchar(detail)) o$detail <- as.character(detail)
  .deg_emit(o)
}

#' 关闭协议通道（幂等：deg_main 与 on.exit 都会调）
deg_close <- function(ctx = NULL) {
  if (isTRUE(.deg_state$closed)) return(invisible(NULL))
  .deg_state$closed <- TRUE
  if (!is.null(.deg_state$con)) {
    try(close(.deg_state$con), silent = TRUE)
    .deg_state$con <- NULL
  }
  invisible(NULL)
}
