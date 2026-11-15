# =============================================================================
# r/probe/_selftest.R —— 进程运行器自测脚本（T05 验收用，非产品功能）
#
# 用途：在装有 R 的机器上验证 RProcessRunner 的三条关键路径：
#   ① 报错路径   : deg_selftest(config params$mode = "boom")  → 应报 E_R_GENERIC 且 detail 含 "boom"
#   ② 取消路径   : mode = "sleep" → 进程应被 kill，3s 内消失，UI 收到 cancelled
#   ③ raw 输出   : mode = "plain" → cat() 的裸输出应进日志面板（level=raw）
#   ④ 正常路径   : mode = "ok"    → 应收到 result 消息并 exit 0
#
# 手动调用示例：
#   Rscript r/probe/_selftest.R --config <runDir>/run_config.json
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
# ★ 加载 loader.R 而不是 bootstrap.R：后者由 loader.R 以与 locale 无关的方式加载，
#   否则 Windows + LC_CTYPE=C 会「source 半途返回 → 找不到 deg_main」。见 loader.R 文件头。
source(file.path(.deg_root, "common", "loader.R"))

deg_main("probe/_selftest.R", function(ctx) {
  mode <- as.character(deg_param(ctx, "mode", "ok"))

  emit_progress("read", 10, paste0("selftest mode=", mode))

  if (identical(mode, "boom")) {
    emit_log("info", "about to stop() on purpose")
    stop("boom: intentional failure for RProcessRunner selftest")
  }

  if (identical(mode, "sleep")) {
    emit_log("info", "sleeping 600s; kill me to test cancellation")
    Sys.sleep(600)
    emit_result(list(mode = mode, note = "should have been killed before this"))
    return(invisible(NULL))
  }

  if (identical(mode, "plain")) {
    cat("plain output line 1\n")
    cat("plain output line 2\n")
    emit_log("info", "two plain lines written to stdout")
    emit_result(list(mode = mode, plainLines = 2L))
    return(invisible(NULL))
  }

  if (identical(mode, "badjson")) {
    cat("@@DEG@@ {this is not json\n")
    cat("@@DEG@@ {\"v\":1,\"type\":\"log\"}\n")   # 缺 seq/level/msg，应被丢弃
    cat("@@DEG@@ {\"v\":1,\"type\":\"log\",\"seq\":9,\"ts\":1,\"level\":\"info\",\"msg\":\"recovered\"}\n")
    emit_result(list(mode = mode))
    return(invisible(NULL))
  }

  # mode == "ok"
  emit_progress("write", 100, "done")
  emit_result(list(mode = mode, rVersion = as.character(getRversion())))
})
