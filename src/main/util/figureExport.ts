/**
 * 图片导出（PNG / PDF）的公共实现。
 *
 * ## 为什么是「复制 R 生成的文件」而不是「重新渲染」
 *
 * 单细胞与时序的图都是 R 画好落在 runDir 里的（png + 同名 pdf 一起写）。
 * 重新渲染等于把 R 的画图逻辑用 JS 复刻一遍，样式必然不一致。
 * 所以这里只做一件正确的事：把已经生成的那份**原样复制**到用户选的位置。
 *
 * ## 为什么按「目录里实际存在的文件」做白名单
 *
 * 渲染进程只传文件名，如果直接拼路径，`../` 就能读到 runDir 之外的文件。
 * 这里两道关：
 *   1. 文件名只允许 `[A-Za-z0-9_.-]`，不含任何路径分隔符；
 *   2. 必须真的在 runDir 里存在（不存在的图明确报「该图未生成」，
 *      而不是复制出 0 字节文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toAppError } from '@shared/errors'
import { logger } from '../logger'

export type FigureFormat = 'png' | 'pdf'

/** 文件名白名单：不含路径分隔符，必须以 .png 结尾（pdf 由它推导） */
const SAFE_FIGURE = /^[A-Za-z0-9_.-]+\.png$/

export interface FigureExportInput {
  runDir: string
  /** runDir 里的 PNG 文件名，如 `p01_volcano.png` */
  file: string
  format: FigureFormat
  outPath: string
}

export interface FigureExportResult {
  outPath: string
  bytes: number
}

/** 把 runDir 里已生成的图复制到 outPath（png 或同名 pdf） */
export function copyFigure(input: FigureExportInput): FigureExportResult {
  const { runDir, file, format, outPath } = input
  if (!SAFE_FIGURE.test(file)) {
    throw toAppError('E_VALIDATION', {
      message: `非法的图片名：${file}`,
      suggestion: '只能导出该次分析实际生成过的图（列表里的那些）。'
    })
  }
  const srcPng = path.join(runDir, file)
  if (!fs.existsSync(srcPng)) {
    throw toAppError('E_RESULT_INVALID', {
      message: `该图未生成：${file}`,
      suggestion: '这一步可能还没跑（图是按步骤分批生成的）。先运行对应步骤，再导出。'
    })
  }

  const src = format === 'pdf' ? srcPng.replace(/\.png$/, '.pdf') : srcPng
  if (!fs.existsSync(src)) {
    throw toAppError('E_RESULT_INVALID', {
      message: `该图没有 PDF 版本：${path.basename(src)}`,
      suggestion: '这张图是旧版本生成的（当时只写 PNG）。重跑该步骤即可产出矢量 PDF。'
    })
  }
  const size = fs.statSync(src).size
  if (size < 1024) {
    // 空 PDF 约 1–2 KB：这种文件导出出去只会让用户以为图坏了
    throw toAppError('E_RESULT_INVALID', {
      message: `图片文件异常（${size} 字节）：${path.basename(src)}`,
      suggestion: '文件过小，可能是空图。请重跑该步骤。'
    })
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.copyFileSync(src, outPath)
  logger.info('export', `导出图片 ${path.basename(src)} → ${outPath}（${size} 字节）`)
  return { outPath, bytes: fs.statSync(outPath).size }
}

export interface FigureExportAllInput {
  runDir: string
  outDir: string
  /** 只导出这些文件（空 = 目录里所有有 pdf 的图） */
  files?: string[]
}

export interface FigureExportAllResult {
  count: number
  skipped: string[]
  outDir: string
}

/**
 * 批量导出该次分析的全部图片。
 *
 * 没有 PDF 的图会被跳过并**列出来**（而不是静默少几张）——
 * 用户点「导出全部」时期待的是「这一批都在」，少一张必须知道。
 */
export function copyAllFigures(input: FigureExportAllInput): FigureExportAllResult {
  const { runDir, outDir } = input
  if (!fs.existsSync(runDir)) {
    throw toAppError('E_RESULT_INVALID', { message: '找不到该次分析的结果目录。' })
  }
  const wanted = input.files && input.files.length > 0
    ? input.files.filter((f) => SAFE_FIGURE.test(f))
    : fs.readdirSync(runDir).filter((f) => SAFE_FIGURE.test(f))

  fs.mkdirSync(outDir, { recursive: true })
  const skipped: string[] = []
  let count = 0
  for (const png of wanted) {
    const pdf = path.join(runDir, png.replace(/\.png$/, '.pdf'))
    if (!fs.existsSync(pdf) || fs.statSync(pdf).size < 1024) {
      skipped.push(png)
      continue
    }
    fs.copyFileSync(pdf, path.join(outDir, path.basename(pdf)))
    count += 1
  }
  logger.info('export', `批量导出 ${count} 张图 → ${outDir}（跳过 ${skipped.length} 张）`)
  return { count, skipped, outDir }
}
