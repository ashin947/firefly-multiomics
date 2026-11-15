/**
 * 火山图导出（走 R / ggplot2）。
 *
 * ## 为什么导出不用前端的 ECharts
 *
 * ARCHITECTURE §4.5 一开始就把两条路分开了：
 *   - **预览**用 ECharts：快、能 hover、拖滑块实时重算；
 *   - **导出**用 R/ggplot2：`theme_bw` + 黑框 + 精确 pt 字号 + 真矢量 PDF，
 *     这些是投稿用的图，需要的是排版精度，不是交互。
 *
 * ## 为什么前端把整批行传过来，而不是给一个文件路径
 *
 * 用户可能画的是**外部导入的表**（`plotDataStore`），它没有落在项目目录里。
 * 统一由渲染进程传「当前显示的这一批行」，主进程写临时 CSV 交给 R ——
 * 两种数据源走同一条路，也顺带保证了「导出的一定是屏幕上这批数据」。
 *
 * ## 临时目录
 *
 * 每次导出在 userData/tmp 下建一个 `plot-<id>` 目录放 `data.csv` 和 R 的运行产物，
 * **finally 里必删**：用户反馈过软件会积累垃圾，这里不能又添一处。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import type {
  PlotExportRequest,
  PlotExportResult,
  PlotPreviewRequest,
  PlotPreviewResult
} from '@shared/types/ipc-contract'
import { writeTableCsv } from '../io/OutputWriter'
import { logger } from '../logger'
import type { PathService } from '../paths'
import type { RRunner } from '../process/RProcessRunner'

export interface VolcanoExporterDeps {
  runner: RRunner
  paths: Pick<PathService, 'getTempDir'>
}

/** 导出超时：正常 1~3 秒，留足余量给慢机器上的字体加载 */
const EXPORT_TIMEOUT_MS = 120_000

export class VolcanoExporter {
  constructor(private readonly deps: VolcanoExporterDeps) {}

  async export(req: PlotExportRequest): Promise<PlotExportResult> {
    if (req.rows.length === 0) {
      throw toAppError('E_VALIDATION', {
        message: '没有可导出的数据。',
        suggestion: '先跑一次差异分析，或导入一张差异结果表。'
      })
    }

    const runId = `plot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const runDir = path.join(this.deps.paths.getTempDir(), runId)

    try {
      fs.mkdirSync(runDir, { recursive: true })
      const dataPath = path.join(runDir, 'data.csv')
      // 用与 de.csv 完全相同的 9 列格式，R 侧直接读列名，不用再约定一套
      writeTableCsv(dataPath, req.rows as unknown as Record<string, unknown>[])

      const config = {
        runId,
        runDir,
        projectRoot: runDir,
        params: {
          dataPath,
          outPath: req.outPath,
          format: req.format,
          widthIn: req.widthIn,
          heightIn: req.heightIn,
          dpi: req.dpi,
          logFC: req.thresholds.logFC,
          fdr: req.thresholds.fdr,
          // 判定依据必须跟界面一致，否则导出的图会「和屏幕上不一样」
          basis: req.thresholds.basis ?? 'adjPValue',
          colors: req.colors,
          title: req.title ?? ''
        }
      }

      logger.info('plot', `导出火山图 ${req.format} ${req.widthIn}x${req.heightIn}in @${req.dpi}dpi`)
      const result = await this.deps.runner.run({
        runId,
        scriptRelPath: 'plot/export_volcano.R',
        config,
        runDir,
        timeoutMs: EXPORT_TIMEOUT_MS,
        requiredPackages: ['ggplot2', 'ragg', 'data.table']
      })

      if (!result.ok) {
        // R 的 stderr 是排障的唯一线索（绘图失败时报错往往只有一行），必须落日志
        if (result.stderr) {
          logger.error('plot', `R 绘图失败（exit=${result.exitCode}），stderr 末尾：\n${result.stderr.slice(-3000)}`)
        }
        throw (
          result.error ??
          toAppError('E_R_GENERIC', {
            message: 'R 绘图失败，但没有返回可识别的错误信息。',
            suggestion: '请查看日志确认；若反复出现，请导出诊断报告。'
          })
        )
      }

      if (!fs.existsSync(req.outPath)) {
        throw toAppError('E_IO_PERMISSION', {
          message: `R 报告成功，但目标文件不存在：${req.outPath}`,
          suggestion: '请确认保存位置可写（例如没有被杀毒软件锁定）。'
        })
      }

      const summary = (result.summary ?? {}) as Record<string, unknown>
      const stat = fs.statSync(req.outPath)

      return {
        outPath: req.outPath,
        files: [req.outPath],
        bytes: Number.isFinite(Number(summary.bytes)) ? Number(summary.bytes) : stat.size,
        durationMs: Number.isFinite(Number(summary.durationMs))
          ? Number(summary.durationMs)
          : result.durationMs,
        counts: {
          up: Number(summary.up ?? 0),
          down: Number(summary.down ?? 0),
          stable: Number(summary.stable ?? 0)
        }
      }
    } finally {
      // 无论成败都清掉：这个目录里是临时 CSV 和 R 的中间产物，没有任何保留价值
      try {
        fs.rmSync(runDir, { recursive: true, force: true })
      } catch {
        // 删不掉不影响导出结果，只记一条日志（Windows 上偶发文件占用）
        logger.warn('plot', `临时目录清理失败：${runDir}`)
      }
    }
  }

  /**
   * 预览图：与导出走**同一个 R 脚本**，只改 format/dpi，并跳过字体注册。
   *
   * 跳过字体（skipFonts）是预览专用的优化：注册字体会让 R 往临时目录解压
   * 约 5MB 字体文件、多花几百毫秒。预览图的轴标签全是英文，不需要中文。
   * 导出**不**跳过 —— 万一以后支持中文标题，那条路必须字体就位。
   */
  async preview(req: PlotPreviewRequest): Promise<PlotPreviewResult> {
    if (req.rows.length === 0) {
      throw toAppError('E_VALIDATION', { message: '没有可绘制的数据。' })
    }

    // 预览分辨率：140dpi 在 9 英寸宽上约 1260px，屏幕上足够清晰，
    // 又不至于让 base64 大到拖慢 IPC（300dpi 会到 2700px、字符串几 MB）
    const PREVIEW_DPI = 140
    const runId = `prev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const runDir = path.join(this.deps.paths.getTempDir(), runId)

    try {
      fs.mkdirSync(runDir, { recursive: true })
      const dataPath = path.join(runDir, 'data.csv')
      const outPath = path.join(runDir, 'preview.png')
      writeTableCsv(dataPath, req.rows as unknown as Record<string, unknown>[])

      const config = {
        runId,
        runDir,
        projectRoot: runDir,
        params: {
          dataPath,
          outPath,
          format: 'png',
          widthIn: req.widthIn,
          heightIn: req.heightIn,
          dpi: PREVIEW_DPI,
          logFC: req.thresholds.logFC,
          fdr: req.thresholds.fdr,
          basis: req.thresholds.basis ?? 'adjPValue',
          colors: req.colors,
          title: req.title ?? '',
          skipFonts: true
        }
      }

      const result = await this.deps.runner.run({
        runId,
        scriptRelPath: 'plot/export_volcano.R',
        config,
        runDir,
        timeoutMs: EXPORT_TIMEOUT_MS,
        requiredPackages: ['ggplot2', 'ragg', 'data.table']
      })

      if (!result.ok || !fs.existsSync(outPath)) {
        if (result.stderr) {
          logger.error('plot', `预览失败（exit=${result.exitCode}）：\n${result.stderr.slice(-1500)}`)
        }
        throw (
          result.error ??
          toAppError('E_R_GENERIC', { message: '预览图生成失败。', suggestion: '可稍后重试，或直接导出图片。' })
        )
      }

      const buffer = fs.readFileSync(outPath)
      const summary = (result.summary ?? {}) as Record<string, unknown>
      return {
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        widthPx: Math.round(req.widthIn * PREVIEW_DPI),
        heightPx: Math.round(req.heightIn * PREVIEW_DPI),
        durationMs: Number.isFinite(Number(summary.durationMs))
          ? Number(summary.durationMs)
          : result.durationMs
      }
    } finally {
      try {
        fs.rmSync(runDir, { recursive: true, force: true })
      } catch {
        logger.warn('plot', `预览临时目录清理失败：${runDir}`)
      }
    }
  }
}
