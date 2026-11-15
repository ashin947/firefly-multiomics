/**
 * 主进程层集成测试：真实 demo 数据 → 导入 → 校验 → 运行 limma-voom → 结果加载。
 *
 * ⚠️ 本机没有安装 R，因此 `runLimmaVoom` 这一步用**注入的 RRunner 桩**代替真实 R：
 * 桩按真实协议序列化/解析进度消息，并写出真实的 de.csv。
 * 因此本测试验证的是：
 *   ① 协议往返（serialize → parse → onProgress）
 *   ② 六阶段进度依次到达
 *   ③ 结果落盘（de.csv / meta.json / project.json）
 *   ④ ResultLoader 逐行校验通过
 * **R 真实执行未验证** —— 这一项必须在有 R 的机器上由 verify:r + 手工跑一次补上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseProtocolLine, serializeProtocolMessage } from '@shared/protocol'
import { STAGES } from '@shared/constants'
import type { DEConfig } from '@shared/types/analysis'
import type { ProjectMeta } from '@shared/types/project'
import type { PathService } from '../paths'
import type { ProjectService } from '../project/ProjectService'
import type { RRunner, RunROptions, RunRResult } from '../process/RProcessRunner'
import { AnalysisRunner } from '../analysis/AnalysisRunner'
import { limmaVoomModule } from '../analysis/modules/limmaVoom'
import { AnalysisRegistry } from '../analysis/registry'
import { ResultLoader } from '../analysis/ResultLoader'
import { DataValidator } from '../data/DataValidator'
import { GroupImporter } from '../data/GroupImporter'
import { MatrixImporter } from '../data/MatrixImporter'
import { ChildProcessManager } from '../process/ChildProcessManager'
import { ProjectStore } from '../project/ProjectStore'
import { tempDir } from '../data/__tests__/fixtures'

const DEMO_DIR = path.resolve(process.cwd(), 'resources/demo')
const LIMma_STAGES = ['read', 'filter', 'normalize', 'fit', 'test', 'write'] as const

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

const fakePaths = {
  getPlotThemePath: () => path.join(process.cwd(), 'resources/plotTheme.json'),
  getRFontPath: () => path.join(process.cwd(), 'resources/runtime/fonts/NotoSansSC-Regular.otf'),
  getDemoDir: () => DEMO_DIR
} as unknown as PathService

/**
 * 假 R：模拟 run_limma_voom.R 的输出行为。
 * @param geneIds 真实基因 ID（让结果文件与 demo 数据同源）
 */
function createLimmaStub(geneIds: string[]): RRunner {
  return {
    async run(opts: RunROptions): Promise<RunRResult> {
      fs.mkdirSync(opts.runDir, { recursive: true })

      // 六阶段进度：按真实协议序列化 → 解析 → 回调
      for (let i = 0; i < LIMma_STAGES.length; i += 1) {
        const line = serializeProtocolMessage({
          v: 1,
          type: 'progress',
          seq: i + 1,
          ts: Date.now(),
          stage: LIMma_STAGES[i] as never,
          pct: Math.round(((i + 1) / LIMma_STAGES.length) * 100)
        })
        const parsed = parseProtocolLine(line)
        if (parsed && parsed.type === 'progress') opts.onProgress?.(parsed)
      }

      // 写出 500 行结果（覆盖「行数较多」的加载路径，同时保持测试够快）
      const rows = geneIds.slice(0, 500).map((id, index) => {
        const logFC = index % 3 === 0 ? 1.5 + index * 0.001 : index % 3 === 1 ? -1.5 : 0.1
        const p = index % 3 === 0 ? 0.0005 : index % 3 === 1 ? 0.008 : 0.6
        const adj = p * 2
        const regulation = p < 0.05 ? (logFC > 0 ? 'up' : 'down') : 'ns'
        return `${id},${id},${logFC},${(5 + index * 0.01).toFixed(3)},${(logFC * 3).toFixed(
          3
        )},${p},${adj},1.5,${regulation}`
      })
      const csv = ['gene_id,gene_name,logFC,aveExpr,t,pValue,adjPValue,b,regulation', ...rows].join('\n')
      fs.writeFileSync(path.join(opts.runDir, 'de.csv'), `${csv}\n`, 'utf8')

      return {
        ok: true,
        exitCode: 0,
        summary: {
          genesAfterFilter: rows.length,
          up: Math.ceil(rows.length / 3),
          down: Math.floor(rows.length / 3),
          ns: rows.length - Math.ceil(rows.length / 3) - Math.floor(rows.length / 3),
          filteredOut: 1234,
          durationMs: 2500
        },
        artifacts: [
          {
            v: 1,
            type: 'artifact',
            seq: 50,
            ts: Date.now(),
            kind: 'de_table',
            path: 'de.csv',
            rows: rows.length
          }
        ],
        stderr: '',
        durationMs: 2500,
        cancelled: false,
        usedFallback: false
      }
    }
  }
}

describe('集成：demo 数据 importMatrix → validate → runLimmaVoom', () => {
  it('全链路跑通，摘要/进度/落盘/结果加载四项均正确', async () => {
    // ---------- 0. 准备项目目录 ----------
    const root = tempDir('deg-integration-')
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.mkdirSync(path.join(root, 'results/de'), { recursive: true })
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true })

    const expressionFile = path.join(DEMO_DIR, 'expression.csv')
    const groupsFile = path.join(DEMO_DIR, 'groups.csv')
    expect(fs.existsSync(expressionFile)).toBe(true)

    // ---------- 1. 导入矩阵 ----------
    const importer = new MatrixImporter()
    const imported = importer.importMatrix({
      filePath: expressionFile,
      dataType: 'counts',
      species: 'human',
      projectRoot: root
    })
    expect(imported.summary.geneCount).toBe(2000)
    expect(imported.summary.sampleCount).toBe(24)
    expect(imported.requiresChoice).toBe(false)
    expect(imported.detectedGeneIdType).toBe('SYMBOL')
    expect(fs.existsSync(path.join(root, 'data/expression.clean.csv'))).toBe(true)

    // ---------- 2. 导入分组表 ----------
    const groupImporter = new GroupImporter()
    const groupResult = groupImporter.importGroups({ filePath: groupsFile })
    expect(Object.keys(groupResult.groups).sort()).toEqual(['Normal', 'Tumor'])
    expect(groupResult.groups.Tumor).toHaveLength(12)
    expect(groupResult.groups.Normal).toHaveLength(12)
    groupImporter.writeNormalized(groupResult.groups, root)

    // ---------- 3. 校验（真实 13 条规则链） ----------
    const matrix = importer.getCleaned()
    expect(matrix).not.toBeNull()
    const issues = new DataValidator().validate({
      matrix: matrix!,
      groups: groupResult.groups,
      groupColumn: 'group',
      dataType: 'counts',
      method: 'limma-voom',
      ...(importer.getSourceInfo() ? { source: importer.getSourceInfo()! } : {})
    })
    const blocking = issues.filter((issue) => issue.level === 'error')
    expect(blocking).toEqual([])
    // demo 数据应当有分组样本数的 warning（每组 12 个 → 不应该有），这里只断言没有 error
    expect(issues.every((issue) => issue.level !== 'error')).toBe(true)

    // ---------- 4. 组装项目并运行分析 ----------
    const meta: ProjectMeta = {
      schemaVersion: 1,
      projectId: 'p-integration',
      name: 'demo-integration',
      species: 'human',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      status: 'imported',
      dataType: 'counts',
      dataset: {
        ...imported.summary,
        groups: groupResult.groups,
        issues,
        hasBlockingIssue: false
      },
      analyses: [],
      enrichRuns: [],
      plots: {}
    }

    const store = new ProjectStore()
    store.set(meta, root)

    const fakeProjectService = {
      save: (patch: Partial<ProjectMeta>): ProjectMeta => {
        const next = { ...store.require(), ...patch }
        store.set(next, root)
        fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(next, null, 2), 'utf8')
        return next
      }
    } as unknown as ProjectService

    const events: { channel: string; payload: unknown }[] = []
    const registry = new AnalysisRegistry()
    registry.register(limmaVoomModule)

    const runner = new AnalysisRunner({
      runner: createLimmaStub(matrix!.geneIds),
      paths: fakePaths,
      projectStore: store,
      projectService: fakeProjectService,
      registry,
      children: new ChildProcessManager(),
      emit: (channel, payload) => events.push({ channel, payload }),
      runtimeInfo: async () => null,
      getCleanedMatrix: () => importer.getCleaned()
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

    const { runId } = runner.start({ method: 'limma-voom', config })
    await runner.waitFor(runId)

    // ① 六阶段进度依次到达
    const progress = events
      .filter((e) => e.channel === 'deg:event:analysisProgress')
      .map((e) => e.payload as { stage: string; pct: number })
    const stageOrder = progress
      .map((p) => p.stage)
      .filter((stage, index, arr) => arr.indexOf(stage) === index)
    expect(stageOrder).toEqual(LIMma_STAGES.filter((s) => STAGES.includes(s as never)))
    expect(Math.max(...progress.map((p) => p.pct))).toBe(100)

    // ② 完成事件
    const done = events.find((e) => e.channel === 'deg:event:analysisDone')?.payload as
      | { status: string; result?: { analysisId: string; rowCount: number } }
      | undefined
    expect(done?.status).toBe('success')
    expect(done?.result?.rowCount).toBe(500)

    // ③ 结果落盘 + project.json 更新
    const runDir = path.join(root, 'results/de', runId)
    expect(fs.existsSync(path.join(runDir, 'de.csv'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'meta.json'))).toBe(true)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) as ProjectMeta
    expect(saved.status).toBe('analyzed')
    expect(saved.analyses).toHaveLength(1)
    expect(saved.analyses[0].stats.totalGenesAfterFilter).toBe(500)
    expect(saved.analyses[0].stats.filteredOutCount).toBe(1234)
    expect(saved.analyses[0].label).toContain('Tumor vs Normal')
    expect(saved.lastRun?.status).toBe('success')

    // ④ ResultLoader 逐行校验通过，且 up/down/ns 之和 == 行数
    const loaded = new ResultLoader().load(runDir)
    expect(loaded.rows).toHaveLength(500)
    expect(loaded.stats.upCount + loaded.stats.downCount + loaded.stats.nsCount).toBe(500)
    expect(loaded.rows[0].geneId).toBe(matrix!.geneIds[0])
  })
})
