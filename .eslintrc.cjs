/* eslint-env node */
/**
 * ESLint 配置。
 *
 * 两条「铁律」用规则强制，而不是靠 review：
 *  1. process.resourcesPath / app.getAppPath() 只允许出现在 src/main/paths.ts
 *  2. 渲染进程禁止 import Node 内置模块（nodeIntegration: false）
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  },
  plugins: ['@typescript-eslint', 'import', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  settings: {
    'import/resolver': {
      node: { extensions: ['.js', '.ts', '.tsx'] }
    }
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
    'prefer-const': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn'
  },
  overrides: [
    {
      // ★ 铁律 1：路径解析集中化
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      excludedFiles: ['src/main/paths.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "MemberExpression[object.property.name='resourcesPath']",
            message:
              'process.resourcesPath 只允许出现在 src/main/paths.ts —— 请改用 paths.ts 导出的函数。'
          },
          {
            selector: "CallExpression[callee.property.name='getAppPath']",
            message:
              'app.getAppPath() 只允许出现在 src/main/paths.ts —— 请改用 paths.ts 导出的函数。'
          }
        ]
      }
    },
    {
      // ★ 铁律 2：渲染进程无 Node
      files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
      rules: {
        'import/no-nodejs-modules': 'error',
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: '渲染进程只能通过 window.deg 访问主进程能力。' },
              { name: 'fs', message: '渲染进程不得使用 fs，请通过 window.deg 调用。' },
              { name: 'path', message: '渲染进程不得使用 path。' },
              { name: 'child_process', message: '渲染进程不得使用 child_process。' }
            ]
          }
        ]
      }
    },
    {
      // 共享层必须保持「纯」：不得 import electron / node 模块
      files: ['src/shared/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: 'src/shared 必须主/渲染两侧通用，不得依赖 electron。' },
              { name: 'fs', message: 'src/shared 不得依赖 Node API。' },
              { name: 'path', message: 'src/shared 不得依赖 Node API。' },
              { name: 'child_process', message: 'src/shared 不得依赖 Node API。' }
            ]
          }
        ]
      }
    },
    {
      // ★ 测试文件不进产物，允许用 Node 内置模块（读夹具、拼路径）。
      //   只放开 `**/__tests__/**`：src/renderer 的**产品代码**仍然禁止 import Node 模块。
      files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'import/no-nodejs-modules': 'off',
        'no-restricted-imports': 'off'
      }
    },
    {
      // ★ 客户数据基线（scripts/baseline/**）是「跑真 R、打印数字给人看」的验证脚本：
      //   console 就是它的输出通道（数字要能贴进 issue），和 *__tests__* 同性质。
      files: ['scripts/baseline/**/*.ts'],
      rules: {
        'no-console': 'off'
      }
    }
  ],
  ignorePatterns: ['node_modules', 'out', 'dist', 'release', 'resources', 'r', 'scripts/*.mjs']
}
