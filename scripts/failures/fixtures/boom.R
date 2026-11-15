# =============================================================================
# scripts/failures/fixtures/boom.R —— 失败路径冒烟用的**测试夹具**
#
# 验证「脚本内 stop() → E_R_GENERIC + exit 10」这条契约。
# 之所以不能只靠 RErrorTranslator 单测：那测的是"给定 stderr 怎么翻译"，
# 而这里要证明的是「R 真的以 10 退出，且错误信息真的经协议行到达了主进程」。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

deg_main("fixtures/boom.R", function(ctx) {
  emit_progress("read", 5, "about to stop() on purpose")
  stop("boom: intentional failure from smoke-r-failures")
})
