# =============================================================================
# r/probe/check_runtime.R —— R 环境能力自检（ARCHITECTURE §6.1 / T04）
#
# 入参（run_config.json 的 params）：
#   requiredPackages : character()  必需包名
#   speciesLibs      : list(human="org.Hs.eg.db", mouse="org.Mm.eg.db")
#   fontFamily       : "DEGSans"
#
# 出参（result.summary = RuntimeProbeResult）：
#   rVersion / rArch / platform / packages[] / speciesLibs / fontFamilies[]
#   + libPaths[] / rHome（诊断用）
#
# 说明：本脚本**不**因为缺包而失败——缺包是「自检结果」，由主进程决定如何呈现。
#       只有 R 本身跑不起来才会 exit 非 0。
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

deg_main("probe/check_runtime.R", function(ctx) {
  emit_progress("read", 5, "collecting R environment info")

  required <- as.character(deg_param(ctx, "requiredPackages", character(0)))
  speciesLibs <- deg_param(ctx, "speciesLibs",
                           list(human = "org.Hs.eg.db", mouse = "org.Mm.eg.db"))
  if (!is.list(speciesLibs)) speciesLibs <- as.list(speciesLibs)

  # ---- 1. R 自身信息 --------------------------------------------------------
  rVersion <- as.character(getRversion())
  rArch <- paste(R.version$arch, R.version$os, sep = "-")
  platform <- as.character(.Platform$OS.type)

  emit_log("info", paste0("R ", rVersion, " (", rArch, ")"))

  # ---- 2. 必需包 ------------------------------------------------------------
  probe_one <- function(pkg, required_flag) {
    installed <- suppressWarnings(requireNamespace(pkg, quietly = TRUE))
    version <- NULL
    if (installed) {
      version <- tryCatch(
        as.character(utils::packageVersion(pkg)),
        error = function(e) NA_character_
      )
      if (is.na(version)) version <- NULL
    }
    list(
      name = pkg,
      version = version,
      ok = isTRUE(installed),
      required = isTRUE(required_flag)
    )
  }

  # 物种库：清单里 required 标记为 true 的会在 required 里出现，
  # 这里单独探测以便 UI 分别点亮 Human / Mouse 两盏灯。
  speciesPkgs <- unique(unlist(lapply(speciesLibs, as.character), use.names = FALSE))
  speciesPkgs <- speciesPkgs[!is.na(speciesPkgs) & nzchar(speciesPkgs)]
  allPkgs <- unique(c(required, speciesPkgs))

  total <- max(1L, length(allPkgs))
  packages <- vector("list", length(allPkgs))
  for (i in seq_along(allPkgs)) {
    pkg <- allPkgs[[i]]
    packages[[i]] <- probe_one(pkg, pkg %in% required)
    pct <- 10 + 70 * i / total
    emit_progress("test", pct, paste0("checking package: ", pkg))
  }

  # ---- 3. 物种库可用性 ------------------------------------------------------
  speciesOk <- function(pkg) {
    if (is.null(pkg) || is.na(pkg) || !nzchar(pkg)) return(FALSE)
    isTRUE(suppressWarnings(requireNamespace(pkg, quietly = TRUE)))
  }
  speciesStatus <- list(
    human = speciesOk(speciesLibs[["human"]]),
    mouse = speciesOk(speciesLibs[["mouse"]])
  )

  # ---- 4. 字体 --------------------------------------------------------------
  emit_progress("plot", 85, "checking CJK font")
  fontFamilies <- deg_font_families()
  if (!"DEGSans" %in% fontFamilies) {
    # 再尝试注册一次（bootstrap 里可能因为 sysfonts 未装而失败）
    invisible(tryCatch(deg_register_fonts(), error = function(e) NULL))
    fontFamilies <- unique(c(fontFamilies, deg_font_families()))
  }

  # ---- 5. 汇总 --------------------------------------------------------------
  emit_progress("write", 95, "writing probe summary")

  summary <- list(
    rVersion = rVersion,
    rArch = rArch,
    platform = platform,
    packages = packages,
    speciesLibs = speciesStatus,
    fontFamilies = as.list(fontFamilies),
    libPaths = as.list(.libPaths()),
    rHome = R.home()
  )

  missingCount <- sum(!vapply(packages, function(p) isTRUE(p$ok), logical(1)))
  emit_log("info", paste0("probe finished: ", length(allPkgs) - missingCount, "/",
                          length(allPkgs), " packages available"))

  emit_result(summary)
})
