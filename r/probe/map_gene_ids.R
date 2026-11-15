# =============================================================================
# r/probe/map_gene_ids.R —— 基因 ID 识别与互转（ARCHITECTURE §8 第 2 行 / T08）
#
# 入参（run_config.json 的 params）：
#   species : "human" | "mouse"
#   ids     : character()  待转换的 ID
#   from    : "AUTO" | "SYMBOL" | "ENSEMBL" | "ENTREZ"
#   to      : "SYMBOL" | "ENSEMBL" | "ENTREZ"
#
# 出参：
#   gene_id_map.json = { mapping: { id: {symbol, ensembl, entrez} }, unmapped: [id...] }
#   result.summary   = { total, mapped, unmapped, from, to }
#
# 重要：**完全离线**。org.Hs.eg.db / org.Mm.eg.db 是随包分发的本地注释库，
#       AnnotationDbi::select 不联网，因此断网环境可用（PRD R-14 / §9 离线能力）。
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

deg_main("probe/map_gene_ids.R", function(ctx) {
  # ---- 1. 参数 ---------------------------------------------------------------
  species <- as.character(deg_param(ctx, "species", "human"))
  deg_validate_species(species)

  ids <- as.character(deg_param(ctx, "ids", character(0)))
  ids <- unique(trimws(ids))
  ids <- ids[nzchar(ids)]
  if (length(ids) == 0) {
    deg_stop("E_DATA_EMPTY", "no gene ids provided", status = 13L)
  }

  from <- toupper(as.character(deg_param(ctx, "from", "AUTO")))
  to <- toupper(as.character(deg_param(ctx, "to", "SYMBOL")))

  # 界面用 ENTREZ，AnnotationDbi 的 keytype 叫 ENTREZID —— 在边界处统一
  toKeytype <- function(x) if (x == "ENTREZ") "ENTREZID" else x
  fromKeytype <- toKeytype(from)
  targetKeytype <- toKeytype(to)

  emit_progress("read", 8, sprintf("preparing %d gene ids", length(ids)))

  # ---- 2. 依赖 ---------------------------------------------------------------
  orgPkg <- if (species == "mouse") "org.Mm.eg.db" else "org.Hs.eg.db"
  deg_ensure_pkgs(c("AnnotationDbi", orgPkg))
  suppressPackageStartupMessages(
    library(orgPkg, character.only = TRUE, quietly = TRUE, warn.conflicts = FALSE)
  )
  db <- get(orgPkg)

  emit_progress("test", 25, paste0("annotation package: ", orgPkg))

  # ---- 3. from = AUTO 时自动判定 keytype -------------------------------------
  # 判定方式：对每个候选 keytype 抽 200 个 ID 去 keys(db) 里命中，命中率最高者胜。
  # 注意不要用正则硬判：用户数据里混着 "---"、旧符号、带版本号的 ENSEMBL 都是常态。
  detectKeytype <- function(x) {
    candidates <- c("SYMBOL", "ENSEMBL", "ENTREZID")
    sampleIds <- utils::head(x, 200)
    allKeys <- AnnotationDbi::keys(db, keytype = "ENTREZID")  # 触发 db 加载
    best <- list(type = "SYMBOL", hits = -1L)
    for (kt in candidates) {
      k <- tryCatch(AnnotationDbi::keys(db, keytype = kt), error = function(e) character(0))
      if (length(k) == 0) next
      hits <- sum(sampleIds %in% k)
      if (hits > best$hits) best <- list(type = kt, hits = hits)
    }
    if (best$hits <= 0) {
      deg_stop(
        "E_R_GENEID_MAP",
        "none of the provided ids match any keytype of the annotation package",
        detail = paste0("first ids: ", paste(utils::head(x, 5), collapse = ", ")),
        status = 13L
      )
    }
    best$type
  }

  keytype <- if (from == "AUTO") detectKeytype(ids) else fromKeytype
  emit_log("info", paste0("resolved keytype = ", keytype, " (requested: ", from, ")"))

  # ---- 4. 转换 ---------------------------------------------------------------
  cols <- c("SYMBOL", "ENSEMBL", "ENTREZID")
  cols <- unique(c(keytype, cols))

  sel <- tryCatch(
    suppressMessages(AnnotationDbi::select(db, keys = ids, columns = cols, keytype = keytype)),
    error = function(e) {
      deg_stop(
        "E_R_GENEID_MAP",
        paste0("AnnotationDbi::select failed: ", conditionMessage(e)),
        status = 13L
      )
    }
  )

  emit_progress("test", 65, sprintf("mapped %d rows", nrow(sel)))

  # ---- 5. 组装 mapping -------------------------------------------------------
  # 一个 key 可能对应多行（多转录本/多映射），每个字段取第一个非 NA 值。
  pick <- function(values) {
    values <- values[!is.na(values) & nzchar(as.character(values))]
    if (length(values) == 0) return(NA_character_)
    as.character(values[1])
  }

  mapping <- list()
  for (i in seq_len(nrow(sel))) {
    key <- as.character(sel[[keytype]][i])
    if (is.na(key) || !nzchar(key)) next
    entry <- mapping[[key]]
    if (is.null(entry)) entry <- list(symbol = NA_character_, ensembl = NA_character_,
                                     entrez = NA_character_)
    if (is.na(entry$symbol)) {
      v <- pick(sel$SYMBOL[i])
      if (!is.na(v)) entry$symbol <- v
    }
    if (is.na(entry$ensembl)) {
      v <- pick(sel$ENSEMBL[i])
      if (!is.na(v)) entry$ensembl <- v
    }
    if (is.na(entry$entrez)) {
      v <- pick(sel$ENTREZID[i])
      if (!is.na(v)) entry$entrez <- v
    }
    mapping[[key]] <- entry
  }

  # 目标字段为空也算「未映射」：下游（GO 富集）要的是目标类型的 ID
  targetField <- switch(targetKeytype,
    SYMBOL = "symbol",
    ENSEMBL = "ensembl",
    ENTREZID = "entrez",
    "symbol"
  )
  hasTarget <- vapply(mapping, function(e) !is.na(e[[targetField]]), logical(1))
  unmapped <- names(mapping)[!hasTarget]
  # 完全没出现在 select 结果里的 ID 也是未映射
  unmapped <- unique(c(unmapped, setdiff(ids, names(mapping))))

  emit_progress("write", 88, "writing gene_id_map.json")

  deg_write_json(
    list(mapping = mapping, unmapped = as.list(unmapped)),
    file.path(ctx$runDir, "gene_id_map.json")
  )

  emit_artifact("gene_id_map", "gene_id_map.json",
                rows = length(mapping), schema = "GeneIdMap")
  emit_progress("write", 97, "done")

  emit_result(list(
    total = length(ids),
    mapped = length(mapping) - length(unmapped),
    unmapped = length(unmapped),
    keytype = keytype,
    from = from,
    to = to,
    species = species
  ))
})
