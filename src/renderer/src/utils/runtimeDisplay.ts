/**
 * 「现在关于 R，我们能说什么」—— 状态栏 / 侧边栏共用的**唯一**口径。
 *
 * ## 为什么需要这个文件
 *
 * `info` 为 `null` 有三种完全不同的含义，而组件以前把它们当成同一种：
 *
 * | 实际状态 | `info` | `probing` | 以前的界面 | 问题 |
 * | --- | --- | --- | --- | --- |
 * | 还没开始探测 / 正在探测 | `null` | false / true | 「R 未检测到」 | **与事实相反** |
 * | 探测失败（IPC 报错） | `null` | false | 「R 未检测到」 | 说错了原因 |
 * | 探测完了，确实没有 R | 有值且 `rscriptPath=''` | false | 「R 未检测到」 | 正确 |
 *
 * 客户看到「R 未检测到」会去查环境、重装包，而实际上分析跑得好好的 ——
 * **界面给出错误信息比不给信息更糟**。所以三态必须分开表达：
 * 未知就说「正在检测」，探测出错就说「检测失败」，只有真的探完且没有 R 才说「未检测到」。
 *
 * ## 为什么不各自写一套
 *
 * 侧栏和底栏本来就是两次踩坑的产物（§41 之前它们各挑一盏灯，出现「绿点 + 环境不完整」）。
 * 文案如果再各写一遍，迟早会出现「侧栏说检测中、底栏说未检测到」。
 * 所以这里同时给出 `label`（短文案）、`hint`（悬停说明）、`light`（灯，仅 ready 时有）。
 */
import type { AppError } from '@shared/errors'
import type { StatusLight } from '@shared/runtimeStatus'
import { overallLight } from '@shared/runtimeStatus'
import type { RRuntimeInfo } from '@shared/types/runtime'

/** 三种「知识状态」，别把 unknown / error 混进「没有 R」里 */
export type RuntimeKnowledgeState = 'pending' | 'error' | 'ready'

export interface RuntimeDisplay {
  state: RuntimeKnowledgeState
  /** 短文案：`R 4.3.2` / `R 未检测到` / `正在检测 R…` / `R 检测失败` */
  label: string
  /** 悬停 / 副标题说明 */
  hint: string
  /**
   * 灯色。**只有 `ready` 时才有值** —— 未探测完不能给颜色结论，
   * 给绿灯是瞎猜，给黄灯同样是在断言「有东西缺」。
   */
  light: StatusLight | null
  /** 悬停时的详细原因（探测失败时是错误原文，便于用户复制给支持） */
  detail?: string
}

/**
 * 把（info, probing, error）三件东西收敛成一句话。
 *
 * @param info 探测结果；`null` 表示「还不知道」
 * @param probing 是否正在探测
 * @param error 探测过程中的 IPC 错误
 */
export function runtimeDisplay(
  info: RRuntimeInfo | null,
  probing: boolean,
  error: AppError | null = null
): RuntimeDisplay {
  if (info) {
    return {
      state: 'ready',
      label: info.rscriptPath ? `R ${info.version || '?'}` : 'R 未检测到',
      hint: info.rscriptPath
        ? info.ok
          ? 'R 运行环境就绪'
          : 'R 可用，但部分分析包缺失（点开诊断看是哪些）'
        : '未检测到 R 运行环境',
      light: overallLight(info)
    }
  }
  if (error) {
    return {
      state: 'error',
      label: 'R 检测失败',
      hint: '环境自检没有跑通，这不等于没装 R —— 点「运行环境诊断」看原因',
      light: null,
      detail: error.message
    }
  }
  return {
    state: 'pending',
    label: '正在检测 R…',
    hint: probing ? '正在探测 R 运行环境，请稍候' : '即将开始探测 R 运行环境',
    // 探测是启动时自动触发的（AppShell），所以「还没开始」与「正在跑」对用户是同一件事；
    // 文案统一成「正在检测」，避免出现一个只有几十毫秒的「尚未检测」闪屏。
    light: null
  }
}
