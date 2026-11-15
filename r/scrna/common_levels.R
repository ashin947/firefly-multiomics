# =============================================================================
# r/scrna/common_levels.R —— 单细胞模块的共用小工具（被 embed / markers 一起 source）
#
# 为什么单独一个文件：簇的顺序必须**只有一处实现**。第 4 步产出对象时定一次，
# 第 5 步兜底时调同一个函数 —— 两处各写一套 `order(as.integer(...))` 迟早分叉，
# 表现是「热图按数字序、表格按字典序」这种没人能一眼看出的错位。
# =============================================================================

#' 把 cluster 的 factor levels 排成**数字序**（不是字典序）
#'
#' 默认的 `factor("0","1","2",...,"10")` 是字典序：0 1 10 11 2 3 …，
#' 于是热图色带、小提琴分面、结果表全是这个顺序 —— 客户看图时第一反应是「这排得不对」。
#'
#' 簇名将来可能不是纯数字（合并/重命名之后可能是 "T cells" 这种），
#' 所以排序键要「能转数字就按数字，转不了就按字符串」，不能硬 `as.integer()`。
.scrna_order_clusters <- function(obj, column = "clusters") {
  if (!column %in% colnames(obj@meta.data)) return(obj)
  ids <- as.character(obj@meta.data[[column]])
  lv <- unique(ids)
  lv <- lv[!is.na(lv)]
  num <- suppressWarnings(as.integer(lv))
  lv <- if (all(!is.na(num))) lv[order(num)] else sort(lv)
  obj@meta.data[[column]] <- factor(ids, levels = lv)
  obj
}

#' 取簇的**有序** levels（数字序，不是字典序）
#'
#' ★ 为什么不能写 `levels(factor(as.character(obj$clusters)))`：
#'   `factor()` 会按**字典序**重建 levels → `0,1,10,11,12,13,2,3,...`。
#'   这个顺序会直接出现在小提琴的 x 轴、图例和 celltype 配色的「取第一个簇」里，
#'   而 UMAP 图例是数字序 —— 两张图并排放着，用户第一眼就会觉得「顺序乱了」。
#'   实测踩过：自选基因小提琴的 x 轴是 0,1,10,11,12,13,2,…
.scrna_cluster_levels <- function(obj, column = "clusters") {
  ids <- tryCatch(obj@meta.data[[column]], error = function(e) NULL)
  if (is.null(ids)) return(character(0))
  if (is.factor(ids)) return(levels(ids))
  lv <- unique(as.character(ids))
  lv <- lv[!is.na(lv)]
  num <- suppressWarnings(as.integer(lv))
  if (length(lv) > 0 && all(!is.na(num))) lv[order(num)] else sort(lv)
}
