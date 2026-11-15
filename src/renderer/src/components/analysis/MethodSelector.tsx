/**
 * 分析方法选择（4 张卡片）。
 *
 * 客户/PRD 明确要求：**不可用的方法要留在界面上并置灰**，hover 说明原因。
 * 隐藏不可用项会让用户以为软件缺功能，置灰才能传达「你换个数据类型就能用」。
 *
 * ★ 可用性来自主进程 `deg:analysis:preflight` 的 `methods` 字段，
 *   本组件**不再自己判断**（历史实现里前端有一份 `methodAvailability()`，
 *   与主进程 preflight 规则重复，漂移后会出现「卡片亮着但跑不了」）。
 *   `methods === null` 表示预检结果还没到，此时按「未知」渲染：卡片正常显示但不可点。
 */
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { MethodAvailabilityEntry } from '@shared/types/analysis'
import type { AnalysisMethodId } from '@shared/types/project'

export type DEMethodId = Extract<AnalysisMethodId, 'limma-voom' | 'limma-lm' | 'deseq2' | 'edger'>

interface MethodSelectorProps {
  value: DEMethodId
  onChange: (method: DEMethodId) => void
  /** 主进程给出的可用性列表；null = 预检结果还没到 */
  methods: MethodAvailabilityEntry[] | null
  disabled?: boolean
}

interface MethodMeta {
  id: DEMethodId
  name: string
  subtitle: string
  description: string
  badge: string
}

const METHODS: MethodMeta[] = [
  {
    id: 'limma-voom',
    name: 'limma + voom',
    subtitle: '原始 counts',
    description: 'voom 做均值-方差加权，适合样本量中等的 counts 数据，速度快、结果稳健。',
    badge: '推荐'
  },
  {
    id: 'limma-lm',
    name: 'limma 线性模型',
    // 副标题不再写「已归一化表达」：这个模块现在两种输入都能处理（见 limmaNorm.ts），
    // 写成只能吃归一化数据会让 counts 用户直接跳过它 —— 一句过期的说明等于没有这个功能
    subtitle: 'log2 或 counts',
    description:
      '对 log2 表达值拟合线性模型；原始 counts 可先做 log2-CPM 转换（limma-trend）。速度最快。',
    badge: '快速'
  },
  {
    id: 'deseq2',
    name: 'DESeq2',
    subtitle: '原始 counts',
    description: '负二项分布模型，对小样本 counts 数据更稳健；每组需 ≥2 个样本。',
    badge: '严谨'
  },
  {
    id: 'edger',
    name: 'edgeR',
    subtitle: '原始 counts',
    description: '负二项 + quasi-likelihood F 检验，对小样本和离散度异常值更稳健；每组需 ≥2 个样本。',
    badge: '稳健'
  }
]

export function MethodSelector({ value, onChange, methods, disabled = false }: MethodSelectorProps): JSX.Element {
  return (
    // 4 张卡片一行；卡片本身是等高的，说明文字折行不影响对齐
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1.5 }}>
      {METHODS.map((method) => {
        const entry = methods?.find((item) => item.id === method.id)
        // 结果未到时按「未知」处理：既不说可用也不说不可用，只是暂时点不动
        const known = Boolean(entry)
        const available = entry ? entry.enabled : false
        const selected = value === method.id
        const clickable = available && !disabled

        const card = (
          <Card
            variant="outlined"
            onClick={() => {
              if (clickable) onChange(method.id)
            }}
            sx={{
              position: 'relative',
              p: 1.75,
              height: '100%',
              cursor: clickable ? 'pointer' : 'not-allowed',
              opacity: known && !available ? 0.55 : 1,
              backgroundColor: selected ? 'rgba(53,126,92,0.05)' : '#FFFFFF',
              borderColor: selected ? 'primary.main' : 'divider',
              borderWidth: selected ? 2 : 1,
              transition: 'all .15s ease',
              '&:hover': clickable ? { borderColor: 'primary.main' } : {}
            }}
          >
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Box>
                <Typography variant="body1" sx={{ fontWeight: 600, fontSize: 13.5 }}>
                  {method.name}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                  {method.subtitle}
                </Typography>
              </Box>
              {selected ? (
                <CheckCircleIcon sx={{ fontSize: 18, color: 'primary.main' }} />
              ) : (
                <Chip size="small" label={method.badge} sx={{ height: 18, fontSize: 10 }} />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontSize: 11.5, lineHeight: 1.65 }}>
              {method.description}
            </Typography>
            {known && !available && (
              <Typography variant="body2" sx={{ mt: 1, fontSize: 11, color: 'error.main', lineHeight: 1.5 }}>
                不可用
              </Typography>
            )}
          </Card>
        )

        return known && !available ? (
          <Tooltip key={method.id} title={entry?.reason ?? '当前条件下不可用'} placement="bottom" arrow>
            <Box>{card}</Box>
          </Tooltip>
        ) : (
          <Box key={method.id}>{card}</Box>
        )
      })}
    </Box>
  )
}
