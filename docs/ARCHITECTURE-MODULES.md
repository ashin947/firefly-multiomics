# 架构增量设计 · 多组学模块化

> 架构师 高见远 ｜ 状态：设计稿，**§1/§3/§6 已按实际实现回写**
> **覆盖 `ARCHITECTURE.md` §4（数据结构）与 §6.9（注册表）**，其余章节不变。前置事实：`registry.ts` 单层注册表已落地；`shared/modules.ts`、`shared/routes.ts`、两级路由与 5 个模块页面已实现（见 §6 状态列）。

## 0. 一句话结论

**不推翻现有设计，只加一个"分组维度"**：`AnalysisRegistry` 仍是唯一执行权威，两级分类 = `AnalysisModule` 加 `omics` 归属字段 + 一份**纯声明式** `MODULES` 目录。渲染层拿目录树，执行层仍拿扁平 `get(id)`。

| 层 | 变化 | 工作量 |
|---|---|---|
| `AnalysisModule` | +`omics?: OmicsModuleId`（默认 transcriptome） | 1 行 |
| `AnalysisRegistry` + `MODULES` | registry 加 3 方法（存量签名不变）；目录常量（已实现） | ~30 行 |
| `AnalysisRunner` / `RProcessRunner` / R 协议 / `FormFieldRenderer` / 现有 5 个已注册模块 | **零改动**（默认值兜底） | 0 |

## 1. 两级分类模型
### 1.1 两套 id 空间（已按实际实现对齐）

**关键澄清：目录层与执行层是两个 id 空间**，这是本次设计最容易出错的地方。

```ts
// 目录层（UI 分组）—— src/shared/modules.ts，已实现
export type ModuleId = 'transcriptome' | 'scrna' | 'spatial' | 'more'  // 'more' 是兜底桶，不是组学类型
export type ModuleStatus = 'available' | 'planned'                     // 客户确认只两档，无 beta

// 执行层（数据形态 + R 侧归属）—— 不含 'more'
export type OmicsModuleId = Exclude<ModuleId, 'more'> | 'proteomics' | 'metabolomics' | 'methylation'
```

`ModuleDef`（`shared/modules.ts` 的实际结构）：

```ts
export interface ModuleDef {
  id: ModuleId; name: string; tagline: string
  scale: string              // "细胞 × 基因 稀疏矩阵"，标题区右侧
  status: ModuleStatus
  analyses: AnalysisEntry[]  // ★ 不是 AnalysisMethodId[]，见 §1.3
}
export interface AnalysisEntry {
  id: string                 // ★ 模块内局部 id，可跨模块重复（cluster 在 scrna/spatial 都有）
  name: string; description: string; input: string
  status: AnalysisStatus     // available | planned
  icon: IconKey              // 字符串键，渲染层 IconByKey.tsx 映射（shared 不能依赖 MUI）
  route?: string             // 由 @shared/routes 构造，禁写裸字符串
  outputs?: string[]; note?: string
}

/** 期望输入形态（v1.1 单细胞/空转导入时用，驱动向导分派 + 校验器选择 + 内存风险预估） */
export interface OmicsDataShape {
  kind: 'dense-matrix' | 'sparse-cells' | 'matrix+coords'   // 与 §4.1 DatasetPayload variant 对齐
  featureLabel: string; observationLabel: string            // "基因"/"细胞"/"spot"
  expectedScale: { maxFeatures: number; maxObservations: number }
  requiredAuxFiles?: { key: string; label: string; extensions: string[]; required: boolean }[]
}
```

**为什么 `status` 只两档（推翻我原方案的 `beta`）**：客户只确认两档；而"部分交付"用 **模块 `available` + 部分分析 `planned`** 表达即可（`AnalysisEntry` 有自己的 status），比新增第三档更省事且已实现。单细胞 v1.1 就这样表达：模块转 `available`，只把 P0 五步改 `available`，其余留 `planned`。
### 1.2 `AnalysisModule` 的唯一改动

```ts
export interface AnalysisModule<TConfig = unknown, TRow = unknown> {
  id: AnalysisMethodId
  label: string
  omics?: OmicsModuleId          // ★ 新增。省略 = 'transcriptome'
  category: AnalysisCategory     // 类型放宽（原 'de'|'enrich'|'gsea'）
  // availability / formSchema / rScript / buildRunConfig / outputs / loadResult 全不变
}
export type AnalysisCategory =
  | 'de' | 'enrich' | 'gsea'                       // 转录组（存量）
  | 'qc' | 'dimred' | 'cluster' | 'marker'         // 单细胞
  | 'spatial-domain' | 'deconvolve'                // 空转
```

**`omics` 可选是"零破坏"的关键**：存量 `deseq2/limmaVoom/limmaNorm/oraGo/oraKegg` **一行不改**，读时 `module.omics ?? 'transcriptome'` 兜底（全项目唯一兜底点）。新模块落地后可改必填。

### 1.3 `AnalysisMethodId`（执行层，全局唯一）

```ts
export type AnalysisMethodId =
  | 'limma-voom' | 'limma-lm' | 'deseq2' | 'ora-go' | 'ora-kegg' | 'gsea-go' | 'gsea-kegg'  // 存量原样
  | 'sc-qc' | 'sc-normalize' | 'sc-hvg' | 'sc-pca' | 'sc-umap' | 'sc-cluster' | 'sc-markers' | 'sc-de'
  | 'sp-qc' | 'sp-normalize' | 'sp-cluster' | 'sp-domain' | 'sp-deconvolve'
```

不重命名成 `tx-deseq2`：会破坏已有 `project.json` 的 `analyses[].method`，需写迁移。仍用字面量联合而非 `string`：新增分析时编译器强制报错提醒补类型（成本 1 行），保住全链路 `switch` 穷尽性检查。

### 1.4 两个 id 空间的桥接（★ 最容易踩的坑）

| | `AnalysisEntry.id`（目录层） | `AnalysisModule.id`（执行层） |
|---|---|---|
| 位置 | `shared/modules.ts` | `analysis/registry.ts` |
| 唯一性 / 查找 | **模块内局部**，可跨模块重复（`cluster` 在 scrna/spatial 都有）；`findAnalysis(omicsId, analysisId)` 二元查找 | **全局唯一**（`sc-cluster` / `sp-cluster`）；`registry.get(analysisMethodId)` 一元查找 |
| 存在性 | `planned` 条目也可以有（只是没有实现） | 只有真正实现的才有 |

**规则**：`AnalysisEntry` → `AnalysisModule` 的解析必须是 **`(omicsId, analysisId)` → `AnalysisMethodId`** 的映射，**不能把 `analysisId` 直接丢给 IPC**。

原因：单细胞和空转都会有 `cluster`，若 `deg:analysis:run` 收到裸 `cluster`，`AnalysisRunner` 无法区分该跑 Seurat 还是空间聚类——**会静默跑错脚本，结果看起来正常但是错的**（和空转坐标错位同类的最坏错误）。

**为什么这个坑比"撞 key"更硬**：`AnalysisRunner` 是**按 `method` 查注册表**的，查不到直接 `E_VALIDATION` 拒绝执行。所以接单细胞时**不是给 `cluster` 加个别名就行**——`AnalysisMethodId` 要新增 `sc-cluster`，注册表也要新增对应 module，两件事必须同时做。撞 key 是渲染层问题（页面错、但能跑），注册表查不到是执行层拒绝（跑不了）。

**落地状态**：

| 措施 | 状态 | 说明 |
|---|---|---|
| `CONFIG_PAGES` 用复合 key `${omicsId}/${analysisId}` | ✅ 已改 | 原按裸 `analysisId` 做 key，`cluster`/`qc` 会**静默覆盖**（后注册的赢，不报错） |
| `AnalysisEntry` 加 `method?: AnalysisMethodId`，`run.start` 改读 `entry.method` | ⏳ **v1.1 前置条件**（未实现） | 现在只有 `de` 一个可用分析，加了也没有第二个消费者。接 `scrna/cluster` 时与"目录 id ↔ 执行 id 解耦"**同批落地**才有意义 |
| `analysisHandlers` 入口 `registry.get()` 校验 | ✅ 已生效 | 现有 `get()` 已会抛 `E_VALIDATION`，无需新增代码 |

## 2. 注册表演进
### 2.1 方案对比

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 加 `omics` 字段 + 按组过滤 | 模块多一字段，`list(omics)` 过滤 | 无，改动最小 |
| B. 新增 `ModuleRegistry` 包一层 | 外层管 Omics，内层管 Analysis | **两份真源**：`get(id)` 语义分裂；未来"跨模块共享分析"两头登记 |
| **C（采用）= A + 独立声明式目录** | 执行权威仍 `AnalysisRegistry`；`MODULES` 只存目录元信息 | 无 |

**选 C**：`ModuleDef` 除 `analyses` 外**没有任何行为**（无 `buildRunConfig`、无 `availability`、无 `loadResult`），本质是配置常量，给它"注册表"是过度设计。`AnalysisRegistry` 承担"按 id 找可执行体"，必须唯一。

### 2.2 改造前后接口对比

```ts
// 改造前：register / get / tryGet / has / list(category) / schemas(ctx)。
// list 的 category 是 'de'|'enrich'|'gsea'，无组学维度；没有"按模块取分析"的能力。
// 改造后：存量 6 方法签名与语义全不变，只新增 3 个 ——
class AnalysisRegistry {
  listByOmics(omics: OmicsModuleId): AnalysisModule[]      // 顺序按 ModuleDef.analyses 声明序
  schemasByOmics(omics: OmicsModuleId, ctx: SchemaContext,
                 availability?: AvailabilityContext): ModuleSchema[]
  omicsOf(id: AnalysisMethodId): OmicsModuleId             // 读时兜底，全项目唯一兜底点
}
```

`src/shared/modules.ts` 已实现（结构见 §1.1，此处不重复）：`MODULES` + `findModule` / `findAnalysis`，纯常量、主/渲染进程都可直接 import，**不需要 `deg:omics:list` 通道**。

> **与 `AnalysisRegistry` 的关系**：`MODULES` 是**目录**（可以有 planned 条目、可以没有实现），`registry` 是**执行体**（只有已实现的）。二者靠 §1.4 的 `(omicsId, analysisId) → AnalysisMethodId` 映射桥接。**不要试图把两者合并**——`planned` 分析永远不会有 `AnalysisModule`，这正是"两级"能同时容纳"已交付"和"未来规划"的原因。

### 2.3 加一个组学模块的完整路径（本节要证明的承诺）

以蛋白组为例，**全部改动 4 项，都不碰调度器**：

| # | 改什么 | 文件 | 碰核心？ |
|---|---|---|---|
| 1 | 把 `proteomics` 从 `more` 桶里提为独立 `ModuleDef`（`status:'available'`，填 `analyses`） | `src/shared/modules.ts` | 否（常量） |
| 2 | 新增模块实现 + `registry.register()` | `modules/proteomicsDe.ts` | 否（新文件） |
| 3 | `AnalysisMethodId` / `AnalysisCategory` 加字面量；新增 R 脚本；`AnalysisEntry` 补 `method` 映射 | `shared/types/project.ts`、`r/proteomics/run_de.R`、`shared/modules.ts` | 否（1 行 + 新文件 + 1 字段） |

**明确不改**：`AnalysisRunner`（只 `get(id)` 后跑）、`ipc/analysisHandlers`（通道不变）、`RProcessRunner`（协议不变）、`FormFieldRenderer`（schema 驱动）、`ProjectSchema`（`method` 是 `AnalysisMethodId`，自然容纳）、`router.tsx`（分析类型已在路径里，新增不用改路由）。蛋白组是 `dense-matrix` 形态，**可直接复用转录组导入器**；只有形态真变了（单细胞稀疏矩阵）才需新 Importer（见 §4）。

## 3. 路由与导航
### 3.1 路由表（`src/renderer/src/router.tsx`，待新建）

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | `WorkspacePage` | **工作台**：模块卡片墙（`MODULES` 驱动，`status` 决定徽标） |
| `/module/:omicsId` | `ModuleHomePage` | 模块首页：分析卡片网格 + 数据状态 + 最近运行 |
| `/module/:omicsId/data` | `ImportWizardPage` | 导入向导（按 `dataShape.kind` 分派子向导） |
| `/module/:omicsId/analysis/:analysisId` | `AnalysisEntryPage` | **分派器**：`import`→向导、`de`→`AnalysisConfigPage`、其余→占位页 |
| `/module/:omicsId/result/:runId` | `ResultPage` | 结果总览（`runId='latest'` 表示当前活动分析） |
| `/module/:omicsId/plot/:runId` · `/enrich/:runId` | `NotYetPage` | 独立作图/富集页未交付，路由先占位（深链不 404） |
| `/settings` · `*` | `SettingsPage` · 重定向 `/` | R 环境与诊断 · 兜底 |

**三条已落地的实现约定**（比我的原方案更好，已采纳）：
1. **地址构造函数放 `src/shared/routes.ts`，不放 renderer**。因为 `shared/modules.ts` 里每个 `AnalysisEntry.route` 也要用同一套地址；若 routes 留在 renderer，modules.ts 只能写裸字符串 → 又成两处真源，改一次漏一处就是「卡片跳 404」。现在页面里**已无任何裸 `/module/...` 字符串**。
2. **`analysisId` 进路径而非写死 `/de/config`**：新增分析不改 `router.tsx`，分派集中在 `AnalysisEntryPage`。接 GSEA 只需在它的 `CONFIG_PAGES` 加一行。
3. **`LATEST_RUN = 'latest'` 哨兵值**：表示「项目当前活动分析」，避免每处调用都先查 `activeAnalysisId`。路由用 **HashRouter**——生产期页面走 `file://`，history 模式下刷新/深链会 404，hash 是 Electron 里唯一稳的方案。

### 3.2 `planned` 与非法路由：**不 404，给引导**

```ts
// src/shared/modules.ts 已提供；页面按返回的 kind 决定渲染什么
const module = findModule(omicsId)        // undefined → 模块不存在
const entry  = findAnalysis(omicsId, analysisId)  // undefined → 分析不属于该模块
// 三级判定：模块不存在 / 模块 planned / 条目 planned 且无 route
```

| 情形 | 渲染 | 文案要点 |
|---|---|---|
| 模块 `planned`（scrna / spatial / more） | 正常渲染 `ModuleHomePage`，卡片带「规划中」徽标 | **可点进去看，不是死链**；每个条目展示 `outputs`（"这个分析会输出什么"），不给假承诺 |
| 条目 `planned` / 无 `route` / `omicsId` 不存在 | `PlannedAnalysisPage` / 模块首页内的「未找到 + 返回工作台」引导 | 展示 `outputs` + `note`（如「后端已就绪、UI 待接入」）/ 「未找到该模块，可能来自更新版本」 |
| 条目 `available` 但**前置数据不满足** | 停在占位页，不放行 | 例：空转的「空间数据导入」是 planned，若放行会得到转录组的 bulk 矩阵向导——**那是错误信息**，比 404 更糟 |
| `runId` 不存在 / 深链但项目未打开 | `ResultPage` 空态 / 重定向 `/` | 「结果不存在或已被清理」+ 重新运行 / 「请先打开或新建项目」 |

**导航骨架**：`AppShell` 用左侧 `Sidebar`（模块列表 + 状态徽标）+ 顶部面包屑，`StatusBar` 显示当前模块与数据规模（`ModuleDef.scale`，如 `细胞 × 基因 稀疏矩阵`）。`DEFAULT_OMICS_ID='transcriptome'`：工作台的新建/打开暂无「选择模块」步骤，先落转录组；等模块选择器做出来后改成读项目元数据，**调用点不用改**。

## 4. 数据契约扩展点
### 4.1 判别联合（新增 `src/shared/types/dataset-omics.ts`，**不改 `dataset.ts`**）

```ts
export interface DatasetBase {
  datasetId: string; omics: OmicsModuleId; createdAt: string; sourceFile: string
  encoding: 'utf-8' | 'gb18030'; geneIdType: GeneIdType
  featureCount: number; observationCount: number
  featureLabel: string; observationLabel: string   // 语义由 label 澄清，字段复用
  issues: Issue[]; hasBlockingIssue: boolean
}
/** ① 转录组（= 现有 DatasetSummary 的超集投影） */
export interface DenseMatrixDataset extends DatasetBase {
  kind: 'dense-matrix'; omics: 'transcriptome' | 'proteomics'
  matrixPath: string; rawMatrixPath: string; delimiter: ',' | '\t' | ';'
  features: string[]; observations: string[]
  groups: Record<string, string[]>; groupColumn: string; sampleColumn: string
  naRatio: number; allZeroFeatureCount: number; duplicateStrategy: DuplicateStrategy
}
/** ② 单细胞：矩阵永不进内存，只存磁盘引用 */
export interface SparseCellDataset extends DatasetBase {
  kind: 'sparse-cells'; omics: 'scrna'
  matrixPath: string                            // data/sparse/matrix.mtx（MatrixMarket 列压缩）
  barcodesPath: string; featuresPath: string    // data/sparse/{barcodes,features}.tsv
  sparsity: number; obsLevels?: Record<string, number>
  metadataColumns: string[]                     // orig.ident / nCount / percent.mt / seurat_clusters
}
/** ③ 空转：稠密矩阵 + 坐标 + 可选图像 */
export interface SpatialDataset extends DatasetBase {
  kind: 'matrix+coords'; omics: 'spatial'
  matrixPath: string; coordsPath: string; spots: string[]
  coordSystem: 'tissue' | 'image'   // ★ 必须显式声明，否则图比例失真
  imagePath?: string; scalefactorsPath?: string
  groupColumn?: string; groups?: Record<string, string[]>
}
export type DatasetPayload = DenseMatrixDataset | SparseCellDataset | SpatialDataset
```

### 4.2 字段归属

| 字段 | 共用 | 转录组 | 单细胞 | 空转 |
|---|---|---|---|---|
| `datasetId / omics / issues / *Count / *Label` | ✅ | | | |
| `matrixPath` | ✅ | 稠密 CSV | **稀疏 MTX** | 稠密 CSV |
| `features / observations`（全量数组） | | ✅ | ❌ 只存文件 | ✅（spot 少） |
| `groups / groupColumn` / `naRatio` / `allZeroFeatureCount` | | ✅ | ❌ 用 `metadataColumns`+`sparsity` | ✅ 可选 |
| `barcodesPath / featuresPath / sparsity / metadataColumns` · `coordsPath / coordSystem / imagePath / scalefactorsPath` | | | ✅ 前者 | ✅ 后者 |

**核心原则**：**"大"的东西一律只存磁盘路径**。单细胞 20 万 barcode × 18B ≈ 3.6 MB 纯浪费，且每次 IPC 都要序列化。同原则约束 `PlotPayload`：降维坐标可传，表达矩阵不行。
### 4.3 现在不改代码也能落地（**给工程师的免打扰承诺**）

| 阶段 | 动作 | 对工程师影响 |
|---|---|---|
| **现在（已完成）** | `shared/modules.ts` + `routes.ts` + 两级路由 + 5 个页面 + `ProjectSchema.passthrough()` | 已交付，未改动任何主进程分析链路 |
| **现在（待做，零风险）** | 只新增 2 个新文件（`types/omics.ts`、`types/dataset-omics.ts`），不修改任何现有文件 | **零影响**（无人 import） |
| T-omics-1（1 天） | 加 `omics?`、registry 3 方法、放宽 `category`、`AnalysisMethodId` 加字面量 | 改 2 文件，机械改动 |
| T-omics-2（单细胞立项） | `SparseCellDataset` + 新 Importer + 新校验器 + `r/scrna/*` | 独立目录，不动转录组链路 |

**技术依据**：`DatasetSummary` 字段是 `DenseMatrixDataset` 的**真子集**（仅 `kind/omics/features/observations/allZeroFeatureCount` 需重命名映射），适配器纯映射、无信息损失，**不需要迁移已有 `project.json`**。`ProjectSchema.dataset` 已加 `.passthrough()`，故 v1.1 加 variant **不用升 `schemaVersion`**。

## 5. 模块规划建议
**总判断**：转录组已交付（v1.0）；**单细胞价值最高但成本与技术风险也最高**，建议 v1.1 先只交付 P0 五步（质控→归一化→降维→聚类→marker），把"能跑通一条完整链路"放在"功能齐全"之前；空转依赖单细胞的 R 基础设施，顺延到 v1.2；蛋白组成本最低（复用转录组链路），可作填充项放 v1.3+。

### 5.1 模块内分析排序

| 模块 | 优先级 | 分析（id） | 说明 |
|---|---|---|---|
| 单细胞 | **P0** | 质控 `sc-qc` + 归一化/高变基因 `sc-normalize` | nFeature/nCount/percent.mt 小提琴 + 阈值；`NormalizeData`+`FindVariableFeatures`。**用户第一步，缺了模块不可用**；两者可合并一次运行 |
| 单细胞 | **P0** | PCA+UMAP/tSNE + 聚类 `sc-pca`/`sc-umap`/`sc-cluster` | 坐标回传前端画散点（§4.2：坐标可传、矩阵不传）；Louvain 聚类分辨率可调 |
| 单细胞 | **P0** | Marker 基因 `sc-markers` | `FindAllMarkers` → cluster×gene 表 + 点图/热图 |
| 单细胞 | P1 | 注释 `sc-annotate` / 差异 `sc-de` / Doublet `sc-doublet` | 注释先做**手工映射**（cluster→类型名写回 metadata），SingleR 后半；DE **伪 bulk 优先**（AggregateExpression+DESeq2），单细胞级 Wilcoxon 次之；`scDblFinder` |
| 单细胞 | P2 | 批次整合 / 亚群再聚类 / 轨迹 / 通讯 | `sc-integrate`(Harmony) / `sc-subcluster` / `sc-trajectory` / `sc-cellchat`，依赖多、稳定性差 |
| 空转 | **P0** | 质控+归一化 `sp-qc`/`sp-normalize` + 聚类 `sp-cluster` | 与单细胞同源逻辑，spot 数少可用稠密矩阵；**必须有「按 cluster 着色的空间坐标散点图」——空转的核心卖点** |
| 空转 | P1/P2 | 空间域识别 `sp-domain` / 区域间差异 `sp-de` / 去卷积 `sp-deconvolve` | BayesSpace 类；两空间域间 DE；去卷积用 cell2location/RCTD，需参考单细胞数据（**跨模块依赖**） |

### 5.2 技术风险点（必须进排期）

| 风险 | 影响 | 缓解 |
|---|---|---|
| **单细胞稀疏矩阵规模 + Seurat 内存爆炸** | 10k 细胞×20k 基因，非零 ~5% → ~10M nnz → `dgCMatrix` ~120MB；`scale.data` **是稠密的**（2000 HVG×10k 细胞 ≈ 160MB）。`plan(multisession)` 让每 worker **完整复制** Seurat 对象，4 worker×300MB=1.2GB，8 核直接 OOM | ① 矩阵**永不进 Node 内存**，只存 MTX 路径 ② `scale.data` 只对 HVG 做 ③ **强制 `future::plan('sequential')`**，`FindAllMarkers` 若用 future 则 `workers=2` 上限 ④ 运行期 `gc()` 并在 `result.summary` 上报峰值内存 |
| **单细胞 DE 语义与 bulk 不同** | 直接复用 `DEConfig` 是统计错误（伪重复） | **不复用**：`sc-de` 用独立 `SCDEConfig`（`test:'wilcox'\|'pseudobulk'`、`groupBy`、`minPct`），`TRow` 是 `SCDERow` |
| **空转坐标与矩阵对齐** | barcode 拼错一位 → 图完全错位且**不报错**（只是画错） | 导入时**强制断言** `coords.spots` 与矩阵列名集合相等，不等则 `E_DATA_SAMPLE_MISMATCH`+列差集；以 `barcodes.tsv` 为唯一真源；用真实 Visium 数据集写单测 |
| **空转坐标系统歧义 / 图像丢失** | `tissue`(µm) 与 `image`(像素，需 scalefactors) 混用→比例失真；只拷矩阵不拷图→重开图全白 | `coordSystem` 显式声明，选 `image` 时强制要求 `scalefactorsPath`；导入时**强制把图像拷进** `data/spatial/`，项目自包含 |
| **R 包体积 / 首跑耗时** | Seurat+依赖约 +300MB（安装包 2→2.5GB）；`FindAllMarkers` 在 10k 细胞×8 cluster 上 5–15 分钟 | 体积需产品决策（见 M1）；耗时走既有长任务框架（进度/取消/真 kill），进度按 cluster 上报 `emit_progress('test', i/n*100)` |

## 6. 对现有代码的影响面

> **必改** = 不改跑不通；**可选改** = 建议但不阻塞；**不改** = 明确不动。

| 文件 | 标注 | 状态 / 动作 |
|---|---|---|
| `src/shared/modules.ts` | ✅ 已完成 | `ModuleDef` + `AnalysisEntry` + `MODULES`（转录组6/单细胞7/空转7/更多3）+ `findModule` / `findAnalysis` |
| `src/shared/routes.ts` | ✅ 已完成 | `routes.*` 构造函数 + `LATEST_RUN` + `DEFAULT_OMICS_ID` |
| `src/renderer/src/router.tsx` · `App.tsx` · `components/layout/{AppShell,Sidebar}.tsx` | ✅ 已完成 | HashRouter + 两级路由 + 侧栏导航 |
| `pages/{WorkspacePage,ModuleHomePage,AnalysisEntryPage,PlannedAnalysisPage,NotYetPage}.tsx` | ✅ 已完成 | 工作台卡片墙 / 模块首页 / 分析分派器 / 规划中占位 / 未交付占位 |
| `src/main/project/ProjectSchema.ts` | ✅ 已完成 | `datasetSummarySchema.passthrough()`，18 字段仍严格校验，v1.1 variant 校验留给 `dataset-omics.ts` |
| `src/shared/types/omics.ts` + `types/dataset-omics.ts` | 新增（待做） | `OmicsModuleId` / `OmicsDataShape`（`ModuleId` 已在 modules.ts，此处只补执行层 id 与数据形态）；3 variant + `DatasetPayload` + `toDatasetPayload()` |
| `src/shared/types/project.ts` | **必改（待做）** | `AnalysisMethodId` 加字面量；新增 `AnalysisCategory`；`AnalysisSnapshot` 加可选 `omics?` |
| `src/main/analysis/registry.ts` | **必改（待做）** | `AnalysisModule` 加 `omics?`；`category` 放宽；新增 3 方法 |
| `src/shared/types/ipc-contract.ts` / `ipc/analysisHandlers.ts` / `resources/r-libs-manifest.json` | 可选改（待做） | `deg:analysis:schemas` req 加可选 `{ omics? }`；**不加 `deg:omics:list` 通道**（渲染进程直接 import `MODULES`）；manifest 加 `optionalGroups: { scrna, spatial }` |
| `src/main/analysis/modules/*.ts`（5 存量） / `shared/types/{dataset,analysis}.ts` | 不改 | 靠 `omics ?? 'transcriptome'` 兜底；`DatasetSummary` 冻结为「转录组扁平投影」；`DEConfig`/`DEResultRow` 保持转录组专用（单细胞另建 `types/sc-analysis.ts`） |
| `AnalysisRunner.ts` / `RProcessRunner.ts` / `protocol.ts` / `components/import/*` / `r/de|enrich|plot/*` | **不改** | Runner 只 `get(id)`，对组学无感知——**设计正确性的验证点**；协议与组学无关；转录组向导与链路冻结 |
| `r/common/*` | 已改动（bug 修复） | 新增 **`loader.R`**（locale 无关加载，`source` 它而非 `bootstrap.R`）；修 `deg_main` 调 `emit_error` 多传 `ctx` 的 bug。详见 `ARCHITECTURE.md` §5.6 |

**改动总量**：新增 2 文件（`omics.ts`、`dataset-omics.ts`）、修改 2 文件（`project.ts`、`registry.ts`），其余不动。
**验收标准**：`AnalysisRunner` / `RProcessRunner` / `protocol.ts` / `FormFieldRenderer` **0 改动**。

## 7. 待确认

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| M1 | 单细胞/空转 R 包（Seurat ~300MB）是否进主安装包 | 2GB → 2.5–3GB | 做**可选组件包**：主包装转录组，单细胞首用提示「安装扩展包（~300MB，联网或离线导入）」。需产品拍板 |
| M2 | 是否支持 `.h5ad`（Scanpy/Python 生态） | 影响是否引入 Python | v1.1 **只做 10x MTX 三件套 + `.h5`**；`.h5ad` 放 P2（需 zellkonverter 或 Python，成本高） |
| M3 | 空转是否只支持 Visium / 蛋白组是否真立项 | 影响坐标与图像处理；决定 catalog 是否保留 | 空转 v1.2 先只做 Visium（Slide-seq/MERFISH 形态差异大）；蛋白组已作 `planned` 占位（零成本），不做则删 8 行 |
| M4 | 跨模块共享分析（火山图/GO 富集在转录组与单细胞都要用） | 处理不好会重复注册 | 预留 `reusableIn?: OmicsModuleId[]`，注册一次多模块可见。**v1.1 暂不做**，等真出现重复再加（避免过早抽象） |
