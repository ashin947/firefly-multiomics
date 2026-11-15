# =============================================================================
# scripts/failures/fixtures/pkg-missing.R —— 失败路径冒烟用的**测试夹具**
#
# 验证「缺必需包 → E_RT_PKG_MISSING + exit 12」。
#
# 为什么不能直接跑 r/de/run_limma_voom.R：
#   本机 limma/edgeR 装在 **R 自带 library**（`<R_HOME>/library`）里，而
#   `.Library` 永远排在 `.libPaths()` 的最前面，且 `R_LIBS_SITE`/`R_LIBS_USER`
#   只能往**后面**追加——环境变量根本屏蔽不掉它（实测：把两个库路径都指向空目录，
#   `requireNamespace("limma")` 仍然 TRUE）。
#
# 所以这里换一个不改用户库、不动 R 安装目录的办法：
#   在 `.libPaths()` 最前面插一个「残缺的 limma」目录（只有 DESCRIPTION、没有
#   Meta/package.rds 与 R/ 代码）。R 会认为这个 limma 不可用，
#   `requireNamespace("limma", quietly = TRUE)` 返回 FALSE（不是报错），
#   于是下游的 `deg_ensure_pkgs()` 走的是**和真脚本一模一样**的缺包分支。
#
# 注意 deg_ensure_pkgs 的实参列表与 r/de/run_limma_voom.R 第 3 行完全相同——
# 这是本夹具唯一想证明的事：那条门禁在缺包时确实给出 12 和 E_RT_PKG_MISSING。
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

deg_main("fixtures/pkg-missing.R", function(ctx) {
  # 由冒烟脚本创建并通过环境变量传入（不改用户库、不改 R 安装）
  shim <- Sys.getenv("DEG_SMOKE_PKG_SHIM", unset = "")
  if (!nzchar(shim) || !dir.exists(shim)) {
    deg_stop(
      "E_VALIDATION",
      "DEG_SMOKE_PKG_SHIM is not set; cannot construct the missing-package scenario",
      status = 11L
    )
  }
  invisible(.libPaths(c(shim, .libPaths())))
  emit_log("info", paste0("libPaths after shim: ", paste(.libPaths(), collapse = " | ")))

  # 与 r/de/run_limma_voom.R 第 3 行完全相同的调用
  deg_ensure_pkgs(c("limma", "edgeR", "data.table"))

  # 走到这里说明 shim 没生效（场景无法构造），如实报出来而不是假装成功
  deg_stop("E_R_GENERIC", "package shim did not take effect: limma is still visible", status = 10L)
})
