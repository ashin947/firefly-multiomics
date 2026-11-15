import React from 'react'
import ReactDOM from 'react-dom/client'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import App from './App'
import theme from './theme'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  // 模板被改坏时给出明确错误，而不是静默白屏
  throw new Error('渲染失败：index.html 缺少 #root 容器')
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
