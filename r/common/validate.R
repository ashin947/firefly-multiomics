# =============================================================================
# r/common/validate.R —— 入参校验与统一错误抛出
#
# 所有「可预期的用户错误」都用 deg_stop() 抛：
#   - 携带 errors.ts 的错误码（主进程据此产出中文文案）
#   - 携带退出码（§5.5：11=配置非法，12=缺包，13=数据不满足前置条件，14=写盘失败）
#
# 绝不要在 R 侧写面向用户的中文长文案（§11.2 第 7 条）——文案统一由主进程产出。
# =============================================================================

#' 抛出一个 deg_error 条件（deg_main 的 tryCatch 会捕获并 emit_error）
deg_stop <- function(code, message, detail = "", status = 10L) {
  cond <- structure(
    class = c("deg_error", "error", "condition"),
    list(
      message = as.character(message),
      call = sys.call(-1),
      code = as.character(code),
      detail = if (is.null(detail)) "" else as.character(detail),
      status = as.integer(status)
    )
  )
  stop(cond)
}

#' 断言
deg_assert <- function(cond, code, message, status = 10L) {
  ok <- isTRUE(tryCatch(all(cond), error = function(e) FALSE))
  if (!ok) deg_stop(code, message, status = status)
  invisible(TRUE)
}

#' 断言取值在允许集合内
deg_assert_in <- function(value, allowed, name, status = 11L) {
  if (length(value) != 1 || is.na(value) || !(value %in% allowed)) {
    deg_stop(
      "E_VALIDATION",
      paste0("invalid value for '", name, "': ", paste(value, collapse = ","),
             " (allowed: ", paste(allowed, collapse = ", "), ")"),
      status = status
    )
  }
  invisible(TRUE)
}

#' 检查必需的 R 包，缺包直接 exit 12（主进程映射 E_RT_PKG_MISSING）
deg_ensure_pkgs <- function(pkgs) {
  if (length(pkgs) == 0) return(invisible(TRUE))
  missing <- pkgs[!vapply(pkgs, function(p) requireNamespace(p, quietly = TRUE), logical(1))]
  if (length(missing) > 0) {
    deg_stop(
      "E_RT_PKG_MISSING",
      paste0("missing R packages: ", paste(missing, collapse = ", "),
             " (R home: ", R.home(), ")"),
      # detail 里同时给 R 安装目录与库搜索路径：只看日志也能判断「连的是哪份 R」——
      # 客户两次撞在「设置里指定了自定义 R，那份没装包」，而界面上看不出这一点。
      detail = paste0("R home: ", R.home(),
                      " | Rscript: ", file.path(R.home("bin"), "Rscript"),
                      " | libPaths: ", paste(.libPaths(), collapse = " | ")),
      status = 12L
    )
  }
  invisible(TRUE)
}

#' 校验物种
#'
#' `allowed` 由各模块显式传入，不集中写死：差异分析只支持 human / mouse
#' （因为 r/common/de.R 的 deg_de_gene_names 只查 org.Hs / org.Mm，
#' 放水稻进来会让水稻基因名被当成人类 Entrez 去查，静默得到一串 NA），
#' 而富集分析的 rice 走自定义注释表、压根不需要 OrgDb。集中写死会让
#' 「富集支持水稻」被迫连累「差异分析也声称支持水稻」。
deg_validate_species <- function(species, allowed = c("human", "mouse")) {
  deg_assert_in(species, allowed, "species")
  invisible(TRUE)
}

deg_validate_fdr_method <- function(method) {
  deg_assert_in(method, c("BH", "BY", "holm", "none"), "fdrMethod")
  invisible(TRUE)
}

#' 校验对比（实验组 vs 对照）
deg_validate_contrast <- function(contrast, groups) {
  if (is.null(contrast) || is.null(contrast$numerator) || is.null(contrast$denominator)) {
    deg_stop("E_VALIDATION", "contrast.numerator / contrast.denominator are required", status = 11L)
  }
  num <- as.character(contrast$numerator)
  den <- as.character(contrast$denominator)
  if (identical(num, den)) {
    deg_stop("E_VALIDATION", "contrast numerator and denominator must differ", status = 11L)
  }
  if (!is.null(groups)) {
    for (g in c(num, den)) {
      if (!g %in% names(groups)) {
        deg_stop("E_DATA_SAMPLE_MISMATCH",
                 paste0("group not found in groups table: ", g,
                        " (available: ", paste(names(groups), collapse = ", "), ")"),
                 status = 13L)
      }
      if (length(groups[[g]]) < 2) {
        deg_stop("E_DATA_GROUP_TOO_SMALL",
                 paste0("group '", g, "' has only ", length(groups[[g]]),
                        " sample(s); need >= 2 to estimate within-group variance"),
                 status = 13L)
      }
    }
  }
  invisible(TRUE)
}

#' 校验表达矩阵列与分组样本是否一一对应
deg_validate_samples <- function(matrixSamples, groupSamples) {
  missingInMatrix <- setdiff(groupSamples, matrixSamples)
  missingInGroups <- setdiff(matrixSamples, groupSamples)
  if (length(missingInMatrix) > 0 || length(missingInGroups) > 0) {
    deg_stop(
      "E_DATA_SAMPLE_MISMATCH",
      paste0(
        "sample mismatch: not in matrix = [", paste(utils::head(missingInMatrix, 20), collapse = ", "),
        "]; not in groups = [", paste(utils::head(missingInGroups, 20), collapse = ", "), "]"
      ),
      status = 13L
    )
  }
  invisible(TRUE)
}

#' counts 整数性检查（DESeq2 前置条件）
#' @param status 13 表示「数据不满足前置条件」
deg_assert_integer_counts <- function(mat, status = 13L) {
  vals <- as.matrix(mat)
  finite <- vals[is.finite(vals)]
  if (length(finite) == 0) {
    deg_stop("E_DATA_EMPTY", "counts matrix contains no finite values", status = status)
  }
  if (any(finite < 0)) {
    deg_stop("E_DATA_NOT_INTEGER",
             paste0("counts contain ", sum(finite < 0), " negative value(s)"),
             status = status)
  }
  bad <- sum(abs(finite - round(finite)) > 1e-8)
  if (bad > 0) {
    deg_stop("E_DATA_NOT_INTEGER",
             paste0("counts contain ", bad, " non-integer value(s); DESeq2 requires raw integer counts"),
             detail = "consider using limma-voom instead",
             status = status)
  }
  invisible(TRUE)
}

#' 通用配置校验（各 run_*.R 开头调用）
#'
#' `speciesAllowed` 透传给 deg_validate_species；富集分析的 run_ora.R 显式放宽到含 rice。
deg_validate_common <- function(ctx, speciesAllowed = c("human", "mouse")) {
  deg_validate_species(deg_param(ctx, "species", "human"), speciesAllowed)
  deg_validate_fdr_method(deg_param(ctx, "fdrMethod", "BH"))
  invisible(TRUE)
}
