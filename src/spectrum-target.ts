import { angularSeparationDeg, propagatePosition, type ObjectSummary } from './kit.js'

export const SOLAR_SYSTEM_KINDS = ['asteroid', 'comet', 'interstellar']
const NEAR_TYPED_ARCSEC = 60

const parseUtc = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)

export function midDate(beg: string | null, end: string | null): string | null {
  if (!beg || !end) return null
  const a = parseUtc(beg)
  const b = parseUtc(end)
  return Number.isFinite(a) && Number.isFinite(b) ? new Date((a + b) / 2).toISOString() : null
}

type Moving = Pick<ObjectSummary, 'id' | 'name' | 'ra' | 'dec' | 'epoch' | 'pm_ra_cosdec' | 'pm_dec'>

export function objectAt(o: Moving, mid: string | null): { ra: number; dec: number; shift_arcsec: number } {
  if (!mid) return { ra: o.ra, dec: o.dec, shift_arcsec: 0 }
  const p = propagatePosition(o, mid)
  return { ra: p.ra, dec: p.dec, shift_arcsec: angularSeparationDeg(o.ra, o.dec, p.ra, p.dec) * 3600 }
}

export function movedAway(objects: Moving[], ra: number, dec: number, mid: string | null, pixelArcsec: number, now: string) {
  if (!mid) return []
  return objects.flatMap((o) => {
    if (o.pm_ra_cosdec == null || o.pm_dec == null) return []
    const atMid = propagatePosition(o, mid)
    const offset = angularSeparationDeg(ra, dec, atMid.ra, atMid.dec) * 3600
    if (offset <= pixelArcsec) return []
    const today = propagatePosition(o, now)
    const near = Math.min(angularSeparationDeg(ra, dec, o.ra, o.dec), angularSeparationDeg(ra, dec, today.ra, today.dec)) * 3600
    return near <= NEAR_TYPED_ARCSEC ? [{ id: o.id, name: o.name, offset_arcsec: offset }] : []
  })
}
