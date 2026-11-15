# =============================================================================
# r/enrich/run_gsea.R —— GSEA（基因集富集分析）
#
# 与 run_ora.R 的区别（别把两者混为一谈）：
#   ORA  —— 先按阈值切出「差异基因」，再看这些基因在通路里是否过代表；
#            输入是**基因集合**，丢掉 logFC 的大小信息。
#   GSEA —— 用**全部基因的排序**（按 logFC 降序）扫过每个基因集的成员，
#            看在排序表的两端是否异常聚集；不需要先切阈值，也不丢效应量。
#   所以 GSEA 的输入必须是「基因 + logFC」两列，只给基因名跑不了。
#
# 基因集来源：
#   1. 内置 human / mouse：resources/gmt/<species>_kegg.gmt
#      ★ 由 scripts/build-gmt.R 从 KEGG 下载的 Entrez 基因集转成 SYMBOL 生成。
#        KEGG 给的是 Entrez，用户文件里是符号，不转换的话交集为 0，
#        fgsea 会报 "No pathways had genes in common"。
#   2. 自定义 GMT：用户提供的 .gmt（标准格式：名称<TAB>描述<TAB>基因...）
#      客户实验室习惯先用 read_excel + get_gmt() 把 KEGG 表转成 GMT 再用，
#      所以 GMT 是他们的既有工作流，直接支持比要求他们改格式更省事。
#
# 输出：
#   gsea_result.csv   全部基因集的结果（pathway/pval/padj/ES/NES/size/leadingEdge）
#   gsea_top.png      按 p 值取的 topN 通路总览（plotGseaTable）
#   gsea_detail.png   用户指定通路的详情图（gseaplot2，含 p 值表）
# =============================================================================

.deg_root <- Sys.getenv("DEG_R_ROOT", unset = "")
if (!nzchar(.deg_root)) {
  .deg_args <- commandArgs(trailingOnly = FALSE)
  .deg_file <- sub("^--file=", "", grep("^--file=", .deg_args, value = TRUE))
  .deg_root <- dirname(dirname(normalizePath(.deg_file, mustWork = FALSE)))
}
source(file.path(.deg_root, "common", "loader.R"))

.plot_param <- function(ctx, name, default) {
  value <- deg_param(ctx, name, default)
  if (is.null(value) || length(value) == 0) default else value
}

#' 读差异基因表并识别「基因列 / logFC 列 / p 列」
#'
#' 为什么要自动识别：用户手里的差异结果来自不同工具，列名完全不统一 ——
#' limma 的叫 `logFC`、DESeq2 的叫 `log2FoldChange`、公司给的表格常叫 `log2.FC`，
#' p 值有 `P.Value` / `PValue` / `pvalue` / `P` 四五种写法。硬编码一种列名，
#' 用户就得手工改表头才能用。
.read_deg_table <- function(path) {
  if (!nzchar(path) || !file.exists(path)) {
    deg_stop("E_DATA_MISSING", paste0("differential result file not found: ", path), status = 12L)
  }
  # 分隔符按扩展名猜：.csv 用逗号，其余按 Tab（客户的 diff.txt 都是 Tab）
  sep <- if (grepl("\\.csv$", path, ignore.case = TRUE)) "," else "\t"
  df <- tryCatch(
    utils::read.delim(path, sep = sep, header = TRUE, check.names = FALSE,
                      quote = "", comment.char = "", stringsAsFactors = FALSE),
    error = function(e) NULL
  )
  if (is.null(df) || ncol(df) < 2) {
    deg_stop("E_DATA_INVALID",
             paste0("cannot parse differential result (need at least 2 columns, tab/comma separated): ",
                    basename(path)),
             status = 13L)
  }
  df
}

#' 按候选名（忽略大小写和标点）找列
.pick_column <- function(cols, candidates) {
  # ★ 必须先 tolower 再剔标点。反过来写的话 `[^a-z0-9]` 会把**大写字母也删掉**：
  #   `logFC` 变成 `log`，于是和候选 `logfc` 永远匹配不上 —— 实测踩过，
  #   现象是「表里明明有 logFC 列，却报 no logFC column found」。
  norm <- function(x) gsub("[^a-z0-9]", "", tolower(x))
  normCols <- norm(cols)
  for (cand in candidates) {
    hit <- which(normCols == norm(cand))
    if (length(hit) > 0) return(cols[hit[1]])
  }
  # 退一步：包含关系（`log2FoldChange` 里含 `logfc` 的规范化后并不相等）
  for (cand in candidates) {
    hit <- which(grepl(norm(cand), normCols, fixed = TRUE))
    if (length(hit) > 0) return(cols[hit[1]])
  }
  NULL
}

#' 把一列数值转成 GSEA 需要的命名向量（降序 + 去重）
#'
#' ★ 必须去重：同一个基因在表里出现两次，fgsea 会把它当两个秩位参与游走，
#'   导致 ES 偏大。保留 |logFC| 最大的那条 —— 它代表这个基因最强的证据。
  .build_ranked_stats <- function(genes, values) {
  keep <- !is.na(values) & is.finite(values) & nzchar(genes)
  genes <- genes[keep]
  values <- values[keep]
  if (length(genes) < 10) {
    deg_stop("E_DATA_EMPTY",
             sprintf("need at least 10 genes with a finite logFC to run GSEA, got %d", length(genes)),
             status = 13L)
  }
  ord <- order(abs(values), decreasing = TRUE)
  genes <- genes[ord]
  values <- values[ord]
  dup <- duplicated(genes)
  genes <- genes[!dup]
  values <- values[!dup]
  stats <- stats::setNames(as.numeric(values), genes)
  sort(stats, decreasing = TRUE)
}

#' 内置 GMT 路径（物种 + 集合）
#'
#' 内置的是 **MSigDB 2024.1.Hs / 2024.1.Mm** 的 symbol 版基因集：
#'   hallmark —— H 集合，50 条，跨研究最稳、解释性最强，默认用它
#'   kegg     —— C2:CP:KEGG_LEGACY，186 条（**仅人类**，MSigDB 没提供小鼠版）
#'   reactome —— C2:CP:REACTOME，人类 1736 / 小鼠 1289 条
#'
#' 小鼠没有 kegg 是 MSigDB 的事实，不是我们漏打包 —— 报错时要把这条说清楚，
#' 否则用户会一直试。
.builtin_gmt <- function(species, collection) {
  root <- Sys.getenv("DEG_RESOURCES_ROOT", unset = "")
  if (!nzchar(root)) return("")
  candidate <- file.path(root, "gmt", sprintf("%s_%s.gmt", species, collection))
  if (file.exists(candidate)) candidate else ""
}

#' 某个物种可用的集合（用于错误提示）
.collections_of <- function(species) {
  root <- Sys.getenv("DEG_RESOURCES_ROOT", unset = "")
  if (!nzchar(root)) return(character(0))
  files <- list.files(file.path(root, "gmt"), pattern = sprintf("^%s_.*\\.gmt$", species))
  sub(sprintf("^%s_(.*)\\.gmt$", species), "\\1", files)
}

deg_main("enrich/run_gsea.R", function(ctx) {
  startedAt <- Sys.time()
  deg_ensure_pkgs(c("fgsea", "clusterProfiler", "enrichplot", "ggplot2", "data.table"))

  degPath <- as.character(.plot_param(ctx, "degPath", ""))
  geneColumn <- as.character(.plot_param(ctx, "geneColumn", ""))
  logfcColumn <- as.character(.plot_param(ctx, "logfcColumn", ""))
  pColumn <- as.character(.plot_param(ctx, "pColumn", ""))
  pCutoff <- as.numeric(.plot_param(ctx, "pvalueCutoff", 1))
  gmtSource <- as.character(.plot_param(ctx, "gmtSource", "human"))
  gmtCollection <- as.character(.plot_param(ctx, "gmtCollection", "hallmark"))
  gmtPath <- as.character(.plot_param(ctx, "gmtPath", ""))
  topN <- as.integer(.plot_param(ctx, "topN", 5))
  wanted <- as.character(.plot_param(ctx, "pathways", character(0)))
  wanted <- wanted[nzchar(wanted)]
  minSize <- as.integer(.plot_param(ctx, "minSize", 15))
  maxSize <- as.integer(.plot_param(ctx, "maxSize", 500))
  nperm <- as.integer(.plot_param(ctx, "nperm", 1000))
  widthIn <- as.numeric(.plot_param(ctx, "widthIn", 10.5))
  # 配色。默认值**逐字取自**客户原始脚本：
  #   ccc = c('#55B7E6','#193E8F','#E53528','#F09739', pal_simpsons()(2))
  # 前四个是他手写的（浅蓝 / 深蓝 / 红 / 橙），后两个是 ggsci 辛普森调色板的前两色
  # （#FED439 黄、#709AE1 天蓝）。别退回 gseaplot2 的默认绿紫黄，也别自己另编色值 ——
  # 他拿这套出过图，颜色对不上会比「不好看」更让人困惑。
  palette <- as.character(.plot_param(ctx, "palette", character(0)))
  palette <- palette[nzchar(palette)]
  if (length(palette) == 0) {
    palette <- c("#55B7E6", "#193E8F", "#E53528", "#F09739", "#FED439", "#709AE1")
  }
  heightIn <- as.numeric(.plot_param(ctx, "heightIn", 8))

  # ---- 1. 读差异表 ------------------------------------------------------
  emit_progress("read", 10, "reading differential result")
  df <- .read_deg_table(degPath)
  cols <- names(df)

  geneCol <- if (nzchar(geneColumn)) geneColumn else {
    .pick_column(cols, c("gene", "gene_id", "geneid", "symbol", "id")) %||% cols[1]
  }
  logfcCol <- if (nzchar(logfcColumn)) logfcColumn else {
    .pick_column(cols, c("logfc", "log2foldchange", "log2fc", "foldchange", "fc"))
  }
  if (is.null(logfcCol) || !logfcCol %in% cols) {
    deg_stop("E_DATA_INVALID",
             paste0("no logFC column found in ", basename(degPath),
                    " (columns: ", paste(utils::head(cols, 12), collapse = ", "), "). ",
                    "GSEA needs a fold-change column; specify it explicitly if the name is unusual."),
             status = 13L)
  }
  pCol <- if (nzchar(pColumn)) pColumn else {
    .pick_column(cols, c("p.value", "pvalue", "pval", "p", "adj.p.val", "padj"))
  }

  # p 预过滤：默认不过滤（GSEA 的标准做法是用全部基因排序）。
  # 客户原来的脚本会先切 p<0.05 —— 那是把 ORA 的习惯带进 GSEA，会削弱检验效力，
  # 所以做成可选：pvalueCutoff < 1 时才过滤。
  if (!is.null(pCol) && pCol %in% cols && pCutoff < 1) {
    pv <- suppressWarnings(as.numeric(df[[pCol]]))
    keep <- !is.na(pv) & pv < pCutoff
    emit_log("info", sprintf("pre-filter %s < %g: %d of %d rows kept", pCol, pCutoff,
                             sum(keep), nrow(df)))
    df <- df[keep, , drop = FALSE]
  }

  stats <- .build_ranked_stats(as.character(df[[geneCol]]),
                               suppressWarnings(as.numeric(df[[logfcCol]])))
  emit_log("info", sprintf("ranked list: %d genes (gene col '%s', logFC col '%s')",
                           length(stats), geneCol, logfcCol))

  # ---- 2. 读基因集 ------------------------------------------------------
  emit_progress("read", 25, "loading gene sets")
  if (identical(gmtSource, "custom")) {
    if (!nzchar(gmtPath) || !file.exists(gmtPath)) {
      deg_stop("E_DATA_MISSING", paste0("custom GMT not found: ", gmtPath), status = 12L)
    }
    pathways <- fgsea::gmtPathways(gmtPath)
    emit_log("info", sprintf("custom GMT: %s (%d gene sets)", basename(gmtPath), length(pathways)))
  } else {
    builtin <- .builtin_gmt(gmtSource, gmtCollection)
    if (!nzchar(builtin)) {
      available <- .collections_of(gmtSource)
      hint <- if (length(available) > 0) {
        sprintf("%s 可用的集合有：%s。", gmtSource, paste(available, collapse = " / "))
      } else {
        "安装包里没有这个物种的任何内置基因集。"
      }
      deg_stop("E_RT_ANNOTATION_MISSING",
               paste0("内置基因集缺失：", gmtSource, "_", gmtCollection, ".gmt。", hint,
                      "请改选其它集合，或改用「自定义 GMT」。"),
               status = 12L)
    }
    pathways <- fgsea::gmtPathways(builtin)
    emit_log("info", sprintf("builtin GMT: %s (%d gene sets)", basename(builtin), length(pathways)))
  }

  # 交集检查：这一步能在「ID 体系不一致」时给出可读报错，
  # 否则 fgsea 只会抛一个 "No pathways had genes in common"
  nCommon <- sum(vapply(pathways, function(g) sum(stats::na.omit(match(g, names(stats))) > 0), integer(1)))
  hitGenes <- unique(unlist(lapply(pathways, function(g) intersect(g, names(stats)))))
  if (length(hitGenes) < 10) {
    deg_stop("E_DATA_MISMATCH",
             sprintf(paste0("only %d of %d input genes appear in the gene sets ",
                            "(%d of %d sets touched). The gene ids in your file and in the ",
                            "gene sets look like different id systems ",
                            "(e.g. file uses Ensembl ids while the GMT uses gene symbols)."),
                     length(hitGenes), length(stats), sum(nCommon > 0), length(pathways)),
             status = 13L)
  }
  emit_log("info", sprintf("overlap: %d input genes in gene sets", length(hitGenes)))

  # ---- 3. 跑 GSEA -------------------------------------------------------
  emit_progress("enrich", 45, "running GSEA")
  # ★ 强制 BiocParallel 用串行后端。
  #   默认后端在 Windows 上是 SnowParam，它会去 requireNamespace("snow")，
  #   而内置 R 里没有 snow 包 → 直接报 `there is no package called 'snow'`，
  #   整个过程还没开跑就失败。串行对单机 GSEA 完全够用（fgsea 本身是 C++ 实现，
  #   几万个基因 × 几千个基因集通常几秒内完成），也避免多进程抢内存。
  suppressWarnings(BiocParallel::register(BiocParallel::SerialParam(), default = TRUE))
  set.seed(42)   # fgsea 的置换检验有随机性；固定种子保证同一份输入两次结果一致
  res <- tryCatch(
    suppressWarnings(clusterProfiler::GSEA(
      geneList = stats, TERM2GENE = data.frame(
        term = rep(names(pathways), lengths(pathways)),
        gene = unlist(pathways, use.names = FALSE),
        stringsAsFactors = FALSE
      ),
      pvalueCutoff = 1, pAdjustMethod = "BH",
      minGSSize = minSize, maxGSSize = maxSize, nPerm = nperm, seed = TRUE
    )),
    error = function(e) {
      deg_stop("E_R_GENERIC", paste0("GSEA failed: ", conditionMessage(e)), status = 10L)
    }
  )
  resDf <- as.data.frame(res)
  if (nrow(resDf) == 0) {
    deg_stop("E_DATA_EMPTY",
             "GSEA returned no gene set; check minSize/maxSize against the gene set sizes",
             status = 13L)
  }
  resDf <- resDf[order(resDf$pvalue), , drop = FALSE]
  emit_log("info", sprintf("GSEA result: %d gene sets (padj<0.05: %d)",
                           nrow(resDf), sum(resDf$p.adjust < 0.05, na.rm = TRUE)))

  # ---- 4. 写结果表 ------------------------------------------------------
  emit_progress("write", 65, "writing result table")
  outDf <- data.frame(
    pathway = as.character(resDf$ID),
    description = as.character(resDf$Description),
    size = as.integer(resDf$setSize),
    es = as.numeric(resDf$enrichmentScore),
    nes = as.numeric(resDf$NES),
    pvalue = as.numeric(resDf$pvalue),
    p_adjust = as.numeric(resDf$p.adjust),
    leading_edge = as.character(resDf$core_enrichment),
    stringsAsFactors = FALSE
  )
  csvPath <- file.path(ctx$runDir, "gsea_result.csv")
  data.table::fwrite(outDf, csvPath)
  emit_artifact("gsea_table", "gsea_result.csv", rows = nrow(outDf), schema = "GseaResultRow[]")

  # ---- 5. 画图 ----------------------------------------------------------
  emit_progress("plot", 80, "drawing GSEA plots")
  #' 同一张图同时画成 PNG（界面预览）和 PDF（投稿矢量）
  #'
  #' ★ 参数必须是**闭包**，不能是表达式。这是 R 的一个坑：形参是 promise，
  #'   第一次 `force(expr)` 之后就被缓存了，第二次再写 `force(expr)` 拿到的是
  #'   上次的结果，**根本不会再执行绘图** —— 表现为 PDF 文件生成了但是空白的，
  #'   而且不报任何错。所以这里收 `drawer` 函数，两次都是真正调用。
  #'
  #' @param base 不含扩展名的路径，如 `<runDir>/gsea_top`
  #' @return list(png=路径, pdf=路径或NULL)
  draw_both <- function(base, drawer) {
    pngPath <- paste0(base, ".png")
    grDevices::png(pngPath, width = widthIn, height = heightIn, units = "in", res = 300)
    tryCatch(drawer(), finally = grDevices::dev.off())

    pdfPath <- paste0(base, ".pdf")
    ok <- tryCatch({
      # useDingbats = FALSE：默认 Dingbats 会把 • 之类编成符号字体，
      # 在投稿系统里常表现为乱码方框
      grDevices::pdf(pdfPath, width = widthIn, height = heightIn,
                     onefile = FALSE, useDingbats = FALSE, bg = "white")
      drawer()
      TRUE
    }, error = function(e) {
      emit_log("warn", paste0("vector PDF failed (PNG is still available): ", conditionMessage(e)))
      FALSE
    }, finally = {
      # dev.cur() > 1 才关：pdf 设备没开成功时乱关会把别的设备关掉
      if (grDevices::dev.cur() > 1L) try(grDevices::dev.off(), silent = TRUE)
    })
    if (!isTRUE(ok) || !file.exists(pdfPath) || isTRUE(file.info(pdfPath)$size < 1024)) {
      if (file.exists(pdfPath)) try(unlink(pdfPath), silent = TRUE)
      return(list(png = pngPath, pdf = NULL))
    }
    list(png = pngPath, pdf = pdfPath)
  }

  # 5.1 topN 总览：按 p 值取前 N 个基因集
  nTop <- max(1L, min(topN, nrow(outDf)))
  topIds <- utils::head(outDf$pathway, nTop)

  topBase <- file.path(ctx$runDir, "gsea_top")
  topPath <- paste0(topBase, ".png")
  # ★ 这里**不用** fgsea::plotGseaTable。
  #   实测它在 png 设备上会把 NES / pval / padj 三列数字叠在一起，
  #   还会输出 `<U+00B7>` 之类的转义字符（列宽不足以容纳科学计数法）。
  #   gseaplot2 的多基因集模式把各条 ES 曲线叠在同一张图上 + 底部 p 值表，
  #   信息量够、渲染稳定，而且和下面「指定通路」的详情图风格统一。
  tryCatch(
    draw_both(topBase, function() {
      print(enrichplot::gseaplot2(
        res, geneSetID = topIds,
        title = sprintf("Top %d gene sets by p-value", length(topIds)),
        pvalue_table = TRUE, base_size = 10,
        rel_heights = c(1.6, 0.25, 0.6), subplots = 1:3,
        # 曲线数可能多于颜色数（topN 可到 50），循环取色而不是报错
        color = rep_len(palette, length(topIds))
      ))
    }),
    error = function(e) emit_log("warn", paste0("top-N plot failed: ", conditionMessage(e)))
  )
  if (file.exists(topPath)) {
    emit_artifact("gsea_plot", "gsea_top.png", rows = length(topIds), kind = "gsea-top")
  }

  # 5.2 指定通路详情：用户点了名字就画这几条，没指定就画 top1
  detailIds <- if (length(wanted) > 0) wanted else utils::head(outDf$pathway, 1)
  missingIds <- setdiff(detailIds, outDf$pathway)
  if (length(missingIds) > 0) {
    emit_log("warn", sprintf("pathway(s) not in the result and skipped: %s",
                             paste(utils::head(missingIds, 5), collapse = ", ")))
  }
  detailIds <- intersect(detailIds, outDf$pathway)
  if (length(detailIds) > 0) {
    detailIds <- utils::head(detailIds, 4)   # 一张图里最多叠 4 条，再多曲线看不清
    detailBase <- file.path(ctx$runDir, "gsea_detail")
    detailPath <- paste0(detailBase, ".png")
    tryCatch(
      draw_both(detailBase, function() {
        print(enrichplot::gseaplot2(res, geneSetID = detailIds,
                                    title = "", pvalue_table = TRUE,
                                    base_size = 11, rel_heights = c(1.2, 0.2, 0.5),
                                    subplots = 1:3,
                                    color = rep_len(palette, length(detailIds))))
      }),
      error = function(e) emit_log("warn", paste0("detail plot failed: ", conditionMessage(e)))
    )
    if (file.exists(detailPath)) {
      emit_artifact("gsea_plot", "gsea_detail.png", rows = length(detailIds), kind = "gsea-detail")
    }
  }

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")
  emit_result(list(
    geneSets = nrow(outDf),
    inputGenes = length(stats),
    overlappedGenes = length(hitGenes),
    significant = sum(outDf$p_adjust < 0.05, na.rm = TRUE),
    topN = length(topIds),
    detailPlotted = length(detailIds),
    gmt = if (identical(gmtSource, "custom")) basename(gmtPath) else paste0(gmtSource, "_", gmtCollection, ".gmt"),
    durationMs = as.integer(durationMs)
  ))
})
