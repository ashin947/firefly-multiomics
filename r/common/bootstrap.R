# =============================================================================
# r/common/bootstrap.R —— 每个 R 脚本的入口（ARCHITECTURE §5.6）
#
# 脚本头固定为：
#   .deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
#   if (!nzchar(.deg_root)) { ...从 --file= 推断... }
#   source(file.path(.deg_root, "common", "loader.R"))
#   deg_main("de/run_deseq2.R", function(ctx) { ... })
#
# ★ 入口脚本 source 的是 loader.R 而**不是本文件**。loader.R 用与 locale 无关的
#   方式（UTF-8 逐行读 + parse(text)）加载本文件。为什么必须这样：
#   Windows 上 source(..., encoding = "UTF-8") 在 LC_CTYPE=C（R 不认 C.UTF-8，
#   而 RProcessRunner 恰好导出它）时会因 UTF-8→native 转换失败而**只发 warning
#   就半途返回**，结果是「脚本退出但没有 deg_main」——最难查的一类故障。
#   完整分析见 r/common/loader.R 文件头。
#
# deg_main 负责：解析 --config → 开 events.jsonl → 注册字体 → 设 UTF-8
#                → emit hello → 跑业务 → 捕获错误 → **显式 quit(status)**
#
# 为什么必须显式 quit：R 脚本末尾自然结束返回 0，但 tryCatch 里 stop() 后若不显式
# quit，某些情况下 exitCode 会是 1 而不是约定的 11/12/13/14，主进程的错误翻译会失准。
# =============================================================================

# ---- 1. 定位脚本根目录（r/）--------------------------------------------------
.deg_script_dir <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  fileArg <- grep("^--file=", args, value = TRUE)
  if (length(fileArg) >= 1) {
    return(dirname(normalizePath(sub("^--file=", "", fileArg[1]), mustWork = FALSE)))
  }
  # source() 场景：用调用栈里的 ofile
  frames <- sys.frames()
  if (length(frames) > 0 && !is.null(frames[[1]]$ofile)) {
    return(dirname(normalizePath(frames[[1]]$ofile, mustWork = FALSE)))
  }
  getwd()
}

.deg_r_root <- function() {
  root <- Sys.getenv("DEG_R_ROOT", unset = "")
  if (nzchar(root) && dir.exists(file.path(root, "common"))) {
    return(normalizePath(root, mustWork = FALSE))
  }
  # 脚本位于 <root>/<category>/xxx.R，往上两级即 r/
  candidate <- dirname(.deg_script_dir())
  if (dir.exists(file.path(candidate, "common"))) {
    return(normalizePath(candidate, mustWork = FALSE))
  }
  # 最后尝试当前工作目录
  if (dir.exists(file.path(getwd(), "common"))) return(normalizePath(getwd(), mustWork = FALSE))
  stop("cannot locate R script root: set DEG_R_ROOT or run scripts from the r/ directory")
}

.deg_root <- .deg_r_root()

# ---- 2. jsonlite 是协议的前提，缺它连错误都发不出去 -------------------------
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  message("FATAL: R package 'jsonlite' is required but not installed.")
  quit(save = "no", status = 12L, runLast = FALSE)
}

# ---- 3. 加载公共库（顺序：protocol → io → validate → fonts → save_plot → de）----
# de.R 只定义函数、无副作用，因此对自检脚本也无害；集中加载可以避免
# 各 run_*.R 自己 source 时出现「谁先谁后」的顺序问题。
# 必须走 .deg_source_utf8（loader.R 提供）：直接 source(encoding = "UTF-8")
# 在 C locale 下会静默半途返回，见本文件头与 loader.R 文件头。
if (!exists(".deg_source_utf8", mode = "function")) {
  stop("bootstrap.R must be loaded through r/common/loader.R", call. = FALSE)
}
for (.deg_f in c("protocol.R", "io.R", "validate.R", "fonts.R", "save_plot.R", "de.R", "viz.R")) {
  .deg_source_utf8(file.path(.deg_root, "common", .deg_f))
}
rm(.deg_f)

# ---- 4. 解析 --config -------------------------------------------------------
.deg_parse_args <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  out <- list(config = NULL)
  i <- 1L
  while (i <= length(args)) {
    if (args[i] %in% c("--config", "-c") && i < length(args)) {
      out$config <- args[i + 1L]
      i <- i + 2L
    } else {
      i <- i + 1L
    }
  }
  out
}

#' 初始化运行上下文
deg_init <- function(scriptName) {
  parsed <- .deg_parse_args()

  if (is.null(parsed$config)) {
    message("FATAL: missing --config <path> argument")
    quit(save = "no", status = 11L, runLast = FALSE)
  }
  configPath <- normalizePath(parsed$config, mustWork = FALSE)
  if (!file.exists(configPath)) {
    message(paste0("FATAL: config file not found: ", configPath))
    quit(save = "no", status = 11L, runLast = FALSE)
  }

  ctx <- new.env(parent = emptyenv())
  ctx$script <- scriptName
  ctx$configPath <- configPath
  ctx$startedAt <- Sys.time()
  ctx$rRoot <- .deg_root

  # UTF-8 与 locale：
  #  - POSIX：C.UTF-8 是真实存在的 locale，切过去最省事；
  #  - Windows：R 不认 "C.UTF-8" 这个名字，切失败会把 LC_CTYPE 留在 "C"（ASCII），
  #    反而有害（正是 loader.R 文件头描述的那个 bug 的成因）。这里传 "" 表示
  #    「回到系统默认 locale」，中文 Windows 上就是 Chinese (Simplified)_China.utf8。
  if (.Platform$OS.type == "windows") {
    suppressWarnings(try(Sys.setlocale("LC_CTYPE", ""), silent = TRUE))
  } else {
    suppressWarnings(try(Sys.setlocale("LC_ALL", "C.UTF-8"), silent = TRUE))
  }
  options(encoding = "UTF-8")
  options(warn = 1)
  # 不要因为 stringsAsFactors 之类的历史默认值影响结果
  options(stringsAsFactors = FALSE)

  # 先开协议通道，后面的任何错误才能被主进程看到
  runDir <- NULL
  ctx$config <- tryCatch(
    jsonlite::fromJSON(configPath, simplifyVector = TRUE, simplifyDataFrame = FALSE),
    error = function(e) {
      message(paste0("FATAL: invalid config JSON: ", conditionMessage(e)))
      quit(save = "no", status = 11L, runLast = FALSE)
    }
  )
  runDir <- if (!is.null(ctx$config$runDir)) as.character(ctx$config$runDir) else dirname(configPath)
  ctx$runDir <- runDir
  ctx$params <- if (is.null(ctx$config$params)) list() else ctx$config$params
  ctx$projectRoot <- if (!is.null(ctx$config$projectRoot)) as.character(ctx$config$projectRoot) else dirname(runDir)

  dir.create(runDir, showWarnings = FALSE, recursive = TRUE)
  deg_init_protocol(runDir, scriptName)

  # 字体注册失败只警告，不影响出图（回退 sans）
  #
  # ★ `params$skipFonts = TRUE` 时跳过。
  #   注册字体会让 sysfonts 往 R 的临时目录**解压约 5MB 的字体文件**（实测正常退出也不删），
  #   而且要几百毫秒。交互式预览用英文轴标题、不需要中文，
  #   跳过它既能省时间，也避免每次刷新都往 %APPDATA% 里扔垃圾。
  if (isTRUE(ctx$params$skipFonts)) {
    ctx$fontFamily <- "sans"
    emit_log("info", "font registration skipped (skipFonts=true)")
  } else {
    ctx$fontFamily <- tryCatch(
      deg_register_fonts(),
      error = function(e) {
        emit_log("warn", paste0("font setup failed: ", conditionMessage(e)))
        "sans"
      }
    )
  }

  ctx
}

#' 统一入口
deg_main <- function(scriptName, fn) {
  ctx <- deg_init(scriptName)
  emit_hello(ctx)

  status <- 0L
  tryCatch(
    fn(ctx),
    deg_error = function(e) {
      # ★ 注意 emit_error 的签名是 (code, message, detail)——**没有 ctx**。
      #   这里以前多传了一个 ctx，导致「只要业务抛 deg_error，错误处理器自己就先
      #   报 unused argument」，进程以 1 退出、错误码 11/12/13/14 全部丢失。
      #   真实执行 r/de/run_limma_voom.R（缺 limma）时才会暴露，已修。
      emit_error(e$code, e$message, if (is.null(e$detail)) "" else e$detail)
      status <<- if (is.null(e$status)) 10L else as.integer(e$status)
    },
    error = function(e) {
      emit_error(
        "E_R_GENERIC",
        conditionMessage(e),
        paste(utils::head(deparse(conditionCall(e)), 5), collapse = " ")
      )
      status <<- 10L
    }
  )

  deg_close(ctx)
  # 显式退出码（§5.5），不依赖隐式返回
  quit(save = "no", status = status, runLast = FALSE)
}

#' 便捷：输出一段耗时日志
deg_log_elapsed <- function(ctx, label) {
  secs <- as.numeric(difftime(Sys.time(), ctx$startedAt, units = "secs"))
  emit_log("info", sprintf("%s (%.1fs)", label, secs))
  invisible(secs)
}
