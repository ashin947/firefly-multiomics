/**
 * 设置 / 诊断页。
 *
 * 核心内容：**指定 R 路径**。客户机器上 R 装在 `D:\R-4.3.2` 且不在 PATH，
 * 这是真实用户最常见的场景 —— 不能要求用户去改系统环境变量。
 *
 * 交互设计：输入 → 「校验」（只探测不保存）→ 看到探测结果 → 「保存并生效」。
 * 为什么不直接保存再探测：用户可能填错路径，先保存会污染当前生效的运行时。
 */
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'
import type { ValidateRPathResult } from '@shared/types/runtime'
import { RuntimeStatusLights } from '../components/runtime/RuntimeStatusLights'
import { DiagnosticsDialog } from '../components/runtime/DiagnosticsDialog'
import { ErrorBanner } from '../components/common/ErrorBanner'
import { useAppStore } from '../store/appStore'
import { useProjectStore } from '../store/projectStore'
import { useRuntimeStore } from '../store/runtimeStore'
import { call } from '../utils/ipc'

export function SettingsPage(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveCustomRPath = useAppStore((s) => s.saveCustomRPath)
  const validateRPath = useAppStore((s) => s.validateRPath)
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)
  const runtime = useRuntimeStore((s) => s.info)
  const probe = useRuntimeStore((s) => s.probe)
  const openDiagnostics = useRuntimeStore((s) => s.openDiagnostics)
  const meta = useProjectStore((s) => s.meta)

  const [input, setInput] = useState(settings.customRPath ?? '')
  const [validating, setValidating] = useState(false)
  const [result, setResult] = useState<ValidateRPathResult | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setInput(settings.customRPath ?? '')
  }, [settings.customRPath])

  const handleValidate = async (): Promise<void> => {
    if (!input.trim()) return
    setValidating(true)
    setSaved(false)
    const validated = await validateRPath(input.trim())
    setResult(validated)
    setValidating(false)
  }

  const handleSave = async (): Promise<void> => {
    const ok = await saveCustomRPath(input.trim() === '' ? null : input.trim())
    if (ok) {
      setSaved(true)
      await probe(true)
    }
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1000, mx: 'auto' }}>
      <Typography variant="h1" sx={{ fontSize: 22, mb: 0.5 }}>
        设置 / 诊断
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2.5 }}>
        R 环境配置与运行环境诊断
      </Typography>

      {error && (
        <Box sx={{ mb: 2 }}>
          <ErrorBanner error={error} onDismiss={clearError} />
        </Box>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 2 }}>
        <Stack spacing={2}>
          <Card variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" sx={{ mb: 0.5 }}>
              指定 R 路径
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 11.5, lineHeight: 1.7 }}>
              如果 R 已安装但不在系统 PATH 中（例如装在 <code>D:\R-4.3.2</code>），在这里填写路径即可，
              无需修改系统环境变量。支持填写 <code>Rscript.exe</code> 完整路径或 R 安装根目录。
            </Typography>

            <Stack direction="row" spacing={1} alignItems="flex-start">
              <TextField
                size="small"
                fullWidth
                label="Rscript 路径或 R 安装目录"
                placeholder="D:\R-4.3.2\bin\x64\Rscript.exe"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value)
                  setSaved(false)
                }}
                helperText={settings.customRPath ? `当前已保存：${settings.customRPath}` : '当前未指定（按 内置 → 开发期目录 → PATH 顺序探测）'}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={<FolderOpenIcon sx={{ fontSize: 15 }} />}
                onClick={async () => {
                  try {
                    const paths = await call(
                      window.deg.system.pickFile({
                        filters: [
                          { name: 'Rscript', extensions: ['exe'] },
                          { name: '全部文件', extensions: ['*'] }
                        ],
                        multi: false
                      })
                    )
                    if (paths.length > 0) {
                      setInput(paths[0])
                      setSaved(false)
                    }
                  } catch {
                    // 取消选择
                  }
                }}
                sx={{ mt: 0.25, whiteSpace: 'nowrap' }}
              >
                浏览
              </Button>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              <Button size="small" variant="outlined" disabled={!input.trim() || validating} onClick={() => void handleValidate()}>
                {validating ? '校验中…' : '校验'}
              </Button>
              <Button size="small" variant="contained" onClick={() => void handleSave()}>
                保存并生效
              </Button>
              {settings.customRPath && (
                <Button
                  size="small"
                  color="inherit"
                  onClick={async () => {
                    setInput('')
                    await saveCustomRPath(null)
                    await probe(true)
                  }}
                >
                  清除
                </Button>
              )}
            </Stack>

            {saved && (
              <Alert severity="success" sx={{ mt: 1.5, py: 0.25 }}>
                已保存，并已重新探测 R 环境。
              </Alert>
            )}

            {result && (
              <Box
                sx={{
                  mt: 1.5,
                  p: 1.5,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: result.usable ? '#B7DFC2' : '#F5C2C0',
                  backgroundColor: result.usable ? '#F1F9F3' : '#FDECEA'
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  {result.usable ? (
                    <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                  ) : (
                    <ErrorOutlineIcon sx={{ fontSize: 16, color: 'error.main' }} />
                  )}
                  <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
                    {result.usable ? '该路径可用' : '该路径不可用'}
                  </Typography>
                </Stack>
                {result.usable && result.runtime ? (
                  <Stack spacing={0.25}>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                      Rscript：{result.rscriptPath}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                      版本：{result.runtime.version || '未知'} ｜ 架构：{result.runtime.arch || '未知'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                      核心包：{result.runtime.missingPackages.length === 0 ? '齐全' : `缺少 ${result.runtime.missingPackages.join('、')}`}
                    </Typography>
                    {result.runtime.missingPackages.length > 0 && (
                      <Typography variant="body2" sx={{ fontSize: 11.5, color: 'warning.dark', mt: 0.5 }}>
                        注意：R 可用但缺分析包，差异分析仍会被阻断。可在 R 里执行{' '}
                        <code>install.packages(c(&quot;limma&quot;,&quot;edgeR&quot;,&quot;DESeq2&quot;))</code>。
                      </Typography>
                    )}
                  </Stack>
                ) : (
                  <Typography variant="body2" sx={{ fontSize: 11.5, color: '#B3261E', lineHeight: 1.6 }}>
                    {result.reason ?? '路径无法运行 R，请确认指向 Rscript.exe 或 R 安装目录。'}
                  </Typography>
                )}
              </Box>
            )}
          </Card>

          <Card variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h3">当前生效的 R 环境</Typography>
              <Button size="small" onClick={openDiagnostics}>
                完整诊断
              </Button>
            </Stack>
            {/*
              ★ runtime 为 null 时**不能**渲染「版本 未检测到 / 系统 PATH / （未找到 Rscript）」：
                自检还没回来，这三句都是断言，而且都是错的。这里只给一句「正在检测」，
                等 probe 回来再显示真实值（与 RuntimeStatusLights 的 loading 分支同一口径）。
            */}
            {!runtime ? (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
                <CircularProgress size={14} />
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
                  正在检测 R 环境…（若长时间无响应，用「完整诊断」查看卡在哪一步）
                </Typography>
              </Stack>
            ) : (
              <>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
                  <Chip size="small" variant="outlined" label={`版本 ${runtime.version || '未检测到'}`} />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={
                      runtime.source === 'bundled' ? '随包内置' : runtime.source === 'custom' ? '用户指定路径' : '系统 PATH'
                    }
                  />
                  <Chip size="small" variant="outlined" label={`R_HOME ${runtime.rHome || '未知'}`} />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {runtime.rscriptPath || '（未找到 Rscript）'}
                </Typography>
              </>
            )}
          </Card>
        </Stack>

        <Card variant="outlined" sx={{ p: 2, height: 'fit-content' }}>
          <Typography variant="h3" sx={{ mb: 1.25 }}>
            环境状态
          </Typography>
          <RuntimeStatusLights species={meta?.species ?? 'human'} />
        </Card>
      </Box>

      <DiagnosticsDialog />
    </Box>
  )
}
