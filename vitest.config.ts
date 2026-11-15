import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单测配置。
 *
 * 只跑纯函数与可注入依赖的服务类（不启动 Electron）。
 * 依赖 electron 的模块在测试里用 vi.mock('electron', factory) 打桩。
 */
export default defineConfig({
  // ★ 渲染层组件测试用 .tsx，必须用「自动 JSX」运行时：
  //   默认的 classic 转换会编译成 React.createElement，而组件文件里并没有
  //   `import React`（应用用 react-jsx），结果是 jsdom 测试里报 "React is not defined"。
  esbuild: { jsx: 'automatic' },
  // ★ 显式把 Vite 的缓存目录放到仓库内：
  //   某些沙箱/CI 环境禁止写系统临时目录，vitest 会把「SSR 模块缓存写失败」
  //   表现为「只收集到部分测试文件」+ unhandled EPERM，非常难查。
  cacheDir: resolve(__dirname, 'node_modules/.vite-cache'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
      // 渲染层组件测试需要 .tsx（用 @vitest-environment jsdom 文件头按需切换环境）
      'src/**/__tests__/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx'
    ],
    exclude: ['node_modules', 'out', 'dist'],
    reporters: 'default',
    // 关闭 vitest 自身的 SSR 缓存：它默认写系统临时目录，沙箱下会 EPERM，
    // 表现为「随机少收集几个测试文件」——比测试失败更难排查。
    cache: false,
    // 用 forks 而不是默认的 threads：
    //  - 部分 CI/沙箱环境限制 worker_threads 写 SSR 缓存目录（EPERM），threads 池会随机少收测试文件；
    //  - 本项目的测试会 touch 文件系统（项目服务、日志），进程隔离更接近真实运行环境。
    pool: 'forks',
    // ★ 单进程跑（singleFork）：并发 fork 时多个子进程同时往系统临时目录写
    //   SSR 模块缓存，在受限沙箱里会 EPERM，导致「随机少收集 1~2 个测试文件」。
    //   本项目测试总量 100+ 且单文件耗时 < 300ms，串行代价可忽略，换来的是确定性。
    poolOptions: {
      forks: { singleFork: true }
    }
  }
})
