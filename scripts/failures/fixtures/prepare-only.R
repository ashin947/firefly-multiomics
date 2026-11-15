# =============================================================================
# scripts/failures/fixtures/prepare-only.R —— 失败路径冒烟用的**测试夹具**，不是产品脚本
#
# 为什么需要它：`r/de/run_limma_voom.R` 第 3 行就 `deg_ensure_pkgs(c("limma", ...))`，
# 缺包时一律 exit 12，**任何下游错误都被 12 挡住**，于是「config 缺字段 → 11」和
# 「数据不满足 → 13」这两条契约在没装 limma 的机器上根本测不到。
#
# 这个夹具走与 run_limma_voom.R **完全相同的前 4 步**（validate_common → prepare →
# 取 contrast → 校验对比），只去掉包门禁。一旦 R 包装好，冒烟脚本会自动改回用
# 真正的 run_limma_voom.R（见 smoke-r-failures.mjs 的 entry 选择逻辑），
# 所以这里只是「缺包环境下的降级入口」，不是替代品。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

deg_main("fixtures/prepare-only.R", function(ctx) {
  deg_validate_common(ctx)
  d <- deg_de_prepare(ctx)
  contrastStr <- deg_de_contrast(deg_param_required(ctx, "contrast"), d$levels)
  emit_log("info", paste0("contrast ok: ", contrastStr))
  emit_progress("write", 100, "done")
  emit_result(list(genes = nrow(d$expr), samples = length(d$samples)))
})
