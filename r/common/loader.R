# =============================================================================
# r/common/loader.R -- locale-proof bootstrap loader
#
# 入口脚本 source 的是**本文件**，不是 bootstrap.R：
#   source(file.path(.deg_root, "common", "loader.R"))
#
# -----------------------------------------------------------------------------
# 为什么需要这一层（真实跑出来的 bug，不是假想）
# -----------------------------------------------------------------------------
# 以前每个入口脚本的第一句是：
#   source(file.path(.deg_root, "common", "bootstrap.R"), encoding = "UTF-8")
#
# Windows 上 source(encoding =) 会在解析时把文件从声明编码**转换到 native 编码**。
# 当 LC_CTYPE 落到 "C"（ASCII）时——而这正是 RProcessRunner 导出 LC_ALL=C.UTF-8
# 造成的结果，因为 Windows 版 R 不认 "C.UTF-8" 这个名字、只能退回 "C"——
# 转换在第一个非 ASCII 字节上失败，而 R 只发一条 **warning**：
#   invalid input found on input connection '.../common/bootstrap.R'
# source() 于是半途返回，deg_main() 从未定义，脚本随即死在：
#   Error in deg_main(...) : could not find function "deg_main"
# 退出码 1、stdout 没有一行协议、events.jsonl 也没建出来。主进程看到的是
# 「进程退出了但没有任何结果」——这是最难查的一类故障，因为：
#   * 不是 exit 0，走不到「零退出无产物」的兜底分支；
#   * 没有 @@DEG@@ 行，错误码无从翻译，只能落到 E_R_GENERIC；
#   * R 的提示指向 bootstrap.R 的「编码」，而真正的原因在 locale。
#
# -----------------------------------------------------------------------------
# 修法
# -----------------------------------------------------------------------------
# 用 UTF-8 逐行读取 + parse(text=)。parse(text=) **不做 native 转换**，
# 因此在 C / GBK / UTF-8 任何 locale 下行为一致。已在 Windows 10 + R 4.3.2 +
# LC_ALL=C.UTF-8 下验证：字符串字面量读出来 nchar 正确、Encoding() 为 UTF-8。
# （对照实验：rawToChar + Encoding<-"UTF-8" 这条路不行，C locale 下会退化成
#  <U+4E2D> 转义，所以这里用 readLines + parse 而不是 rawToChar。）
#
# -----------------------------------------------------------------------------
# 本文件必须保持**纯 ASCII**
# -----------------------------------------------------------------------------
# 它是整个链路里第一个被加载的文件，也就是「必须在无法表示中文的 locale 下也能
# 加载成功」的那一个。别往这个文件里加中文——注释也不行。
# =============================================================================

#' 以 UTF-8 加载一个 R 源文件，与进程 locale 无关
#'
#' @param path 源文件路径（相对或绝对均可）。
#' @return 不可见地返回 TRUE；出错时 stop()（此时脚本还没进 deg_main，
#'   没有协议通道，所以只能靠 stderr + 退出码，属于「装机/发布」级故障）。
.deg_source_utf8 <- function(path) {
  resolved <- normalizePath(path, mustWork = FALSE)
  if (!file.exists(resolved)) {
    stop("R source file not found: ", resolved, call. = FALSE)
  }
  # readLines(encoding = "UTF-8") 把内容标记为 UTF-8，而不是转成本地编码；
  # warn = FALSE 避免「incomplete final line」之类的噪音。
  lines <- readLines(resolved, encoding = "UTF-8", warn = FALSE)
  exprs <- parse(text = lines, encoding = "UTF-8", keep.source = FALSE)
  # 与 source() 的默认行为一致：在全局环境求值（各入口脚本都假定这一点）
  eval(exprs, envir = globalenv())
  invisible(TRUE)
}

# ---- 定位 r/ 根目录（与 bootstrap.R 的 .deg_r_root 同逻辑，但这里不能依赖它）--
# 先无条件占位：DEG_R_ROOT 已设置时下面的 if 块不执行，直接 rm() 会报
# "object '.deg_boot_args' not found"（实测踩过）
.deg_boot_args <- character(0)
.deg_boot_file <- character(0)
.deg_boot_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_boot_root)) {
  .deg_boot_args <- commandArgs(trailingOnly = FALSE)
  .deg_boot_file <- sub("^--file=", "", grep("^--file=", .deg_boot_args, value = TRUE))
  if (length(.deg_boot_file) >= 1) {
    # 脚本位于 <root>/<category>/xxx.R，往上两级即 r/
    .deg_boot_root <- dirname(dirname(normalizePath(.deg_boot_file[1], mustWork = FALSE)))
  } else {
    .deg_boot_root <- getwd()
  }
}

if (!dir.exists(file.path(.deg_boot_root, "common"))) {
  stop(
    "cannot locate R script root (looked for ", file.path(.deg_boot_root, "common"),
    "): set DEG_R_ROOT or run the script by path",
    call. = FALSE
  )
}

.deg_source_utf8(file.path(.deg_boot_root, "common", "bootstrap.R"))

# 清理本文件的临时变量，避免污染业务脚本的全局环境
rm(.deg_boot_root, .deg_boot_args, .deg_boot_file)
