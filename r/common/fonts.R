# =============================================================================
# r/common/fonts.R —— 中文字体注册（PRD R-30 / ARCHITECTURE §6.4）
#
# 根因：Windows 上 pdf() 的默认字体族不含中文；windowsFonts() 注册的字体在 pdf() 上无效；
#       cairo_pdf() 依赖系统 cairo 与字体配置。
# 方案：内置 Noto Sans SC + sysfonts 注册为 DEGSans + showtext 接管文本渲染。
#
# 设计取舍（ARCHITECTURE U11）：优先只用 ragg + family="DEGSans"（ragg 原生支持字体），
# showtext 仅作为 cairo_pdf 的兜底；两者同时启用时若出现 dpi 错位，可关掉 showtext。
# =============================================================================

#' 候选字体文件（内置优先，其次系统常见中文字体）
deg_font_candidates <- function() {
  builtin <- Sys.getenv("DEG_FONT_PATH", unset = "")
  cands <- c(
    builtin,
    file.path(Sys.getenv("DEG_RESOURCES_ROOT", unset = ""),
              "runtime", "fonts", "NotoSansSC-Regular.otf"),
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
  )
  cands[nzchar(cands)]
}

#' 注册 DEGSans，返回可用的 family 名（失败返回 "sans"）
deg_register_fonts <- function() {
  cands <- deg_font_candidates()
  hit <- cands[file.exists(cands)]

  if (length(hit) == 0) {
    emit_log("warn", "no CJK font file found; Chinese text may render as boxes")
    return("sans")
  }

  if (!requireNamespace("sysfonts", quietly = TRUE)) {
    emit_log("warn", "sysfonts not installed; fallback to system sans font")
    return("sans")
  }

  registered <- tryCatch({
    sysfonts::font_add("DEGSans", regular = hit[1])
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("font registration failed: ", conditionMessage(e)))
    FALSE
  })

  if (!registered) return("sans")

  # showtext 接管文本渲染：cairo_pdf 场景下保证中文不出方框
  if (requireNamespace("showtext", quietly = TRUE)) {
    try(showtext::showtext_auto(), silent = TRUE)
    try(showtext::showtext_opts(dpi = 300), silent = TRUE)
  }

  emit_log("info", paste0("registered CJK font: ", hit[1]))
  "DEGSans"
}

#' 当前可用字体族（供 ggplot theme 使用）
deg_font_family <- function(ctx = NULL) {
  if (!is.null(ctx) && !is.null(ctx$fontFamily) && nzchar(ctx$fontFamily)) {
    return(ctx$fontFamily)
  }
  fams <- tryCatch(
    if (requireNamespace("sysfonts", quietly = TRUE)) sysfonts::font_families() else character(0),
    error = function(e) character(0)
  )
  if ("DEGSans" %in% fams) "DEGSans" else "sans"
}

#' 字体是否就绪（自检用）
deg_font_available <- function() {
  if (identical(deg_font_family(), "DEGSans")) return(TRUE)
  # 没有 sysfonts 时退回「文件是否存在」的判断，至少能告知用户缺字体文件
  length(deg_font_candidates()[file.exists(deg_font_candidates())]) > 0
}

#' 已注册的字体族列表（自检回传给主进程）
deg_font_families <- function() {
  fams <- tryCatch(
    if (requireNamespace("sysfonts", quietly = TRUE)) sysfonts::font_families() else character(0),
    error = function(e) character(0)
  )
  as.character(fams)
}
