/**
 * 首页三盏状态灯。
 *
 * ★ 所有判定都来自 `@shared/runtimeStatus`，组件里**不允许**再写 if 判断 ——
 *   尤其是「物种注释库缺失永不红灯」这条产品决策（客户明确要求），
 *   一旦某个组件自己判断就会出现「同一台机器，首页红灯、设置页黄灯」。
 *
 * 三盏灯的语义：
 *   ① R 运行时      —— 没有 Rscript / 版本过低 → 红
 *   ② 核心分析包    —— 有方法缺包 → 黄（**不是红**：limma 能用就不该看起来像废了）
 *   ③ 物种注释库    —— 当前项目物种的 org.*.db 缺失 → 黄（不阻断）
 *
 * 「核心分析包」灯可点击展开，逐方法列出「limma-voom ✅ 可用 / deseq2 ⚠ 缺 DESeq2」。
 * 数据直接读 `runtime.methods`（主进程按方法算好），这里不做任何包名比对 ——
 * 一旦在这里自己 filter，就会出现「首页说能用、预检说不能用」。
 */
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import {
  blockingReason,
  corePackagesLight,
  corePackagesMessage,
  partialAvailabilityReason,
  runtimeLight,
  speciesLibLight,
  speciesLibMessage
} from '@shared/runtimeStatus'
import type { Species } from '@shared/types/project'
import type { RRuntimeInfo } from '@shared/types/runtime'
import { useRuntimeStore } from '../../store/runtimeStore'
import { runtimeDisplay } from '../../utils/runtimeDisplay'
import { StatusLightDot } from '../common/StatusBadge'
import type { StatusLight } from '@shared/runtimeStatus'

interface LightRowProps {
  light: StatusLight
  title: string
  detail: string
  /** 有展开内容时传入（整行变成可点击） */
  onToggle?: () => void
  expanded?: boolean
}

function LightRow({ light, title, detail, onToggle, expanded }: LightRowProps): JSX.Element {
  const color = light === 'green' ? 'text.primary' : light === 'yellow' ? 'warning.dark' : 'error.main'
  const content = (
    <Stack direction="row" spacing={1.25} alignItems="flex-start" sx={{ width: '100%' }}>
      <Box sx={{ pt: '5px' }}>
        <StatusLightDot light={light} size={9} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, color }}>
          {title}
          {onToggle && (
            <Box component="span" sx={{ ml: 0.75, fontSize: 10.5, fontWeight: 500, color: 'text.secondary' }}>
              {expanded ? '收起 ▲' : '展开 ▼'}
            </Box>
          )}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5, lineHeight: 1.55 }}>
          {detail}
        </Typography>
      </Box>
    </Stack>
  )

  if (!onToggle) return content
  return (
    <ButtonBase
      onClick={onToggle}
      aria-expanded={expanded}
      sx={{ textAlign: 'left', borderRadius: 1, px: 0.5, mx: -0.5, '&:hover': { backgroundColor: '#F7F9FC' } }}
    >
      {content}
    </ButtonBase>
  )
}

interface RuntimeStatusLightsProps {
  /** 当前项目物种（未打开项目时按 human 展示，并注明「默认」） */
  species: Species
  /** 是否显示「运行诊断」按钮 */
  showDiagnosticsButton?: boolean
}

export function RuntimeStatusLights({ species, showDiagnosticsButton = true }: RuntimeStatusLightsProps): JSX.Element {
  const runtime = useRuntimeStore((s) => s.info)
  const probing = useRuntimeStore((s) => s.probing)
  const probeError = useRuntimeStore((s) => s.error)
  const openDiagnostics = useRuntimeStore((s) => s.openDiagnostics)
  const probe = useRuntimeStore((s) => s.probe)
  const [expanded, setExpanded] = useState(false)

  if (!runtime) {
    // 探针还没回来（或探测失败）：灰点 + 一句话，**不渲染任何三色灯**
    const display = runtimeDisplay(null, probing, probeError)
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <StatusLightDot light="yellow" pending size={9} hint={display.hint} />
        <Typography variant="body2" color="text.secondary">
          {display.label}
        </Typography>
        <Button size="small" onClick={() => void probe(true)} disabled={probing}>
          {probing ? '检测中…' : '重新检测'}
        </Button>
      </Stack>
    )
  }

  const methods = runtime.methods ?? []
  const partialReason = partialAvailabilityReason(runtime)
  const blocked = blockingReason(runtime)

  return (
    <Box>
      <Stack spacing={1.5}>
        <LightRow
          light={runtimeLight(runtime)}
          title="R 运行时"
          detail={
            runtime.rscriptPath
              ? `${runtime.version || '版本未知'} · ${runtime.source === 'bundled' ? '随包内置' : runtime.source === 'custom' ? '用户指定路径' : '系统 PATH'} · ${runtime.rscriptPath}`
              : '未检测到 Rscript。差异分析依赖 R，请安装 R 4.2+ 或在设置里指定路径。'
          }
        />
        <LightRow
          light={corePackagesLight(runtime)}
          title="核心分析包"
          detail={corePackagesMessage(runtime)}
          {...(methods.length > 0 ? { onToggle: () => setExpanded((v) => !v), expanded } : {})}
        />
        <Collapse in={expanded} timeout="auto" unmountOnExit>
          <Box sx={{ pl: 3, pt: 0.75 }}>
            <Stack spacing={0.5}>
              {methods.map((method) => (
                <Stack key={method.id} direction="row" spacing={1} alignItems="center">
                  <Typography
                    variant="body2"
                    sx={{ fontSize: 11.5, color: method.available ? '#1B5E20' : '#8A5300', fontWeight: 500 }}
                  >
                    {method.available ? '✅' : '⚠'}
                  </Typography>
                  <Typography variant="body2" sx={{ fontSize: 11.5, fontWeight: 500, minWidth: 92 }}>
                    {method.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                    {method.available ? '可用' : `缺 ${method.missingPackages.join('、')}`}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
        </Collapse>
        <LightRow
          light={speciesLibLight(runtime, species)}
          title={`物种注释库（${species === 'mouse' ? 'Mouse' : 'Human'}）`}
          detail={speciesLibMessage(runtime, species)}
        />
      </Stack>

      {partialReason && (
        <Box sx={{ mt: 1.5, px: 1.25, py: 1, borderRadius: 1.5, backgroundColor: '#FFF6E5', border: '1px solid #F3DCA8' }}>
          <Typography variant="body2" sx={{ color: '#8A5300', fontSize: 11.5, lineHeight: 1.6 }}>
            {partialReason}
          </Typography>
        </Box>
      )}

      {blocked && (
        <Box sx={{ mt: 1.5, px: 1.25, py: 1, borderRadius: 1.5, backgroundColor: '#FDECEA', border: '1px solid #F5C2C0' }}>
          <Typography variant="body2" sx={{ color: '#B3261E', fontSize: 11.5, lineHeight: 1.6 }}>
            {blocked}
          </Typography>
        </Box>
      )}

      {showDiagnosticsButton && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button size="small" variant="outlined" onClick={openDiagnostics}>
            运行环境诊断
          </Button>
          <Button size="small" onClick={() => void probe(true)} disabled={probing}>
            {probing ? '检测中…' : '重新检测'}
          </Button>
        </Stack>
      )}
    </Box>
  )
}

/** 供其它页面复用：根据运行时信息给出「能否进入分析」的判定 */
/**
 * `null` 表示**还不知道**（未探测完 / 探测失败），必须与「被阻断」区分开。
 *
 * 以前签名是 `boolean`，`false` 同时表示「没 R」和「还没探」。
 * 一旦有页面拿它去 `disabled={!canEnterAnalysis(runtime)}`，
 * 启动瞬间的几十毫秒里按钮就是灰的 —— 且没有任何提示说明为什么。
 * 现在调用方必须显式处理「未知」（通常是先不禁用，或显示「检测中」）。
 */
export function canEnterAnalysis(runtime: RRuntimeInfo | null): boolean | null {
  if (!runtime) return null
  return blockingReason(runtime) === null
}
