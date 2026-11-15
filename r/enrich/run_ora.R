# =============================================================================
# r/enrich/run_ora.R —— GO / KEGG 过表达富集（ORA）
#
# 支持三种背景来源：
#   1. 内置 human / mouse：OrgDb（org.Hs.eg.db / org.Mm.eg.db）+ enrichGO / enrichKEGG
#   2. 内置 rice：随包注释表 resources/annot/rice_go.tsv + enricher()
#      ★ 由 scripts/build-rice-annot.mjs 从客户的 rice_go_matched.txt 聚合而来：
#        25443 个基因 / 97 个 GO Slim term（176966 行长表 → 宽表）
#   3. 自定义背景文件：clusterProfiler::enricher() + TERM2GENE
#
# ★ 自定义背景（含水稻内置）下的 BP / CC / MF **是分别富集的**：
#   传 `ontology = "BP"` 时先用 GO.db 把这批 term 收窄到 BP，再调 enricher()，
#   于是 BH 校正的分母就是「本类的 term 数」而不是全表 97 个 ——
#   这与客户脚本 docs/reference/rice-enrich-method.R 的口径一致
#   （它同样是 for (classify in c("CC","MF","BP")) 各跑一次 enricher）。
#   `ontology = "ALL"` 时不做收窄，行为与改动前逐字相同。
#
# ★ 为什么水稻不能像人/鼠那样用 OrgDb：
#   Bioconductor **根本没有 org.Os.eg.db**。这不是「没装」，是这个包不存在 ——
#   3.18 的 data/annotation 索引里 org.* 只有 Ag / At.tair / Bt / Ce / Cf / Dm /
#   Dr / EcK12 / EcSakai / Gg / Hs / Mm / Mmu / Mxanthus / Pt / Rn / Sc.sgd /
#   Ss / Xl 共 19 个，没有水稻。所以曾经写的 rice → org.Os.eg.db 分支是**死代码**：
#   用户点「水稻」永远只会拿到 E_RT_PKG_MISSING，且提示里那句「install it」是骗人的
#   （装不上）。水稻必须走 enricher() + 注释表这条路，和自定义背景是同一套代码。
#
# ★ 关于自定义背景文件的格式（客户提供的水稻 R498 注释就是这么长的）：
#     gene_id <TAB> term1 <TAB> term2 ...
#   一行一个基因，后面跟它涉及的所有 term —— 这是「基因→term」方向，
#   而 enricher 要的是「term→基因」两列。所以必须转置，不能直接读进去。
#
#   另外 pathway 文件里一个 term 会带数据库前缀（`KEGG: 00630+4.1.1.39`、
#   `Reactome: REACT_22258`），而 GO 文件里是纯 `GO:0016651`。
#   两种都保留原样，前端可以按前缀筛。
#
# 输出：enrich_result.csv + enrich_result.json（统一 11 列，前端只面对一种形状）
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

# ---------------------------------------------------------------------------
# 自定义背景（含水稻内置注释）的 term 大小门槛 —— **客户口径的固定值**
#
# 客户脚本 docs/reference/rice-enrich-method.R 写的是：
#   enricher(GENE_list, TERM2GENE, TERM2NAME,
#            minGSSize = 3, maxGSSize = 500, pvalueCutoff = 1, qvalueCutoff = 1)
#
# ★★ 我们的取值与那份脚本**不完全相同**，两处差异都是客户后来明确要求的，
#    不是我们算错，也不是随手调的：
#
#   | 参数 | 客户旧脚本 | 我们现在 | 谁定的 |
#   | --- | --- | --- | --- |
#   | minGSSize | 3 | **3** | 对齐旧脚本 |
#   | maxGSSize | 500 | **5000** | **客户 2026-11-12 明确要求放大到 5000** |
#
#   ★ maxGSSize = 5000 这一条尤其要记住：以后有人拿客户 2026-11-12 之前的旧图
#     来对照，会发现我们的条目**更多**（大 term 被放进来了）。那不是 bug。
#     反过来，如果哪天有人「按旧脚本对齐」把它改回 500，是在回退客户的需求。
#
#   minGSSize 那一侧差在 3–9 个基因的小 term：默认 10 会把它们**静默丢掉**，
#   客户拿同一份基因列表跑出来比我们多条目，而界面上没有任何提示说明是阈值不同。
#
# ★ 为什么不去读 EnrichConfig 里的 minGSSize / maxGSSize：
#   那两个字段（src/shared/types/enrich.ts）目前**没有**被 EnrichService 往下传。
#   一旦这里改成读配置，就等于顺带把 human/mouse 也一起改了 —— 它们走 enrichGO
#   另一条分支，客户从没要求它也变成 3 / 5000。要放开成可配置，应该是「两条分支
#   各自读、各自有默认值」，那是独立的一次改动，不要混在这里做。
#
# ★ 作用范围：只有 useCustom 分支的两个 enricher() 调用用它们。
#   `enrichGO` / `enrichKEGG`（human / mouse）一行未动，继续用 clusterProfiler 默认值。
# ---------------------------------------------------------------------------
CUSTOM_MIN_GSSIZE <- 3L
CUSTOM_MAX_GSSIZE <- 5000L

# 物种 → OrgDb 包名
#
# rice 刻意返回 NULL：Bioconductor 没有 org.Os.eg.db（见文件头说明）。
# 返回 NULL 而不是硬写包名，是为了让下面的分支显式地走「注释表」路线，
# 而不是先 requireNamespace 失败再兜底 —— 那样日志里会留一条误导人的警告。
.org_db_of <- function(species) {
  switch(species,
         human = "org.Hs.eg.db",
         mouse = "org.Mm.eg.db",
         NULL)
}

# 物种 → KEGG organism code
.kegg_code_of <- function(species) {
  switch(species, human = "hsa", mouse = "mmu", NULL)
}

#' 找随包的内置注释表
#'
#' 打包后 resources/ 与 r/ 并列，由 DEG_RESOURCES_ROOT 指过来；开发态两者都在仓库根。
#' 文件不存在返回空串（而不是报错），让调用方决定是降级还是停下。
builtin_annot_path <- function(species, kind) {
  root <- Sys.getenv("DEG_RESOURCES_ROOT", unset = "")
  if (!nzchar(root)) return("")
  candidate <- file.path(root, "annot", sprintf("%s_%s.tsv", species, kind))
  if (file.exists(candidate)) candidate else ""
}

#' 注释文件是「宽表」还是「长表」？
#'
#' 两种格式都真实存在，必须自动分辨：
#'
#' | 格式 | 形态 | 来源 |
#' | --- | --- | --- |
#' | **宽表** | `gene <TAB> term1 <TAB> term2 ...`（**无表头**） | 我们自己的产物（rice_go.tsv / rice_pathway.tsv）、老自定义文件 |
#' | **长表** | `term <TAB> gene <TAB> name <TAB> category`（**有表头**） | 客户原始导出（水稻/螃蟹的 GO、KEGG.xlsx） |
#'
#' 判据只用**第一行有没有表头词**，不用列数：宽表永远没有表头
#' （第一行就是数据，`LOC_Os01g01010` 这种），而长表一定有。
#' 拿列数判断会在「某基因恰好只有一个 term」的宽表行上翻车。
#'
#' 注意：**不要**用 `term` 这种词做判据 —— 太泛。只用客户导出里稳定出现的
#' 那几个列名。
.LONG_TABLE_HEADER_RE <- paste0(
  "^(GO[_ ]?ID|GO|gene[_ ]?(ID|id)?|Gene[_ ]?(ID|id)?|",
  "Description|description|Category|category|Pathway|pathway)$"
)

#' 读注释文件第一行（表头或首个数据行）
.read_annot_header <- function(path) {
  con <- file(path, open = "r", encoding = "UTF-8")
  on.exit(close(con), add = TRUE)
  first <- tryCatch(readLines(con, n = 1L, warn = FALSE), error = function(e) character(0))
  if (length(first) == 0 || !nzchar(first)) return(character(0))
  trimws(strsplit(first, "\t", fixed = TRUE)[[1]])
}

.looks_like_long_table <- function(path) {
  cells <- .read_annot_header(path)
  if (length(cells) < 2L) return(FALSE)
  any(grepl(.LONG_TABLE_HEADER_RE, cells))
}

#' 从表头判断哪一列是 term、哪一列是 gene（**不能按位置猜**）
#'
#' ★ 这是客户的真实数据教的：两份文件的长表**列序是相反的**
#'
#' | 文件 | 表头 | term 在第几列 | gene 在第几列 |
#' | --- | --- | --- | --- |
#' | 螃蟹 `go_matched_results.txt` | `GO_ID / gene_ID / Description / Category` | **1** | 2 |
#' | 螃蟹 `KEGG.xlsx` | `gene_id / Pathway / Description` | **2** | **1** |
#'
#' 一开始按「第 1 列 term、第 2 列 gene」硬读，KEGG 那份会把**基因当通路、
#' 通路当基因**喂给 enricher —— 不报错，只是富集出一堆叫 `Esine00002` 的「通路」。
#'
#' 所以按表头**认角色**；认不出来才退回「term=1, gene=2」并留一条 warn，
#' 因为那是 GO 长表的常规形态。
.long_table_columns <- function(cells) {
  lower <- tolower(trimws(cells))

  # 两级匹配：先「精确等于常见列名」，再退到「包含关键词」。
  # 只做包含判断会在 `term_name` 这种列上把 term 和 name 都算成同一列；
  # 只做精确判断又认不出 `gene_id (RAP-DB)` 这种带注的列名。
  pick <- function(exact, contains, exclude = integer(0)) {
    idx <- setdiff(which(lower %in% exact), exclude)
    if (length(idx) == 0L) idx <- setdiff(which(grepl(contains, lower)), exclude)
    if (length(idx) == 0L) NA_integer_ else idx[1]
  }

  # 顺序有意义：gene 最具体，先认它，后面几个再把它排除掉
  geneIdx <- pick(
    c("gene", "gene_id", "geneid", "gene_name", "gene_symbol", "geneid_1", "tigr", "locus"),
    "gene"
  )
  termIdx <- pick(
    c("go", "go_id", "goid", "go term", "pathway", "pathway_id", "term", "term_id", "ko", "kegg"),
    "pathway|go[_ ]?id|goid|term|^ko|_ko",
    exclude = geneIdx
  )
  nameIdx <- pick(
    c("description", "desc", "name", "term_name", "anno", "annotation", "annot"),
    "description|^desc|name|anno",
    exclude = c(geneIdx, termIdx)
  )
  catIdx <- pick(
    c("category", "ontology", "class", "ont"),
    "categor|ontology|class",
    exclude = c(geneIdx, termIdx, nameIdx)
  )

  if (!is.na(termIdx) && !is.na(geneIdx) && termIdx != geneIdx) {
    return(list(
      term = termIdx, gene = geneIdx, name = nameIdx, category = catIdx,
      byHeader = TRUE
    ))
  }
  # 一个都对不上：退回 GO 长表的常规形态（term 在第 1 列）
  list(
    term = 1L, gene = 2L,
    name = if (length(cells) >= 3L) 3L else NA_integer_,
    category = if (length(cells) >= 4L) 4L else NA_integer_,
    byHeader = FALSE
  )
}

#' 把注释文件读成 TERM2GENE 两列（外加文件里带的名称）
#'
#' 自动识别宽表 / 长表（见 `.looks_like_long_table`），两种都转成
#' `data.frame(term, gene)`。空单元格、重复 term 都要处理掉，否则 enricher
#' 会因为重复行把同一个基因数两遍，把 Count 算大。
#'
#' ## 为什么不用 for 循环逐行 c() 追加（实测过的性能坑）
#'
#' 第一版写的是 `for (line in lines) { genes <- c(genes, ...); terms <- c(terms, ...) }`。
#' 对客户那份 R498 注释（46061 行 × 平均 5 个 term ≈ 23 万个元素）实测解析耗时
#' **50 秒**，占了整次富集 55 秒里的 90%：`c()` 每次都重新分配并复制整个向量，
#' 是 O(n²)。读文件的 0.3 秒反而无关紧要。
#' 改成先一次 strsplit 全部拆开、再用 rep/unlist 一次性拼平，同样的文件降到 1 秒内。
#' 这类「文件不大但就是慢」的问题，八成都是循环里长向量追加。
#'
#' 长表（客户螃蟹那份 66 MB / 120 万行）走同一条路：`strsplit` 一次 + `[[` 取值。
#' 刻意不用 `vapply(parts, \`[\`, ...)` —— 后者每个元素都要过一次函数调用与长度检查，
#' 百万级行数上差距是秒级。
#'
#' @return `list(t2g = data.frame(term, gene), names = 命名向量 term→名称 或 NULL)`
.read_term2gene <- function(path, prefixFilter = "") {
  headerCells <- .read_annot_header(path)
  longFormat <- length(headerCells) >= 2L && any(grepl(.LONG_TABLE_HEADER_RE, headerCells))

  lines <- readLines(path, warn = FALSE, encoding = "UTF-8")
  lines <- lines[nzchar(lines)]
  if (longFormat && length(lines) > 0) lines <- lines[-1L]   # 去掉表头
  if (length(lines) == 0) {
    deg_stop("E_DATA_EMPTY", paste0("background file is empty: ", basename(path)), status = 13L)
  }

  parts <- strsplit(lines, "\t", fixed = TRUE)
  keep <- lengths(parts) >= 2L
  parts <- parts[keep]
  if (length(parts) == 0) {
    deg_stop("E_DATA_EMPTY",
             paste0("no line has a gene plus at least one term: ", basename(path)),
             status = 13L)
  }

  fileNames <- NULL
  layout <- NULL
  if (longFormat) {
    # 长表：**按表头认列的角色**（term / gene / name）。
    # 客户两份文件的列序是相反的（GO 的 term 在第 1 列，KEGG 的 gene 在第 1 列），
    # 按位置读会把两份之一搞反 —— 详见 .long_table_columns() 的注释。
    layout <- .long_table_columns(headerCells)
    if (!layout$byHeader) {
      emit_log("warn", sprintf(
        "cannot tell term/gene columns from header (%s); assuming term=col1, gene=col2",
        paste(utils::head(headerCells, 4), collapse = " | ")
      ))
    }
    terms <- trimws(unlist(lapply(parts, `[[`, layout$term), use.names = FALSE))
    genes <- trimws(unlist(lapply(parts, `[[`, layout$gene), use.names = FALSE))
    if (!is.na(layout$name)) {
      nameCol <- layout$name
      namePerRow <- trimws(unlist(lapply(parts, function(p) {
        if (length(p) >= nameCol) p[[nameCol]] else ""
      }), use.names = FALSE))
      okName <- nzchar(terms) & nzchar(namePerRow)
      if (any(okName)) {
        # 同一个 term 会重复出现（每个基因一行），取第一个非空名称即可
        firstIdx <- !duplicated(terms[okName])
        fileNames <- stats::setNames(namePerRow[okName][firstIdx], terms[okName][firstIdx])
      }
    }
  } else {
    # 宽表：每行第 1 列是基因，其余是 term；拉平成一一对应的两列
    genePerLine <- trimws(vapply(parts, `[`, character(1), 1L))
    genes <- rep(genePerLine, lengths(parts) - 1L)
    terms <- trimws(unlist(lapply(parts, `[`, -1L), use.names = FALSE))
  }

  ok <- nzchar(genes) & nzchar(terms)
  if (nzchar(prefixFilter)) ok <- ok & startsWith(terms, prefixFilter)
  genes <- genes[ok]
  terms <- terms[ok]

  if (length(genes) == 0) {
    deg_stop("E_DATA_EMPTY",
             paste0("no usable term-gene pairs parsed from ", basename(path),
                    if (nzchar(prefixFilter)) paste0(" (prefix filter: ", prefixFilter, ")") else ""),
             status = 13L)
  }

  fmt <- if (longFormat) {
    sprintf("long table (term=col%d, gene=col%d%s%s)", layout$term, layout$gene,
            if (is.na(layout$name)) "" else sprintf(", name=col%d", layout$name),
            if (is.na(layout$category)) "" else sprintf(", category=col%d", layout$category))
  } else {
    "wide table (gene/term...)"
  }
  emit_log("info", sprintf(
    "background: %s, %d pairs, %d terms, %d genes%s",
    fmt,
    length(genes), length(unique(terms)), length(unique(genes)),
    if (is.null(fileNames)) "" else sprintf(", %d names from file", length(fileNames))
  ))

  list(
    t2g = unique(data.frame(term = terms, gene = genes, stringsAsFactors = FALSE)),
    names = fileNames
  )
}

#' 给 GO 条目补上名称与 ontology
#'
#' 名称有**两个来源，优先级不同**：
#'   1. **注释文件里带的名称**（`fileNames`）—— 最高优先。陌生物种（螃蟹/石磺）
#'      没有 OrgDb 也没有对应的 GO 注释库，`.attach_go_info` 查不到名，
#'      结果表就会显示 `GO:0000001` 而不是 `mitochondrion inheritance`。
#'      客户的长表第 3 列就是 Description，那是唯一能拿到名字的地方。
#'   2. **GO.db 兜底** —— 内置/老格式的自定义文件只有 GO 号（客户那份 R498 就是
#'      `基因<TAB>GO:0016651...`），而 GO.db 是 clusterProfiler 的依赖、本来就装好了，
#'      离线就能把「GO:0006139 → 核碱基/核苷/核苷酸代谢过程」补回来。
#'
#' ontology 一列**只能**从 GO.db 来（文件里的 Category 列是导出那一刻的快照，
#' 已废弃条目会漂移，见 `.go_ontology_of` 的注释）。
#'
#' 不补的后果不是「少一列」：结果表的「条目」列会全是 `GO:0006139` 这种编号，
#' 用户看不出富集到了什么；气泡图的 y 轴也一样，而且因为没有 ontology，
#' BP/MF/CC 分面根本不会触发。
.attach_go_info <- function(df, fileNames = NULL) {
  if (is.null(df) || nrow(df) == 0) return(df)
  ids <- as.character(df$ID)

  # ① 文件里的名称先落一遍（没有 GO.db 的物种就指它了）
  fromFile <- rep(NA_character_, length(ids))
  if (!is.null(fileNames) && length(fileNames) > 0) {
    idx <- match(ids, names(fileNames))
    hit <- !is.na(idx)
    fromFile[hit] <- unname(fileNames[idx[hit]])
  }
  nFromFile <- sum(!is.na(fromFile) & nzchar(fromFile))
  if (nFromFile > 0) df$Description[!is.na(fromFile) & nzchar(fromFile)] <- fromFile[!is.na(fromFile) & nzchar(fromFile)]

  # ② GO.db 只跑 GO 号；非 GO（通路）保持文件里的名称
  if (all(grepl("^GO:", ids))) {
    if (!requireNamespace("GO.db", quietly = TRUE) ||
        !requireNamespace("AnnotationDbi", quietly = TRUE)) {
      emit_log("warn", "GO.db / AnnotationDbi not available: GO terms keep their ids as names")
      if (nFromFile > 0) {
        emit_log("info", sprintf("GO names from annotation file: %d / %d", nFromFile, length(ids)))
      }
      return(df)
    }
    mapped <- tryCatch(
      suppressMessages(AnnotationDbi::select(
        GO.db::GO.db,
        keys = unique(ids),
        columns = c("TERM", "ONTOLOGY"),
        keytype = "GOID"
      )),
      error = function(e) {
        emit_log("warn", paste0("GO term lookup failed: ", conditionMessage(e)))
        NULL
      }
    )
    if (!is.null(mapped) && nrow(mapped) > 0) {
      mapped <- mapped[!duplicated(mapped$GOID), , drop = FALSE]
      idx <- match(ids, mapped$GOID)
      hit <- !is.na(idx)
      term <- mapped$TERM[idx]
      ont <- mapped$ONTOLOGY[idx]
      # ★ **文件里的名称优先**：GO.db 只补文件里没有的那些。
      #   写反了不会报错，只会让陌生物种自己的 Description 被 GO.db 的同名条目顶掉 ——
      #   实测就是这样：客户文件里的 "UDP reductase activity [from file]"
      #   被 GO.db 覆盖成 "UDP reductase activity"，后缀消失。
      missing <- is.na(fromFile)
      named <- hit & !is.na(term) & missing

      df$Description[named] <- term[named]
      # GO.db 里**保留已废弃（obsolete）条目的 GO 号，但 TERM 和 ONTOLOGY 都是 NA**
      # （例如 GO:0008026 "ATP-dependent helicase activity"）。
      # 如果直接 ifelse(hit, term, ...)，这些条目的名称会被清成空白单元格 ——
      # 比留着 GO 号更难懂，而且用户看不出来「这个名字缺失是因为条目废弃了」。
      # 显式标注 (obsolete)，等于提醒他这条通路不该拿来下结论。
      obsolete <- hit & !named & missing
      df$Description[obsolete] <- paste0(ids[obsolete], " (obsolete)")
      df$ONTOLOGY <- ifelse(!is.na(ont), ont, NA_character_)

      emit_log("info", sprintf(
        "GO names resolved: %d / %d (file=%d, GO.db=%d)%s",
        sum(named | (!is.na(fromFile) & nzchar(fromFile))), length(ids),
        nFromFile, sum(named),
        if (any(obsolete)) sprintf(" (%d obsolete)", sum(obsolete)) else ""
      ))
      return(df)
    }
  }

  # ③ 没有 GO.db（或全是非 GO 号）：用文件里的名称收尾
  if (nFromFile > 0) {
    emit_log("info", sprintf("names from annotation file: %d / %d", nFromFile, length(ids)))
  } else if (all(grepl("^GO:", ids))) {
    emit_log("warn", "GO.db unavailable and the annotation file carries no names: term column will show ids")
  }
  df
}

#' 查一批 GO 号各自的 ontology（BP / CC / MF）
#'
#' 返回一个**带名字的**字符向量：名字是 GO 号，值是 "BP"/"CC"/"MF"，
#' 查不到（GO.db 里没有、或已废弃）为 NA。查不到不报错、不丢弃 ——
#' 丢弃与否由调用方决定，这个函数只回答「是什么」。
#'
#' ## 为什么不用注释文件里的 Category 列
#'
#' 客户那份 `rice_go_matched.txt` 是有 Category 列的，看起来可以直接用。
#' 但那是**导出时那一刻的快照**：GO 条目会改归属（merge / obsolete），
#' 而 GO.db 是随包固定版本。两个来源同时存在时，一旦不一致，
#' 「为什么界面上 BP 里出现了这个条目」就没有唯一答案了。
#' 所以宽度表里刻意不存 Category（见 scripts/build-rice-annot.mjs 的注释），
#' 这里现查 GO.db —— 单一事实来源。
.go_ontology_of <- function(terms) {
  terms <- unique(as.character(terms))
  out <- rep(NA_character_, length(terms))
  names(out) <- terms
  if (length(terms) == 0) return(out)
  if (!requireNamespace("GO.db", quietly = TRUE) ||
      !requireNamespace("AnnotationDbi", quietly = TRUE)) {
    emit_log("warn", "GO.db / AnnotationDbi not available: cannot split GO terms by ontology")
    return(out)
  }
  mapped <- tryCatch(
    suppressMessages(AnnotationDbi::select(
      GO.db::GO.db,
      keys = terms,
      columns = "ONTOLOGY",
      keytype = "GOID"
    )),
    error = function(e) {
      emit_log("warn", paste0("GO ontology lookup failed: ", conditionMessage(e)))
      NULL
    }
  )
  if (is.null(mapped) || nrow(mapped) == 0) return(out)
  mapped <- mapped[!duplicated(mapped$GOID), , drop = FALSE]
  hit <- as.character(mapped$GOID) %in% names(out)
  out[as.character(mapped$GOID)[hit]] <- as.character(mapped$ONTOLOGY)[hit]
  out
}

#' 剔掉 GO.db 里查不到归属的 term（基本都是已废弃 / obsolete 条目）
#'
#' ## 为什么 ALL 也要剔
#'
#' 三条理由，按重要性：
#'   1. **obsolete term 没有解释价值**。`GO:0006464 (obsolete)` 富集到又怎样？
#'      它在 GO 里已被废弃，用户拿这一条写不进文章，只会来问「这是什么」。
#'   2. **一致性**：`ontology = "BP"` 时本来就会丢掉 unknown（见
#'      `.filter_term2gene_by_ontology`），只有 `ALL` 保留 —— 同一批 term 在两种
#'      模式下**一个丢一个不丢**，本身就是不一致。
#'   3. **不让界面说谎**：`EnrichService.toSource()` 在 ontology 为空时兜底成
#'      `'GO:BP'`，于是这条废弃条目会被算进 GO·BP（实测界面 BP=16 / CSV=15）。
#'      在 R 侧丢掉，界面就永远看不到这种「归属不明」的行，也不需要在 TS 侧
#'      扩 `EnrichSource` 联合类型（那会波及 SOURCE_LABEL / 表格过滤 / 分面）。
#'
#' ## ★ 语义边界：`ontology = "ALL"` 仍然是「所有有效分类」
#'
#' 只是不再包含**已废弃**项。「ALL」从来不是「连废弃的也算」的意思，
#' 别把这条理解成「ALL 被改窄了」。写在这里是为了防止以后有人把
#' .filter... 里的 unknown 分支也一起删掉，或者反过来把这里改回去。
#'
#' @return 过滤后的 data.frame；若一个 term 都不剩则返回 NULL（调用方负责跳过）
.drop_obsolete_go_terms <- function(t2g) {
  terms <- unique(as.character(t2g$term))
  if (length(terms) == 0) return(t2g)
  ont <- .go_ontology_of(terms)
  unknown <- names(ont)[is.na(ont)]
  if (length(unknown) == 0) return(t2g)

  keep <- terms[!is.na(ont)]
  emit_log("warn", sprintf(
    "%d of %d GO term(s) skipped: obsolete or unknown to GO.db, no ontology to report (e.g. %s)%s",
    length(unknown), length(terms),
    paste(utils::head(unknown, 3), collapse = ", "),
    if (length(keep) == 0) "; no term left to enrich" else ""
  ))
  if (length(keep) == 0) return(NULL)
  t2g[as.character(t2g$term) %in% keep, , drop = FALSE]
}

#' 按 ontology 把 TERM2GENE 收窄到 BP / CC / MF 之一
#'
#' ★ 与客户脚本 `docs/reference/rice-enrich-method.R` 的口径对齐：
#'   它是对 `c("CC","MF","BP")` 各跑一次 `enricher()`，**每类内部各自 BH 校正**。
#'   一次拿全部 term 跑再按 ontology 拆开看，p.adjust 的分母是全表 97 个 term，
#'   和「只在 BP 的 30 个 term 里校正」得到的 adj.P.Val 完全不同 ——
#'   用户拿去和客户给的旧结果对照就会发现对不上。
#'
#' 查不到 ontology 的 term **丢弃**（它们无法证明属于被请求的那一类），
#' 但必须 warn 出来：否则用户会以为「BP 只有这么几个 term」，
#' 而真相是有一批 term 的 GO.db 映射缺失。
#'
#' @return 收窄后的 data.frame；若一个 term 都不剩则返回 NULL
.filter_term2gene_by_ontology <- function(t2g, ontology) {
  terms <- unique(as.character(t2g$term))
  ont <- .go_ontology_of(terms)
  unknown <- names(ont)[is.na(ont)]
  keep <- names(ont)[!is.na(ont) & ont == ontology]
  other <- setdiff(terms, c(keep, unknown))

  if (length(unknown) > 0) {
    emit_log("warn", sprintf(
      "%d of %d GO term(s) dropped: ontology unknown in GO.db (e.g. %s)",
      length(unknown), length(terms),
      paste(utils::head(unknown, 3), collapse = ", ")
    ))
  }
  emit_log("info", sprintf("GO ontology split: requested %s, kept %d term(s), excluded %d term(s) of other ontologies, %d unknown",
                           ontology, length(keep), length(other), length(unknown)))
  if (length(keep) == 0) {
    emit_log("warn", sprintf(
      "no GO term in the background belongs to %s; nothing to enrich. Set ontology to ALL to use every term",
      ontology
    ))
    return(NULL)
  }
  t2g[as.character(t2g$term) %in% keep, , drop = FALSE]
}

#' 把 "KEGG: 00970+6.1.1.7" 拆成 category=KEGG + ID=00970+6.1.1.7
#'
#' 客户给的 pathway 文件里 term 带库名前缀，直接当 ID 会让「条目」列显示成
#' `KEGG: 00970+6.1.1.7`，而「类别」列又空着 —— 库名信息放错了地方。
#' 拆开后类别列有值，条目列也短了一半。没有前缀的（如 MetaCyc 的 PWY-5532）原样保留。
.split_term_prefix <- function(df) {
  if (is.null(df) || nrow(df) == 0) return(df)
  ids <- as.character(df$ID)
  m <- regmatches(ids, regexec("^([A-Za-z][A-Za-z0-9_.-]*):\\s*(.+)$", ids))
  prefix <- vapply(m, function(x) if (length(x) == 3) x[2] else NA_character_, character(1))
  bare <- vapply(m, function(x) if (length(x) == 3) x[3] else NA_character_, character(1))
  hit <- !is.na(prefix)
  if (!any(hit)) return(df)
  df$ID[hit] <- bare[hit]
  df$Description[hit] <- bare[hit]
  df$category <- prefix
  df
}

#' 用旁挂的名字表覆盖通路条目的 Description
#'
#' `.split_term_prefix()` 只能把 `KEGG: dosa01100` 拆成 ID，**没有任何名称来源** ——
#' 结果表「条目」列会显示 `dosa01100` 这种编号。GO 有 GO.db 可以离线补名
#' （`.attach_go_info()`），通路没有对应的离线库（KEGG 名称联网才能取，
#' 而本产品定位是离线），所以名称随注释表一起发布：
#'
#'     rice_pathway.tsv        gene      → dosaXXXXX
#'     rice_pathway_names.tsv  dosaXXXXX → Metabolic pathways
#'
#' ★ **必须在 `.split_term_prefix()` 之后调用**：名字表的键是不带前缀的
#'   （`dosa01100`），而 enricher 返回的 ID 可能是 `KEGG: dosa01100`。
#'   顺序反了就一条都查不到 —— 而且**不会报错**，只是名字没被替换，
#'   界面上继续显示 ID。这类静默失败最难发现。
#'
#' 名字表不存在时不报错（warn 一句，回退到显示 ID）：自定义通路文件不一定带
#' 名字表，那不是错误，只是体验差一点。内置 rice 一定有（见
#' scripts/build-rice-pathway.mjs）。
.attach_pathway_names <- function(df, namesPath, fileNames = NULL) {
  if (is.null(df) || nrow(df) == 0) return(df)

  # ① 注释文件自带的名称（长表第 3 列）先落一遍 —— 陌生物种只有这个来源
  ids <- as.character(df$ID)
  fromFile <- rep(NA_character_, length(ids))
  if (!is.null(fileNames) && length(fileNames) > 0) {
    idx <- match(ids, names(fileNames))
    hit <- !is.na(idx)
    fromFile[hit] <- unname(fileNames[idx[hit]])
    if (any(!is.na(fromFile))) df$Description[!is.na(fromFile)] <- fromFile[!is.na(fromFile)]
  }

  if (is.null(namesPath) || !nzchar(namesPath) || !file.exists(namesPath)) {
    # 有文件自带的名称就不必报警了（这不是缺失，是已经拿到了）
    if (all(is.na(fromFile))) {
      emit_log("warn", sprintf(
        "pathway name table not found (%s) and the annotation file carries no names: the term column will show ids",
        if (is.null(namesPath) || !nzchar(namesPath)) "(none)" else basename(namesPath)
      ))
    }
    return(df)
  }
  tbl <- tryCatch(
    utils::read.delim(namesPath, header = FALSE, sep = "\t", quote = "",
                      col.names = c("term", "name"), stringsAsFactors = FALSE),
    error = function(e) {
      emit_log("warn", paste0("pathway name table unreadable: ", conditionMessage(e)))
      NULL
    }
  )
  if (is.null(tbl) || nrow(tbl) == 0) return(df)

  idx <- match(as.character(df$ID), as.character(tbl$term))
  hit <- !is.na(idx)
  if (any(hit)) df$Description[hit] <- as.character(tbl$name)[idx[hit]]
  emit_log("info", sprintf("pathway names resolved: %d / %d", sum(hit), nrow(df)))
  df
}

#' 统一整理成 11 列
.normalize_result <- function(df, database, ontology = NA_character_) {
  if (is.null(df) || nrow(df) == 0) return(NULL)
  need <- c("ID", "Description", "GeneRatio", "BgRatio", "pvalue", "p.adjust", "qvalue", "geneID", "Count")
  if (!all(need %in% names(df))) {
    deg_stop("E_RESULT_INVALID",
             paste0("unexpected enrichment columns: ", paste(names(df), collapse = ", ")),
             status = 10L)
  }
  # GeneRatio "12/345" → 小数；BgRatio 取分母
  ratio_num <- suppressWarnings(as.numeric(sub("/.*$", "", df$GeneRatio)))
  ratio_den <- suppressWarnings(as.numeric(sub("^.*/", "", df$GeneRatio)))
  out <- data.frame(
    database = database,
    ontology = if ("ONTOLOGY" %in% names(df)) df$ONTOLOGY else ontology,
    term_id = as.character(df$ID),
    description = as.character(df$Description),
    gene_ratio = ratio_num / ratio_den,
    gene_ratio_text = as.character(df$GeneRatio),
    bg_ratio = as.character(df$BgRatio),
    pvalue = as.numeric(df$pvalue),
    p_adjust = as.numeric(df$p.adjust),
    qvalue = as.numeric(df$qvalue),
    count = as.integer(df$Count),
    gene_ids = as.character(df$geneID),
    category = if ("category" %in% names(df)) as.character(df$category) else NA_character_,
    stringsAsFactors = FALSE
  )
  out[order(out$p_adjust), , drop = FALSE]
}

deg_main("enrich/run_ora.R", function(ctx) {
  # 富集额外支持 rice：它不需要 OrgDb（走注释表），所以不能沿用通用白名单
  deg_validate_common(ctx, speciesAllowed = c("human", "mouse", "rice", "other"))
  startedAt <- Sys.time()

  genes <- as.character(.plot_param(ctx, "geneList", character(0)))
  genes <- genes[nzchar(genes)]
  if (length(genes) < 3) {
    deg_stop("E_DATA_EMPTY",
             sprintf("need at least 3 genes for enrichment, got %d", length(genes)),
             status = 13L)
  }

  species <- as.character(.plot_param(ctx, "species", "human"))
  geneIdType <- as.character(.plot_param(ctx, "geneIdType", "SYMBOL"))
  databases <- as.character(.plot_param(ctx, "databases", c("GO", "KEGG")))
  ontology <- as.character(.plot_param(ctx, "ontology", "ALL"))
  pCut <- as.numeric(.plot_param(ctx, "pvalueCutoff", 0.05))
  qCut <- as.numeric(.plot_param(ctx, "qvalueCutoff", 0.05))

  customGo <- as.character(.plot_param(ctx, "customGoPath", ""))
  customPathway <- as.character(.plot_param(ctx, "customPathwayPath", ""))
  customPrefix <- as.character(.plot_param(ctx, "customTermPrefix", ""))

  # ---- 水稻：把「内置背景」解析成随包注释表 -----------------------------
  #
  # 用户选「水稻 + 内置背景」时并没有传文件，这里替他把 resources/annot/rice_*.tsv
  # 找出来当成自定义背景用。找不到就明确告诉他两条出路，而不是抛一个装不上的包名。
  riceNote <- ""
  if (identical(species, "rice") && !nzchar(customGo) && !nzchar(customPathway)) {
    builtinGo <- builtin_annot_path("rice", "go")
    builtinPathway <- builtin_annot_path("rice", "pathway")
    if (!nzchar(builtinGo) && !nzchar(builtinPathway)) {
      deg_stop("E_RT_ANNOTATION_MISSING",
               paste0(
                 "水稻没有可用的内置注释：Bioconductor 未提供 org.Os.eg.db，",
                 "内置背景依赖随包注释表 resources/annot/rice_go.tsv / rice_pathway.tsv，",
                 "当前安装包里没有这两个文件。请在「背景来源」里选择「自定义文件」并",
                 "指定水稻注释（每行：基因ID<TAB>term<TAB>term...），或改用人类/小鼠。"
               ),
               status = 12L)
    }
    customGo <- builtinGo
    customPathway <- builtinPathway
    riceNote <- sprintf("rice builtin annotation (go=%s, pathway=%s)",
                        if (nzchar(builtinGo)) basename(builtinGo) else "none",
                        if (nzchar(builtinPathway)) basename(builtinPathway) else "none")
  }

  useCustom <- nzchar(customGo) || nzchar(customPathway)
  emit_log("info", sprintf("input genes: %d  species=%s  idType=%s  db=%s  custom=%s",
                           length(genes), species, geneIdType,
                           paste(databases, collapse = "+"),
                           if (useCustom) "yes" else "no"))
  if (nzchar(riceNote)) emit_log("info", riceNote)

  # ---- 环境检查 ---------------------------------------------------------
  deg_ensure_pkgs(c("clusterProfiler", "data.table"))
  if (!useCustom) {
    orgPkg <- .org_db_of(species)
    if (is.null(orgPkg)) {
      deg_stop("E_VALIDATION", paste0("unsupported species: ", species), status = 11L)
    }
    if (!requireNamespace(orgPkg, quietly = TRUE)) {
      deg_stop("E_RT_PKG_MISSING",
               paste0("missing annotation package: ", orgPkg,
                      " (install it or use a custom background file)"),
               status = 12L)
    }
  }

  work <- list()   # 每块结果：list(name, df)
  # 背景匹配率过低时记一句人话，用来说明「为什么没结果」。
  # 0/300 的情况下如果只报「放宽 p/q 阈值」，用户会去调阈值 —— 而真正的原因是
  # 基因 ID 体系不一致（背景用 Esine04101，输入用 LOC_Os01g01010）。
  lowMatchNotes <- character(0)
  noteLowMatch <- function(matched, total, bgLabel) {
    if (total <= 0) return(invisible(NULL))
    ratio <- matched / total
    if (ratio >= 0.1) return(invisible(NULL))
    lowMatchNotes <<- c(lowMatchNotes, sprintf(
      "only %d of %d input genes were found in the %s background (%.1f%%)",
      matched, total, bgLabel, 100 * ratio))
    invisible(NULL)
  }
  emit_progress("read", 15, "preparing gene list")

  # =====================================================================
  # A. 自定义背景
  # =====================================================================
  if (useCustom) {
    emit_progress("enrich", 30, "custom background: parsing annotation")

    # 自定义背景（含水稻内置注释）只读用户/随包给的注释表，`databases` 在老代码里
    # 不起作用 —— 文件里有什么就富集什么。
    #
    # ★ 但**水稻内置背景**不一样：它是「内置注释库」，界面上 GO / KEGG 两个开关是
    #   亮着的、用户会以为能选。不给它看 databases 的话，用户取消勾选 KEGG 仍然会
    #   拿到通路结果（实测：只勾 GO 也返回 GO=27 + Pathway=14），开关就是假的。
    #   所以内置背景按 databases 走；用户自己给的注释文件保持「文件说了算」的旧语义
    #   （界面那边第二个开关会显示成「通路」，不叫 KEGG，语义本来就不同）。
    usesBuiltinAnnot <- nzchar(riceNote)
    wantGo <- !usesBuiltinAnnot || ("GO" %in% databases)
    wantPathway <- !usesBuiltinAnnot || ("KEGG" %in% databases)

    if ("KEGG" %in% databases && !nzchar(customPathway)) {
      emit_log("warn", "KEGG requested but no pathway annotation is available for this background; only GO will be enriched")
    }
    if (usesBuiltinAnnot) {
      emit_log("info", sprintf("builtin background obeys the database switches: GO=%s, pathway=%s",
                               if (wantGo) "on" else "off", if (wantPathway) "on" else "off"))
    }

    if (wantGo && nzchar(customGo) && file.exists(customGo)) {
      parsed <- .read_term2gene(customGo, "")
      t2g <- parsed$t2g
      goFileNames <- parsed$names
      emit_log("info", sprintf("custom GO: %d terms, %d genes", length(unique(t2g$term)), length(unique(t2g$gene))))
      # ★ 先剔掉 GO.db 里查不到归属的 term（已废弃条目）——**不论 ontology 是不是 ALL**。
      #   理由见 .drop_obsolete_go_terms() 的注释，最关键的一条：
      #   ontology 为空的行会被 EnrichService.toSource() 兜底标成 GO·BP，
      #   界面上就变成「BP 比 CSV 多一条」。在 R 侧丢掉，界面永远看不到这种行。
      #   语义边界：ALL 仍是「所有有效分类」，只是不再包含废弃项。
      t2g <- .drop_obsolete_go_terms(t2g)
      # 再按 ontology 分类富集（对齐客户脚本口径：BP/CC/MF 各自 enricher、各自 BH）。
      # 此时 unknown 已经在上面被剔掉了，收窄只需要处理「不属于本类」的。
      if (!is.null(t2g) && !identical(ontology, "ALL")) {
        t2g <- .filter_term2gene_by_ontology(t2g, ontology)
      }
      if (is.null(t2g)) {
        # 一个 term 都没剩下：不再往下算，让最后的「没有富集到任何条目」统一报错，
        # 但上面已经 warn 过原因（废弃条目全被剔掉 / 本类一个都没有）
        emit_log("warn", sprintf("skipped GO enrichment: no usable GO term left for ontology %s", ontology))
      } else {
        hit <- intersect(genes, unique(t2g$gene))
        emit_log("info", sprintf("genes matched in custom GO background: %d / %d", length(hit), length(genes)))
        noteLowMatch(length(hit), length(genes), "GO")
        if (length(hit) >= 3) {
          res <- suppressWarnings(clusterProfiler::enricher(
            hit, TERM2GENE = t2g, pvalueCutoff = pCut, qvalueCutoff = qCut,
            minGSSize = CUSTOM_MIN_GSSIZE, maxGSSize = CUSTOM_MAX_GSSIZE
          ))
          if (!is.null(res) && nrow(as.data.frame(res)) > 0) {
            # ★ 名称优先用**注释文件里带的**（陌生物种没有 GO.db，只能靠它），
            #   GO.db 只做兜底；两者都没有时才显示 GO 号。
            goDf <- .attach_go_info(as.data.frame(res), goFileNames)
            work[[length(work) + 1]] <- list(name = "GO-custom",
                                             df = .normalize_result(goDf, "GO", NA_character_))
          }
        } else {
          emit_log("warn", "too few input genes found in the custom GO background; skipped")
        }
      }
    }

    if (wantPathway && nzchar(customPathway) && file.exists(customPathway)) {
      parsedPw <- .read_term2gene(customPathway, customPrefix)
      t2g <- parsedPw$t2g
      pathFileNames <- parsedPw$names
      emit_log("info", sprintf("custom pathway: %d terms, %d genes (prefix '%s')",
                               length(unique(t2g$term)), length(unique(t2g$gene)), customPrefix))
      hit <- intersect(genes, unique(t2g$gene))
      emit_log("info", sprintf("genes matched in custom pathway background: %d / %d", length(hit), length(genes)))
      noteLowMatch(length(hit), length(genes), "pathway")
      if (length(hit) >= 3) {
        res <- suppressWarnings(clusterProfiler::enricher(
          hit, TERM2GENE = t2g, pvalueCutoff = pCut, qvalueCutoff = qCut,
          minGSSize = CUSTOM_MIN_GSSIZE, maxGSSize = CUSTOM_MAX_GSSIZE
        ))
        if (!is.null(res) && nrow(as.data.frame(res)) > 0) {
          pathDf <- .split_term_prefix(as.data.frame(res))
          # ★ 名字表按「同名旁挂」约定找：x.tsv → x_names.tsv。
          #   内置 rice 是 rice_pathway.tsv → rice_pathway_names.tsv；
          #   用户自带的通路文件若也带一份 xxx_names.tsv，同样自动生效。
          #   非 .tsv 结尾的文件不猜（拼出来会指向注释表本身，读进去就是垃圾）。
          namesPath <- if (grepl("\\.tsv$", customPathway)) {
            sub("\\.tsv$", "_names.tsv", customPathway)
          } else {
            ""
          }
          pathDf <- .attach_pathway_names(pathDf, namesPath, pathFileNames)
          # ★ database 列决定界面「类型」列的标签：
          #   内置 rice 的 dosa 通路**就是 KEGG 数据**，标成 "KEGG" →
          #   界面显示「KEGG」，与用户勾选的那个开关一致；
          #   只有「用户自己给的 pathway 文件」才标 "Pathway" → 界面显示「通路」。
          #   曾经一律写 "Pathway"，结果用户选的是内置背景、类型列却写着「自定义」。
          dbLabel <- if (usesBuiltinAnnot) "KEGG" else "Pathway"
          work[[length(work) + 1]] <- list(name = paste0("Pathway-", dbLabel),
                                           df = .normalize_result(pathDf, dbLabel, NA_character_))
        }
      } else {
        emit_log("warn", "too few input genes found in the custom pathway background; skipped")
      }
    }
  } else {
    # =====================================================================
    # B. 内置物种：OrgDb + clusterProfiler
    # =====================================================================
    orgPkg <- .org_db_of(species)
    # OrgDb 的数据库对象名与包名相同（如 org.Hs.eg.db），必须先 attach 才能 get 到
    suppressPackageStartupMessages(
      library(orgPkg, character.only = TRUE, quietly = TRUE, warn.conflicts = FALSE)
    )
    orgDb <- get(orgPkg)
    keggCode <- .kegg_code_of(species)

    # 转 ENTREZ（KEGG 必须要；GO 可以直接用原 keytype，但统一转一次更省事）
    emit_progress("read", 25, "mapping gene ids")
    entrez <- tryCatch({
      mapped <- suppressMessages(AnnotationDbi::select(
        orgDb, keys = genes, columns = "ENTREZID", keytype = geneIdType
      ))
      unique(stats::na.omit(as.character(mapped$ENTREZID)))
    }, error = function(e) {
      deg_stop("E_R_GENEID_MAP",
               paste0("gene id mapping failed (keytype=", geneIdType, "): ", conditionMessage(e)),
               status = 13L)
    })
    emit_log("info", sprintf("mapped to ENTREZ: %d / %d", length(entrez), length(genes)))
    if (length(entrez) < 3) {
      deg_stop("E_R_GENEID_MAP",
               sprintf("only %d of %d genes could be mapped to ENTREZ id; check geneIdType",
                       length(entrez), length(genes)),
               status = 13L)
    }

    if ("GO" %in% databases) {
      emit_progress("enrich", 40, paste0("GO enrichment (", ontology, ")"))
      go <- tryCatch(
        suppressWarnings(clusterProfiler::enrichGO(
          gene = entrez, OrgDb = orgDb, keyType = "ENTREZID",
          ont = ontology, pvalueCutoff = pCut, qvalueCutoff = qCut, readable = FALSE
        )),
        error = function(e) {
          emit_log("warn", paste0("GO enrichment failed: ", conditionMessage(e)))
          NULL
        }
      )
      if (!is.null(go) && nrow(as.data.frame(go)) > 0) {
        work[[length(work) + 1]] <- list(name = paste0("GO-", ontology),
                                         df = .normalize_result(as.data.frame(go), "GO", ontology))
      } else {
        emit_log("warn", "GO enrichment returned no significant term")
      }
    }

    if ("KEGG" %in% databases) {
      emit_progress("enrich", 60, "KEGG enrichment")
      kk <- tryCatch(
        suppressWarnings(clusterProfiler::enrichKEGG(
          gene = entrez, organism = keggCode,
          pvalueCutoff = pCut, qvalueCutoff = qCut
        )),
        error = function(e) {
          deg_stop("E_KEGG_NETWORK",
                   paste0("KEGG enrichment failed (needs network to fetch KEGG data): ",
                          conditionMessage(e)),
                   status = 10L)
        }
      )
      if (!is.null(kk) && nrow(as.data.frame(kk)) > 0) {
        kkDf <- as.data.frame(kk)
        # 去掉 Human Diseases 分类：和本实验的生物学问题无关，混在气泡图里只会干扰
        if ("category" %in% names(kkDf)) {
          kkDf <- kkDf[is.na(kkDf$category) | kkDf$category != "Human Diseases", , drop = FALSE]
        }
        # 描述里带的物种后缀（" - Mus musculus (house mouse)"）统一去掉
        kkDf$Description <- sub(" - [A-Za-z ]+\\(.*\\)$", "", kkDf$Description)
        if (nrow(kkDf) > 0) {
          work[[length(work) + 1]] <- list(name = "KEGG",
                                           df = .normalize_result(kkDf, "KEGG", NA_character_))
        }
      } else {
        emit_log("warn", "KEGG enrichment returned no significant term")
      }
    }
  }

  if (length(work) == 0) {
    # ★ 两种「没结果」要分开说，否则用户会对着一个无关的动作使劲：
    #   - 基因根本没对上背景 → 检查 ID 体系 / 物种，调阈值没用
    #   - 对上了但没有显著 term → 才是「放宽 p/q」
    if (length(lowMatchNotes) > 0) {
      deg_stop("E_DATA_EMPTY",
               paste0(
                 "no enrichment result: ", paste(lowMatchNotes, collapse = "; "),
                 ". The gene ids in your list and in the background file look like ",
                 "different id systems (e.g. background uses Esine04101 while the input ",
                 "uses LOC_Os01g01010). Check the background file and the species setting ",
                 "before relaxing any cutoff — a lower p/q threshold cannot fix an id mismatch."
               ),
               status = 13L)
    }
    deg_stop("E_DATA_EMPTY",
             sprintf("no significant term at p<%.3g / q<%.3g; relax the cutoff or check the background",
                     pCut, qCut),
             status = 13L)
  }

  # ---- 合并写出 --------------------------------------------------------
  emit_progress("write", 85, "writing result table")
  allDf <- do.call(rbind, lapply(work, function(w) w$df))
  rownames(allDf) <- NULL

  csvPath <- file.path(ctx$runDir, "enrich_result.csv")
  jsonPath <- file.path(ctx$runDir, "enrich_result.json")
  data.table::fwrite(allDf, csvPath)
  deg_write_json(allDf, jsonPath)

  emit_artifact("enrich_table", "enrich_result.csv", rows = nrow(allDf), schema = "EnrichResultRow[]")
  emit_artifact("enrich_table", "enrich_result.json", rows = nrow(allDf), schema = "EnrichResultRow[]")

  durationMs <- as.numeric(difftime(Sys.time(), startedAt, units = "secs")) * 1000
  emit_progress("write", 100, "done")

  perDb <- table(allDf$database)
  emit_log("info", paste0("enriched terms: ",
                          paste(sprintf("%s=%d", names(perDb), as.integer(perDb)), collapse = ", ")))
  emit_result(list(
    totalTerms = nrow(allDf),
    inputGenes = length(genes),
    byDatabase = as.list(as.integer(perDb)) |> stats::setNames(names(perDb)),
    durationMs = as.integer(durationMs)
  ))
})
