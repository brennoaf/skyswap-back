import { createHash } from 'node:crypto'

export const EXPLORE_ORDER = 5
export const WARMUP_CARDS = 10
export const WARMUP_KNOWN_SHARE = 0.9
export const QUIET_STREAK = 5
export const KNOWN_GOLD_SHARE = 2 / 3
export const GOLD_CLASS_LEAD = 3
export const SKY_REVISIT_SHARE = 0.25
export const SKY_REVISIT_QUIET_SHARE = 0.4
export const SKY_REVISIT_PROBE = 40
export const SKY_QUIET_KEPT = 256

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
    const group = groups.get(v)
    if (group) group.push(f)
    else groups.set(v, [f])
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

export interface SkySpot {
  id: string
  ra: number
  dec: number
  fov_deg: number
  band: string
  size_px: number
  frames: { key: string; mjd: number; wl_um: number; visit: number }[]
}

export function skySpot(card: SkyCard): SkySpot {
  return { id: card.id, ra: card.ra, dec: card.dec, fov_deg: card.fov_deg, band: card.band, size_px: card.size_px, frames: card.frames.map((f, i) => ({ key: f.key, mjd: f.mjd, wl_um: f.wl_um, visit: f.visit ?? i })) }
}

export function skyCardId(ra: number, dec: number, fovDeg: number, band: string): string {
  const raw = `${ra.toFixed(4)}|${dec.toFixed(4)}|${fovDeg.toFixed(4)}|${band}`
  return `sky-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

export function mjdIso(mjd: number): string {
  return new Date(Math.round((mjd - 40587) * 86400000)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
