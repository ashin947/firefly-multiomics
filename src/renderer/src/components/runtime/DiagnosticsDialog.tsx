/**
 * 环境诊断弹窗。
 *
 * 客户/技术支持拿到这个弹窗就能自助排查，因此必须包含：
 *  ① 三个候选路径 + 每个是否存在（「我找过这些地方」）
 *  ② 包清单（版本 + 必需/可选 + 状态）
 *  ③ 缺失项汇总
 *  ④ 可整段复制的 Markdown 报告
 *
 * 弹窗里的「修复指引」是写死的中文步骤，不依赖 R 是否可用 ——
 * 正因为 R 不可用才需要看这段文字。
 */
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'
import { LIB_PATH_ROLE_LABELS } from '@shared/constants'
import type { DiagnosticsReport } from '@shared/types/runtime'
import { call, normalizeError } from '../../utils/ipc'
import { useRuntimeStore } from '../../store/runtimeStore'

export function DiagnosticsDialog(): JSX.Element {
  const open = useRuntimeStore((s) => s.diagnosticsOpen)
  const close = useRuntimeStore((s) => s.closeDiagnostics)
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = await call(window.deg.runtime.diagnostics())
        setReport(data)
      } catch (err) {
        setError(normalizeError(err).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const copyReport = async (): Promise<void> => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report.report)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('复制失败，请手动选择文本复制。')
    }
  }

  // 防御式取值：开发期热更新时渲染进程可能是新代码、主进程还是旧的
  // （返回里没有这两个字段）。诊断弹窗本身崩掉是最糟的失败方式 ——
  // 它是用户排查问题的最后一件工具。
  const libPaths = report?.libPaths ?? []
  const rUserDefault = report?.rUserDefault ?? ''

  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pb: 1 }}>环境诊断</DialogTitle>
      <DialogContent dividers sx={{ maxHeight: '68vh' }}>
        {loading && (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 4, justifyContent: 'center' }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              正在探测 R 环境与依赖包…
            </Typography>
          </Stack>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        {report && !loading && (
          <Stack spacing={2}>
            <Box>
              <Typography variant="h3" sx={{ mb: 1 }}>
                R 运行时
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" color={report.runtime.ok ? 'success' : 'error'} label={report.runtime.ok ? '可用' : '不可用'} />
                <Chip size="small" variant="outlined" label={`版本 ${report.runtime.version || '未检测到'}`} />
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    report.runtime.source === 'bundled'
                      ? '随包内置'
                      : report.runtime.source === 'custom'
                        ? '用户指定路径'
                        : '系统 PATH'
                  }
                />
                <Chip size="small" variant="outlined" label={`架构 ${report.runtime.arch || '未知'}`} />
                <Chip
                  size="small"
                  variant="outlined"
                  color={report.runtime.fontAvailable ? 'success' : 'warning'}
                  label={report.runtime.fontAvailable ? '中文字体就绪' : '中文字体缺失'}
                />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, wordBreak: 'break-all', fontSize: 11.5 }}>
                Rscript：{report.runtime.rscriptPath || '（未找到）'}
              </Typography>
            </Box>

            <Box>
              <Typography variant="h3" sx={{ mb: 1 }}>
                候选路径（按优先级）
              </Typography>
              <Stack spacing={0.5}>
                {report.candidates.map((candidate) => (
                  <Stack key={`${candidate.label}-${candidate.path}`} direction="row" spacing={1} alignItems="baseline">
                    <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: candidate.exists ? 'success.main' : 'text.disabled' }}>
                      {candidate.exists ? '✓' : '✗'}
                    </Typography>
                    <Typography variant="body2" sx={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                      {candidate.label}
                      {candidate.path ? ` → ${candidate.path}` : ''}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>

            <Box>
              <Typography variant="h3" sx={{ mb: 1 }}>
                R 包搜索路径（按优先级）
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: 11, lineHeight: 1.7 }}>
                包按这个顺序查找，第一个命中的版本生效。带「未生效」的行是配了但 R 没有采用
                （几乎都是目录不存在）—— <strong>「装完了还说缺包」基本都是包被装进了这些目录</strong>。
              </Typography>
              {libPaths.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  未能获取（R 不可用时读不到 .libPaths()）。
                </Typography>
              ) : (
                <Stack spacing={0.75}>
                  {libPaths.map((entry, index) => (
                    <Stack key={entry.path} direction="row" spacing={0.75} alignItems="flex-start">
                      <Typography sx={{ fontSize: 11, color: 'text.disabled', minWidth: 16, pt: 0.25 }}>
                        {index + 1}.
                      </Typography>
                      <Typography
                        sx={{
                          fontSize: 11,
                          fontWeight: 700,
                          pt: 0.25,
                          color: entry.exists ? 'success.main' : 'error.main'
                        }}
                      >
                        {entry.exists ? '✓' : '✗'}
                      </Typography>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                          {entry.path}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 10.5 }}>
                          {LIB_PATH_ROLE_LABELS[entry.role] ?? entry.role}
                          {entry.effective ? '' : ' · 未生效（目录不存在时 R 会静默跳过）'}
                        </Typography>
                      </Box>
                    </Stack>
                  ))}
                </Stack>
              )}
              {rUserDefault.length > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontSize: 10.5, wordBreak: 'break-all' }}>
                  注：R 的原始个人库（未设置 R_LIBS_USER 时的默认值）是 {rUserDefault}
                  ，本软件已把它追加在最后一位 —— 随包分发的受控版本永远优先。
                </Typography>
              )}
            </Box>

            <Box>
              <Typography variant="h3" sx={{ mb: 1 }}>
                R 包清单（{report.runtime.packages.length}）
              </Typography>
              {report.runtime.packages.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  未能探测到任何包（通常意味着 R 不可用）。
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {report.runtime.packages.map((pkg) => (
                    <Chip
                      key={pkg.name}
                      size="small"
                      label={`${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}`}
                      color={pkg.ok ? 'success' : pkg.required ? 'error' : 'default'}
                      variant={pkg.ok ? 'outlined' : 'filled'}
                      sx={{ fontSize: 11 }}
                    />
                  ))}
                </Box>
              )}
            </Box>

            {(report.runtime.missingPackages.length > 0 || report.runtime.missingSpeciesLibs.length > 0) && (
              <Alert severity="warning">
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  缺失项
                </Typography>
                {report.runtime.missingPackages.length > 0 && (
                  <Typography variant="body2">
                    核心包（缺哪个就少哪些方法，不整体阻断）：{report.runtime.missingPackages.join('、')}
                  </Typography>
                )}
                {report.runtime.missingSpeciesLibs.length > 0 && (
                  <Typography variant="body2">
                    物种注释库（不阻断差异分析，仅影响基因名映射与富集）：{report.runtime.missingSpeciesLibs.join('、')}
                  </Typography>
                )}
              </Alert>
            )}

            {(report.runtime.methods ?? []).length > 0 && (
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
                  方法可用性（按 R 包判定，与数据无关）
                </Typography>
                <Stack spacing={0.5}>
                  {(report.runtime.methods ?? []).map((method) => (
                    <Stack key={method.id} direction="row" spacing={1} alignItems="center">
                      <Typography
                        variant="body2"
                        sx={{ fontSize: 11.5, fontWeight: 600, color: method.available ? '#1B5E20' : '#8A5300' }}
                      >
                        {method.available ? '✅ 可用' : '⚠ 缺包'}
                      </Typography>
                      <Typography variant="body2" sx={{ fontSize: 11.5, minWidth: 92 }}>
                        {method.label}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                        需要 {method.requiredPackages.join('、')}
                        {method.available ? '' : ` · 缺 ${method.missingPackages.join('、')}`}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}

            <Alert severity="info" icon={false}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                修复指引
              </Typography>
              <Typography variant="body2" component="div" sx={{ fontSize: 11.5, lineHeight: 1.8 }}>
                ① 已有 R 但不在 PATH：到「设置 / 诊断」页填写 Rscript 路径（例如 <code>D:\R-4.3.2\bin\x64\Rscript.exe</code>），点「校验并保存」。
                <br />
                ② 缺 R 包：在 R 里执行 <code>install.packages(c(&quot;limma&quot;,&quot;edgeR&quot;,&quot;DESeq2&quot;))</code>，Bioconductor 包需先装 <code>BiocManager</code>。
                <br />
                ③ 便携部署：把 R 放到 <code>resources/runtime/R/</code>（需含 <code>bin/Rscript.exe</code>）。
              </Typography>
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => void copyReport()} disabled={!report}>
          {copied ? '已复制' : '复制诊断报告'}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" onClick={close}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  )
}
