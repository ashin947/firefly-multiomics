/**
 * 单细胞图片导出：把 runDir 里已生成的 png/pdf 复制到用户选的位置。
 *
 * ## 为什么是柯里化（`useScrnaExport(id)` → `(file) => (format) => ...`）
 *
 * `FigureImage` 的 `onExport` 只收 `format`，文件名在外层就固定了：
 * `<FigureImage onExport={exportPlot('p01.png')} />`。
 * 这样每个图位置的调用都是一行，不用在 JSX 里拼请求。
 *
 * ## 失败处理
 *
 * 图未生成 / 没有 PDF 版本时主进程会抛带 suggestion 的错误，
 * `FigureImage` 会把它显示成一条 Snackbar —— 这两个模块的图是**按步骤分批生成**的，
 * 用户很可能只跑了第 2 步就点第 4 步的导出。
 */
import { useCallback } from 'react'
import { call } from '../utils/ipc'

export type FigureFormat = 'png' | 'pdf'

export function useScrnaExport(
  scrnaId: string | null | undefined
): (file: string) => (format: FigureFormat) => Promise<void> {
  return useCallback(
    (file: string) =>
      async (format: FigureFormat): Promise<void> => {
        if (!scrnaId) throw new Error('还没有可导出的结果（先跑一步分析）')
        const outPath = await call(
          window.deg.system.saveFile({
            defaultName: file.replace(/\.png$/, '') + '.' + format,
            filters:
              format === 'pdf'
                ? [{ name: 'PDF 矢量图', extensions: ['pdf'] }]
                : [{ name: 'PNG 图片', extensions: ['png'] }]
          })
        )
        if (!outPath) return
        await call(window.deg.scrna.exportPlot({ scrnaId, file, format, outPath }))
      },
    [scrnaId]
  )
}
