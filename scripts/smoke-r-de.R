#!/usr/bin/env Rscript
# =============================================================================
# scripts/smoke-r-de.R —— R 侧差异分析的**独立**冒烟验证（不依赖 Electron）
#
# 为什么需要它：
#   到目前为止 `r/de/` 下的四个脚本（run_limma_voom.R / run_limma_norm.R /
#   run_deseq2.R / run_edger.R）只被「假 R」桩验证过
#   （integration.dataAnalysis.test.ts 用桩回放协议），**真实 R 执行从未跑过**。
#   这个脚本让任何人（QA / 客户 / 我）在没有 Electron 的机器上就能回答一个问题：
#   「R 这一侧算得对不对？」
#
# 覆盖 5 个 case：limma-voom / deseq2 / edger / limma-lm（counts→limma-trend）/
#   limma-lm-log2（已 log2 直接拟合）。后两个是同一个脚本的两条分支。
#
# 入参方式刻意与主进程**完全一致**（同一份 run_config.json 结构 + 同样的
# `--config` 参数 + 同样的 DEG_R_ROOT 环境变量），否则验的就不是同一条路。
#
# 断言（每条都会写进 docs/SMOKE-R-DE.md）：
#   ① de.csv 数据行数 == summary.genesAfterFilter，且满足守恒律
#      「de.csv 行数 + summary.filteredOut == 输入矩阵基因数」
#      （只比前两个是自证——它们同源于 nrow(out)；守恒律才抓得住「悄悄丢行」）
#   ② 表头严格等于 gene_id,gene_name,logFC,aveExpr,t,pValue,adjPValue,b,regulation
#   ③ 植入的差异基因中，**通过低表达过滤**的那些要有 ≥85% 显著
#      （|logFC|>=1 且 FDR<0.05），且通过过滤的植入基因不少于 60%
#      —— 分母为什么不是 200：相当一部分植入基因本身低表达，会被 filterByExpr
#      正常过滤掉，它们没有检验机会；但也要防止过滤把信号整体吃掉。
#      ★ log2 分支（limma-lm-log2）的降级过滤在本 demo 上不生效，分母会额外
#        收窄到 counts 分支保留的基因集，理由见 ③ 处的注释。
#   ④ de.json 与 de.csv 逐行一致（gene_id 相同、logFC 差 < 1e-9）
#   ⑤ 进度消息覆盖该方法约定的全部阶段，且 pct 单调不减
#   ⑥ 进程退出码为 0，事件流里有 result、没有 error
#   ⑦ 上下调方向正确（植入的上调基因 logFC>0、下调基因 logFC<0）
#      —— 这是 design 写成 ~group 而不是 ~0+group 时唯一能发现方向反了的断言，
#         前 6 条数值断言全都发现不了。
#   ⑧ de.csv 的 regulation 列与界面同一阈值下的三分类严格相等
#      —— 锁「用户在 Excel 里数出来的行数 == 界面统计卡」。历史 bug：R 写 118/98、
#         界面算 75/48，不报错但结论不一致。
#   ⑨ 两个 limma-lm 分支在共同基因集上结论一致（Jaccard ≥0.95 且 max|ΔlogFC| <0.1）
#      —— A3 验「信号有没有丢」，这条验「算得对不对」。方向反了或 trend 用错时，
#         两边的显著基因集合会错开，而各自的检出率可能都还是绿的。
#
# 用法：
#   Rscript scripts/smoke-r-de.R                      # 跑所有方法（缺包的自动标「待验证」）
#   Rscript scripts/smoke-r-de.R --method limma-voom  # 只跑一个方法
#   Rscript scripts/smoke-r-de.R --method limma-voom,deseq2
#   Rscript scripts/smoke-r-de.R --keep               # 保留临时项目目录（排查用）
#
# R 不在 PATH 时（本项目当前就是这种环境）用绝对路径：
#   "D:/R-4.3.2/bin/x64/Rscript.exe" scripts/smoke-r-de.R
#
# 退出码：全部通过 0（含「某方法缺包待验证」）/ 有断言失败 1 / 所选方法都缺包 3 / 环境或参数问题 4
#
# 关于启动时那 4 条 "Setting LC_COLLATE=C.UTF-8 failed"：
#   这是 R 自己的启动警告——Git Bash 会导出 LC_ALL=C.UTF-8，而 Windows 版 R 不认
#   这个 locale 名。脚本开头会 `Sys.unsetenv("LC_ALL")`，所以**子进程**不会再报；
#   但本进程启动时那几条已经打印了，去不掉，也无害。
# =============================================================================

# ---- 0. 定位仓库根目录 -------------------------------------------------------
args_all <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", args_all, value = TRUE)
if (length(file_arg) == 0) {
  cat("必须通过 Rscript 运行：Rscript scripts/smoke-r-de.R\n")
  quit(save = "no", status = 4L, runLast = FALSE)
}
script_path <- normalizePath(sub("^--file=", "", file_arg[1]), mustWork = FALSE)
root <- dirname(dirname(script_path))
r_root <- file.path(root, "r")
demo_dir <- file.path(root, "resources", "demo")
docs_dir <- file.path(root, "docs")

keep_tmp <- "--keep" %in% commandArgs(trailingOnly = TRUE)

cat("=== DEG Studio · R 差异分析冒烟验证 ===\n")
cat("仓库根目录 : ", root, "\n", sep = "")
cat("R 版本     : ", R.version.string, "\n", sep = "")

# ---- 1. 资源自检 -------------------------------------------------------------
demo_expr <- file.path(demo_dir, "expression.csv")
demo_groups <- file.path(demo_dir, "groups.csv")
bootstrap <- file.path(r_root, "common", "bootstrap.R")

missing_files <- c(demo_expr, demo_groups, bootstrap)[
  !file.exists(c(demo_expr, demo_groups, bootstrap))
]
if (length(missing_files) > 0) {
  cat("\n缺少必需文件：\n", paste0("  - ", missing_files, collapse = "\n"), "\n", sep = "")
  cat("请在仓库根目录执行：node scripts/gen-demo-data.mjs\n")
  quit(save = "no", status = 4L, runLast = FALSE)
}

# ---- 2. R 包自检：**按方法分组** --------------------------------------------
#
# 为什么按方法而不是"缺一个就整体退出"：DESeq2 的依赖树很大，装它常常比 limma
# 慢几个小时。这段时间里 limma-voom 明明可以真跑、真出数值，却因为"另一个方法
# 缺包"而什么都不验——那是把测试的洁癖放在证据之上。
# 所以：缺包的方法标「待验证（缺包）」，能跑的方法照跑照断言；
# 只有**一个方法都跑不了**时才算"无法验证"（exit 3）。
PKGS_OF <- list(
  "limma-voom" = c("limma", "edgeR", "data.table"),
  "deseq2" = c("DESeq2", "edgeR", "data.table"),
  "edger" = c("edgeR", "limma", "data.table"),
  # limma-lm 的两个分支用同一个脚本，只是 run_config 的 inputIsLog2 不同。
  # 两个都算「方法」，因为它们验的是两条完全不同的 R 代码路径。
  "limma-lm" = c("limma", "edgeR", "data.table"),
  "limma-lm-log2" = c("limma", "edgeR", "data.table")
)
# 脚本自身 + 协议通道需要的包：缺了连报告都写不出来，属于硬失败
BASE_PKGS <- c("jsonlite", "data.table")

has_pkg <- function(p) requireNamespace(p, quietly = TRUE)
print_install_hint <- function(pkgs) {
  bioc_pkgs <- intersect(pkgs, c("limma", "edgeR", "DESeq2", "apeglm"))
  cran_pkgs <- intersect(pkgs, c("jsonlite", "data.table", "ggplot2", "matrixStats"))
  if (length(bioc_pkgs) > 0) {
    cat("  if (!requireNamespace(\"BiocManager\", quietly = TRUE)) install.packages(\"BiocManager\")\n")
    cat("  BiocManager::install(c(",
        paste0("\"", bioc_pkgs, "\"", collapse = ", "), "))\n", sep = "")
  }
  if (length(cran_pkgs) > 0) {
    cat("  install.packages(c(",
        paste0("\"", cran_pkgs, "\"", collapse = ", "), "))\n", sep = "")
  }
}

missing_base <- BASE_PKGS[!vapply(BASE_PKGS, has_pkg, logical(1))]
if (length(missing_base) > 0) {
  cat("\n[无法验证] 缺少脚本自身依赖的 R 包：", paste(missing_base, collapse = ", "), "\n", sep = "")
  cat("这些包缺失时连协议通道与报告都建不出来。安装方法：\n\n")
  print_install_hint(missing_base)
  cat("\n提示：本软件「设置 / 诊断」页也会显示缺哪些包，并给出一条可复制的安装命令。\n")
  quit(save = "no", status = 3L, runLast = FALSE)
}

# --method limma-voom / --method limma-voom,deseq2（默认全跑）
method_arg <- grep("^--method(=|$)", commandArgs(trailingOnly = TRUE), value = TRUE)
selected <- names(PKGS_OF)
if (length(method_arg) > 0) {
  raw <- sub("^--method=?", "", method_arg[1])
  if (!nzchar(raw)) {
    # --method limma-voom 这种空格分隔写法
    idx <- match("--method", commandArgs(trailingOnly = TRUE))
    raw <- commandArgs(trailingOnly = TRUE)[idx + 1L]
  }
  selected <- trimws(strsplit(raw, ",", fixed = TRUE)[[1]])
  unknown <- setdiff(selected, names(PKGS_OF))
  if (length(unknown) > 0) {
    cat("\n[参数错误] 未知方法：", paste(unknown, collapse = ", "),
        "（可选：", paste(names(PKGS_OF), collapse = ", "), "）\n", sep = "")
    quit(save = "no", status = 4L, runLast = FALSE)
  }
}

runnable <- character(0)
pending <- list()   # method -> 缺失的包
for (m in selected) {
  miss <- PKGS_OF[[m]][!vapply(PKGS_OF[[m]], has_pkg, logical(1))]
  if (length(miss) == 0) runnable <- c(runnable, m) else pending[[m]] <- miss
}

cat("验证范围   : ", paste(selected, collapse = ", "), "\n", sep = "")
if (length(pending) > 0) {
  for (m in names(pending)) {
    cat("  · ", m, " → 待验证（缺包：", paste(pending[[m]], collapse = ", "), "）\n", sep = "")
  }
}

if (length(runnable) == 0) {
  cat("\n[无法验证] 所选方法都缺 R 包，没有任何一个能真跑。安装方法（Bioconductor 官方源）：\n\n")
  print_install_hint(unique(unlist(pending)))
  cat("\n提示：本软件「设置 / 诊断」页也会显示缺哪些包，并给出一条可复制的安装命令。\n")
  quit(save = "no", status = 3L, runLast = FALSE)
}

# ---- 2.5 清掉 shell 带来的 LC_ALL -------------------------------------------
# 生产路径（RProcessRunner.buildRenv）在 Windows 上**不设** LC_ALL，就是为了避免
# R 4.3 不认 "C.UTF-8"、LC_CTYPE 退回 C 之后 source(encoding="UTF-8") 半途返回。
# 本脚本是直接 system2 起 R 的（不走 RProcessRunner），所以必须自己把 shell 里的
# LC_ALL 清掉，否则子进程会重现那 4 条 "Setting LC_xxx failed"，而且更糟的是
# 子进程的 native 编码会退化成 ASCII。
# 注意：清不掉本进程**启动时**已经打印的那几条（R 在读脚本之前就打印了），无害。
if (nzchar(Sys.getenv("LC_ALL", unset = ""))) {
  cat("locale 处理 : 已清除继承的 LC_ALL=", Sys.getenv("LC_ALL"), "（与 buildRenv 的 Windows 策略一致）\n", sep = "")
  Sys.unsetenv("LC_ALL")
}

# ---- 3. 准备临时「项目」（结构与真实项目一致：data/ + results/de/）-----------
# ★ --keep 的落点必须在 R 会话临时目录**之外**：R 退出时会整个删掉 tempdir()，
#   放在里面的东西 --keep 也留不住（最初版本就是这样，--keep 形同虚设）。
keep_root <- if (keep_tmp) {
  dir <- file.path(root, ".smoke-tmp")
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  dir
} else {
  tempdir()
}
work_dir <- tempfile("deg-smoke-", tmpdir = keep_root)
if (keep_tmp) cat("临时目录   : ", work_dir, "（--keep：跑完保留）\n", sep = "")
dir.create(file.path(work_dir, "data"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(work_dir, "results", "de"), recursive = TRUE, showWarnings = FALSE)
copied <- file.copy(
  c(demo_expr, demo_groups),
  file.path(work_dir, "data", c("expression.clean.csv", "groups.csv")),
  overwrite = TRUE
)
if (!all(copied)) {
  cat("\n[环境问题] 无法把 demo 数据复制到临时目录：", work_dir, "\n", sep = "")
  quit(save = "no", status = 4L, runLast = FALSE)
}

cleanup <- function() {
  if (!keep_tmp && dir.exists(work_dir)) unlink(work_dir, recursive = TRUE, force = TRUE)
}
if (!keep_tmp) on.exit(cleanup(), add = TRUE)

# ---- 4. 读 demo 数据，确认「前 200 个基因是植入差异基因」这个前提仍成立 ------
demo_dt <- data.table::fread(demo_expr, data.table = FALSE, check.names = FALSE)
demo_group <- data.table::fread(demo_groups, data.table = FALSE, check.names = FALSE)
gene_ids <- as.character(demo_dt[[1]])
group_vec <- stats::setNames(as.character(demo_group$group), as.character(demo_group$sample))
mat <- as.matrix(demo_dt[, -1, drop = FALSE])
storage.mode(mat) <- "double"
tumor_cols <- colnames(mat)[group_vec[colnames(mat)] == "Tumor"]
normal_cols <- colnames(mat)[group_vec[colnames(mat)] == "Normal"]
implanted <- gene_ids[seq_len(min(200L, length(gene_ids)))]

# 方向自检：前 100 个应上调、后 100 个应下调（用中位数，避免个别低表达基因的噪声）
mean_tumor <- rowMeans(mat[, tumor_cols, drop = FALSE])
mean_normal <- rowMeans(mat[, normal_cols, drop = FALSE])
ratio <- mean_tumor / pmax(mean_normal, 1e-9)
up_ratio <- stats::median(ratio[seq_len(100)])
down_ratio <- stats::median(ratio[101:200])
assumption_ok <- up_ratio > 1.5 && down_ratio < 0.67

cat("demo 数据   : ", nrow(mat), " 基因 × ", ncol(mat), " 样本（",
    length(tumor_cols), " Tumor / ", length(normal_cols), " Normal）\n", sep = "")
cat("植入差异自检: 前 100 中位倍数 ", sprintf("%.2f", up_ratio),
    "，后 100 中位倍数 ", sprintf("%.2f", down_ratio),
    if (assumption_ok) "（符合预期）" else "（**不符合预期**）", "\n", sep = "")

# ---- 5. 结果收集器 -----------------------------------------------------------
results <- list()
add <- function(method, id, title, ok, actual) {
  results[[length(results) + 1L]] <<- list(
    method = method, id = id, title = title, ok = isTRUE(ok), actual = actual
  )
}

# ---- 6. 组装 run_config（与 src/main/analysis/modules/deShared.ts 逐字段一致）--

#' 生成一份 log2-CPM 矩阵（limma-lm 的「已 log2」分支要用）
#'
#' 为什么不直接拿 demo counts 当 log2 数据喂进去：那样脚本里那条
#' 「99 分位 > 50 → warn 看起来像 raw counts」会一直触发，等于没验「已 log2」这条路径。
ensure_log2_matrix <- function(path) {
  if (file.exists(path)) return(path)
  dge <- edgeR::DGEList(counts = mat)
  dge <- edgeR::calcNormFactors(dge, method = "TMM")
  logcpm <- edgeR::cpm(dge, log = TRUE, prior.count = 2)
  out <- data.frame(gene_id = gene_ids, logcpm, check.names = FALSE, stringsAsFactors = FALSE)
  data.table::fwrite(out, path)
  emit_line <- sprintf("log2 矩阵    : %s（%d × %d，cpm(log=TRUE, prior.count=2)）",
                       basename(path), nrow(out), ncol(out) - 1L)
  cat(emit_line, "\n", sep = "")
  path
}

build_config <- function(method, run_dir) {
  params <- list(
    matrixPath = file.path(work_dir, "data", "expression.clean.csv"),
    groupsPath = file.path(work_dir, "data", "groups.csv"),
    species = "human",
    dataType = "counts",
    sampleColumn = "sample",
    groupColumn = "group",
    geneIdType = "SYMBOL",
    contrast = list(groupColumn = "group", numerator = "Tumor", denominator = "Normal"),
    filter = list(enabled = TRUE, mode = "filterByExpr", minCount = 10, minSamplesPct = 50),
    fdrMethod = "BH",
    outputGeneName = TRUE,
    keepAllGenes = FALSE
  )
  # deseq2 模块额外带 shrinkLfc（deShared 的 extraParams）
  if (identical(method, "deseq2")) params$shrinkLfc <- FALSE
  # limma-lm 的两个分支：参数名与 limmaNorm.ts 的 buildRunConfig 逐字一致
  if (identical(method, "limma-lm")) {
    params$inputIsLog2 <- FALSE
    params$priorCount <- 2
  }
  if (identical(method, "limma-lm-log2")) {
    params$inputIsLog2 <- TRUE
    params$priorCount <- 2
    # 已 log2 的输入：现造一份，绝不拿 counts 冒充（否则验的不是这条路径）
    params$matrixPath <- ensure_log2_matrix(file.path(run_dir, "expression.log2.csv"))
  }
  list(
    runId = method,
    projectRoot = work_dir,
    runDir = run_dir,
    themePath = file.path(root, "resources", "plotTheme.json"),
    fontPath = file.path(root, "resources", "runtime", "fonts", "NotoSansSC-Regular.otf"),
    params = params
  )
}

# ---- 7. 调真实 R 脚本（同样的 --config 方式，同样的环境变量）------------------
run_script <- function(script_rel, cfg_path) {
  rscript <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "Rscript.exe" else "Rscript")
  script <- file.path(r_root, script_rel)
  saved <- Sys.getenv(
    c("DEG_R_ROOT", "DEG_THEME_PATH", "DEG_FONT_PATH", "DEG_RESOURCES_ROOT", "TMPDIR", "TEMP", "TMP"),
    unset = NA_character_
  )
  Sys.setenv(
    DEG_R_ROOT = r_root,
    DEG_THEME_PATH = file.path(root, "resources", "plotTheme.json"),
    DEG_FONT_PATH = file.path(root, "resources", "runtime", "fonts", "NotoSansSC-Regular.otf"),
    DEG_RESOURCES_ROOT = file.path(root, "resources"),
    TMPDIR = work_dir, TEMP = work_dir, TMP = work_dir
  )
  on.exit({
    for (nm in names(saved)) {
      if (is.na(saved[[nm]])) Sys.unsetenv(nm) else do.call(Sys.setenv, stats::setNames(list(saved[[nm]]), nm))
    }
  }, add = TRUE)

  started <- Sys.time()
  # ★ cwd 也要与 Electron 一致：RProcessRunner 用 `cwd = runDir` 启动子进程。
  #   system2() 没有 wd 参数，这里 setwd 并在退出时恢复（after = FALSE 让恢复
  #   先于环境变量恢复执行，顺序不影响结果，但避免中途 stop 时残留工作目录）。
  old_wd <- getwd()
  setwd(dirname(cfg_path))
  on.exit(setwd(old_wd), add = TRUE, after = FALSE)
  output <- suppressWarnings(system2(
    rscript,
    args = c("--vanilla", "--no-save", "--no-restore", script, "--config", cfg_path),
    stdout = TRUE,
    stderr = TRUE
  ))
  status <- attr(output, "status")
  if (is.null(status)) status <- 0L
  list(
    status = as.integer(status),
    output = as.character(output),
    elapsed = as.numeric(difftime(Sys.time(), started, units = "secs"))
  )
}

# ---- 8. 解析事件流 -----------------------------------------------------------
read_events <- function(run_dir) {
  f <- file.path(run_dir, "events.jsonl")
  if (!file.exists(f)) return(list())
  lines <- readLines(f, warn = FALSE, encoding = "UTF-8")
  lines <- sub("^@@DEG@@ ", "", lines)
  lines <- lines[nzchar(lines)]
  out <- lapply(lines, function(l) tryCatch(jsonlite::fromJSON(l, simplifyVector = TRUE),
                                            error = function(e) NULL))
  Filter(Negate(is.null), out)
}

# ---- 9. 单个方法的完整验证 ---------------------------------------------------
EXPECTED_STAGES <- list(
  "limma-voom" = c("read", "filter", "normalize", "fit", "test", "write"),
  deseq2 = c("read", "filter", "normalize", "dispersion", "fit", "test", "write"),
  edger = c("read", "filter", "normalize", "dispersion", "fit", "test", "write"),
  # limma-lm 两个分支都会报一个 normalize 阶段（已 log2 分支报的是「跳过标准化」）
  "limma-lm" = c("read", "filter", "normalize", "fit", "test", "write"),
  "limma-lm-log2" = c("read", "filter", "normalize", "fit", "test", "write")
)
SCRIPT_OF <- c(
  "limma-voom" = "de/run_limma_voom.R",
  deseq2 = "de/run_deseq2.R",
  edger = "de/run_edger.R",
  "limma-lm" = "de/run_limma_norm.R",
  "limma-lm-log2" = "de/run_limma_norm.R"
)

verify_method <- function(method) {
  cat("\n--- ", method, " ---\n", sep = "")
  run_dir <- file.path(work_dir, "results", "de", method)
  dir.create(run_dir, recursive = TRUE, showWarnings = FALSE)
  cfg_path <- file.path(run_dir, "run_config.json")
  jsonlite::write_json(
    build_config(method, run_dir), cfg_path,
    auto_unbox = TRUE, null = "null", digits = NA, pretty = TRUE
  )

  run <- run_script(SCRIPT_OF[[method]], cfg_path)
  events <- read_events(run_dir)
  csv_path <- file.path(run_dir, "de.csv")
  json_path <- file.path(run_dir, "de.json")

  is_type <- function(type) Filter(function(m) identical(as.character(m$type), type), events)
  progress <- is_type("progress")
  result_msg <- is_type("result")
  error_msg <- is_type("error")

  summary <- if (length(result_msg) > 0) result_msg[[length(result_msg)]]$summary else NULL
  genes_after_filter <- if (!is.null(summary) && !is.null(summary$genesAfterFilter)) {
    as.integer(summary$genesAfterFilter)
  } else {
    NA_integer_
  }
  filtered_out_n <- if (!is.null(summary) && !is.null(summary$filteredOut)) {
    as.integer(summary$filteredOut)
  } else {
    NA_integer_
  }

  # ① de.csv 行数 == 过滤后基因数，且满足守恒律
  has_csv <- file.exists(csv_path)
  csv_dt <- if (has_csv) {
    tryCatch(data.table::fread(csv_path, data.table = FALSE, check.names = FALSE),
             error = function(e) NULL)
  } else {
    NULL
  }
  csv_rows <- if (is.null(csv_dt)) 0L else nrow(csv_dt)
  # ★ 守恒律才是「少了几行」的真检查：summary.genesAfterFilter 与 de.csv 同源
  #   （都是 nrow(out)），只比它们俩属于自证。真正的不变量是
  #   「写出行数 + 被过滤掉的行数 == 输入矩阵基因数」。
  #   DESeq2 把 NA logFC 的行也计入 filteredOut，所以两种方法都成立。
  conserved <- !is.na(genes_after_filter) && !is.na(filtered_out_n) &&
    csv_rows + filtered_out_n == nrow(mat)
  add(method, "A1", "de.csv 行数 == 过滤后基因数，且 行数+过滤掉 == 输入基因数",
      has_csv && !is.null(csv_dt) && !is.na(genes_after_filter) &&
        csv_rows == genes_after_filter && conserved,
      sprintf("de.csv %d 行 / summary.genesAfterFilter %s / 过滤掉 %s / 输入 %d 行（守恒 %s）",
              csv_rows,
              if (is.na(genes_after_filter)) "（缺失）" else genes_after_filter,
              if (is.na(filtered_out_n)) "（缺失）" else filtered_out_n,
              nrow(mat),
              if (conserved) "成立" else "**不成立**"))

  # ② 9 列表头严格一致
  expected_cols <- c("gene_id", "gene_name", "logFC", "aveExpr", "t",
                     "pValue", "adjPValue", "b", "regulation")
  actual_cols <- if (is.null(csv_dt)) character(0) else names(csv_dt)
  add(method, "A2", "表头严格等于约定的 9 列",
      identical(actual_cols, expected_cols),
      if (identical(actual_cols, expected_cols)) {
        paste(expected_cols, collapse = ",")
      } else {
        paste0("实际：", paste(actual_cols, collapse = ","))
      })

  # ③ 植入的差异基因里，被检验到的那些要有 ≥85% 显著
  #
  # ★ 为什么分母不是 200（真实数据跑出来的教训）：
  #   demo 数据里 200 个植入基因的基线表达是 lognormal，相当一部分本身只有个位数
  #   counts，会被 filterByExpr 正常过滤掉（实测 200 → 137，过滤掉 63）。这些基因
  #   **根本没有被检验的机会**，把它们计入分母等于要求「低表达基因也必须显著」，
  #   那是在惩罚一个正确的过滤，不是在验证信号。
  #   但也不能只看比例：如果哪天过滤把 190 个植入基因都吃掉，比例再漂亮也说明
  #   信号没了。所以同时要求「通过过滤的植入基因 ≥ 60%」。
  has_cols <- !is.null(csv_dt) && all(c("gene_id", "logFC", "adjPValue") %in% names(csv_dt))
  # 本次冒烟不传阈值参数 → R 侧用 PRD 默认值。这里显式写出来，
  # A8 要拿它和 regulation 列对照，硬编码两处容易改一处漏一处。
  TH_LOGFC <- 1.0
  TH_FDR <- 0.05
  ids <- if (has_cols) as.character(csv_dt$gene_id) else character(0)
  logfc <- if (has_cols) as.numeric(csv_dt$logFC) else numeric(0)
  fdr <- if (has_cols) as.numeric(csv_dt$adjPValue) else numeric(0)
  pval <- if (has_cols && "pValue" %in% names(csv_dt)) {
    as.numeric(csv_dt$pValue)
  } else {
    rep(NA_real_, length(ids))
  }
  # 与 utils/threshold.ts 的 isSignificant **逐字相同**（含 pValue 有限且 <1 的守卫）：
  # 只有逐字相同，A8 那条「regulation 计数 == 界面计数」才有意义。
  significant <- if (has_cols) {
    is.finite(pval) & pval < 1 & is.finite(logfc) & !is.na(fdr) &
      fdr < TH_FDR & abs(logfc) >= TH_LOGFC
  } else {
    logical(0)
  }
  total_sig <- if (has_cols) as.integer(sum(significant)) else NA_integer_
  # 全表（不只植入基因）的显著基因按符号拆分，用于报告里的「其中上调/下调」
  total_up <- if (has_cols) as.integer(sum(significant & logfc > 0)) else NA_integer_
  total_down <- if (has_cols) as.integer(sum(significant & logfc < 0)) else NA_integer_

  # ③ 的 universe：检出率必须在**与 counts 分支相同的基因集**上算（见下方注释）
  #
  # ★ log2 分支的降级过滤（log2 >= 1）在本 demo 数据上不生效 —— 该矩阵 log2-CPM
  #   最小值是 4.48（q10 = 5.73），所以保留 2000/2000，200 个植入基因全部进入检验，
  #   其中 63 个是 counts 分支会正常过滤掉的低表达基因，它们本来没有检出机会，
  #   把检出率从 87.6% 稀释到 77.0%。
  #
  #   85% 这条线是按 filterByExpr 的基因集标定的。要在 log2 分支上继续用它，
  #   分母就必须换成同一个基因集 —— 否则比的不是同一件事。
  #   实测：限制到 counts 分支的 1400 基因后，log2 分支是 137 检验 / 120 检出 /
  #   87.6%，且与 counts 分支的显著基因 Jaccard = 1.000。
  #
  #   ★ 这不是给断言放水：分母缩小后，通过门槛需要**更少**的检出吗？不是 ——
  #   它要求 log2 分支在 counts 分支认为「值得检验」的那批基因上，一个都不能少地
  #   找到信号。A9 再额外卡两个分支的显著基因集合本身必须重合。
  a3_universe <- ids
  a3_rate_min <- 0.85
  a3_note <- ""
  # counts 分支的结果一定先落盘：PKGS_OF 里 limma-lm 排在 limma-lm-log2 前面。
  # 只有 `--method limma-lm-log2` 单跑时才会缺失，那种情况下退回全基因集 + 75%。
  ref_csv <- file.path(work_dir, "results", "de", "limma-lm", "de.csv")
  if (identical(method, "limma-lm-log2")) {
    if (file.exists(ref_csv)) {
      ref_ids <- tryCatch(
        as.character(data.table::fread(ref_csv, data.table = FALSE, check.names = FALSE)$gene_id),
        error = function(e) character(0)
      )
      if (length(ref_ids) > 0) {
        a3_universe <- intersect(ids, ref_ids)
        a3_note <- sprintf("；检出率在与 counts 分支相同的 %d 基因集上计算", length(a3_universe))
      } else {
        a3_rate_min <- 0.75
        a3_note <- "；counts 分支结果不可读，检出率在全基因集上计算，阈值放宽至 75%"
      }
    } else {
      a3_rate_min <- 0.75
      a3_note <- "；未找到 counts 分支结果（单独跑了本 case），检出率在全基因集上计算，阈值放宽至 75%"
    }
  }

  sig_hits <- NA_integer_
  tested_implanted <- NA_integer_
  tested_implanted_all <- NA_integer_
  if (has_cols) {
    is_implanted <- ids %in% implanted
    in_universe <- ids %in% a3_universe
    # 存活率衡量「过滤有没有把植入基因吃掉」→ 必须对全部 200 个算，不跟着 universe 缩
    tested_implanted_all <- as.integer(sum(is_implanted))
    tested_implanted <- as.integer(sum(is_implanted & in_universe))
    sig_hits <- as.integer(sum(significant & is_implanted & in_universe))
  }
  detect_rate <- if (!is.na(sig_hits) && !is.na(tested_implanted) && tested_implanted > 0) {
    sig_hits / tested_implanted
  } else {
    NA_real_
  }
  filter_survival <- if (!is.na(tested_implanted_all)) tested_implanted_all / length(implanted) else NA_real_
  a3_ok <- !is.na(detect_rate) &&
    tested_implanted_all >= ceiling(0.6 * length(implanted)) &&
    detect_rate >= a3_rate_min &&
    sig_hits >= 100L
  add(method, "A3", "通过过滤的植入基因中 ≥85% 显著（且 ≥60% 的植入基因能通过过滤）",
      a3_ok,
      if (is.na(sig_hits)) {
        "无法计算（de.csv 缺失或缺少 gene_id/logFC/adjPValue 列）"
      } else {
        sprintf("%d / %d 显著（植入 %d，进入检验 %d，检出率 %.1f%%，存活率 %.1f%%）%s",
                sig_hits, tested_implanted, length(implanted), tested_implanted_all,
                100 * detect_rate, 100 * filter_survival, a3_note)
      })

  # ④ de.json 与 de.csv 逐行一致
  json_ok <- FALSE
  json_detail <- "de.json 不存在"
  if (!is.null(csv_dt) && file.exists(json_path)) {
    json_dt <- tryCatch(jsonlite::fromJSON(json_path, simplifyDataFrame = TRUE),
                        error = function(e) NULL)
    if (is.null(json_dt) || !is.data.frame(json_dt)) {
      json_detail <- "de.json 无法解析为表格"
    } else {
      same_rows <- nrow(json_dt) == nrow(csv_dt)
      same_ids <- same_rows && identical(as.character(json_dt$gene_id), as.character(csv_dt$gene_id))
      max_diff <- if (same_rows) max(abs(as.numeric(json_dt$logFC) - as.numeric(csv_dt$logFC)),
                                     na.rm = TRUE) else NA_real_
      json_ok <- same_rows && same_ids && is.finite(max_diff) && max_diff < 1e-9
      json_detail <- sprintf("json %d 行 / csv %d 行，gene_id %s，max|ΔlogFC| = %s",
                             nrow(json_dt), nrow(csv_dt),
                             if (same_ids) "一致" else "**不一致**",
                             if (is.na(max_diff)) "NA" else format(max_diff, scientific = TRUE, digits = 3))
    }
  }
  add(method, "A4", "de.json 与 de.csv 逐行一致", json_ok, json_detail)

  # ⑤ 进度覆盖全部阶段且 pct 单调不减
  pcts <- vapply(progress, function(m) as.numeric(m$pct), numeric(1))
  stages <- vapply(progress, function(m) as.character(m$stage), character(1))
  expected <- EXPECTED_STAGES[[method]]
  covered <- all(expected %in% stages)
  monotonic <- length(pcts) < 2 || all(diff(pcts) >= -1e-9)
  add(method, "A5", "进度覆盖全部阶段且 pct 单调不减",
      covered && monotonic,
      sprintf("阶段 %d 条 / 覆盖 %s；pct 序列 %s（%s）",
              length(pcts),
              if (covered) "完整" else paste0("缺少：", paste(setdiff(expected, stages), collapse = ",")),
              if (length(pcts) <= 12) paste(pcts, collapse = "→") else
                paste0(paste(pcts[1:6], collapse = "→"), "→…→", paste(utils::tail(pcts, 3), collapse = "→")),
              if (monotonic) "单调" else "**有回退**"))

  # ⑥ 退出码 0 + 有 result、无 error
  add(method, "A6", "退出码 0，事件流有 result、无 error",
      run$status == 0L && length(result_msg) > 0 && length(error_msg) == 0,
      sprintf("exit=%d，result=%d 条，error=%d 条，耗时 %.1fs",
              run$status, length(result_msg), length(error_msg), run$elapsed))

  # ⑦ 方向正确：植入的上调基因 logFC 必须 > 0，下调基因必须 < 0
  #   ★ 这是整个 R 侧最危险的一类 bug 的守门人：design 写成 ~group（有截距）而不是
  #     ~0+group 时，对比的含义会随 factor levels 变化，结果"看起来正常"但方向
  #     可能整体反过来。数值断言（A1–A6）全都发现不了它，只有方向断言能。
  sign_errors <- NA_integer_
  sig_up <- NA_integer_
  sig_down <- NA_integer_
  if (has_cols) {
    half <- floor(length(implanted) / 2)
    up_ids <- implanted[seq_len(half)]
    down_ids <- implanted[half + seq_len(length(implanted) - half)]
    is_sig_up <- significant & ids %in% up_ids
    is_sig_down <- significant & ids %in% down_ids
    sig_up <- as.integer(sum(is_sig_up))
    sig_down <- as.integer(sum(is_sig_down))
    sign_errors <- as.integer(sum(logfc[is_sig_up] <= 0) + sum(logfc[is_sig_down] >= 0))
  }
  add(method, "A7", "上下调方向正确（植入的上调基因 logFC>0、下调基因 logFC<0）",
      !is.na(sign_errors) && sign_errors == 0L,
      if (is.na(sign_errors)) {
        "无法计算（de.csv 缺失或缺少 gene_id/logFC/adjPValue 列）"
      } else {
        sprintf("显著上调 %d 个 / 显著下调 %d 个；方向错误 %d 个", sig_up, sig_down, sign_errors)
      })

  # ⑧ regulation 列与界面口径一致
  #   ★ 这条锁的是「用户把 de.csv 发给导师、在 Excel 里数出来的行数 == 界面统计卡」。
  #     历史 bug：R 侧写的是「符号 + 原始 p<0.05」，界面用的是「|logFC|>=1 且 FDR<0.05」，
  #     同一份 limma-voom 结果是 118/98 对 75/48 —— 不报错，但结论不一致，
  #     比崩溃更难发现。现在 R 侧按配置阈值写（默认 1.0/0.05），两边必须严格相等。
  reg_ok <- FALSE
  reg_detail <- "无法计算（de.csv 缺失 regulation 列）"
  if (has_cols && "regulation" %in% names(csv_dt)) {
    reg <- as.character(csv_dt$regulation)
    csv_up <- as.integer(sum(reg == "up"))
    csv_down <- as.integer(sum(reg == "down"))
    csv_ns <- as.integer(sum(reg == "ns"))
    ui_up <- as.integer(sum(significant & logfc > 0))
    ui_down <- as.integer(sum(significant & logfc < 0))
    ui_ns <- as.integer(sum(!significant))
    reg_ok <- csv_up == ui_up && csv_down == ui_down && csv_ns == ui_ns
    reg_detail <- sprintf(
      "regulation %d/%d/%d vs 界面口径 %d/%d/%d（up/down/ns，阈值 |logFC|>=%s 且 FDR<%s）%s",
      csv_up, csv_down, csv_ns, ui_up, ui_down, ui_ns, TH_LOGFC, TH_FDR,
      if (reg_ok) "" else " —— **两套口径不一致**"
    )
  }
  add(method, "A8", "de.csv 的 regulation 列与界面同一阈值下的三分类严格相等", reg_ok, reg_detail)

  # ⑨ 两个 limma-lm 分支在共同基因集上的结论必须高度一致
  #
  # 为什么需要这条：A3 只验「信号有没有丢」，验不出「算得对不对」。
  # 如果 log2 分支的 logFC 方向反了、或者 eBayes 该带 trend 的地方没带，
  # 各自的检出率可能都还是绿的（植入基因两侧都有，掉几个不致命），
  # 但两个分支的显著基因集合会明显错开 —— 只有跨分支比对才看得见。
  # 实测 Jaccard = 1.000、同基因 max|ΔlogFC| = 1.5e-2，留出余量后卡 0.95 / 0.1。
  if (identical(method, "limma-lm-log2") && file.exists(ref_csv) && has_cols) {
    ref <- tryCatch(
      data.table::fread(ref_csv, data.table = FALSE, check.names = FALSE),
      error = function(e) NULL
    )
    ref_has_cols <- !is.null(ref) && all(c("gene_id", "logFC", "adjPValue") %in% names(ref))
    if (!ref_has_cols) {
      add(method, "A9", "两个 limma-lm 分支在共同基因集上结论一致（Jaccard ≥0.95 且 max|ΔlogFC| <0.1）",
          FALSE, "无法计算（counts 分支的 de.csv 不可读或缺列）")
    } else {
      # 与上面 `significant` 完全同一套判据（含 pValue 有限且 <1 的守卫），
      # 否则「同一阈值」这句话就不成立了
      sig_mask <- function(dt) {
        lfc <- as.numeric(dt$logFC)
        fdr <- as.numeric(dt$adjPValue)
        pv <- if ("pValue" %in% names(dt)) as.numeric(dt$pValue) else rep(NA_real_, length(lfc))
        is.finite(pv) & pv < 1 & is.finite(lfc) & !is.na(fdr) & fdr < TH_FDR & abs(lfc) >= TH_LOGFC
      }
      # ★ Jaccard 与 ΔlogFC 必须用**同一个 universe**，两边都要先限制到共同基因集。
      #
      #   为什么不能只限制 ΔlogFC：log2 分支的降级过滤（log2 >= 1）在本 demo 数据上
      #   空转（log2-CPM 最小值 4.48），保留 2000/2000；counts 分支的 filterByExpr
      #   保留 1400/2000。如果 cur_sig 在全部 2000 行上算，log2 分支会多出 34 个
      #   只在低表达区显著的基因，Jaccard 被压到 0.782 —— 但那不是「结论不一致」，
      #   是「两边看的基因集不同」。实测限制到共同 1400 个基因后 Jaccard = 1.000。
      #
      #   这正是 A3 同一个坑的第二次出现：分母不同，比出来的数就不是同一件事。
      common <- intersect(as.character(ref$gene_id), as.character(csv_dt$gene_id))
      ref_u <- ref[match(common, as.character(ref$gene_id)), , drop = FALSE]
      cur_u <- csv_dt[match(common, as.character(csv_dt$gene_id)), , drop = FALSE]
      ref_sig <- as.character(ref_u$gene_id[sig_mask(ref_u)])
      cur_sig <- as.character(cur_u$gene_id[sig_mask(cur_u)])
      inter <- length(intersect(ref_sig, cur_sig))
      uni <- length(union(ref_sig, cur_sig))
      jac <- if (uni > 0) inter / uni else NA_real_
      d_lfc <- if (length(common) > 0) {
        suppressWarnings(max(abs(as.numeric(cur_u$logFC) - as.numeric(ref_u$logFC)), na.rm = TRUE))
      } else {
        NA_real_
      }
      a9_ok <- is.finite(jac) && jac >= 0.95 && is.finite(d_lfc) && d_lfc < 0.1
      add(method, "A9", "两个 limma-lm 分支在共同基因集上结论一致（Jaccard ≥0.95 且 max|ΔlogFC| <0.1）",
          a9_ok,
          sprintf("Jaccard = %.3f（交集 %d / 并集 %d），比较范围 %d 基因×%d 行（counts 分支）/ %d 基因×%d 行（本分支），同基因 max|ΔlogFC| = %s",
                  jac, inter, uni,
                  length(unique(as.character(ref$gene_id))), nrow(ref),
                  length(unique(as.character(csv_dt$gene_id))), nrow(csv_dt),
                  if (is.na(d_lfc)) "NA" else format(d_lfc, scientific = TRUE, digits = 3)))
    }
  }

  # 失败时把 stderr 尾巴留在报告里（否则只有「失败」两个字没法查）
  detail_tail <- character(0)
  if (run$status != 0L || length(error_msg) > 0) {
    tail_lines <- utils::tail(run$output, 25)
    detail_tail <- c(detail_tail, "", "**R 输出（末 25 行）**", "```", tail_lines, "```")
  }

  list(
    method = method,
    run_dir = run_dir,
    elapsed = run$elapsed,
    input_genes = nrow(mat),
    genes_after_filter = genes_after_filter,
    filtered_out = filtered_out_n,
    total_sig = total_sig,
    total_up = total_up,
    total_down = total_down,
    sig_up = sig_up,
    sig_down = sig_down,
    tested_implanted = tested_implanted,
    tested_implanted_all = tested_implanted_all,
    detect_rate = detect_rate,
    up = if (!is.null(summary) && !is.null(summary$up)) as.integer(summary$up) else NA_integer_,
    down = if (!is.null(summary) && !is.null(summary$down)) as.integer(summary$down) else NA_integer_,
    sig_hits = sig_hits,
    detail_tail = detail_tail
  )
}

method_info <- lapply(runnable, verify_method)

# ---- 10. 生成 markdown 报告 --------------------------------------------------
all_ok <- all(vapply(results, function(r) isTRUE(r$ok), logical(1))) && assumption_ok

verdict <- if (!all_ok) {
  "存在失败 ❌"
} else if (length(pending) > 0) {
  sprintf("已验证的方法全部通过 ✅（%s 待验证：缺包）", paste(names(pending), collapse = ", "))
} else {
  "全部通过 ✅"
}

lines <- c(
  "# R 差异分析冒烟验证报告",
  "",
  "> 本文件由 `scripts/smoke-r-de.R` 自动生成，请勿手工编辑。",
  "",
  sprintf("- 生成时间：%s", format(Sys.time(), "%Y-%m-%d %H:%M:%S")),
  sprintf("- R 版本：%s", R.version.string),
  sprintf("- 数据：`resources/demo/expression.csv`（%d 基因 × %d 样本）+ `groups.csv`（%d Tumor / %d Normal）",
          nrow(mat), ncol(mat), length(tumor_cols), length(normal_cols)),
  sprintf("- 植入差异基因：前 %d 个（前一半上调、后一半下调，倍数 2~5）", length(implanted)),
  sprintf("- 入参方式：与主进程完全一致（`--config <json>` + `DEG_R_ROOT` + 同样的 `buildRenv()` 环境策略）"),
  sprintf("- 本次已验证：%s", paste(runnable, collapse = ", ")),
  if (length(pending) > 0) {
    sprintf("- 本次未验证（缺包，不是失败）：%s",
            paste(sprintf("%s（缺 %s）", names(pending),
                          vapply(pending, function(x) paste(x, collapse = "/"), character(1))),
                  collapse = "；"))
  } else {
    NULL
  },
  sprintf("- **总体结论：%s**", verdict),
  "",
  "## 前置假设自检",
  "",
  "| 检查 | 结果 | 实际 |",
  "| --- | --- | --- |",
  sprintf("| demo 数据前 200 个基因确实是植入差异基因（方向正确） | %s | 前 100 中位倍数 %.2f / 后 100 中位倍数 %.2f |",
          if (assumption_ok) "✅" else "❌", up_ratio, down_ratio),
  ""
)

for (info in method_info) {
  rows <- Filter(function(r) identical(r$method, info$method), results)
  lines <- c(
    lines,
    sprintf("## %s", info$method),
    "",
    sprintf("脚本：`%s` ｜ 耗时：%.1fs", SCRIPT_OF[[info$method]], info$elapsed),
    "",
    "**关键数值**（用户真正会关心的那几个）",
    "",
    "| 指标 | 数值 |",
    "| --- | --- |",
    sprintf("| 输入基因数 | %s |", info$input_genes),
    sprintf("| 低表达过滤后（参与检验） | %s |", ifelse(is.na(info$genes_after_filter), "?", info$genes_after_filter)),
    sprintf("| 被过滤掉 | %s |", ifelse(is.na(info$filtered_out), "?", info$filtered_out)),
    sprintf("| **显著基因总数**（\\|logFC\\|≥1 且 FDR<0.05） | **%s** |", ifelse(is.na(info$total_sig), "?", info$total_sig)),
    sprintf("| 其中上调 / 下调（全表） | %s / %s |",
            ifelse(is.na(info$total_up), "?", info$total_up),
            ifelse(is.na(info$total_down), "?", info$total_down)),
    sprintf("| 植入的 200 个里被检验到的 | %s%s |",
            ifelse(is.na(info$tested_implanted_all), "?", info$tested_implanted_all),
            # log2 分支的 A3 分母被收窄到 counts 分支的基因集，两个数不一致时必须写清楚，
            # 否则读者会以为「过滤后剩 2000」和「被检验到 137」自相矛盾
            if (!is.na(info$tested_implanted_all) && !is.na(info$tested_implanted) &&
                info$tested_implanted != info$tested_implanted_all) {
              sprintf("（A3 分母收窄到与 counts 分支相同的基因集：%s）", info$tested_implanted)
            } else {
              ""
            }),
    sprintf("| 植入基因检出（显著） | %s（检出率 %s） |", ifelse(is.na(info$sig_hits), "?", info$sig_hits),
            ifelse(is.na(info$detect_rate), "?", sprintf("%.1f%%", 100 * info$detect_rate))),
    sprintf("| R 侧粗标注 up/down（p<0.05 的符号） | %s / %s |",
            ifelse(is.na(info$up), "?", info$up), ifelse(is.na(info$down), "?", info$down)),
    "",
    "| # | 断言 | 结果 | 实际 |",
    "| --- | --- | --- | --- |",
    vapply(rows, function(r) {
      sprintf("| %s | %s | %s | %s |", r$id, r$title, if (r$ok) "✅" else "❌", r$actual)
    }, character(1)),
    info$detail_tail,
    ""
  )
}

# 缺包的方法单独一节，明确写「待验证」而不是「失败」
if (length(pending) > 0) {
  lines <- c(lines, "## 未验证的方法（缺包，不是失败）", "")
  for (m in names(pending)) {
    lines <- c(
      lines,
      sprintf("### %s", m),
      "",
      sprintf("- 状态：**待验证** —— 缺少 R 包 `%s`", paste(pending[[m]], collapse = "`, `")),
      sprintf("- 脚本：`%s`（已写好，装包后无需改代码，直接重跑即可）", SCRIPT_OF[[m]]),
      sprintf("- 期望的断言：%s", paste(EXPECTED_STAGES[[m]], collapse = " → ")),
      ""
    )
  }
  lines <- c(
    lines,
    "装好缺的包后重跑：`Rscript scripts/smoke-r-de.R`（或 `--method deseq2` 只跑那个）。",
    ""
  )
}

lines <- c(
  lines,
  "## 断言含义（为什么是这几条）",
  "",
  "1. **行数 == 过滤后基因数，且满足守恒律**：结果表少几行是最难发现的数据错误 ——",
  "   用户不会去数 5000 行。`genesAfterFilter` 与 `de.csv` 同源，所以额外断言",
  "   `行数 + 过滤掉 == 输入基因数`，这一条才真正能抓住「悄悄丢了行」。",
  "2. **9 列表头严格一致**：`ResultLoader` 逐行 zod 校验，列名错一个字母整表加载失败。",
  "3. **通过过滤的植入基因 ≥85% 显著**：这条验证的是「能不能真的找出信号」。",
  "   只验文件存在的话，一个把 logFC 全写成 0 的脚本也能通过。",
  "   分母取「通过过滤的植入基因」而不是 200：实测有 63/200 因基线表达过低被",
  "   filterByExpr 正常过滤，它们没有检验机会；但另加「≥60% 能通过过滤」防止",
  "   过滤把信号整体吃掉。",
  "   **log2 分支的分母额外收窄到 counts 分支保留的基因集**：85% 是按 filterByExpr",
  "   的基因集标定的，而 log2 分支的降级过滤（`log2 >= 1`）在本 demo 上不生效",
  "   （log2-CPM 最小值 4.48），若用全基因集作分母就变成另一个量了。",
  "   ⚠ 这是 demo 数据没有低表达基因造成的，**不是产品缺陷**：真实 RNA-seq 的",
  "   log2-CPM 能低到 -3，counts=0 的基因会被正常过滤掉。",
  "4. **de.json 与 de.csv 逐行一致**：两份产物由同一个 data.frame 写出，不一致说明写盘逻辑分叉了。",
  "5. **进度单调不减**：进度条回退会让用户以为任务卡死重跑了；主进程虽有钳制，脚本自身也不该产生回退。",
  "6. **退出码 0 且有 result**：避免「进程退出 0 但读不到结果」这种最难查的静默失败。",
  "7. **上下调方向正确**：design 若写成 `~group`（有截距）而不是 `~0+group`，对比的含义会",
  "   随 factor levels 变化，结果「看起来正常」但方向可能整体反过来。前面 6 条数值断言",
  "   全都发现不了它——只有方向断言能。",
  "8. **两个 limma-lm 分支结论一致（Jaccard ≥0.95 且 max|ΔlogFC| <0.1）**：A3 只验",
  "   「信号有没有丢」，验不出「算得对不对」。方向反了、`trend` 该开没开这类错误，",
  "   各分支的检出率可能都还是绿的，但两边的显著基因集合会明显错开。实测两个分支",
  "   在同一批基因上 Jaccard = 1.000、logFC 差 1.5e-2（归一化方式不同所致，量级正常）。",
  ""
)

if (!dir.exists(docs_dir)) dir.create(docs_dir, recursive = TRUE, showWarnings = FALSE)
report_path <- file.path(docs_dir, "SMOKE-R-DE.md")
report_text <- paste(lines, collapse = "\n")
# ★ 编码坑（实测踩过，报告里出现过 "e7.e<ee…" 这种乱码）：
#   本脚本源码是 UTF-8，但 R 在 LC_CTYPE=C 或 GBK 下会把源码里的字符串解析成
#   "unknown" 编码。此时 enc2utf8() 会把它当**本地编码**再转一次 → 中文全乱。
#   这些字节本来就是 UTF-8，正确做法是「声明为 UTF-8 + 按字节写出」，不做任何转换。
Encoding(report_text) <- "UTF-8"
con <- file(report_path, open = "wb")
writeLines(report_text, con = con, useBytes = TRUE)
close(con)

# ---- 11. 控制台汇总 ----------------------------------------------------------
cat("\n=== 断言结果 ===\n")
for (r in results) {
  cat(sprintf("[%s] %-11s %s %s\n", if (r$ok) "OK  " else "FAIL", r$method, r$id, r$title))
  cat(sprintf("        %s\n", r$actual))
}
cat("\n报告已写入：", report_path, "\n", sep = "")
if (length(pending) > 0) {
  for (m in names(pending)) {
    cat(sprintf("· %s 待验证：缺 R 包 %s（不是失败，装好后重跑即可）\n",
                m, paste(pending[[m]], collapse = ", ")))
  }
}
if (!assumption_ok) {
  cat("⚠ demo 数据的前 200 个基因不再呈现植入差异，断言 ③ 的语义已失效。\n")
  cat("  请检查 resources/demo 是否被重新生成（node scripts/gen-demo-data.mjs）。\n")
}
cat(sprintf("\n总体：%s\n", verdict))

quit(save = "no", status = if (all_ok) 0L else 1L, runLast = FALSE)
