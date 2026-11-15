# 回归清单（Regression Checklist）

一条命令回答一个问题：**我这次的改动，有没有把别的模块带坏？**

```bash
npm run regress          # L0+L1+L2+L3，默认（约 9 分钟）
```

| 命令 | 层 | 耗时 | 什么时候跑 |
| --- | --- | --- | --- |
| `npm run regress:fast` | L0 静态 + L1 单测 | ~1 分钟 | 改前端/纯函数，随手跑 |
| `npm run regress` | + L2 R 冒烟 + L3 轻走查 | **~9 分钟**（实测 8 分 45 秒 / 18 步） | **提交前默认**；改了 `r/**` 必跑 |
| `npm run regress:baseline` | L4 客户数据基线 | ~1 分钟（实测 63 秒） | 改时序算法/参数（MAD、log2、df、Fisher） |
| `npm run regress:ui` | L5 重走查 | ~15 分钟 | 改 IPC / 页面结构 / 导出链路 |
| `npm run regress:all` | 全部 | ~25 分钟 | 发版前 |

其他开关：`--layer=2`（只跑某几层）、`--only=sam`（按名字过滤）、`--list`（只列步骤）、
`--keep-going`（失败也跑完，看是不是只有一处）。

**失败即停**是故意的：一次改动的多个失败通常是同一个根因，先修第一个。
想知道"到底坏了几处"再加 `--keep-going`。

每次运行都会写 `.tmp/regress-report.json`（含每步耗时与失败项），可以直接贴进 issue。

---

## 为什么分层，而不是一个大 npm script

`save_plot.R` 改一行，理论上要把 5 万行矩阵的 R 分析跑一遍才能确认没坏 —— 但那要 25 分钟。
现实是：**没人会为了改一行注释跑 25 分钟**，于是"想起来再跑"就成了主要策略。

分层解决的是这个：90% 的改动只需要 1 分钟的 L0+L1；涉及 R 的改动跑 L2（6 分钟，
全部是真实 Rscript，不经过 Electron）；只有动界面/IPC 才需要 L5。

---

## L0 静态（~30 秒）

| id | 验什么 | 命令 | 预期 |
| --- | --- | --- | --- |
| `typecheck` | node + web 两套 TS 类型 | `npm run typecheck` | 退出码 0 |
| `lint` | ESLint，含 `no-restricted-syntax` 的架构约束（如 `process.resourcesPath` 只许出现在 `src/main/paths.ts`） | `npm run lint` | 退出码 0 |

## L1 单测（~25 秒）

| id | 验什么 | 命令 | 预期 |
| --- | --- | --- | --- |
| `unit` | 纯函数 + 服务类 + 渲染组件（jsdom），**不碰 R** | `npx vitest run` | 44 文件 / 411 条全绿 |

> 新增用例只会让数字变大。数字**变小**通常意味着有测试文件没被收集（`vitest.config.ts`
> 的 include 只收 `src/**`），不是"删了几个用例"。

## L2 R 冒烟（~6 分钟，需要 Rscript）

全部直接驱动 `Rscript`，不启动 Electron。每条都是**真 R、真数据**。

| id | 验什么 | 预期（客户验收看得到的口径） |
| --- | --- | --- |
| `r-de` | 差异分析 5 条方法：limma-voom / limma-lm / limma-lm-log2 / DESeq2 / edgeR | 脚本自报「全部通过 ✅」；A3 = 通过过滤的植入基因 ≥85% 显著，且 ≥60% 的植入基因能过 `filterByExpr` |
| `r-failures` | 失败路径契约：退出码 10/11/12/13/14 → 错误码 | 退出码**精确等于**期望值，且 `@@DEG@@ error` 行能被主进程解析 |
| `scrna-import` | 第 1 步：10x 导入 | CellRanger v2（`genes.tsv.gz`）与 v3（`features.tsv.gz`）都要认；Seurat 5 只认 v3，这条防的正是「扫描测试全绿、真跑必崩」 |
| `scrna-qc` | 第 2 步：质控/过滤 | 数据里没有线粒体基因时 `mtGeneCount=0`、不筛细胞；三个阈值全为 null **不是错误** |
| `scrna-prep` | 第 3 步：标准化/PCA/harmony | 单样本跳过 harmony；`activeReduction` 与对象里真实存在的 reduction 一致 |
| `scrna-embed` | 第 4 步：聚类/UMAP/tSNE | 聚类列名必须是 `clusters`（不是 `harmony_clusters`）；簇序是数字序 |
| `scrna-markers` | 第 5 步：Marker | `totalMarkers > 0`（`future.globals.maxSize` 静默返回 0 行那类坑）；二次筛选行数与 summary 一致 |
| `scrna-annotate` | 第 6 步：细胞注释 | 34/34；`clusters` 列必须留下；客户 `07.clusterAnn.txt`（两列、无表头）可直读 |
| `scrna-custom-plots` | 第 5 步自选基因两张图 | 22/22；两张图都 > 5 KB 且**各有一份矢量 PDF** |
| `scrna-gene-query` | 第 6 步基因查询三张图 | 25/25；`split.by` 只分面不改配色；celltype 色由簇色派生 |
| `scrna-import-object` | 「从已有 rds 继续」的四类判定 | 有降维无聚类 / 无降维 / 非 Seurat / 损坏文件，各自**不同**的错误码 |
| `timeseries-sam` | 单序列 SAM | 22/22；UTF-16LE 与 UTF-8 结果完全一致；阈值放宽后显著数只增不减；`LOC_Os03g54160` ↔ `Os03g54160` 要能匹配 |
| `timeseries-moanin` | 两组 moanin | 23/23；df ≥ nTime−1 必须报错（不是 0 个显著基因）；`max`/`min` 的 lfc 非负；同 seed 两次结果一致 |

## L3 轻走查（~2 分钟，真起 Electron）

| id | 验什么 | 预期 |
| --- | --- | --- |
| `statusbar` | 底栏 R 状态文案 | 5/5；探针未回来时只许说「正在检测 R…」，**采样序列里不许出现「未检测到」「环境待完善」** |
| `export` | 单细胞图导出按钮（第 5 步两图 + 第 6 步三图） | 16/16；导出文件与 runDir 里同名 pdf **字节一致**；删掉 pdf 后点导出要报「没有 PDF 版本」且不留空文件 |

> `export` 的字节比对是关键：只断言"导出成功"抓不到"导出了别张图"。

## L4 客户数据基线（~1 分钟，需要 `D:/ai/data`）

`npm run regress:baseline` —— 用**客户真实矩阵**跑真 R，钉住客户验收时看的数字。

| 数据 | 模式 | 基线（必须精确） |
| --- | --- | --- |
| `fpkm109.txt` | 单序列 SAM（log2、`minSamplesExpr=3`、`nperm=200`、`q≤5%`、`|Score(d)|≥2`） | **1,242**（561↑ / 681↓），过滤后 19,002 基因 |
| `fpkm109dt.txt` | 同上 | **2,835**（2,472↑ / 363↓），过滤后 18,848 基因 |
| `fpkm109dtck.txt` | 两组 moanin（df=5、`varianceCutoff=0.5`、8 簇、seed=42） | **18,740** 基因 → q<0.05 **6,844** / q<0.01 **4,328** → Fisher+lfc_max>2 **1,877**；簇大小 250/203/121/476/312/162/225/128 |
| `fpkm.txt`（4 组 × 6 时间点） | 四组 moanin（df=**4**，df=5 会被硬校验拦下） | **20,114** 基因；6 个对比 q<0.05 = 8,066 / 10,405 / 15,683 / 15,304 / 13,019 / 11,986 |

**这两份文件还兼作「组间不平衡提示」的真实用例**（改这块逻辑就拿它们验）：

| 文件 | 组 × 时间点 | 提示 |
| --- | --- | --- |
| `fpkm109dtck.txt` | `IR09_D` = A–I 共 7 期 / 21 样本；`IR09_W` = B–I 共 6 期 / 18 样本 | **触发**：全局最早是 A，`IR09_W` 从 B 起 → 点名 `IR09_W`，并说明它在 A 处是**模型外推**不是观测 |
| `fpkm.txt` | 四组都是 B–I（均衡） | 不触发（负例） |

> 提示只存在于**两组模式**（`MoaninPanel`）。单序列没有「组间」这个概念，按决定不加此提示。

> 2026-11-15 复核：四条全部精确复现。此前记录的 20,402 不是参数问题——**是文件被换过**：
> 旧版是 78 样本、含 A 期（IR09WW/ZS97WW 缺 A）；现在这份是 **73 列 = gene_id + 72 样本**，
> 四组 × 6 时间点（B/C/D/F/H/I）× 3 重复，没有 A 期。样本解析本身正确（72 个全部解析成功）。
>
> 因为踩过这一次，基线现在**先校验输入指纹**（文件字节数 + 前 16 位 sha256），
> 不匹配就先报「基线数据已变更 —— 先看文件，别去查 R 脚本」，而不是让人对着一个
> 悄悄变了的数字查半天。换数据后的重新校准方式见下。

怎么改数据目录：`DEG_DATA_DIR=<目录> npm run regress:baseline`。数据不在时整组 skip（不算失败）。

换了一份数据之后：`DEG_BASELINE_REPRINT=1 npm run regress:baseline` 会打印当前指纹
（不拦截断言），把 `scripts/baseline/timeseries.baseline.ts` 顶部的 `FINGERPRINTS`
与断言里的数字一起更新即可。指纹不匹配时整组在 `beforeAll` 就停——不会白跑几分钟的 R。

## L5 重走查（~15 分钟，真起 Electron + 真 R）

| id | 验什么 | 预期 |
| --- | --- | --- |
| `ui-de` | 差异分析完整流程 | 进度条推进、结果页数字、**中途取消后 Rscript 进程要被杀掉** |
| `ui-viz` | 绘图模块（Venn / 火山 / 热图） | png、pdf 各导一次并校验文件头 |
| `ui-gsea` | GSEA（带 logFC 排序列 + GMT 资源 + fgsea 并行后端） | 三张图 + 导出 |
| `ui-wgcna` | WGCNA 两段式 | 九张诊断图；第二次只改合并高度要**命中 TOM 缓存**且明显更快 |
| `ui-restore` | 重启后自动恢复上次项目 | 真实两次启动；重启后状态栏有物种、红条不再出现 |

---

## 已知不覆盖的地方（别误以为跑绿了就万事大吉）

1. **单细胞第 1–6 步在客户真实数据上的数字**（例如 `obj_step4.rds` 的 26,565 细胞 / 14 簇）
   不在 L2/L4 里：那需要一份 200 MB 的中间 rds，且单步要数分钟。
   L2 用的是合成数据 + 结构性断言，能证明"逻辑对"，不能证明"客户那份数据的数字没变"。
   需要时用 `npm run walkthrough:scrna-export`（它带 `obj_step4.rds`/`obj_step5.rds` 时自动跑，
   缺了会 SKIP）或手工按 DEV-NOTES 的 §记录 复核。
2. **打包产物**（`dist:dir` 之后的 `.exe`）不在 `regress` 里：`scripts/verify-packaged.mjs`
   与 `verify-r-runtime.mjs` 需要先出包，属于发版手工步骤。
3. **演示/客户机器上的字体与 locale**：`skipFonts: true` 让冒烟不依赖系统中文字体，
   所以"图上的中文是方框"这类问题只能靠真机看（`walkthrough-*` 会出图，看一眼即可）。

---

## 新增一条验证入口时怎么挂进来

在 `scripts/regress.mjs` 的 `STEPS` 数组里加一条：

```js
{
  id: 'my-check',            // 唯一、短、能 --only= 匹配
  layer: 2,                  // 0 静态 / 1 单测 / 2 R 冒烟 / 3 轻走查 / 4 客户数据 / 5 重走查
  needsR: true,              // 需要 Rscript（缺了 skip 而不是 fail）
  name: '人话说明这一条在防什么',
  cmd: process.execPath,     // 或 npm('xxx') / npx
  args: [path.join(ROOT, 'scripts', 'my-check.mjs')],
  expect: '失败时要给人看的口径/数字'   // 失败时原样打印，别写"应该通过"
}
```

`expect` 是这套东西的价值所在：失败时打出来的是**"期望 1,242 得到 1,396"**，
而不是"某个脚本退出码 1"。

> 别再往 `package.json` 里加 `smoke:xxx` 就完事 —— 那样它只会出现在 README 里，
> 不会出现在任何人的执行路径上。
