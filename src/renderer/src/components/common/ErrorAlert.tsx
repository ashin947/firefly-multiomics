/**
 * 「页面内错误提示」的统一写法 —— **必须同时显示 message 和 suggestion**。
 *
 * ## 为什么单独抽出来
 *
 * 之前 WGCNA 页与单细胞页各自只取 `normalizeError(err).message`，把 `suggestion`
 * 丢了。而 `suggestion` 才是**可操作的那句**：
 *
 *   message    「R 环境缺少必需包：Seurat」
 *   suggestion 「先到「设置 / 诊断」点「重新检测」……若仍缺失，说明当前使用的 R
 *                缺这些包：软件自带的 R 已包含全部依赖，在设置里清空「自定义 R 路径」」
 *
 * 只显示 message 的结果是：客户两次撞上同一个「其实你连的不是内置 R」的问题
 * （WGCNA 一次、单细胞一次），却都无从下手 —— 屏幕上只说缺包，不说该怎么办。
 *
 * ## 为什么不是各页复制一份
 *
 * 两份实现会在「哪天要加 detail 折叠」「哪天要加复制错误」时必然漂移，
 * 而这类漂移的表现是「A 页提示全、B 页提示少」，很难被当成 bug 报上来。
 */
import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import { normalizeError } from '../../utils/ipc'

/** 页面上要显示的错误：message 说「出了什么事」，suggestion 说「下一步点哪儿」 */
export interface UiError {
  message: string
  suggestion: string
  /** 原始 stderr 摘要（可折叠展示）。为空则不显示折叠区 */
  detail: string
}

export function toUiError(err: unknown): UiError {
  const e = normalizeError(err)
  return {
    message: e.message,
    suggestion: e.suggestion ?? '',
    detail: e.detail ?? ''
  }
}

/**
 * 错误卡片。
 *
 * `detail`（R 的原始 stderr）折叠显示：默认收起，因为绝大多数用户不需要看，
 * 但排查时又必须能拿到 —— 让用户「复制这段给开发」比让他描述现象有用得多。
 */
export function ErrorAlert({ error }: { error: UiError }): JSX.Element {
  return (
    <Alert severity="error" sx={{ mb: 1.5, fontSize: 11.5 }}>
      {error.message}
      {error.suggestion && (
        <Typography variant="body2" sx={{ fontSize: 10.5, mt: 0.5, opacity: 0.85, lineHeight: 1.45 }}>
          {error.suggestion}
        </Typography>
      )}
      {error.detail && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 10.5, opacity: 0.8 }}>
            查看原始日志
          </summary>
          <pre
            style={{
              margin: '6px 0 0',
              maxHeight: 160,
              overflow: 'auto',
              fontSize: 10,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {error.detail}
          </pre>
        </details>
      )}
    </Alert>
  )
}
