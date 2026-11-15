# =============================================================================
# r/common/save_plot.R —— 一张图同时写 PNG（界面预览）与 PDF（投稿矢量）
#
# ## 为什么必须抽成公共函数
#
# 单细胞 9 个脚本 + 时序 4 个脚本各自复制了一份 ggsave 调用，加 PDF 要改 13 处；
# 更糟的是**每个副本都在踩同一个坑**（见下）。集中成一个函数后，只在 bootstrap 里
# source 一次，各脚本只调它。
#
# ## ★ 坑一：别把「绘图动作」写成表达式参数
#
# R 的形参是 promise：`f(expr)` 里第一次 `force(expr)` 之后就缓存了，
# 第二次再 force 拿到的还是上次的结果，**根本不会再画一遍** ——
# 表现为 PDF 文件生成了、但内容是空白/零页，而且不报错。
# 所以 base 图形那条收的是**函数**（闭包），两次都是真正调用。
# 这条在 enrich/run_gsea.R 里已经踩过一次，注释留在那儿。
#
# ## ★ 坑二：PDF 设备要显式关，且只在真开了才关
#
# `dev.off()` 前判 `dev.cur() > 1L`：设备没开成功时乱关会把别的设备关掉。
# `useDingbats = FALSE`：默认的 Dingbats 会把 • 之类编成符号字体，
# 投稿系统里常表现为乱码方框。
#
# ## ★ 坑三：PDF 失败不能连累 PNG
#
# 少了 cairo、字体缺字、临时目录只读……都可能让 PDF 失败。
# 预览图（PNG）已经在手上了，绝不能因为矢量图失败就整个结果作废。
# =============================================================================

#' 判断 cairo 是否可用（PDF 字体嵌入更稳）
.deg_has_cairo <- function() {
  isTRUE(capabilities("cairo"))
}

#' 把 PNG 旁边的 PDF 写出来（内部函数）
#'
#' @param draw 无参函数：真正执行一次绘图
#' @return PDF 路径；失败返回 NULL（并已 warn，不抛错）
.deg_write_pdf <- function(draw, pdfFile, width, height, label) {
  ok <- tryCatch({
    if (.deg_has_cairo()) {
      grDevices::cairo_pdf(pdfFile, width = width, height = height,
                           onefile = FALSE, bg = "white")
    } else {
      emit_log("warn", "cairo is unavailable; falling back to grDevices::pdf (fonts may not embed)")
      grDevices::pdf(pdfFile, width = width, height = height,
                     onefile = FALSE, useDingbats = FALSE, bg = "white")
    }
    draw()
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("vector PDF failed (PNG is still available): ",
                            label, " / ", conditionMessage(e)))
    FALSE
  }, finally = {
    # 只在确实开了设备时才关（dev.cur() == 1 表示只有 null device）
    if (grDevices::dev.cur() > 1L) try(grDevices::dev.off(), silent = TRUE)
  })

  # 空 PDF 约 1–2 KB：小于 1 KB 一定是坏的（典型是上面那个 promise 坑）
  if (!isTRUE(ok) || !file.exists(pdfFile) || isTRUE(file.info(pdfFile)$size < 1024)) {
    if (file.exists(pdfFile)) try(unlink(pdfFile), silent = TRUE)
    return(NULL)
  }
  pdfFile
}

#' 保存一个 ggplot：PNG 用于界面预览，同时写同名 PDF
#'
#' @param plot ggplot 对象
#' @param file PNG 路径（`.pdf` 由它推导）
#' @return TRUE 表示 PNG 写成功（PDF 失败不影响返回值）
deg_save_ggplot <- function(plot, file, width, height, label = "", dpi = 150) {
  ok <- tryCatch({
    deg_ensure_pkgs("ggplot2")
    ggplot2::ggsave(file, plot, width = width, height = height, dpi = dpi,
                    limitsize = FALSE)
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("plot failed (", label, "): ", conditionMessage(e)))
    FALSE
  })
  if (!isTRUE(ok) || !file.exists(file)) return(FALSE)

  .deg_write_pdf(
    function() print(plot),
    sub("\\.png$", ".pdf", file),
    width, height, label
  )
  TRUE
}

#' 保存一个 base 图形：`drawer` 会被调用**两次**（PNG 一次、PDF 一次）
#'
#' @param drawer 无参函数（闭包）。**不能传表达式** —— 见文件头「坑一」。
deg_save_drawer <- function(file, width, height, drawer, label = "", res = 300) {
  ok <- tryCatch({
    grDevices::png(file, width = width, height = height, units = "in", res = res)
    drawer()
    TRUE
  }, error = function(e) {
    emit_log("warn", paste0("plot failed (", label, "): ", conditionMessage(e)))
    FALSE
  }, finally = {
    if (grDevices::dev.cur() > 1L) try(grDevices::dev.off(), silent = TRUE)
  })
  if (!isTRUE(ok) || !file.exists(file)) return(FALSE)

  .deg_write_pdf(drawer, sub("\\.png$", ".pdf", file), width, height, label)
  TRUE
}
