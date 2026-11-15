# Firefly

多组学分析桌面客户端。双击安装、离线运行，**不需要自己装 R**——R 4.3.2 运行时和全部依赖包都在安装包里。

面向不写代码的科研用户：导入数据、点按钮、拿结果表和可直接投稿的矢量图。

## 下载安装

到 [Releases](../../releases) 下载 `Firefly-Setup-1.0.0.exe`（约 472 MB），双击安装。

- 不需要管理员权限
- 不需要预装 R
- 装完桌面出现 Firefly 快捷方式

安装包校验（SHA256）：

```
848ab365bb710c3835fc0f369ce03fb31f19b611393c31cee59a3493907ccdbb
```

## 功能模块

| 模块 | 内容 |
| --- | --- |
| 转录组差异表达 | limma / limma-voom / DESeq2 / edgeR / wilcox；火山图、热图、PCA、箱线图 |
| 富集分析 | GO / KEGG 富集，GSEA；支持自定义背景基因集（gmt） |
| WGCNA | 共表达网络构建、模块识别、模块-性状关联 |
| 生存分析 | KM 曲线、单因素/多因素 Cox |
| 单细胞 | 第 1–6 步：导入与对象构建、质控过滤、标准化/PCA/harmony、聚类/UMAP/tSNE、Marker 基因、细胞注释 |
| 时序分析 | 单序列（SAM timecourse）与两组×时间（moanin 样条模型），含自选基因曲线与趋势聚类 |

所有图**同时输出 PNG 与矢量 PDF**，PDF 可直接用于投稿（字体已嵌入，放大不糊）。

## 系统要求

- Windows 10 1803 或更新（需要系统自带 `tar.exe`）
- x64
- 磁盘约 2 GB（安装后）

## 从源码构建

```bash
npm install
npm run build          # 类型检查 + 打包前端
npm run dist           # 生成安装包到 dist/
```

内置 R 运行时不在版本库里（约 1.8 GB），需要自行准备并放到 `resources/runtime/R/`。
构建前的验证入口见 `docs/REGRESSION.md`：

```bash
npm run regress:fast      # 静态检查 + 单测，约 43 秒
npm run regress           # 加 R 冒烟与轻走查
npm run regress:baseline  # 客户数据基线（带输入文件指纹校验）
```

## 目录说明

```
src/main        Electron 主进程：IPC、R 子进程调度、文件与项目存储
src/renderer    界面（React + MUI）
r/              R 分析内核，按模块分目录，由主进程以子进程方式调用
scripts/        冒烟测试、走查脚本、回归清单
docs/           PRD、架构设计、回归说明
```

## 已知限制

- **单细胞第 7 步（拟时序/分化潜能）未实现**：`monocle2` 与 `igraph 2.x` 冲突、`CytoTRACE` 需源码编译且依赖 PyTorch，在本项目的内置 R 环境下装不上。
- **单细胞注释的自动参考集不随包分发**：`celldex` 在 Bioconductor 3.18 无 Windows 二进制。需要自动注释时请自备参考集 `.rds`，在界面里导入。
- **UMAP 与 tSNE 只是两种可视化，都不参与聚类**：分群由 `FindNeighbors` + `FindClusters` 在 harmony/PCA 空间里算好，两个降维方法只是把同一个结果投影到二维。tSNE 的邻域范围由 perplexity 决定（本工具按 `min(30, (细胞数−1)/3)` 自适应），容易出现同一群被拆成几块、或两群在图上叠在一起——**那是降维算法的表现，聚类本身没变**。判断分群质量请看 marker 基因与各群的差异基因，不要用任何一张二维图下结论。

## 许可

内部科研工具。第三方 R 包遵循各自许可证（GPL-2/3、Artistic-2.0 等），随安装包分发的 R 运行时遵循 GPL-2。
