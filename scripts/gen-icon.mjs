#!/usr/bin/env node
/**
 * scripts/gen-icon.mjs —— 生成应用图标（build/icon.png + build/icon.ico）
 *
 * ## 为什么自己画，不放一个 .png 进仓库
 *
 * 图标要跟侧栏品牌区（渐变方块 + 白色波浪「虫」）保持一致，靠手绘文件没法随
 * 配色改动重生成。这里用纯 Node 画：**不引 sharp / canvas / jimp** ——
 * 为了一个 256×256 的图标多装几十 MB 原生依赖不值得，而 PNG 的编码格式
 * 本身只比「zlib + 几个 chunk」复杂一点。
 *
 * ## 抗锯齿
 *
 * 按 4 倍超采样绘制（1024×1024）再盒式降采样。直接按 256 画会出现锯齿边缘，
 * 缩小到 16×16 的任务栏图标后尤其难看。
 *
 * 用法：node scripts/gen-icon.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = path.join(ROOT, 'build')
const SIZE = 256
const SS = 4 // 超采样倍数

/* ------------------------------------------------------------------ *
 * 形状与配色
 * ------------------------------------------------------------------ */

const RADIUS = 56
const PAD = 10
const INDIGO = [79, 107, 237]
const TEAL = [18, 165, 148]
const WORM = [255, 255, 255]
const WORM_WIDTH = 21
const HEAD_RADIUS = 13

/** 圆角矩形内部判定（坐标按 0..SIZE） */
function insideRoundedRect(x, y) {
  const min = PAD
  const max = SIZE - PAD
  if (x < min || x > max || y < min || y > max) return false
  const cx = Math.min(Math.max(x, min + RADIUS), max - RADIUS)
  const cy = Math.min(Math.max(y, min + RADIUS), max - RADIUS)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

/** 三次贝塞尔求点 */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
  ]
}

/** 把贝塞尔离散成折线，后面用「点到线段距离」做描边 */
function sampleCurve() {
  const p0 = [46, 168]
  const p1 = [92, 168]
  const p2 = [86, 92]
  const p3 = [132, 92]
  const p4 = [172, 92]
  const p5 = [166, 152]
  const p6 = [210, 152]
  const points = []
  for (let i = 0; i <= 60; i += 1) {
    const t = i / 60
    if (t <= 0.5) points.push(bezier(p0, p1, p2, p3, t * 2))
    else points.push(bezier(p3, p4, p5, p6, (t - 0.5) * 2))
  }
  return points
}

const CURVE = sampleCurve()
const HEAD = CURVE[CURVE.length - 1]

function distanceToCurve(px, py) {
  let best = Infinity
  for (let i = 1; i < CURVE.length; i += 1) {
    const [x1, y1] = CURVE[i - 1]
    const [x2, y2] = CURVE[i]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy || 1
    let t = ((px - x1) * dx + (py - y1) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const qx = x1 + t * dx
    const qy = y1 + t * dy
    const d = Math.hypot(px - qx, py - qy)
    if (d < best) best = d
  }
  return best
}

/** 单点取色（返回 [r,g,b,a]），坐标已归一化到 0..SIZE */
function sample(x, y) {
  if (!insideRoundedRect(x, y)) return [0, 0, 0, 0]
  // 渐变方向 135°：从左下到右上
  const t = Math.max(0, Math.min(1, (x + (SIZE - y)) / (2 * SIZE)))
  let r = INDIGO[0] + (TEAL[0] - INDIGO[0]) * t
  let g = INDIGO[1] + (TEAL[1] - INDIGO[1]) * t
  let b = INDIGO[2] + (TEAL[2] - INDIGO[2]) * t

  const dCurve = distanceToCurve(x, y)
  const dHead = Math.hypot(x - HEAD[0], y - HEAD[1])
  if (dCurve <= WORM_WIDTH / 2 || dHead <= HEAD_RADIUS) {
    r = WORM[0]
    g = WORM[1]
    b = WORM[2]
  }
  return [r, g, b, 255]
}

/* ------------------------------------------------------------------ *
 * 绘制 + 降采样
 * ------------------------------------------------------------------ */

function render() {
  const big = SIZE * SS
  // 累积缓冲（float，降采样时取平均）
  const acc = new Float32Array(SIZE * SIZE * 4)
  const step = 1 / SS
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) * step
          const y = py + (sy + 0.5) * step
          const [sr, sg, sb, sa] = sample(x, y)
          // 预乘 alpha 累加，避免边缘出现黑边
          r += sr * sa
          g += sg * sa
          b += sb * sa
          a += sa
        }
      }
      const n = SS * SS
      const idx = (py * SIZE + px) * 4
      if (a > 0) {
        acc[idx] = r / a
        acc[idx + 1] = g / a
        acc[idx + 2] = b / a
      }
      acc[idx + 3] = a / n
    }
  }
  void big
  return acc
}

/* ------------------------------------------------------------------ *
 * PNG 编码（最小实现：IHDR + IDAT + IEND，每行 filter 0）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0 // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO 容器：直接内嵌 PNG（Windows Vista+ 支持，electron-builder 也认） */
function encodeIco(pngBuffers) {
  const count = pngBuffers.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const entries = []
  let offset = 6 + 16 * count
  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)])
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function downsample(acc, size) {
  // 已经按 SIZE 累积过了，这里只做 clamp 到 0..255
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    const idx = i * 4
    out[idx] = Math.max(0, Math.min(255, Math.round(acc[idx])))
    out[idx + 1] = Math.max(0, Math.min(255, Math.round(acc[idx + 1])))
    out[idx + 2] = Math.max(0, Math.min(255, Math.round(acc[idx + 2])))
    out[idx + 3] = Math.max(0, Math.min(255, Math.round(acc[idx + 3] * 255)))
  }
  return out
}

fs.mkdirSync(OUT_DIR, { recursive: true })

const acc = render()
const rgba256 = downsample(acc, SIZE)
const png256 = encodePng(rgba256, SIZE, SIZE)
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256)

// ICO 里放多档尺寸，任务栏 / 资源管理器 / 安装程序各取所需
const icoSizes = [16, 32, 48, 64, 128, 256]
const icoEntries = icoSizes.map((size) => {
  if (size === SIZE) return { size, data: png256 }
  // 简易盒式缩放（同比例整数无关，按比例取样即可）
  const buf = Buffer.alloc(size * size * 4)
  const ratio = SIZE / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(SIZE - 1, Math.floor(x * ratio))
      const sy = Math.min(SIZE - 1, Math.floor(y * ratio))
      const src = (sy * SIZE + sx) * 4
      const dst = (y * size + x) * 4
      buf[dst] = rgba256[src]
      buf[dst + 1] = rgba256[src + 1]
      buf[dst + 2] = rgba256[src + 2]
      buf[dst + 3] = rgba256[src + 3]
    }
  }
  return { size, data: encodePng(buf, size, size) }
})
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(icoEntries))

console.log(`icon.png ${png256.length} 字节`)
console.log(`icon.ico ${fs.statSync(path.join(OUT_DIR, 'icon.ico')).size} 字节（${icoSizes.join('/')}）`)
