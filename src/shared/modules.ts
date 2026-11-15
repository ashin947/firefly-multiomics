/**
 * 多组学平台的模块目录 —— 侧栏、模块首页、占位页的**唯一数据源**。
 *
 * 为什么放在 shared：
 *  侧栏徽标、模块首页卡片网格、占位页的「这个分析会输出什么」三处必须描述同一件事。
 *  如果各写一份，改文案时必然漏改一处，用户就会看到「侧栏说可用、点进去说规划中」。
 *
 * 状态语义（客户确认过的两档）：
 *  - `available`：第一版真正能跑（或后端已就绪、UI 即将接入）
 *  - `planned`  ：后续版本提供，界面上要看得见但不给假承诺
 */

import { routes } from './routes'

export type ModuleId = 'transcriptome' | 'viz' | 'scrna' | 'spatial' | 'more'

/** 模块可用性 */
export type ModuleStatus = 'available' | 'planned'

/** 分析条目可用性（与模块状态同构，便于徽标组件统一处理） */
export type AnalysisStatus = 'available' | 'planned'

/**
 * 图标键。
 * shared 层不能依赖 MUI（会污染主进程构建），因此只存字符串，
 * 由渲染进程的 `components/common/IconByKey.tsx` 映射到具体图标组件。
 */
export type IconKey =
  | 'table'
  | 'diff'
  | 'chart'
  | 'enrich'
  | 'gsea'
  | 'network'
  | 'filter'
  | 'cluster'
  | 'label'
  | 'marker'
  | 'subset'
  | 'trajectory'
  | 'communication'
  | 'venn'
  | 'violin'
  | 'survival'
  | 'spatial-import'
  | 'spatial-qc'
  | 'spatial-cluster'
  | 'spatial-svg'
  | 'spatial-region'
  | 'deconv'
  | 'neighborhood'
  | 'more'

/** 一条分析能力 */
export interface AnalysisEntry {
  id: string
  name: string
  /** 一句话说明（卡片副标题） */
  description: string
  /** 输入要求（卡片底部小字） */
  input: string
  status: AnalysisStatus
  icon: IconKey
  /** 已接入页面的路由（`available` 且已接 UI 时才有） */
  route?: string
  /** 占位页展示：这个分析会输出什么 */
  outputs?: string[]
  /** 占位页补充说明（例如「后端已就绪、UI 待接入」） */
  note?: string
}

/** 一个组学模块 */
export interface ModuleDef {
  id: ModuleId
  name: string
  /** 侧栏与标题区的一句话定位 */
  tagline: string
  /** 数据规模提示（标题区右侧） */
  scale: string
  status: ModuleStatus
  /**
   * 该模块会不会在项目里留下「运行记录」（`project.json` 的 `analyses`）。
   *
   * 目前只有转录组会（差异分析）。绘图模块是**即时出图**，不产生任何运行记录 ——
   * 如果首页不加区分地去读 `meta.analyses`，绘图模块会把转录组跑过的差异分析
   * 列成自己的「最近任务」，那是比空态更糟的错误信息。
   * 不写默认 false：新增模块时「我没记录」是更安全的默认。
   */
  tracksRuns?: boolean
  analyses: AnalysisEntry[]
}

/**
 * 路由约定（与 docs/ARCHITECTURE-MODULES.md §3.1 一致）：
 *  - 数据导入：`/module/<id>/data`
 *  - 分析配置：`/module/<id>/analysis/<analysisId>`（analysisId 决定分析类型）
 *  - 结果总览：`/module/<id>/result/<runId>`（`latest` = 当前活动分析）
 *
 * 地址一律通过 `@shared/routes` 的构造函数生成，**不在本文件写裸字符串** ——
 * 否则改路由要同时改这里和页面里的 navigate()，必然漏改一处。
 *
 * 这里只写「点下去真的会到达」的条目；未接 UI 的条目不要给 route，
 * 由 AnalysisCardGrid 兜底到 `/module/<id>/analysis/<analysisId>`，
 * 再由 AnalysisEntryPage 分派到占位页（规划中 / 后端就绪但 UI 待接入）。
 */

export const MODULES: ModuleDef[] = [
  {
    id: 'transcriptome',
    name: '转录组',
    tagline: 'bulk RNA-seq 差异表达与功能富集',
    scale: '表达矩阵 × 分组表',
    status: 'available',
    tracksRuns: true,
    analyses: [
      {
        id: 'import',
        name: '数据导入与质控',
        description: '表达矩阵 + 分组表，13 项格式校验，重复基因强制确认',
        input: 'CSV / TSV / Excel + 分组表',
        status: 'available',
        icon: 'table',
        route: routes.data('transcriptome')
      },
      {
        id: 'de',
        name: '差异表达分析',
        description: 'limma-voom / DESeq2，输出 logFC、P 值、FDR',
        input: '已清洗矩阵 + ≥2 组分组',
        status: 'available',
        icon: 'diff',
        route: routes.analysis('transcriptome', 'de')
      },
      {
        id: 'timeseries',
        name: '时序转录组分析',
        description: '多时间点差异：单序列随时间变化，或两组（ck/dt）× 多时间点',
        input: '表达矩阵 + 时间点信息（如 1d / 3d / 5d / 7d）',
        /**
         * 两种模式都接好了才敢标 available：
         *   · 单序列 → SAM One class timecourse + 自选基因曲线
         *   · 两组 × 时间 → moanin 样条模型 + 五种 lfc + Fisher 合并 + 聚类
         */
        status: 'available',
        icon: 'trajectory',
        route: routes.timeseries('transcriptome'),
        outputs: [
          '单序列模式：各时间点 vs 基线的差异基因表、时序显著基因、表达趋势聚类与趋势图',
          '两组模式：每个时间点的 ck vs dt 差异表、组间差异随时间的交互效应',
          '两种模式都输出差异基因数随时间的概览图，用于判断响应强度与拐点'
        ],
        note: '单序列（SAM）与两组×时间（moanin）两种模式均已可用，含自选基因曲线与聚类。'
      },
      {
        id: 'plot',
        name: '结果与可视化',
        description: '火山图 + 阈值联动；热图 / PCA / 箱线图与 R 导出在后续版本提供',
        input: '一次差异分析结果',
        status: 'available',
        icon: 'chart',
        // 火山图与阈值联动当前就在结果总览页里，因此这张卡落到结果页
        // （而不是一个写着「尚未接入」的空白页）—— 点了要有东西看。
        route: routes.result('transcriptome'),
        note: '当前可视化能力集中在结果总览页：火山图、统计卡与结果表共用同一套阈值。独立作图页（热图 / PCA / 箱线图与 300dpi 导出）将在后续版本接入。'
      },
      {
        id: 'enrich',
        name: '富集分析',
        description: '用背景基因集做 ORA（GO / KEGG），支持人类 / 小鼠 / 水稻与自定义背景文件',
        input: '显著基因列表（可手填）+ 物种注释库或自定义背景文件',
        status: 'available',
        icon: 'enrich',
        route: routes.enrich('transcriptome'),
        outputs: [
          'GO 三大类（BP / CC / MF）富集表：term、count、geneRatio、p.adjust',
          'KEGG 通路富集表（需联网下载注释，离线时给出明确提示）',
          '气泡图：颜色映射 -log10(p)，大小映射基因数，GO 按 ontology 分面'
        ],
        note: '内置人类 / 小鼠 / 水稻注释库；也支持导入 gene<TAB>term 格式的自定义背景文件（如水稻 R498 注释）。'
      },
      {
        id: 'gsea',
        name: 'GSEA',
        description: '全基因排序 + 基因集富集，不依赖阈值切分',
        input: '差异结果文件（基因列 + logFC 列）+ MSigDB 基因集或自定义 GMT',
        status: 'available',
        icon: 'gsea',
        route: routes.gsea('transcriptome'),
        outputs: [
          '基因集富集表：ES、NES、p 值、校正 p、leading-edge 基因',
          '按 p 值取前 N 个基因集的富集曲线总览（可调 N）',
          '指定通路的详情图（ES 曲线 + 基因位置条 + 排序指标）'
        ],
        note: '内置 MSigDB 2024.1（人类 Hallmark / KEGG / Reactome，小鼠 Hallmark / Reactome）；也支持导入自定义 .gmt。GSEA 需要 logFC 排序，只给基因名跑不了。'
      },
      {
        id: 'wgcna',
        name: 'WGCNA 共表达网络',
        description: '先定软阈值 β，再建网络：模块识别与性状关联',
        input: '表达矩阵（行=基因，列=样本，≥8 样本）+ 可选性状表',
        status: 'available',
        icon: 'network',
        route: routes.wgcna('transcriptome'),
        outputs: [
          '软阈值拟合表 + 3 张质控图（样本聚类树、无标度拟合、平均连接度）',
          '9 张网络诊断图（基因聚类树、模块色条、TOM 热图、模块-性状热图等）',
          '模块划分表：每个基因归属哪个模块、各模块基因数',
          '模块-性状相关表：相关系数、p 值、FDR'
        ]
      }
    ]
  },
  {
    /**
     * 绘图模块。
     *
     * 与转录组并列而不是塞进转录组的「结果与可视化」：这三张图的输入是
     * **用户手头的任意数据**（一张表达矩阵、一份临床表、几列基因列表），
     * 不依赖项目里有没有跑过差异分析。放进转录组会让人以为必须先做差异分析。
     *
     * 排在这里（紧跟转录组）而不是排在「更多」前面：它是 `available` 的，
     * 与另一个 `available` 的模块挨着，「可用 / 规划中」不会被隔开。
     */
    id: 'viz',
    name: '绘图',
    tagline: '通用作图画板：集合、分布与生存',
    scale: '基因列表 / 表达矩阵 × 分组',
    status: 'available',
    analyses: [
      {
        id: 'venn',
        name: 'Venn 图',
        description: '多组基因列表求交集，2~7 组；支持填充、数量与占比标注',
        input: '每组一列基因列表（粘贴）',
        status: 'available',
        icon: 'venn',
        route: routes.venn('viz'),
        outputs: [
          'Venn 图：各交集区域标注基因数（可选占比）',
          '交集明细表：每个区域的基因列表',
          'PNG / PDF 导出，尺寸与分辨率可选'
        ],
        note: '2~5 组用经典椭圆 / 圆形排布；6~7 组改用 ggVennDiagram 的矩形布局（经典椭圆排布在 6 组以上无法保证每个交集都被画出）。'
      },
      {
        id: 'violin',
        name: '分面小提琴图',
        description: '多基因 × 多组分布对比，自动标注组间 Wilcoxon / t 检验 FDR',
        input: '表达矩阵 + 分组表（组数不限）',
        status: 'available',
        icon: 'violin',
        route: routes.violin('viz'),
        outputs: [
          '分面小提琴 / 箱线 / 蜂群图：每个基因一个分面，每组一个颜色',
          '组间两两比较的显著性括号与 FDR 标注',
          '每组的样本量、均值与检验结果表'
        ],
        note: 'FDR 在所有基因 × 所有两两比较上统一做 BH 校正，而不是每个基因各校正一次 —— 一张图里有几十个基因时，后者会明显高估显著性。'
      },
      {
        id: 'survival',
        name: '生存曲线',
        description: 'Kaplan-Meier 曲线，可按分组列或按基因表达高低分组',
        input: '随访表（time / status / 分组）+ 可选表达矩阵',
        status: 'available',
        icon: 'survival',
        route: routes.survival('viz'),
        outputs: [
          'KM 生存曲线（含置信区间与 log-rank P 值）',
          'risk table：各时间点每组剩余人数',
          '按基因表达中位数 / 三分位 / 最优截断分组的 High vs Low 曲线'
        ],
        note: '底层是 survminer::ggsurvplot，配色支持 ggsci（lancet / jco / npg …）、RColorBrewer 与自定义色值。'
      }
    ]
  },
  {
    id: 'scrna',
    name: '单细胞',
    tagline: '单细胞转录组分析',
    scale: '细胞 × 基因 稀疏矩阵',
    status: 'planned',
    analyses: [
      {
        id: 'pipeline',
        name: '单细胞分析流程',
        description:
          '导入 10x 矩阵构建 Seurat 对象 → 质控 → 标准化/PCA → 聚类 → Marker → 注释 → 下游分析',
        input: '10x 矩阵目录（CellRanger v2 / v3）',
        /*
         * ★ 这里刻意只放**一张**卡片（原先是 qc / cluster / annotate / marker 四张）。
         *
         * 那四个步骤是**线性依赖**的：没有导入就没有对象，没有聚类就没有 marker。
         * 拆成四张卡会让人以为可以点「聚类」直接开始，点进去只会得到「请先导入数据」。
         * 一张卡 + 页面内的步骤栏，才和「线性流程」这个事实对齐。
         *
         * status 仍是 planned：内核目前只做了第 1 步，徽标必须说实话 ——
         * 标成 available 就等于承诺了一条还跑不通的链路。
         */
        status: 'planned',
        icon: 'cluster',
        route: routes.scrnaPipeline('scrna'),
        outputs: [
          'Seurat 对象（obj_step1.rds，可随时下载）',
          '每样本细胞数统计表与柱状图',
          '后续：质控 / 聚类 / 注释 / 拟时序 等逐步接入'
        ]
      }
    ]
  },
  {
    id: 'spatial',
    name: '空转',
    tagline: '空间转录组分析',
    scale: '表达矩阵 + 空间坐标',
    status: 'planned',
    analyses: [
      {
        id: 'import',
        name: '空间数据导入',
        description: '表达矩阵、坐标文件与组织切片图像对齐',
        input: '矩阵 + 坐标 + 切片图',
        status: 'planned',
        icon: 'spatial-import',
        outputs: ['切片图上叠加的空间点位图', '点位-坐标对齐校验结果']
      },
      {
        id: 'qc',
        name: 'QC 与归一化',
        description: '空间点质控与标准化',
        input: '空间表达矩阵',
        status: 'planned',
        icon: 'spatial-qc',
        outputs: ['点位质控指标分布', '标准化前后对比']
      },
      {
        id: 'cluster',
        name: '空间聚类',
        description: '结合表达与空间邻域信息的聚类',
        input: '标准化矩阵 + 坐标',
        status: 'planned',
        icon: 'spatial-cluster',
        outputs: ['空间聚类图（切片上按簇着色）', '各簇标记基因']
      },
      {
        id: 'svg',
        name: '空间可变基因',
        description: '识别随空间位置显著变化的基因',
        input: '空间聚类结果',
        status: 'planned',
        icon: 'spatial-svg',
        outputs: ['空间可变基因表（含空间自相关统计量）', 'Top 基因空间表达热图']
      },
      {
        id: 'region',
        name: '区域注释',
        description: '组织区域划分与注释',
        input: '空间聚类 + 参考标记',
        status: 'planned',
        icon: 'spatial-region',
        outputs: ['区域划分图', '区域-细胞类型对应表']
      },
      {
        id: 'deconv',
        name: '反卷积',
        description: '从空间混样中估计细胞类型比例',
        input: '空间矩阵 + 单细胞参考',
        status: 'planned',
        icon: 'deconv',
        outputs: ['每个点位的细胞类型比例', '比例空间分布图']
      },
      {
        id: 'neighborhood',
        name: '邻域富集',
        description: '细胞类型空间共现与邻域偏好分析',
        input: '区域注释结果',
        status: 'planned',
        icon: 'neighborhood',
        outputs: ['细胞类型邻域富集矩阵', '显著共现对列表']
      }
    ]
  },
  {
    id: 'more',
    name: '更多',
    tagline: '蛋白组、代谢组、甲基化等模块持续接入',
    scale: '按模块定义',
    status: 'planned',
    analyses: [
      {
        id: 'proteomics',
        name: '蛋白组',
        description: '质谱定量矩阵的差异蛋白与通路分析',
        input: '蛋白定量矩阵 + 样本分组',
        status: 'planned',
        icon: 'more',
        outputs: ['差异蛋白表', '火山图', '通路富集结果']
      },
      {
        id: 'metabolomics',
        name: '代谢组',
        description: '代谢物定量矩阵的差异分析与通路映射',
        input: '代谢物定量矩阵 + 分组',
        status: 'planned',
        icon: 'more',
        outputs: ['差异代谢物表', '火山图 / 热图', '代谢通路映射']
      },
      {
        id: 'methylation',
        name: '甲基化',
        description: '差异甲基化位点与区域分析',
        input: '甲基化 β 值矩阵 + 分组',
        status: 'planned',
        icon: 'more',
        outputs: ['差异甲基化位点表', 'DMR 区域注释', '甲基化热图']
      }
    ]
  }
]

/** 按 id 取模块（找不到返回 undefined，调用方负责渲染「模块不存在」） */
export function findModule(moduleId: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === moduleId)
}

/** 按 id 取分析条目 */
export function findAnalysis(moduleId: string, analysisId: string): AnalysisEntry | undefined {
  return findModule(moduleId)?.analyses.find((a) => a.id === analysisId)
}

/** 模块状态的徽标文案 */
export const MODULE_STATUS_LABELS: Record<ModuleStatus, string> = {
  available: '可用',
  planned: '规划中'
}
