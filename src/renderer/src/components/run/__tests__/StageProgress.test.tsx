/**
 * @vitest-environment jsdom
 *
 * 进度遮罩的「阶段叙述」验证。
 *
 * ## 为什么需要它
 *
 * 示例数据 1 秒跑完，进度条上只有两三个百分比台阶 —— 光看百分比等于什么都没说。
 * 真正有信息量的是这两行：
 *
 *     正在拟合模型 · fitting weighted linear model
 *     已完成：读取数据 → 低表达过滤 → 标准化
 *
 * 这里锁住三件事：
 *   ① 阶段名用**中文标签**（不是把 R 的英文 msg 当标题）；
 *   ② R 上报的 `msg` 作为副标题原样展示（技术细节，不翻译、不改写）；
 *   ③ 「已完成」按**方法自身的阶段顺序**排列，不按事件到达顺序 ——
 *      事件乱序或重复时展示仍然稳定。
 *
 * ## 为什么不测「平滑动画」
 *
 * 百分比只反映 R 真实上报的值。补间动画会让用户以为进度在走，实际 R 可能已经卡死 ——
 * 那是骗人。所以这里也断言：给定 pct=78，进度条就是 78，不会被任何动画改变。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { METHOD_STAGES, type Stage } from '@shared/constants'
import { StageProgress } from '../StageProgress'

afterEach(() => {
  cleanup()
})

const VOOM_STAGES = METHOD_STAGES['limma-voom'] as Stage[]

describe('StageProgress —— 阶段叙述', () => {
  it('显示「正在{阶段}」+ R 上报的英文细节', () => {
    render(
      <StageProgress
        stages={VOOM_STAGES}
        current="fit"
        pct={78}
        doneStages={['read', 'filter', 'normalize']}
        message="fitting weighted linear model"
      />
    )
    expect(screen.getByText(/正在拟合模型/)).toBeTruthy()
    expect(screen.getByText(/fitting weighted linear model/)).toBeTruthy()
    expect(screen.getByText('78%')).toBeTruthy()
  })

  it('「已完成」按方法阶段顺序排列，不按事件到达顺序', () => {
    // 故意把 doneStages 打乱：真实事件偶尔会乱序/重复
    render(
      <StageProgress
        stages={VOOM_STAGES}
        current="fit"
        pct={78}
        doneStages={['normalize', 'read', 'filter']}
        message={null}
      />
    )
    expect(screen.getByTestId('completed-stages').textContent).toBe(
      '已完成：读取数据 → 低表达过滤 → 标准化'
    )
  })

  it('刚开始跑时「已完成」是占位符，不是空白', () => {
    render(<StageProgress stages={VOOM_STAGES} current="read" pct={1} doneStages={[]} message={null} />)
    expect(screen.getByTestId('completed-stages').textContent).toBe('已完成：—')
  })

  it('100% 时改说「全部阶段已完成」，不再显示上一条细节', () => {
    render(
      <StageProgress
        stages={VOOM_STAGES}
        current="write"
        pct={100}
        doneStages={['read', 'filter', 'normalize', 'fit', 'test']}
        message="writing de.csv"
      />
    )
    expect(screen.getByText(/全部阶段已完成/)).toBeTruthy()
    expect(screen.queryByText(/writing de\.csv/)).toBeNull()
  })

  it('只点亮该方法真正会经过的阶段（limma 没有「估计离散度」）', () => {
    render(<StageProgress stages={VOOM_STAGES} current="fit" pct={50} doneStages={[]} message={null} />)
    expect(screen.queryByText('估计离散度')).toBeNull()
    expect(screen.getByText('拟合模型')).toBeTruthy()
  })
})
