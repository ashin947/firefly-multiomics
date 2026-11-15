/**
 * 绘图的「旁路数据源」——用户从外部导入的差异结果表。
 *
 * ## 为什么单独开一个 store，而不塞进 analysisStore
 *
 * `analysisStore.rows` 的语义是「**这个项目跑出来的分析结果**」，它由
 * `loadResult(analysisId)` 从 `results/de/<runId>/de.csv` 读出来，并配一份
 * `snapshot`（方法、耗时、参数快照）。统计卡、结果表、火山图、导出的行数
 * 全都挂在它上面。
 *
 * 如果外部导入的表直接写进去：
 *  - `snapshot` 会开始说谎（"limma-voom 耗时 1.8s" 说的其实是别人给的表）；
 *  - 用户下次点「重新分析」时，`startRun` 把 rows 清空、跑完再填回，
 *    外部数据就在用户没要求的情况下消失了，而且没有任何提示；
 *  - 最糟的是**没有任何东西记录这份数据的来历** —— 用户三个月后想复现
 *    「当初图里那 123 个基因是怎么来的」，永远查不清。
 *
 * 所以外部数据单独放，只活在渲染进程内存里，**不落盘、不写项目**。
 * 切回分析结果 = 把 `external` 置 null，一切照旧。
 */
import { create } from 'zustand'
import type { DEResultRow } from '@shared/types/analysis'

export interface ExternalDE {
  rows: DEResultRow[]
  /** 来源文件名，界面上必须显示出来（用户要能分辨这张图的数据从哪来） */
  label: string
  /** 导入时的非致命问题（缺 FDR 列、跳过若干行…） */
  warnings: string[]
  importedAt: number
}

interface PlotDataState {
  external: ExternalDE | null
  setExternal: (payload: Omit<ExternalDE, 'importedAt'>) => void
  clearExternal: () => void
}

export const usePlotDataStore = create<PlotDataState>((set) => ({
  external: null,

  setExternal: (payload) =>
    set({
      external: {
        rows: payload.rows,
        label: payload.label,
        warnings: payload.warnings,
        importedAt: Date.now()
      }
    }),

  clearExternal: () => set({ external: null })
}))
