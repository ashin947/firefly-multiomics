# =============================================================================
# scripts/failures/fixtures/write-failure.R —— 失败路径冒烟用的**测试夹具**
#
# 验证「写盘失败 → E_IO_PERMISSION + exit 14」。
#
# 失败是怎么造出来的：冒烟脚本会在 runDir 里预先创建一个**名为 de.csv.tmp 的目录**。
# 于是 deg_write_csv() 里 `data.table::fwrite(df, "de.csv.tmp")` 必然失败，
# 走到 `deg_stop("E_IO_PERMISSION", ..., status = 14L)`。
# 为什么不用「只读目录」：Windows 上只读属性对文件不生效（要 ACL），不可靠；
# 「同名目录占位」是跨平台确定的失败方式，而且不需要管理员权限。
#
# 这里调用的是产品代码 deg_write_csv()，不是自己造一个写失败 —— 要验的正是
# 那个函数在失败时给不给 14。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

deg_main("fixtures/write-failure.R", function(ctx) {
  df <- data.frame(gene_id = c("g1", "g2"), logFC = c(1.5, -2), stringsAsFactors = FALSE)
  deg_write_csv(df, file.path(ctx$runDir, "de.csv"))
  emit_result(list(rows = nrow(df)))
})
