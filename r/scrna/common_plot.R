# =============================================================================
# r/scrna/common_plot.R —— 出图相关的公共函数
#
# 为什么单独一个文件：这些函数要能被冒烟脚本直接 source 来单测。
# 放在 run_*.R 里的话，`source()` 会顺带执行 deg_main()，没法只测函数。
# =============================================================================

#' 在图上按**质心**打分组标签（不走 repel）
#'
#' 为什么需要：`DimPlot(label = TRUE, repel = TRUE)` 在只有 2~3 个类型时，
#' 标签会互相「推」——实测两个类型时只剩一个标签，另一个被推到画布外或被丢弃。
#' 类型少的时候直接用质心最稳：位置可预测、一定画得出来、也不会挡住一半的点。
#' 类型多（> 8）时反而该用 repel，否则质心会重叠成一坨 —— 那种情况走 DimPlot 自带。
.scrna_centroid_labels <- function(plot, obj, reduction, column, size = 3.2) {
  emb <- tryCatch(Seurat::Embeddings(obj, reduction)[, 1:2, drop = FALSE],
                  error = function(e) NULL)
  if (is.null(emb)) return(plot)
  grp <- as.character(obj@meta.data[[column]])
  keep <- !is.na(grp)
  if (!any(keep)) return(plot)
  ctr <- tapply(seq_len(sum(keep)), grp[keep], function(i) colMeans(emb[keep, , drop = FALSE][i, , drop = FALSE]))
  ctr <- do.call(rbind, ctr)
  df <- data.frame(x = ctr[, 1], y = ctr[, 2], label = rownames(ctr), stringsAsFactors = FALSE)
  # 用「半透明白底标签」而不是纯文字：簇很密时深色文字会糊在深色点里
  # （实测 Vascular 落在深紫细胞堆上，只剩半截能看清）
  plot + ggplot2::geom_label(
    data = df, ggplot2::aes(x = x, y = y, label = label),
    inherit.aes = FALSE, size = size, fontface = "bold", colour = "grey10",
    fill = "white", alpha = 0.72, label.size = NA, label.padding = ggplot2::unit(0.12, "lines")
  )
}

