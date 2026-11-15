# 真实 UI 走查报告（Playwright + Electron）

> 本文件由 `scripts/walkthrough-ui.mjs` 自动生成，请勿手工编辑。

- 生成时间：2026-11-11T13:16:12.000Z
- Rscript：D:/R-4.3.2/bin/x64/Rscript.exe
- 走查对象：构建产物 `out/`（源码改动后需先 `npm run build`）
- 示例数据：默认 2,000 基因 × 24 样本
- 临时放宽 required：否
- **结论：全部通过 ✅**

| 步骤 | 结果 | 详情 |
| --- | --- | --- |
| 工作台渲染 | ✅ | 标题「DEG Studio」 |
| 核心分析包灯：展开后逐方法列出可用性 | ✅ | 方法行 4/4，DESeq2 已就绪 |
| 载入示例项目 → 模块首页 | ✅ | #/module/transcriptome |
| 分析配置页 + 预检 | ✅ | 预检通过，开始分析可点 |
| 真实运行（limma-voom） | ✅ | 耗时 1.7s，进度采样 4 个台阶 |
| 全局缺包不阻断所选方法（按方法门禁） | ✅ | 全局缺 clusterProfiler、DOSE、enrichplot，limma-voom 仍跑通（未放宽清单） |
| 进度单调不减（没有回退/卡死） | ✅ | 1→3→36→90 |
| 最大进度停顿 < 3s | ✅ | 停在 1% 约 1.2s |
| 结果页渲染（真实结果） | ✅ | 上调 75 / 下调 48 / 通过过滤 1,400 |
| 结果页不是演示数据 | ✅ | 无演示标记 |
| 取消 → UI 进入「已取消」 | ✅ | 遮罩显示已取消 |
| 取消 → R 进程已终止 | ✅ | 运行中 Rscript 4 个 → 取消后 0 个（基线 2） |

## 环境说明

### 1. 运行时缺包，但本方法不受影响

缺失的必需包：clusterProfiler、DOSE、enrichplot。
这些包按用途分三类：DESeq2 只被 deseq2 方法需要；clusterProfiler/DOSE/enrichplot 只被富集分析需要；AnnotationDbi 只在 geneIdType≠SYMBOL 时用到。limma-voom 一个都不需要。
`AnalysisRunner.run()` 的门禁按**所选方法的 requiredPackages** 判（`RProcessRunner.resolveRscript()` 同样接收这份清单），所以这些包缺失**不会**挡住 limma-voom；全局清单 `RRuntimeInfo.ok` 只用于首页的三盏灯和预检提示。
本次**没有**加 `--relax-missing-packages`，即上述门禁是在真实产品行为下被验证的。

## 走查路径

```
工作台 → 载入示例项目 → 模块首页 → 差异表达分析 → 开始分析（真起 Rscript）
      → 采样进度 → 分析完成 → 查看结果 → 读统计卡
      → 再跑一次并在中途取消 → 确认 R 进程已终止
```

## 说明

- 进度采样每 120ms 读一次运行遮罩上的百分比，只记录**变化**（台阶）。
- 「最大进度停顿」是相邻两个台阶之间的最大时间差 —— 它比总耗时更能反映
  「进度条是不是卡住了」：总耗时里有 R 启动（约 0.3–0.5s）和进程回收。
- 取消测试会真的杀掉 R 进程；用 `tasklist` 数 Rscript.exe 的数量来验证。
- 示例数据一次 limma-voom 只要 ~1.1s，采样窗口很窄，界面上只能看到几个台阶；
  R 侧 13 条进度消息是否全部发出、pct 是否单调，由 `docs/SMOKE-R-DE.md` 的 A5 覆盖。