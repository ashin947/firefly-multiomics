import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * CSP 注入插件。
 *
 * 为什么不用静态 meta：开发期 Vite 会注入内联的 react-refresh 预置脚本，生产期不允许任何内联脚本。
 * 同一个 index.html 需要两套策略，因此用 transformIndexHtml 按「是否 dev server」替换占位符。
 * 放在 HTML 里（而不是 webRequest 头）是因为生产期走 file:// 协议，webRequest 拦不到。
 */
function cspPlugin(): Plugin {
  const PROD_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'"
  ].join('; ')

  // 开发期额外放开：内联脚本（react-refresh）、HMR websocket、本地 http 资源
  const DEV_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')

  return {
    name: 'deg-csp-injector',
    transformIndexHtml(html: string, ctx) {
      const isDevServer = Boolean(ctx && ctx.server)
      return html.replace('__CSP_POLICY__', isDevServer ? DEV_CSP : PROD_CSP)
    }
  }
}

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
