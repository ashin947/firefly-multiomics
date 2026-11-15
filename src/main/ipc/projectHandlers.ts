/**
 * 项目类通道：新建 / 打开 / 保存 / 关闭 / 最近列表 / 载入示例。
 *
 * 这一层保持「薄」：只做入参 schema 校验 + 转发到 ProjectService，
 * 业务规则（原子写、中断恢复、目录结构）全部在 Service 里，便于单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { toAppError } from '@shared/errors'
import { IPC } from '@shared/ipc'
import type { DatasetSummary } from '@shared/types/dataset'
import type { OpenProjectResult, ProjectMeta, RecentProject } from '@shared/types/project'
import { hasBlockingIssue } from '../data/DataValidator'
import { ServiceError } from '../project/ProjectService'
import { logger } from '../logger'
import { defineHandler, type AppContext } from './registerHandlers'

const createSchema = z.object({
  name: z.string().min(1, '项目名称不能为空').max(120, '项目名称过长'),
  species: z.enum(['human', 'mouse']),
  parentDir: z.string().min(1, '请选择项目保存位置')
})

const openSchema = z.object({
  dir: z.string().min(1)
})

const saveSchema = z.object({
  // patch 的结构由 ProjectSchema 统一校验（这里只保证是对象）
  patch: z.record(z.unknown())
})

const loadDemoSchema = z.object({
  /**
   * 示例项目的保存位置；**空串表示「用默认位置」**（userData/demo-projects）。
   *
   * ★ 这里不能要求 `.min(1)`：渲染进程的 `projectStore.loadDemo()` 正是传空串
   *   （它不想让用户为了看示例数据先选一个目录）。之前写成 `.min(1)` 的后果是
   *   「载入示例项目」按钮**点了完全没反应** —— zod 在 IPC 层就拒了，渲染进程只
   *   把错误塞进 store.error，界面连个提示都没有。这种「按钮是死的」问题单测
   *   抓不到（它们直接调 service），只有真的点一遍才发现。
   */
  parentDir: z.string().optional(),
  /**
   * 示例数据规模：默认 2000×24（约 1 秒），stress 为 20000×48（30–60 秒）。
   * 压力数据的入口在「载入示例项目」卡片下方，明确标注用途与耗时。
   */
  variant: z.enum(['default', 'stress']).optional()
})

export function registerProjectHandlers(ctx: AppContext): void {
  defineHandler(ctx, IPC.project.create, createSchema, async (req): Promise<ProjectMeta> => {
    return ctx.projectService.create(req)
  })

  defineHandler(ctx, IPC.project.open, openSchema, async (req): Promise<OpenProjectResult> => {
    return ctx.projectService.open(req.dir)
  })

  defineHandler(ctx, IPC.project.save, saveSchema, async (req): Promise<ProjectMeta> => {
    return ctx.projectService.save(req.patch as Partial<ProjectMeta>)
  })

  defineHandler(ctx, IPC.project.close, null, async (): Promise<void> => {
    // 清掉数据层的会话缓存：否则下一个项目会继承上一个项目的矩阵与 ID 映射缓存
    ctx.matrixImporter.reset()
    ctx.geneIdResolver.reset()
    ctx.projectService.close()
  })

  defineHandler(ctx, IPC.project.recent, null, async (): Promise<RecentProject[]> => {
    return ctx.recentProjects.list()
  })

  /**
   * 载入示例数据 —— 这里把 T06 留下的「摘要缺口」闭环。
   *
   * T06 只负责建项目 + 拷 CSV；`dataset` 摘要（2000×24、分组、issues）
   * 必须由真正的导入链路产出，否则示例项目打开后是「有文件、无摘要」的半残状态。
   * 因此这里复用与用户导入**完全相同**的 MatrixImporter / GroupImporter / DataValidator，
   * 保证示例数据与用户数据走同一条代码路径（这也是对导入链路的免费验收）。
   */
  defineHandler(ctx, IPC.project.loadDemo, loadDemoSchema, async (req): Promise<ProjectMeta> => {
    const variant = req.variant ?? 'default'
    const meta = ctx.projectService.loadDemo(req.parentDir ?? '', variant)
    const root = ctx.projectStore.requireRoot()

    const demoDir = variant === 'stress' ? ctx.paths.getDemoStressDir() : ctx.paths.getDemoDir()
    const expressionFile = path.join(demoDir, 'expression.csv')
    const groupsFile = path.join(demoDir, 'groups.csv')
    if (!fs.existsSync(expressionFile)) {
      throw new ServiceError(
        toAppError('E_UNKNOWN', {
          title: '示例数据缺失',
          message: `未找到 ${expressionFile}`,
          suggestion: '请执行 npm run gen:demo 重新生成示例数据。'
        })
      )
    }

    // 1) 导入矩阵（示例数据是 counts，物种 human）
    const imported = ctx.matrixImporter.importMatrix({
      filePath: expressionFile,
      dataType: 'counts',
      species: meta.species,
      projectRoot: root
    })

    // 2) 导入分组表（写 data/groups.csv）
    let groups: Record<string, string[]> = {}
    let groupColumn = imported.summary.groupColumn
    let sampleColumn = imported.summary.sampleColumn
    if (fs.existsSync(groupsFile)) {
      const groupResult = ctx.groupImporter.importGroups({ filePath: groupsFile })
      ctx.groupImporter.writeNormalized(groupResult.groups, root)
      groups = groupResult.groups
      groupColumn = groupResult.groupColumn
      sampleColumn = groupResult.sampleColumn
    }

    // 3) 全量校验（与用户数据同一条规则链）
    const matrix = ctx.matrixImporter.getCleaned()
    if (!matrix) {
      throw new ServiceError(toAppError('E_DATA_EMPTY', { message: '示例数据导入失败。' }))
    }
    const source = ctx.matrixImporter.getSourceInfo()
    const issues = ctx.dataValidator.validate({
      matrix,
      groups: Object.keys(groups).length > 0 ? groups : null,
      groupColumn,
      dataType: 'counts',
      ...(source ? { source } : {})
    })

    const summary: DatasetSummary = {
      ...imported.summary,
      groupColumn,
      sampleColumn,
      groups,
      naRatio: matrix.naRatio,
      allZeroGeneCount: matrix.allZeroGeneCount,
      issues,
      hasBlockingIssue: hasBlockingIssue(issues)
    }

    const saved = ctx.projectService.save({
      dataset: summary,
      dataType: 'counts',
      status: 'imported'
    })
    logger.info(
      'project',
      `示例项目就绪 ${summary.geneCount}×${summary.sampleCount} 分组=${Object.keys(groups).length} 问题=${issues.length}`
    )
    return saved
  })
}
