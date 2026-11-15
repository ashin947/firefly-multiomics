import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * RRuntimeResolver 的单测。
 *
 * 必须 mock 'electron'：paths.ts 在模块加载时就读 app.isPackaged。
 * 这里不启动 Electron、也不需要真 R —— 正是要验证「本机没有 R 时不能崩」。
 */
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => path.join(path.sep, 'fake', 'repo'),
    getPath: () => path.join(path.sep, 'fake', 'userData'),
    getVersion: () => '1.0.0-test'
  }
}))

import { RRuntimeResolver, type RuntimeResolverDeps } from '../runtime/RRuntimeResolver'
import type { PathService } from '../paths'
import type { RProcessRunner } from '../process/RProcessRunner'
import type { LoggerLike, LogLine } from '../logger'

const REPO = path.join(path.sep, 'fake', 'repo')
const USER_DATA = path.join(path.sep, 'fake', 'userData')

function createFakePaths(): PathService {
  return {
    isDev: true,
    getResourcesRoot: () => path.join(REPO, 'resources'),
    getPackagedResourcesRoot: () => path.join(path.sep, 'fake', 'electron', 'resources'),
    getAppPathRoot: () => REPO,
    getRRuntimeRoot: () => path.join(REPO, 'resources', 'runtime', 'R'),
    getRlibsRoot: () => path.join(REPO, 'resources', 'runtime', 'R-libs'),
    getRlibsUserDir: () => path.join(USER_DATA, 'r-libs-user'),
    getRFontsDir: () => path.join(REPO, 'resources', 'runtime', 'fonts'),
    getRFontPath: () => path.join(REPO, 'resources', 'runtime', 'fonts', 'NotoSansSC-Regular.otf'),
    getDemoDir: () => path.join(REPO, 'resources', 'demo'),
    getDemoStressDir: () => path.join(REPO, 'resources', 'demo-stress'),
    getManifestPath: () => path.join(REPO, 'resources', 'r-libs-manifest.json'),
    getPlotThemePath: () => path.join(REPO, 'resources', 'plotTheme.json'),
    getRScriptsRoot: () => path.join(REPO, 'r'),
    getRscriptBinary: (root = path.join(REPO, 'resources', 'runtime', 'R')) =>
      path.join(root, 'bin', process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'),
    getUserDataDir: () => USER_DATA,
    getProbeCachePath: () => path.join(USER_DATA, 'runtime-probe.json'),
    getTempDir: () => path.join(USER_DATA, 'tmp'),
    getMainLogDir: () => path.join(USER_DATA, 'logs'),
    getRecentProjectsPath: () => path.join(USER_DATA, 'recent-projects.json'),
    getSettingsPath: () => path.join(USER_DATA, 'settings.json'),
    resolveInProject: (root, rel) => path.join(root, rel),
    toProjectRelative: (root, abs) => path.relative(root, abs).split(path.sep).join('/'),
    sanitizeFileName: (name) => name
  }
}

const silentLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  ringBuffer: (): LogLine[] => [],
  flush: () => undefined
}

/** 一个「永不成功」的 runner：如果被调用说明探测逻辑跑到了不该跑的地方 */
function createFakeRunner(): { runner: RProcessRunner; runCalls: () => number } {
  let calls = 0
  const runner = {
    run: async () => {
      calls += 1
      throw new Error('fake runner 不应被调用')
    }
  } as unknown as RProcessRunner
  return { runner, runCalls: () => calls }
}

function createDeps(overrides: RuntimeResolverDeps = {}): RuntimeResolverDeps {
  return {
    existsSync: () => false,
    statSync: () => null,
    which: () => null,
    readTextFile: () => null,
    writeTextFile: () => undefined,
    log: silentLogger,
    disableRevalidate: true,
    ...overrides
  }
}

describe('RRuntimeResolver —— 无 runtime 目录 + 无系统 R', () => {
  it('返回 ok:false 且不抛异常', async () => {
    const { runner, runCalls } = createFakeRunner()
    const resolver = new RRuntimeResolver(runner, createFakePaths(), createDeps())

    const info = await resolver.resolve()

    expect(info.ok).toBe(false)
    expect(info.rscriptPath).toBe('')
    expect(info.version).toBe('')
    expect(info.packages).toEqual([])
    expect(info.missingPackages).toEqual([])
    expect(info.speciesLibs).toEqual({ human: false, mouse: false })
    expect(info.fontAvailable).toBe(false)
    // 三级都没找到 → 不应该去 spawn 任何 R 进程
    expect(runCalls()).toBe(0)
    // 必须给出可操作的原因
    expect(info.warnings.join('\n')).toContain('未检测到 R 运行环境')
  })

  it('candidates() 按三级顺序给出候选，且都标记为不存在', () => {
    const { runner } = createFakeRunner()
    const resolver = new RRuntimeResolver(runner, createFakePaths(), createDeps())

    const candidates = resolver.candidates()
    expect(candidates).toHaveLength(3)
    expect(candidates[0].label).toContain('打包内置')
    expect(candidates[1].label).toContain('开发期目录')
    expect(candidates[2].label).toContain('系统 PATH')
    expect(candidates.every((c) => c.exists === false)).toBe(true)
  })

  it('包清单缺失时也不崩溃（降级为空清单）', async () => {
    const { runner } = createFakeRunner()
    const resolver = new RRuntimeResolver(runner, createFakePaths(), createDeps())
    await expect(resolver.resolve({ force: true })).resolves.toMatchObject({ ok: false })
  })

  it('找到 Rscript 但自检失败时，返回可读的 warnings 而不是抛异常', async () => {
    const runner = {
      run: async () => {
        throw new Error('Rscript 被安全软件拦截')
      }
    } as unknown as RProcessRunner

    const paths = createFakePaths()
    const resolver = new RRuntimeResolver(
      runner,
      paths,
      createDeps({
        // 只让第 1 级候选「存在」
        existsSync: (p: string) => p.includes(path.join('electron', 'resources'))
      })
    )

    const info = await resolver.resolve()
    expect(info.ok).toBe(false)
    expect(info.rscriptPath.length).toBeGreaterThan(0)
    expect(info.warnings.join('\n')).toContain('R 环境自检失败')
    expect(info.warnings.join('\n')).toContain('安全软件拦截')
  })

  it('探测成功时按清单判定缺失包，并把版本不足写进 warnings', async () => {
    const runner = {
      run: async () => ({
        ok: true,
        exitCode: 0,
        artifacts: [],
        stderr: '',
        durationMs: 12,
        cancelled: false,
        usedFallback: false,
        summary: {
          rVersion: '4.1.3', // 低于 4.2.0
          rArch: 'x86_64-w64-mingw32',
          platform: 'windows',
          packages: [
            { name: 'jsonlite', version: '1.8.8', ok: true, required: true },
            { name: 'DESeq2', version: null, ok: false, required: true }
          ],
          speciesLibs: { human: true, mouse: false },
          fontFamilies: ['sans']
        }
      })
    } as unknown as RProcessRunner

    const paths = createFakePaths()
    const resolver = new RRuntimeResolver(
      runner,
      paths,
      createDeps({
        existsSync: (p: string) => p.includes(path.join('electron', 'resources'))
      })
    )

    const info = await resolver.resolve()
    expect(info.ok).toBe(false)
    expect(info.version).toBe('4.1.3')
    expect(info.missingPackages).toContain('DESeq2')
    expect(info.fontAvailable).toBe(false)
    expect(info.warnings.join('\n')).toContain('低于要求的 4.2.0')
  })

  it('按方法判包：缺 DESeq2 时 limma-voom 仍标记为可用', async () => {
    const runner = {
      run: async () => ({
        ok: true,
        exitCode: 0,
        artifacts: [],
        stderr: '',
        durationMs: 12,
        cancelled: false,
        usedFallback: false,
        summary: {
          rVersion: '4.3.2',
          rArch: 'x86_64-w64-mingw32',
          platform: 'windows',
          packages: [
            { name: 'jsonlite', version: '1.8.8', ok: true, required: true },
            { name: 'limma', version: '3.58.1', ok: true, required: true },
            { name: 'edgeR', version: '4.0.16', ok: true, required: true },
            { name: 'data.table', version: '1.15.4', ok: true, required: true },
            { name: 'DESeq2', version: null, ok: false, required: true }
          ],
          speciesLibs: { human: true, mouse: true },
          fontFamilies: ['DEGSans']
        }
      })
    } as unknown as RProcessRunner

    const resolver = new RRuntimeResolver(
      runner,
      createFakePaths(),
      createDeps({
        existsSync: (p: string) => p.includes(path.join('electron', 'resources')),
        methodSpecs: () => [
          { id: 'limma-voom', label: 'limma-voom', requiredPackages: ['limma', 'edgeR', 'data.table'] },
          { id: 'deseq2', label: 'DESeq2', requiredPackages: ['DESeq2', 'edgeR', 'data.table'] }
        ]
      })
    )

    const info = await resolver.resolve()
    // 全局 ok 仍是 false（清单里 DESeq2 是必需包），但**方法层面**只有 deseq2 不可用
    expect(info.ok).toBe(false)
    expect(info.methods).toHaveLength(2)
    const voom = info.methods.find((m) => m.id === 'limma-voom')
    const deseq2 = info.methods.find((m) => m.id === 'deseq2')
    expect(voom).toMatchObject({ available: true, missingPackages: [] })
    expect(deseq2).toMatchObject({ available: false, missingPackages: ['DESeq2'] })
  })

  it('invalidate() 之后强制重探（不读缓存）', async () => {
    const { runner } = createFakeRunner()
    const resolver = new RRuntimeResolver(runner, createFakePaths(), createDeps())
    resolver.invalidate()
    const info = await resolver.resolve()
    expect(info.ok).toBe(false)
  })
})
