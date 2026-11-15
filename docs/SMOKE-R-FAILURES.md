# R 失败路径契约验证报告

> 本文件由 `scripts/smoke-r-failures.mjs` 自动生成，请勿手工编辑。

- 生成时间：2026-11-15T12:21:09.486Z
- 平台：win32 x64
- Rscript：`D:\ai\shengxin\resources\runtime\R\bin\Rscript.exe`
- R 版本：Rscript (R) version 4.3.2 (2023-10-31)
- 执行方式：真实 `RProcessRunner`（同样的 `--vanilla` / `--config` / `buildRenv()` / cwd=runDir）
- **总体结论：全部通过 ✅**（通过 6 / 共 6）

## 断言口径

每个场景同时断言四件事，全部精确相等（不做「非 0 即可」这种安慰剂）：

1. 进程退出码 == 期望值
2. `events.jsonl` 里恰好 1 条 `type=error` 协议行
3. 协议行里的 `code` == 期望错误码（R 侧有没有把 code 发出来）
4. 主进程翻译出的 `error.code` == 期望错误码（能不能到达主进程，用户最终看到的就是它）

## 结果

| # | 场景 | 入口脚本 | 期望 exit | 实际 exit | 期望 code | 实际 code | 协议行 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 缺必需包（limma 不可用） | `fixtures/pkg-missing.R（夹具）` | 12 | 12 | E_RT_PKG_MISSING | E_RT_PKG_MISSING | 1 条 | ✅ |
| 2 | config 缺字段（contrast） | `de/run_limma_voom.R` | 11 | 11 | E_VALIDATION | E_VALIDATION | 1 条 | ✅ |
| 3 | 每组只有 1 个样本 | `de/run_limma_voom.R` | 13 | 13 | E_DATA_GROUP_TOO_SMALL | E_DATA_GROUP_TOO_SMALL | 1 条 | ✅ |
| 4 | 分组表里有矩阵没有的样本 | `de/run_limma_voom.R` | 13 | 13 | E_DATA_SAMPLE_MISMATCH | E_DATA_SAMPLE_MISMATCH | 1 条 | ✅ |
| 5 | 写盘失败（de.csv.tmp 被同名目录占用） | `de/run_limma_voom.R` | 14 | 14 | E_IO_PERMISSION | E_IO_PERMISSION | 1 条 | ✅ |
| 6 | 脚本内 stop() | `fixtures/boom.R（夹具）` | 10 | 10 | E_R_GENERIC | E_R_GENERIC | 1 条 | ✅ |

## 环境提示

- limma 按 **app 的库路径**（`R_LIBS_SITE`/`R_LIBS_USER` = 应用自己的目录）可见：**是**
- limma 按 **R 默认库路径**可见：**是**

> limma 可见 → 失败场景走真正的 `de/run_limma_voom.R`，不是夹具。

## 每个场景是怎么构造出来的

| 场景 | 构造方式 |
| --- | --- |
| 缺必需包 | 夹具把一个「残缺 limma」（只有 DESCRIPTION、无 Meta/package.rds）顶到 `.libPaths()` 最前，`deg_ensure_pkgs()` 遂报缺包 |
| config 缺字段 | config JSON 里删掉 `contrast` → `deg_param_required()` 抛 `E_VALIDATION` |
| 每组 1 个样本 | 矩阵只留 S01(Tumor) + S13(Normal)，`deg_de_prepare()` 的组内样本数检查触发 |
| 样本不匹配 | 分组表多一行 `S99`（矩阵里没有）→ `deg_validate_samples()` 触发 |
| 写盘失败 | runDir 里预建一个名为 `de.csv.tmp` 的**目录**，`deg_write_csv()` 的 fwrite 必然失败 |
| 脚本内 stop | 夹具直接 `stop("boom")` → `E_R_GENERIC` / 10 |
