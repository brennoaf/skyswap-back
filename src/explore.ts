import { createHash } from 'node:crypto'

export const EXPLORE_ORDER = 5
export const WARMUP_CARDS = 10
export const WARMUP_KNOWN_SHARE = 0.9
export const QUIET_STREAK = 5

export interface SkyFrame {
  key: string
  mjd: number
  wl_um: number
  visit?: number
}

export interface SkyVisit {
  mjd: number
  n_exp: number
  wl_min: number
  wl_max: number
}

export function skyVisits(frames: SkyFrame[]): SkyVisit[] {
  const groups = new Map<number, SkyFrame[]>()
  frames.forEach((f, i) => {
    const v = f.visit ?? i
    groups.set(v, [...(groups.get(v) ?? []), f])
  })
  return [...groups.values()]
    .map((g) => ({
      mjd: g.reduce((a, f) => a + f.mjd, 0) / g.length,
      n_exp: g.length,
      wl_min: Math.min(...g.map((f) => f.wl_um)),
      wl_max: Math.max(...g.map((f) => f.wl_um)),
    }))
    .sort((a, b) => a.mjd - b.mjd)
}

export interface SkyCard {
  id: string
  ra: number
  dec: number
  fov_deg: number
  band: string
  cell: number
  size_px: number
  frames: SkyFrame[]
  created_at: number
}

export function skyCardId(ra: number, dec: number, fovDeg: number, band: string): string {
  const raw = `${ra.toFixed(4)}|${dec.toFixed(4)}|${fovDeg.toFixed(4)}|${band}`
  return `sky-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

export function mjdIso(mjd: number): string {
  return new Date(Math.round((mjd - 40587) * 86400000)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
