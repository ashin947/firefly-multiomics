# =============================================================================
# r/scrna/common_palette.R —— 簇配色的**唯一来源**
#
# 为什么必须只有一处：UMAP、DotPlot、小提琴、热图色带都用同一份颜色。
# 如果两处各调一次 `DiscretePalette()`，只要簇数量或顺序有一点差别，颜色就错位 ——
# 而错位的表现是「图还是花的，只是叠在一起对不上」，肉眼极难发现。
#
# 做法：第 4 步生成对象时把 palette 写进 `obj@misc$clusterPalette`，
# 下游一律先读它；外部导入的对象没有这个字段时，用**同一个函数**按 levels 现生成
# （levels 相同 → 颜色相同）。
# =============================================================================

.scrna_cluster_palette <- function(obj, column = "clusters") {
  cached <- tryCatch(obj@misc$clusterPalette, error = function(e) NULL)
  if (!is.null(cached) && length(cached) > 0) return(cached)

  lv <- .scrna_cluster_levels(obj, column)
  # 客户脚本的 color74 是空向量（颜色全被注释），不能用；这里用 Seurat 自带调色板
  pal <- tryCatch({
    if (length(lv) <= 26L) {
      Seurat::DiscretePalette(length(lv), palette = "alphabet")
    } else if (length(lv) <= 36L) {
      Seurat::DiscretePalette(length(lv), palette = "polychrome")
    } else {
      NULL
    }
  }, error = function(e) NULL)
  if (is.null(pal) || length(pal) < length(lv)) {
    pal <- grDevices::hcl.colors(length(lv), "Dark 3")
  }
  stats::setNames(unname(pal), lv)
}

#' 细胞类型配色 —— **从簇配色派生**，不另生成一套
#'
#' 为什么不能给 celltype 单独生成：一个 celltype 往往由多个簇合并而来。
#' 如果注释前 UMAP 是簇色、注释后换成另一套互不相干的颜色，用户会认不出
#' 「刚才那块细胞去哪了」。派生规则：取该 celltype 包含的**第一个簇（按 levels 顺序）**
#' 的颜色 —— 合并出来的类型，颜色等于它「最主要的那个簇」，视觉上天然连贯。
#'
#' 结果写进 `obj@misc$celltypePalette`，下游 DimPlot / VlnPlot / DotPlot 全读这一份。
.scrna_celltype_palette <- function(obj, clusterColumn = "clusters", celltypeColumn = "celltype") {
  cached <- tryCatch(obj@misc$celltypePalette, error = function(e) NULL)
  if (!is.null(cached) && length(cached) > 0) return(cached)

  meta <- obj@meta.data
  if (!celltypeColumn %in% colnames(meta)) return(stats::setNames(character(0), character(0)))

  clusterPal <- .scrna_cluster_palette(obj, clusterColumn)
  clusters <- .scrna_cluster_levels(obj, clusterColumn)
  # 每个簇对应哪个 celltype（取该簇第一个细胞的标签；理论上簇内一致）
  perCluster <- tapply(
    as.character(meta[[celltypeColumn]]),
    factor(as.character(meta[[clusterColumn]]), levels = clusters),
    function(x) x[1]
  )
  perCluster <- perCluster[!is.na(perCluster)]

  types <- unique(unname(perCluster))
  pal <- vapply(types, function(ct) {
    firstCluster <- names(perCluster)[which(unname(perCluster) == ct)[1]]
    colour <- unname(clusterPal[firstCluster])
    if (is.na(colour)) "#999999" else colour
  }, character(1))
  stats::setNames(unname(pal), types)
}
