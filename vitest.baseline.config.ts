/**
 * 客户数据基线（L4）—— 只在**有客户数据**的机器上跑，默认单测不会碰到它。
 *
 * 为什么单独一份配置：`vitest.config.ts` 的 include 只收 `src/**`，
 * 这里的用例要读 `D:/ai/data` 下的真实矩阵、起真 R、跑几分钟，
 * 放进默认套件会把「单测 20 秒」变成「单测 10 分钟」，那就没人愿意跑了。
 *
 * 用法：`npm run regress:baseline`
 *   DEG_DATA_DIR=<目录>  指定数据目录（默认 D:/ai/data）
 *   DEG_RSCRIPT=<路径>   指定 Rscript（默认 内置 → D:/R-4.3.2 → 系统）
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  cacheDir: resolve(__dirname, 'node_modules/.vite-cache'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['scripts/baseline/**/*.baseline.ts'],
    exclude: ['node_modules', 'out', 'dist'],
    reporters: 'default',
    cache: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // 客户数据单跑一次就要几分钟（moanin 2 万基因 × 8 簇），默认 5 秒超时必然误报
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60 * 1000
  }
})
