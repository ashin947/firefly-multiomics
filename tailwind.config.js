/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  corePlugins: {
    // 关键：关闭 preflight，避免 Tailwind 的全局 reset 覆盖 MUI 的基线样式
    // （按钮/输入框/标题的行高与 margin 会被 reset 破坏，这是 MUI + Tailwind 共存的标准做法）
    preflight: false
  },
  theme: {
    extend: {
      spacing: {
        appbar: '56px',
        statusbar: '28px'
      },
      colors: {
        deg: {
          up: '#B2182B',
          down: '#2166AC',
          ns: '#9E9E9E'
        }
      }
    }
  },
  plugins: []
}
