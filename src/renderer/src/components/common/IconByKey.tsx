/**
 * 图标键 → MUI 图标组件的映射。
 *
 * shared/modules.ts 里只存字符串（主进程构建不能依赖 MUI），
 * 渲染进程在这里做一次映射。新增模块时只需在这张表里补一个键。
 */
import AppsIcon from '@mui/icons-material/Apps'
import BubbleChartIcon from '@mui/icons-material/BubbleChart'
import CallSplitIcon from '@mui/icons-material/CallSplit'
import CompareArrowsIcon from '@mui/icons-material/CompareArrows'
import DonutLargeIcon from '@mui/icons-material/DonutLarge'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import ForumIcon from '@mui/icons-material/Forum'
import GraphicEqIcon from '@mui/icons-material/GraphicEq'
import GridOnIcon from '@mui/icons-material/GridOn'
import HubIcon from '@mui/icons-material/Hub'
import InsightsIcon from '@mui/icons-material/Insights'
import LabelIcon from '@mui/icons-material/Label'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import MapIcon from '@mui/icons-material/Map'
import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import MultilineChartIcon from '@mui/icons-material/MultilineChart'
import PieChartIcon from '@mui/icons-material/PieChart'
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot'
import ShareIcon from '@mui/icons-material/Share'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import TableChartIcon from '@mui/icons-material/TableChart'
import TimelineIcon from '@mui/icons-material/Timeline'
import TuneIcon from '@mui/icons-material/Tune'
import WavesIcon from '@mui/icons-material/Waves'
import type { SvgIconComponent } from '@mui/icons-material'
import type { IconKey } from '@shared/modules'

const MAP: Record<IconKey, SvgIconComponent> = {
  table: TableChartIcon,
  diff: CompareArrowsIcon,
  chart: InsightsIcon,
  enrich: BubbleChartIcon,
  gsea: ShowChartIcon,
  network: HubIcon,
  filter: FilterAltIcon,
  cluster: ScatterPlotIcon,
  label: LabelIcon,
  marker: LocalOfferIcon,
  subset: CallSplitIcon,
  trajectory: TimelineIcon,
  communication: ForumIcon,
  'spatial-import': GridOnIcon,
  'spatial-qc': TuneIcon,
  'spatial-cluster': AppsIcon,
  'spatial-svg': WavesIcon,
  'spatial-region': MapIcon,
  // 绘图模块：Venn 用叠圆（DonutLarge 是两个偏心的环，视觉上最接近集合图）；
  // 小提琴/蜂群用 GraphicEq（宽窄不一的竖条，正是分布形状）；
  // 生存曲线用 MultilineChart（阶梯折线 + 多组）。
  venn: DonutLargeIcon,
  violin: GraphicEqIcon,
  survival: MultilineChartIcon,
  deconv: PieChartIcon,
  neighborhood: ShareIcon,
  more: MoreHorizIcon
}

export function iconFor(key: IconKey): SvgIconComponent {
  return MAP[key] ?? MoreHorizIcon
}
