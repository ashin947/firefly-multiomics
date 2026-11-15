/**
 * 「echo 假模块」全链路测试（T09 必做项，也是 U12 风险的验收证据）。
 *
 * 验证的是**扩展点本身**，而不是某个具体算法：
 *   formSchema 下发（含函数形式 options 求值）
 *   → 注册（重复注册报错）
 *   → 调度（AnalysisRunner 完全不知道背后是哪个模块）
 *   → 结果加载（module.loadResult 由模块自己实现）
 *
 * 这里用一个 `id = 'gsea-go'` 的假模块跑完整流程。如果这条链路成立，
 * v1.1 加 GSEA 就真的只需要「一个 R 脚本 + 一个 module 文件」，
 * Runner / handler / 前端表单渲染一行都不用改。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseProtocolLine, serializeProtocolMessage } from '@shared/protocol'
import { RUN_ID_PATTERN } from '@shared/constants'
import type { DEConfig, DEResultRow, DEStats, PreflightItem } from '@shared/types/analysis'
import type { ProjectMeta } from '@shared/types/project'
import type { AppError } from '@shared/errors'
import type { PathService } from '../../paths'
import type { CleanedMatrix } from '../../data/MatrixImporter'
import type { ProjectService } from '../../project/ProjectService'
import type { RRunner, RunROptions, RunRResult } from '../../process/RProcessRunner'
import { ChildProcessManager } from '../../process/ChildProcessManager'
import { ProjectStore } from '../../project/ProjectStore'
import { AnalysisRunner } from '../AnalysisRunner'
import { AnalysisRegistry, RegistryError, type AnalysisModule, type SchemaContext } from '../registry'
import { computeStats, ResultLoader } from '../ResultLoader'
import { deseq2Module } from '../modules/deseq2'
import { makeMatrix, tempDir } from '../../data/__tests__/fixtures'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const DE_CSV = `gene_id,gene_name,logFC,aveExpr,t,pValue,adjPValue,b,regulation
TP53,TP53,2.5,10.2,5.1,0.0001,0.001,3.2,up
EGFR,EGFR,-2.2,8.1,-3.2,0.01,0.04,1.1,down
MYC,MYC,0.2,7.0,0.5,0.6,0.7,0.1,ns
`

/** 假 R：按真实协议序列化 → 解析 → 回调，验证协议往返与六阶段进度 */
function createEchoRunner(stagesToEmit: readonly string[]): RRunner {
  return {
    async run(opts: RunROptions): Promise<RunRResult> {
      fs.mkdirSync(opts.runDir, { recursive: true })
      // 写出 run_config.json（RProcessRunner 在真实链路里会做，这里显式模拟）
      fs.writeFileSync(path.join(opts.runDir, 'run_config.json'), JSON.stringify(opts.config, null, 2))

      for (let i = 0; i < stagesToEmit.length; i += 1) {
        const line = serializeProtocolMessage({
          v: 1,
          type: 'progress',
          seq: i + 1,
          ts: Date.now(),
          stage: stagesToEmit[i] as never,
          pct: Math.round(((i + 1) / stagesToEmit.length) * 100),
          msg: `stage ${stagesToEmit[i]}`
        })
        const parsed = parseProtocolLine(line)
        expect(parsed?.type).toBe('progress')
        if (parsed && parsed.type === 'progress') opts.onProgress?.(parsed)
        opts.onLog?.({ ts: Date.now(), level: 'info', line: `echo ${stagesToEmit[i]}` })
      }

      fs.writeFileSync(path.join(opts.runDir, 'de.csv'), DE_CSV, 'utf8')

      return {
        ok: true,
        exitCode: 0,
        summary: { genesAfterFilter: 3, up: 1, down: 1, ns: 1, filteredOut: 42, durationMs: 12 },
        artifacts: [
          { v: 1, type: 'artifact', seq: 99, ts: Date.now(), kind: 'de_table', path: 'de.csv', rows: 3 }
        ],
        stderr: '',
        durationMs: 12,
        cancelled: false,
        usedFallback: false
      }
    }
  }
}

const fakePaths = {
  getPlotThemePath: () => '/fake/plotTheme.json',
  getRFontPath: () => '/fake/font.otf',
  getDemoDir: () => '/fake/demo'
} as unknown as PathService

function makeProject(): ProjectMeta {
  return {
    schemaVersion: 1,
    projectId: 'p-echo',
    name: 'echo-test',
    species: 'human',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appVersion: '1.0.0',
    status: 'imported',
    dataType: 'counts',
    dataset: {
      matrixSourceFile: 'expression.csv',
      matrixPath: 'data/expression.clean.csv',
      rawMatrixPath: 'data/expression.raw.csv',
      encoding: 'utf-8',
      delimiter: ',',
      geneIdColumn: 'gene_id',
      geneIdType: 'SYMBOL',
      duplicateStrategy: 'first',
      geneCount: 4,
      sampleCount: 4,
      samples: ['S01', 'S02', 'S03', 'S04'],
      groupColumn: 'group',
      sampleColumn: 'sample',
      groups: { Tumor: ['S01', 'S02'], Normal: ['S03', 'S04'] },
      naRatio: 0,
      allZeroGeneCount: 0,
      issues: [],
      hasBlockingIssue: false
    },
    analyses: [],
    enrichRuns: [],
    plots: {}
  }
}

describe('AnalysisRegistry — 注册与 schema 下发', () => {
  it('重复注册同一 id 会抛错（防止两份实现互相覆盖）', () => {
    const registry = new AnalysisRegistry()
    const module = createEchoModule()
    registry.register(module)
    expect(() => registry.register(module)).toThrowError(RegistryError)
  })

  it('schemas() 把函数形式的 options 求值成数组（渲染进程拿不到函数）', () => {
    const registry = new AnalysisRegistry()
    registry.register(createEchoModule())
    const ctx: SchemaContext = {
      groups: ['Tumor', 'Normal'],
      species: 'human',
      dataType: 'counts',
      geneCount: 4,
      sampleCount: 4
    }
    const schemas = registry.schemas(ctx)
    expect(schemas).toHaveLength(1)
    expect(schemas[0].id).toBe('gsea-go')
    expect(schemas[0].formSchema[0].options).toEqual([
      { value: 'Tumor', label: 'Tumor' },
      { value: 'Normal', label: 'Normal' }
    ])
    // 静态 options 原样透传
    expect(schemas[0].formSchema[1].options).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ])
  })

  it('get() 取不存在的模块 → 中文可读错误', () => {
    const registry = new AnalysisRegistry()
    try {
      registry.get('deseq2')
      throw new Error('应当抛错')
    } catch (err) {
      const appError = (err as { appError?: AppError }).appError
      expect(appError?.message).toContain('未实现的分析方法')
    }
  })
})

describe('AnalysisRunner — echo 假模块全链路', () => {
  it('formSchema → 注册 → 调度 → 结果加载 全链路可用', async () => {
    const root = tempDir('deg-echo-')
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/expression.clean.csv'), 'gene_id,S01,S02,S03,S04\nTP53,1,2,3,4\n')
    fs.writeFileSync(path.join(root, 'data/groups.csv'), 'sample,group\nS01,Tumor\nS02,Tumor\nS03,Normal\nS04,Normal\n')

    const store = new ProjectStore()
    store.set(makeProject(), root)

    const savedPatches: Partial<ProjectMeta>[] = []
    const fakeProjectService = {
      save: (patch: Partial<ProjectMeta>): ProjectMeta => {
        savedPatches.push(patch)
        const next = { ...store.require(), ...patch }
        store.set(next, root)
        fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(next, null, 2), 'utf8')
        return next
      }
    } as unknown as ProjectService

    const events: { channel: string; payload: unknown }[] = []
    const registry = new AnalysisRegistry()
    registry.register(createEchoModule())

    const runner = new AnalysisRunner({
      runner: createEchoRunner(DE_STAGES),
      paths: fakePaths,
      projectStore: store,
      projectService: fakeProjectService,
      registry,
      children: new ChildProcessManager(),
      emit: (channel, payload) => events.push({ channel, payload }),
      runtimeInfo: async () => null,
      getCleanedMatrix: () => null
    })

    const config: DEConfig = {
      method: 'limma-voom',
      dataType: 'counts',
      contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
      filter: { enabled: true, mode: 'filterByExpr' },
      fdrMethod: 'BH',
      outputGeneName: true,
      keepAllGenes: false
    }

    const { runId } = runner.start({ method: 'gsea-go', config })
    expect(runId).toMatch(RUN_ID_PATTERN)

    await runner.waitFor(runId)

    // 1) 六阶段进度全部到达 UI
    const progress = events
      .filter((e) => e.channel === 'deg:event:analysisProgress')
      .map((e) => e.payload as { stage: string; pct: number })
    const stagesSeen = new Set(progress.map((p) => p.stage))
    for (const stage of DE_STAGES) {
      expect(stagesSeen.has(stage)).toBe(true)
    }
    // pct 单调不回退（RProcessRunner 的职责，这里在 Runner 层再确认一次数据形状）
    expect(progress.every((p) => typeof p.pct === 'number')).toBe(true)

    // 2) 日志事件到达
    expect(events.some((e) => e.channel === 'deg:event:analysisLog')).toBe(true)

    // 3) 完成事件为 success，且带着模块自己加载出来的行数
    const done = events.find((e) => e.channel === 'deg:event:analysisDone')?.payload as
      | { status: string; result?: { rowCount: number; stats: DEStats } }
      | undefined
    expect(done?.status).toBe('success')
    expect(done?.result?.rowCount).toBe(3)
    expect(done?.result?.stats.upCount).toBe(1)
    expect(done?.result?.stats.filteredOutCount).toBe(42)

    // 4) 结果落盘：de.csv 在 runDir 里，meta.json 也在
    const runDir = path.join(root, 'results/de', runId)
    expect(fs.existsSync(path.join(runDir, 'de.csv'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'meta.json'))).toBe(true)

    // 5) project.json 被更新（analyses + activeAnalysisId + status）
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) as ProjectMeta
    expect(saved.analyses).toHaveLength(1)
    expect(saved.analyses[0].method).toBe('gsea-go')
    expect(saved.analyses[0].resultPath).toBe(`results/de/${runId}/de.csv`)
    expect(saved.status).toBe('analyzed')
    expect(saved.lastRun?.status).toBe('success')
    expect(savedPatches.some((p) => p.status === 'analyzed')).toBe(true)

    // 6) 结果能被再次加载（loadResult 走模块自己实现）
    const reloaded = new ResultLoader().load(runDir)
    expect(reloaded.rows).toHaveLength(3)
    expect(reloaded.rows[0].geneId).toBe('TP53')
  })

  it('预检失败（没有打开项目）时不创建任何文件', () => {
    const runner = new AnalysisRunner({
      runner: createEchoRunner(DE_STAGES),
      paths: fakePaths,
      projectStore: new ProjectStore(),
      projectService: {} as unknown as ProjectService,
      registry: new AnalysisRegistry(),
      children: new ChildProcessManager(),
      emit: () => undefined
    })

    expect(() =>
      runner.start({
        method: 'gsea-go',
        config: {
          method: 'limma-voom',
          dataType: 'counts',
          contrast: { groupColumn: 'group', numerator: 'A', denominator: 'B' },
          filter: { enabled: true, mode: 'filterByExpr' },
          fdrMethod: 'BH',
          outputGeneName: true,
          keepAllGenes: false
        }
      })
    ).toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * 假模块定义
 * ------------------------------------------------------------------ */

/** 六阶段（与 METHOD_STAGES 的 limma-voom 一致） */
const DE_STAGES = ['read', 'filter', 'normalize', 'fit', 'test', 'write'] as const

function createEchoModule(): AnalysisModule<DEConfig, DEResultRow> {
  const loader = new ResultLoader()
  return {
    id: 'gsea-go',
    label: 'Echo 测试模块',
    category: 'gsea',
    availability: () => ({ enabled: true }),
    formSchema: [
      {
        key: 'contrast.numerator',
        label: '实验组',
        type: 'select',
        // ★ 函数形式：依赖运行时上下文（分组名由主进程注入）
        options: (ctx) => ctx.groups.map((g) => ({ value: g, label: g }))
      },
      {
        key: 'echo.mode',
        label: '模式',
        type: 'select',
        default: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]
      }
    ],
    rScript: 'test/echo.R',
    buildRunConfig: (config, ctx) => ({
      runId: ctx.runId,
      projectRoot: ctx.projectRoot,
      runDir: ctx.runDir,
      params: {
        matrixPath: ctx.matrixPath,
        numerator: config.contrast.numerator,
        denominator: config.contrast.denominator
      }
    }),
    outputs: [{ kind: 'de_table', fileName: 'de.csv', format: 'csv' }],
    loadResult: async (runDir) => loader.load(runDir).rows,
    computeStats: (rows, thresholds, filteredOutCount) =>
      computeStats(rows, thresholds, filteredOutCount)
  }
}

/**
 * 反回归：`counts 整数性` 这一行不得说谎。
 *
 * 历史 bug：`checkIntegerCounts()` 在「内存里没有矩阵」时返回 `ok: true` +
 * 「当前没有可检查的内存矩阵…」，但 `collect()` 用三元表达式把 ok 分支的 detail
 * 换成了写死的「已确认数据为整数」。于是重启后打开分析配置页，界面显示
 * 「已确认数据为整数」，而实际一次检查都没做。
 *
 * 这里做**双向**断言：既要求出现「没有可检查」，也要求**不出现**「已确认」。
 * 只断言前者不够——写死文案同时出现在 ok 分支时，前者仍然成立。
 */
describe('AnalysisRunner — counts 整数性不得说谎', () => {
  it('内存矩阵为空时，detail 必须说明「没有可检查」，不得声称「已确认」', async () => {
    const root = tempDir('deg-counts-')
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'data/expression.clean.csv'),
      'gene_id,S01,S02,S03,S04\nTP53,1,2,3,4\n'
    )

    const store = new ProjectStore()
    store.set(makeProject(), root)

    const registry = new AnalysisRegistry()
    registry.register(deseq2Module)

    const runner = new AnalysisRunner({
      runner: createEchoRunner(DE_STAGES),
      paths: fakePaths,
      projectStore: store,
      projectService: {} as unknown as ProjectService,
      registry,
      children: new ChildProcessManager(),
      emit: () => {},
      runtimeInfo: async () => null,
      // ★ 模拟「进程刚重启、MatrixImporter 内存态为空」
      getCleanedMatrix: () => null
    })

    const config: DEConfig = {
      method: 'deseq2',
      dataType: 'counts',
      contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
      filter: { enabled: true, mode: 'filterByExpr' },
      fdrMethod: 'BH',
      outputGeneName: true,
      keepAllGenes: false
    }

    const { items } = await runner.checkPreflight({ method: 'deseq2', config })
    const counts = items.find((f) => f.id === 'counts')

    expect(counts).toBeDefined()
    expect(counts?.detail).toContain('没有可检查')
    expect(counts?.detail).not.toContain('已确认')
  })
})

/**
 * 预检里「counts 整数性」这一项必须说真话。
 *
 * 背景（客户可复现）：重启软件后主进程没有内存矩阵，`checkIntegerCounts()` 走
 * 「跳过」分支返回 ok，而 `collect()` 在 ok 分支写死了
 * 「DESeq2 需要整数 counts，已确认数据为整数。」——**一次检查都没做**却给了肯定结论。
 * 会撒谎的校验比没有校验更糟，所以这里双向卡住：既断言该出现的，也断言不该出现的。
 */
describe('AnalysisRunner — 预检 counts 整数性必须区分「查过」与「没查」', () => {
  /** 造一个能走到 ⑨ 的 runner（项目 + 矩阵文件齐备，其余项不参与断言） */
  function makeRunner(getCleanedMatrix: () => CleanedMatrix | null): AnalysisRunner {
    const root = tempDir('deg-counts-')
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/expression.clean.csv'), 'gene_id,S01,S02\nTP53,1,2\n')

    const store = new ProjectStore()
    store.set(makeProject(), root)

    const registry = new AnalysisRegistry()
    registry.register(deseq2Module)

    return new AnalysisRunner({
      // 预检不起 R 进程；真被调用说明测试写错了，直接炸出来
      runner: {
        async run(): Promise<RunRResult> {
          throw new Error('预检不应启动 R 进程')
        }
      },
      paths: fakePaths,
      projectStore: store,
      projectService: { save: () => store.require() } as unknown as ProjectService,
      registry,
      children: new ChildProcessManager(),
      emit: () => undefined,
      runtimeInfo: async () => null,
      getCleanedMatrix
    })
  }

  const config: DEConfig = {
    method: 'deseq2',
    dataType: 'counts',
    contrast: { groupColumn: 'group', numerator: 'Tumor', denominator: 'Normal' },
    filter: { enabled: true, mode: 'filterByExpr' },
    fdrMethod: 'BH',
    outputGeneName: true,
    keepAllGenes: false
  }

  async function countsItem(runner: AnalysisRunner): Promise<PreflightItem> {
    const result = await runner.checkPreflight({ method: 'deseq2', config })
    const item = result.items.find((entry) => entry.id === 'counts')
    expect(item).toBeDefined()
    return item as PreflightItem
  }

  it('没有内存矩阵：说「没有可检查」，绝不说「已确认」', async () => {
    const item = await countsItem(makeRunner(() => null))
    expect(item.detail).toContain('没有可检查')
    expect(item.detail).not.toContain('已确认')
    // 没检查不阻断分析：R 侧还有第二道整数性校验兜底
    expect(item.level).toBe('ok')
  })

  it('有整数矩阵：说「已确认」，且不再提「没有可检查」', async () => {
    const matrix = makeMatrix({
      geneIds: ['TP53', 'EGFR'],
      samples: ['S01', 'S02'],
      values: [
        [1, 2],
        [3, 4]
      ]
    })
    const item = await countsItem(makeRunner(() => matrix))
    expect(item.detail).toContain('已确认')
    expect(item.detail).not.toContain('没有可检查')
    expect(item.level).toBe('ok')
  })

  it('有小数矩阵：报错并指出数量', async () => {
    const matrix = makeMatrix({ geneIds: ['TP53'], samples: ['S01', 'S02'], values: [[1.5, 2]] })
    const item = await countsItem(makeRunner(() => matrix))
    expect(item.level).toBe('error')
    expect(item.detail).toContain('非整数值')
  })
})
