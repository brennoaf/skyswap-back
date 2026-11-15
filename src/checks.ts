export type CheckService = 'gaia' | 'simbad' | 'asteroids' | 'quality'
export type CheckResult = 'found' | 'nothing' | 'unavailable'

export const CHECK_SERVICES: CheckService[] = ['gaia', 'simbad', 'asteroids', 'quality']
export const CHECK_TIMEOUT_MS = 20_000

const GAIA_EPOCH_MJD = 57388.5
const FAST_STAR_MAS_YR = 100
const MAX_NAMES = 5

export interface CheckTarget {
  ra: number
  dec: number
  fov_deg: number
  mjd: number
}

export interface CheckPoint {
  name: string
  ra: number
  dec: number
  mjd?: number
}

export interface CheckOutcome {
  result: CheckResult
  names: string[]
  note: string | null
  points?: CheckPoint[]
}

export type Checker = (service: CheckService, target: CheckTarget) => Promise<CheckOutcome>

const unavailable = (note: string): CheckOutcome => ({ result: 'unavailable', names: [], note })

function sexagesimal(text: string): number {
  const [a = 0, b = 0, c = 0] = text.trim().replace('+', '').split(/\s+/).map(Number)
  const sign = text.trim().startsWith('-') ? -1 : 1
  return sign * (Math.abs(a) + b / 60 + c / 3600)
}

function fieldRadius(fovDeg: number): number {
  return fovDeg / Math.SQRT2
}

function mjdToIso(mjd: number): string {
  return new Date((mjd - 40587) * 86_400_000).toISOString().slice(0, 19)
}

export function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180
  const a = Math.sin(((dec2 - dec1) * r) / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / r
}

export function propagateGaia(ra: number, dec: number, pmra: number, pmdec: number, mjd: number): [number, number] {
  const years = (mjd - GAIA_EPOCH_MJD) / 365.25
  const nextDec = dec + (pmdec * years) / 3_600_000
  const nextRa = ra + (pmra * years) / 3_600_000 / Math.max(0.01, Math.cos((dec * Math.PI) / 180))
  return [nextRa, nextDec]
}

export function parseGaia(body: unknown, target: CheckTarget): CheckOutcome {
  const rows = (body as { data?: unknown[][] } | null)?.data
  if (!Array.isArray(rows)) return unavailable('bad_response')
  const radius = fieldRadius(target.fov_deg)
  const points: CheckPoint[] = []
  for (const row of rows) {
    const [id, ra, dec, pmra, pmdec] = row as [string | number, number, number, number, number]
    const [atRa, atDec] = propagateGaia(ra, dec, pmra, pmdec, target.mjd)
    if (separationDeg(atRa, atDec, target.ra, target.dec) <= radius) points.push({ name: `Gaia DR3 ${id}`, ra: atRa, dec: atDec })
  }
  return { result: points.length ? 'found' : 'nothing', names: points.slice(0, MAX_NAMES).map((p) => p.name), note: null, points }
}

export function parseSimbad(body: unknown): CheckOutcome {
  const rows = (body as { data?: unknown[][] } | null)?.data
  if (!Array.isArray(rows)) return unavailable('bad_response')
  const names = rows.map((r) => String(r[0]).trim()).filter(Boolean)
  return { result: names.length ? 'found' : 'nothing', names: names.slice(0, MAX_NAMES), note: null }
}

export function parseSkybot(text: string): CheckOutcome {
  if (!text.trim()) return { result: 'nothing', names: [], note: null, points: [] }
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    return unavailable('bad_response')
  }
  if (!Array.isArray(rows)) return unavailable('bad_response')
  const points = rows.map((r: { Num?: number | string; Name?: string; 'RA (hms)'?: string; 'DEC (dms)'?: string }) => ({
    name: [r.Num, r.Name].filter((v) => v !== undefined && v !== '-').join(' ').trim(),
    ra: sexagesimal(r['RA (hms)'] ?? '0') * 15,
    dec: sexagesimal(r['DEC (dms)'] ?? '0'),
  })).filter((p) => p.name)
  return { result: points.length ? 'found' : 'nothing', names: points.slice(0, MAX_NAMES).map((p) => p.name), note: null, points }
}

export function makeChecker(fetchImpl: typeof fetch, online: boolean): Checker {
  const get = (url: string) => fetchImpl(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  return async (service, target) => {
    if (service === 'quality') return unavailable('no_flags_for_card')
    if (!online) return unavailable('offline')
    const radius = fieldRadius(target.fov_deg)
    try {
      if (service === 'asteroids') {
        const q = new URLSearchParams({ '-ep': mjdToIso(target.mjd), '-ra': String(target.ra), '-dec': String(target.dec), '-rd': radius.toFixed(4), '-mime': 'json', '-output': 'basic', '-loc': '500', '-from': 'SkySwap' })
        const r = await get(`https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?${q}`)
        return r.ok ? parseSkybot(await r.text()) : unavailable(`http_${r.status}`)
      }
      if (service === 'gaia') {
        const query = `SELECT TOP 50 source_id,ra,dec,pmra,pmdec FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT(ra,dec),CIRCLE(${target.ra},${target.dec},${radius + 0.05})) AND pmra*pmra+pmdec*pmdec>${FAST_STAR_MAS_YR ** 2}`
        const q = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'json', QUERY: query })
        const r = await get(`https://gea.esac.esa.int/tap-server/tap/sync?${q}`)
        return r.ok ? parseGaia(await r.json(), target) : unavailable(`http_${r.status}`)
      }
      const query = `SELECT TOP 20 main_id FROM basic WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${target.ra},${target.dec},${radius}))`
      const q = new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'json', query })
      const r = await get(`https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?${q}`)
      return r.ok ? parseSimbad(await r.json()) : unavailable(`http_${r.status}`)
    } catch {
      return unavailable('network')
    }
  }
}
