/**
 * IPC 注册中心：统一的高阶包装 `defineHandler`。
 *
 * 所有 invoke handler 必须经它注册，才能保证三条铁律（ARCHITECTURE §11.2）：
 *  1. 入参先过 zod 校验（不信任渲染进程）；
 *  2. 返回值永远是 IpcResult 信封，**永不 throw 到渲染进程**；
 *  3. 异常与耗时统一记日志。
 *
 * 本文件同时充当「组合根」：创建各服务实例并注入依赖（构造顺序见 createAppContext）。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ZodTypeAny } from 'zod'
import { IPC } from '@shared/ipc'
import type { IpcEventChannel } from '@shared/ipc'
import { fail, fromUnknownError, ok, toAppError, type AppError, type IpcResult } from '@shared/errors'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/types/ipc-contract'
import { logger } from '../logger'
import { pathService, type PathService } from '../paths'
import { ChildProcessManager } from '../process/ChildProcessManager'
import { RErrorTranslator } from '../process/RErrorTranslator'
import { RProcessRunner } from '../process/RProcessRunner'
import { ProjectService } from '../project/ProjectService'
import { ProjectStore } from '../project/ProjectStore'
import { RecentProjectsStore } from '../project/RecentProjectsStore'
import { SettingsStore } from '../settings/SettingsStore'
import { RRuntimeResolver } from '../runtime/RRuntimeResolver'
import { RDefaultLibs } from '../runtime/RDefaultLibs'
import { DataValidator } from '../data/DataValidator'
import { GeneIdResolver } from '../data/GeneIdResolver'
import { GroupImporter } from '../data/GroupImporter'
import { MatrixImporter } from '../data/MatrixImporter'
import { AnalysisRunner } from '../analysis/AnalysisRunner'
import { deseq2Module } from '../analysis/modules/deseq2'
import { edgerModule } from '../analysis/modules/edger'
import { limmaNormModule } from '../analysis/modules/limmaNorm'
import { limmaVoomModule } from '../analysis/modules/limmaVoom'
import { AnalysisRegistry, registerBuiltinModules, registry } from '../analysis/registry'
import { registerAnalysisHandlers } from './analysisHandlers'
import { registerDataHandlers, ensureMatrix } from './dataHandlers'
import { registerProjectHandlers } from './projectHandlers'
import { registerOutputHandlers } from './outputHandlers'
import { registerEnrichHandlers } from './enrichHandlers'
import { registerGseaHandlers } from './gseaHandlers'
import { registerWgcnaHandlers } from './wgcnaHandlers'
import { registerScrnaHandlers } from './scrnaHandlers'
import { registerTimeSeriesHandlers } from './timeseriesHandlers'
import { registerVizHandlers } from './vizHandlers'
import { registerSystemHandlers } from './systemHandlers'

/** 服务容器（主进程内所有 handler 的依赖来源） */
export interface AppContext {
  paths: PathService
  children: ChildProcessManager
  runner: RProcessRunner
  resolver: RRuntimeResolver
  /** R 的原始默认库路径（R_LIBS_USER / R_LIBS_SITE），诊断页要用它标注每一行的来历 */
  rDefaultLibs: RDefaultLibs
  projectStore: ProjectStore
  projectService: ProjectService
  recentProjects: RecentProjectsStore
  /** 用户设置（自定义 R 路径等） */
  settings: SettingsStore
  /** 数据层（T07/T08） */
  matrixImporter: MatrixImporter
  groupImporter: GroupImporter
  dataValidator: DataValidator
  geneIdResolver: GeneIdResolver
  /** 分析层（T09/T10） */
  analysisRegistry: AnalysisRegistry
  analysisRunner: AnalysisRunner
  /** 主进程 → 渲染进程单向事件 */
  emit(channel: IpcEventChannel, payload: unknown): void
}

/** 向所有存活窗口广播事件（多窗口时每个窗口都要收到） */
function emitToAllWindows(channel: IpcEventChannel, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * 创建服务容器。
 *
 * 构造顺序上的一个环：runner 需要 resolver 才能解析 Rscript，
 * 而 resolver 需要 runner 才能跑能力自检。
 * 用「延迟取用」打破：runner 持有的是 () => resolver，调用时才求值。
 */
export function createAppContext(): AppContext {
  const children = new ChildProcessManager()
  const holder: { current: RRuntimeResolver | null } = { current: null }

  // 设置必须最先就绪：RRuntimeResolver 的候选链要读用户指定的 R 路径
  const settings = new SettingsStore(pathService.getSettingsPath())

  // R 的原始默认库路径（用户在 R 里手工 install.packages 装到哪）。
  // 惰性解析：第一次真的起 R 进程时才探测（约 0.3 s，之后走磁盘缓存）。
  const rDefaultLibs = new RDefaultLibs(pathService)

  const runner = new RProcessRunner(
    () => {
      if (!holder.current) throw new Error('RRuntimeResolver 尚未初始化')
      return holder.current
    },
    pathService,
    children,
    new RErrorTranslator(),
    rDefaultLibs
  )

  const resolver = new RRuntimeResolver(runner, pathService, {
    onChanged: (info) => emitToAllWindows(IPC.event.runtimeChanged, info),
    // 用户手工指定的 R 路径优先级最高（客户机器上 R 装在 D:\R-4.3.2 且不在 PATH）
    customRPath: () => settings.customRPath(),
    /**
     * 按方法判包用的「方法 → 依赖包」清单。
     *
     * 用回调而不是现成数组：模块注册在下面 `registerBuiltinModules()` 才发生，
     * 传数组会拿到空列表，首页的展开详情就永远是空的。
     */
    methodSpecs: () =>
      registry.list().map((module) => ({
        id: module.id,
        label: module.label,
        requiredPackages: module.requiredPackages ?? []
      }))
  })
  holder.current = resolver

  const projectStore = new ProjectStore()
  const recentProjects = new RecentProjectsStore()
  const projectService = new ProjectService(
    pathService,
    projectStore,
    recentProjects,
    app.getVersion()
  )

  // ---- 数据层 ----
  const matrixImporter = new MatrixImporter()
  const groupImporter = new GroupImporter()
  const dataValidator = new DataValidator()
  const geneIdResolver = new GeneIdResolver(runner, pathService)

  // ---- 分析层 ----
  // registry 是模块级单例：注册只做一次，重复注册会抛错（防止两份实现互相覆盖）
  registerBuiltinModules([limmaVoomModule, limmaNormModule, deseq2Module, edgerModule])

  const analysisRunner = new AnalysisRunner({
    runner,
    paths: pathService,
    projectStore,
    projectService,
    registry,
    children,
    emit: emitToAllWindows,
    // 预检时探一次运行时（命中缓存时是同步返回，开销可忽略）
    runtimeInfo: () => resolver.resolve(),
    /**
     * TS 层整数性双保险需要内存中的清洗矩阵。
     *
     * 重启后内存是空的（矩阵只在磁盘上），所以这里先懒恢复一次。不补这一句的后果不是
     * 「报错」而是**假绿**：`checkIntegerCounts()` 拿到 null 会走「跳过」分支返回 ok，
     * 而预检界面把 ok 渲染成「已确认数据为整数」——一句根本没做过检查的肯定结论。
     */
    getCleanedMatrix: () => {
      ensureMatrix({ matrixImporter, projectStore })
      return matrixImporter.getCleaned()
    }
  })

  return {
    paths: pathService,
    children,
    runner,
    resolver,
    rDefaultLibs,
    projectStore,
    projectService,
    recentProjects,
    settings,
    matrixImporter,
    groupImporter,
    dataValidator,
    geneIdResolver,
    analysisRegistry: registry,
    analysisRunner,
    emit: emitToAllWindows
  }
}

export type HandlerFn<C extends IpcInvokeChannel> = (
  req: IpcInvokeMap[C]['req'],
  ctx: AppContext
) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']

/** 把任意异常收敛成 AppError（服务层异常带 .appError 字段） */
export function toAppErrorFromUnknown(err: unknown): AppError {
  if (err && typeof err === 'object' && 'appError' in err) {
    const candidate = (err as { appError?: unknown }).appError
    if (candidate && typeof candidate === 'object' && 'code' in candidate) {
      return candidate as AppError
    }
  }
  return fromUnknownError(err)
}

/**
 * 注册一个 invoke 通道。
 *
 * @param schema 入参 schema；null 表示该通道无入参（或入参不做结构校验）
 */
export function defineHandler<C extends IpcInvokeChannel>(
  ctx: AppContext,
  channel: C,
  schema: ZodTypeAny | null,
  fn: HandlerFn<C>
): void {
  ipcMain.handle(channel, async (_event, rawReq: unknown): Promise<IpcResult<IpcInvokeMap[C]['res']>> => {
    const startedAt = Date.now()
    try {
      let req = rawReq as IpcInvokeMap[C]['req']
      if (schema) {
        const parsed = schema.safeParse(rawReq)
        if (!parsed.success) {
          const detail = parsed.error.issues
            .slice(0, 6)
            .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
            .join('；')
          logger.warn('ipc', `入参校验失败 ${channel}：${detail}`)
          return fail(toAppError('E_VALIDATION', { message: `参数校验未通过 —— ${detail}` }))
        }
        req = parsed.data as IpcInvokeMap[C]['req']
      }

      const data = await fn(req, ctx)
      const elapsed = Date.now() - startedAt
      if (elapsed > 500) {
        logger.info('ipc', `${channel} 完成，耗时 ${elapsed}ms`)
      } else {
        logger.debug('ipc', `${channel} ok ${elapsed}ms`)
      }
      return ok(data)
    } catch (err) {
      const appError = toAppErrorFromUnknown(err)
      logger.error('ipc', `${channel} 失败 code=${appError.code} ${appError.message}`)
      return fail(appError)
    }
  })
}

/**
 * 注册全部通道。
 *
 * 当前覆盖：system / runtime / project（T03/T06）、data（T07/T08）、analysis（T09/T10）。
 * enrich / plot / export 通道留待 T15–T17 —— 未注册的通道在渲染进程调用会 reject，
 * 因此 UI 在对应功能未上线前不要发起调用。
 */
export function registerAllHandlers(ctx: AppContext): void {
  registerSystemHandlers(ctx)
  registerProjectHandlers(ctx)
  registerDataHandlers(ctx)
  registerAnalysisHandlers(ctx)
  registerOutputHandlers(ctx)
  registerEnrichHandlers(ctx)
  registerGseaHandlers(ctx)
  registerWgcnaHandlers(ctx)
  registerScrnaHandlers(ctx)
  registerTimeSeriesHandlers(ctx)
  registerVizHandlers(ctx)
  logger.info('ipc', `IPC handler 注册完成，共 ${Object.keys(ctx).length} 项服务就绪`)
}
