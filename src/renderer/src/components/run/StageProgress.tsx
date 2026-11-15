/**
 * 阶段化进度条 + **阶段叙述**。
 *
 * 只点亮该方法真正会经过的阶段（limma 没有 dispersion，DESeq2 没有 voom），
 * 否则用户会盯着一个永远不亮的「估计离散度」以为卡住了。
 *
 * ★ 为什么除了进度条还要写两行字（2025-11）：
 *   示例数据 1 秒跑完，界面上只能采到两三个百分比台阶 —— 用户看到的是
 *   「1% → 50% → 完成」，中间发生了什么完全不知道。
 *   进度条本身没有信息量，**阶段名和已完成的阶段清单才有**：
 *     「正在拟合模型 · fitting weighted linear model」
 *     「已完成：读取数据 → 低表达过滤 → 标准化」
 *   注意：这里**不做假动画**。百分比只反映 R 真实上报的值，
 *   平滑补间会让用户以为进度在走，实际 R 早就卡住了 —— 那是骗人。
 *
 * ★ 为什么副标题直接用 R 的英文 `msg`，**不加翻译表**：
 *   ① 主行已经是中文阶段名，用户主要看那行；英文 `msg` 的作用是「证明真的在跑」，
 *      不需要读懂（`running voom (mean-variance modelling)` 这种）。
 *   ② `msg` 在同一阶段内是**变化**的（fit 阶段有三条），静态翻译表必然失真。
 *   ③ 更关键：R 包升级随时会改措辞，翻译表会**悄悄失效**——查不到就回落英文，
 *      没人会发现，又是一种静默错误。宁可显示原文，也不要一份会过期的对照表。
 */
import Box from '@mui/material/Box'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { STAGE_LABELS, type Stage } from '@shared/constants'

interface StageProgressProps {
  stages: Stage[]
  current: Stage
  pct: number
  doneStages: Stage[]
  /** 当前阶段的细粒度说明（R 上报的 `progress.msg` 原文，可能是英文技术描述） */
  message?: string | null
}

export function StageProgress({ stages, current, pct, doneStages, message }: StageProgressProps): JSX.Element {
  // 「已完成」按方法自身的阶段顺序排列，而不是按事件到达顺序 ——
  // 事件乱序或重复时，展示顺序仍然稳定。
  const completed = stages.filter((stage) => doneStages.includes(stage))
  const currentLabel = STAGE_LABELS[current] ?? '准备中'

  return (
    <Box>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        {stages.map((stage, index) => {
          const done = doneStages.includes(stage) || (stage === current && pct >= 100)
          const active = stage === current && !done
          return (
            <Stack key={stage} direction="row" alignItems="center" spacing={0.5}>
              <Box
                sx={{
                  px: 1,
                  py: 0.25,
                  borderRadius: 1,
                  fontSize: 10.5,
                  fontWeight: active ? 700 : 500,
                  color: done ? '#1B5E20' : active ? '#245C42' : 'text.disabled',
                  backgroundColor: done ? '#E6F4EA' : active ? '#EEF4FF' : 'transparent',
                  border: '1px solid',
                  borderColor: done ? '#B7DFC2' : active ? '#D6E4FF' : 'divider'
                }}
              >
                {STAGE_LABELS[stage]}
              </Box>
              {index < stages.length - 1 && (
                <Box sx={{ width: 8, height: 1, backgroundColor: done ? '#B7DFC2' : 'divider' }} />
              )}
            </Stack>
          )
        })}
      </Stack>

      <LinearProgress variant="determinate" value={Math.min(100, Math.max(0, pct))} sx={{ height: 6, borderRadius: 3 }} />

      <Box sx={{ mt: 0.75 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="body2" sx={{ fontSize: 12, fontWeight: 600, color: 'text.primary' }}>
            {pct >= 100 ? '全部阶段已完成' : `正在${currentLabel}`}
            {pct < 100 && message ? (
              <Box component="span" sx={{ ml: 0.75, fontSize: 11, fontWeight: 400, color: 'text.secondary' }}>
                · {message}
              </Box>
            ) : null}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, fontWeight: 600 }}>
            {Math.round(pct)}%
          </Typography>
        </Stack>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontSize: 11, mt: 0.25, lineHeight: 1.5 }}
          data-testid="completed-stages"
        >
          {completed.length === 0
            ? '已完成：—'
            : `已完成：${completed.map((stage) => STAGE_LABELS[stage]).join(' → ')}`}
        </Typography>
      </Box>
    </Box>
  )
}
