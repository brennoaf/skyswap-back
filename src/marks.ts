import { join } from 'node:path'
import sharp from 'sharp'
import type { DeckCard } from './kit.js'

export type MarkInput = { frame: number; x: number; y: number; ax?: number; ay?: number }
export type StoredMark = { x: number; y: number; ax: number; ay: number }
export type Grey = { width: number; height: number; at: (x: number, y: number) => number }

export const SNAP_RADIUS = 0.06
export const PEAK_RADIUS = 0.025
export const MIN_CONTRAST = 12
export const TRACK_TOLERANCE = 0.035
export const MIN_TRACK_MARKS = 3

const round = (v: number) => Math.round(v * 1e4) / 1e4

export function snapToPeak(grey: Grey, x0: number, y0: number, w: number, u: number, v: number): { u: number; v: number } {
  const cx = x0 + u * w
  const cy = y0 + v * w
  const r = SNAP_RADIUS * w
  const values: number[] = []
  let best = -Infinity
  let bx = cx
  let by = cy
  for (let y = Math.max(y0, Math.floor(cy - r)); y <= Math.min(y0 + w - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(x0, Math.floor(cx - r)); x <= Math.min(x0 + w - 1, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue
      const g = grey.at(x, y)
      values.push(g)
      if (g > best) [best, bx, by] = [g, x + 0.5, y + 0.5]
    }
  }
  if (!values.length) return { u, v }
  const bg = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
  if (best - bg < MIN_CONTRAST) return { u, v }
  const p = Math.max(1, PEAK_RADIUS * w)
  let sw = 0
  let sx = 0
  let sy = 0
  for (let y = Math.max(y0, Math.floor(by - p)); y <= Math.min(y0 + w - 1, Math.ceil(by + p)); y++) {
    for (let x = Math.max(x0, Math.floor(bx - p)); x <= Math.min(x0 + w - 1, Math.ceil(bx + p)); x++) {
      if (Math.hypot(x + 0.5 - bx, y + 0.5 - by) > p) continue
      const wgt = grey.at(x, y) - bg
      if (wgt <= 0) continue
      sw += wgt
      sx += wgt * (x + 0.5)
      sy += wgt * (y + 0.5)
    }
  }
  if (!sw) return { u, v }
  return { u: round((sx / sw - x0) / w), v: round((sy / sw - y0) / w) }
}

const sprites = new Map<string, Promise<Grey | null>>()

function spriteGrey(dataDir: string, card: DeckCard): Promise<Grey | null> {
  let got = sprites.get(card.id)
  if (!got) {
    const file = join(dataDir, 'deck', 'media', card.sprite.split('/').pop() ?? '')
    got = sharp(file)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => ({ width: info.width, height: info.height, at: (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? 0 }))
      .catch(() => null)
    sprites.set(card.id, got)
  }
  return got
}

export async function snapMarks(dataDir: string, deck: DeckCard | null, marks: (MarkInput | null)[]): Promise<(StoredMark | null)[]> {
  const grey = deck ? await spriteGrey(dataDir, deck) : null
  return marks.map((m) => {
    if (!m) return null
    const x = round(m.x)
    const y = round(m.y)
    if (deck && grey) {
      const s = snapToPeak(grey, m.frame * deck.tile, 0, deck.tile, x, y)
      return { x, y, ax: s.u, ay: s.v }
    }
    if (!deck && m.ax !== undefined && m.ay !== undefined && Math.hypot(m.ax - x, m.ay - y) <= SNAP_RADIUS) return { x, y, ax: round(m.ax), ay: round(m.ay) }
    return { x, y, ax: x, ay: y }
  })
}

export function steadyTrack(marks: (StoredMark | null)[], times: number[]): boolean | null {
  const pts = marks.flatMap((m, i) => (m && times[i] !== undefined ? [{ t: times[i] as number, x: m.ax, y: m.ay }] : []))
  if (pts.length < MIN_TRACK_MARKS) return null
  const mean = (f: (p: (typeof pts)[number]) => number) => pts.reduce((s, p) => s + f(p), 0) / pts.length
  const mt = mean((p) => p.t)
  const vt = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0)
  if (!vt) return false
  const fit = (f: (p: (typeof pts)[number]) => number) => {
    const m = mean(f)
    const slope = pts.reduce((s, p) => s + (p.t - mt) * (f(p) - m), 0) / vt
    return (p: (typeof pts)[number]) => m + slope * (p.t - mt)
  }
  const fx = fit((p) => p.x)
  const fy = fit((p) => p.y)
  return pts.every((p) => Math.hypot(p.x - fx(p), p.y - fy(p)) <= TRACK_TOLERANCE)
}
