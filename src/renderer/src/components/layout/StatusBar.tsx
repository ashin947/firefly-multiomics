/**
 * 底部状态栏：R 状态、物种、数据规模、隐私承诺。
 *
 * 「数据全程在本机处理，不会上传任何内容」必须常驻可见 ——
 * 这是生信用户最关心的一件事（样本数据往往涉及伦理审批）。
 *
 * ★ 物种前面为什么带「项目数据：」前缀：
 *   这一项描述的是**已加载的表达矩阵**的物种，不是当前页面正在做的事。
 *   但状态栏是全局的：在水稻富集页上，它和「水稻」并排出现时会被读成
 *   「你其实在跑人类」（验包截图里第一眼就是这个感觉）。
 *
 *   两种修法里只选前者：
 *     ✅ 加前缀，说明「这是数据集属性」
 *     ❌ 让它跟随当前页面的物种 —— 那会造成真正的事实错误：状态栏说的
 *        是数据集，跟着页面变就等于在说谎（页面上换物种不会改数据集）
 */
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import { SPECIES_LABELS } from '@shared/constants'
import { useAppStore } from '../../store/appStore'
import { useProjectStore } from '../../store/projectStore'
import { useRuntimeStore } from '../../store/runtimeStore'
import { runtimeDisplay } from '../../utils/runtimeDisplay'
import { StatusLightDot } from '../common/StatusBadge'

const LIGHT_TEXT = { green: '环境正常', yellow: '环境待完善', red: '环境不可用' } as const

export function StatusBar(): JSX.Element {
  const runtime = useRuntimeStore((s) => s.info)
  const probing = useRuntimeStore((s) => s.probing)
  const probeError = useRuntimeStore((s) => s.error)
  const openDiagnostics = useRuntimeStore((s) => s.openDiagnostics)
  const meta = useProjectStore((s) => s.meta)
  const dataset = useProjectStore((s) => s.dataset)
  const info = useAppStore((s) => s.info)

  /**
   * ★ 这里必须用 `overallLight`，不能只算 R 运行时那一盏。
   *
   * 原来用的是 `runtimeLight`（只回答「R 本身能不能跑」），于是出现过一个很荒唐
   * 的画面：底部绿点 +「环境正常」，左边侧栏黄点 +「环境不完整」，同一屏两句话
   * 互相打脸。根因就是两个组件各挑一盏灯来代表「整体」。
   * 侧栏的注释里写着「不能每个组件自己挑一盏灯」，底部状态栏当时正好违反了它。
   *
   * ★ 但「还没探测完」不能算成任何一盏灯。
   *   以前 `runtime` 为 null 时直接落到 `'yellow'` +「环境待完善」，
   *   再配上 `!runtime?.rscriptPath` 推出的「R 未检测到」—— 探针还没回来，
   *   界面已经断言「没装 R」，用户看到就去查环境了，而实际分析跑得好好的。
   *   现在三态由 `runtimeDisplay` 统一给：未探测 → 灰点 +「正在检测 R…」，
   *   探测出错 → 灰点 +「R 检测失败」，只有真探完才给颜色与结论。
   */
  const display = runtimeDisplay(runtime, probing, probeError)
  const verdict = display.light ? ` · ${LIGHT_TEXT[display.light]}` : ''

  return (
    <Box
      sx={{
        flex: '0 0 auto',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        borderTop: '1px solid',
        borderColor: 'divider',
        backgroundColor: '#FFFFFF',
        fontSize: 11,
        color: 'text.secondary'
      }}
    >
      {/* data-testid：走查脚本要能逐帧采样这一小块的文案（「偶发」的 bug 只能这么抓） */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }} data-testid="runtime-status">
        {/* 黄灯时鼠标悬停能立刻看到「到底缺什么」，不用再点进诊断页 */}
        <StatusLightDot
          light={display.light ?? 'yellow'}
          pending={display.light === null}
          hint={display.detail ? `${display.hint}：${display.detail}` : display.hint}
          size={7}
        />
        <Typography
          variant="body2"
          sx={{ fontSize: 11, cursor: display.state === 'ready' ? 'default' : 'pointer' }}
          onClick={display.state === 'ready' ? undefined : openDiagnostics}
        >
          {display.label}
          {verdict}
        </Typography>
      </Box>

      <Typography variant="body2" sx={{ fontSize: 11 }}>
        {/* 前缀只在真有项目时加：没有项目时「项目数据：未打开项目」是病句 */}
        {meta
          ? `项目数据：${SPECIES_LABELS[meta.species] ?? meta.species}`
          : '未打开项目'}
      </Typography>

      {dataset && (
        <Typography variant="body2" sx={{ fontSize: 11 }}>
          {dataset.geneCount.toLocaleString()} 基因 × {dataset.sampleCount} 样本
        </Typography>
      )}

      {info?.mock && (
        <Typography variant="body2" sx={{ fontSize: 11, color: 'warning.main', fontWeight: 600 }}>
          演示数据
        </Typography>
      )}

      <Box sx={{ flex: 1 }} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <LockOutlinedIcon sx={{ fontSize: 12 }} />
        <Typography variant="body2" sx={{ fontSize: 11 }}>
          数据全程在本机处理，不会上传任何内容
        </Typography>
      </Box>
    </Box>
  )
}
