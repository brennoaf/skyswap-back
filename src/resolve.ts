export interface Resolved {
  name: string
  ra: number
  dec: number
  epoch: number
  pm_ra_cosdec: number | null
  pm_dec: number | null
  source: 'sesame' | 'mast' | 'horizons'
  moving: boolean
}

type Fetch = typeof fetch

const cache = new Map<string, Resolved | null>()

async function withTimeout(f: Fetch, url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await f(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(xml)
  return m?.[1]?.trim() ?? null
}

export function parseSesame(xml: string, query: string): Resolved | null {
  const ra = tag(xml, 'jradeg')
  const dec = tag(xml, 'jdedeg')
  if (!ra || !dec) return null
  const pmBlock = /<pm>([\s\S]*?)<\/pm>/.exec(xml)?.[1] ?? ''
  const pmra = tag(pmBlock, 'pmRA')
  const pmde = tag(pmBlock, 'pmDE')
  return {
    name: tag(xml, 'oname') ?? query,
    ra: Number(ra),
    dec: Number(dec),
    epoch: 2000,
    pm_ra_cosdec: pmra ? Number(pmra) : null,
    pm_dec: pmde ? Number(pmde) : null,
    source: 'sesame',
    moving: false,
  }
}

export function parseHorizons(result: string, query: string): Resolved | null {
  const soe = result.indexOf('$$SOE')
  const eoe = result.indexOf('$$EOE')
  if (soe < 0 || eoe < 0) return null
  const line = result.slice(soe + 5, eoe).trim().split('\n')[0] ?? ''
  const nums = line.trim().split(/\s+/).slice(2).map(Number)
  const [ra, dec] = nums
  if (ra === undefined || dec === undefined || !Number.isFinite(ra) || !Number.isFinite(dec)) return null
  const name = /Target body name:\s*(.+?)\s{2,}/.exec(result)?.[1] ?? query
  return { name, ra, dec, epoch: new Date().getUTCFullYear(), pm_ra_cosdec: null, pm_dec: null, source: 'horizons', moving: true }
}

async function sesame(f: Fetch, query: string): Promise<Resolved | null> {
  const r = await withTimeout(f, `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?${encodeURIComponent(query)}`, 6000)
  if (!r.ok) return null
  return parseSesame(await r.text(), query)
}

async function mast(f: Fetch, query: string): Promise<Resolved | null> {
  const req = JSON.stringify({ service: 'Mast.Name.Lookup', params: { input: query, format: 'json' } })
  const r = await withTimeout(f, `https://mast.stsci.edu/api/v0/invoke?request=${encodeURIComponent(req)}`, 8000)
  if (!r.ok) return null
  const body = (await r.json()) as { resolvedCoordinate?: { canonicalName?: string; ra?: number; decl?: number }[] }
  const hit = body.resolvedCoordinate?.[0]
  if (!hit || typeof hit.ra !== 'number' || typeof hit.decl !== 'number') return null
  return { name: (hit.canonicalName ?? query).replace(/^NAME\s+/, ''), ra: hit.ra, dec: hit.decl, epoch: 2000, pm_ra_cosdec: null, pm_dec: null, source: 'mast', moving: false }
}

async function horizons(f: Fetch, query: string, now: Date): Promise<Resolved | null> {
  const start = now.toISOString().slice(0, 10)
  const stop = new Date(now.getTime() + 86400000).toISOString().slice(0, 10)
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: `'${query.replace(/'/g, '')};'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: "'500@399'",
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: "'1d'",
    QUANTITIES: "'1'",
    ANG_FORMAT: "'DEG'",
  })
  const r = await withTimeout(f, `https://ssd.jpl.nasa.gov/api/horizons.api?${params}`, 10000)
  if (!r.ok) return null
  const body = (await r.json()) as { result?: string }
  return body.result ? parseHorizons(body.result, query) : null
}

export function looksLikeSmallBody(q: string): boolean {
  return /^(\d+\s*[a-z]|[cpai]\/|\d+[pi](\/|$)|\d{4}\s?[a-z]{2}\d*|\d+$)/i.test(q.trim())
}

export async function resolveName(query: string, opts: { fetchImpl?: Fetch; now?: Date } = {}): Promise<Resolved | null> {
  const key = query.trim().toLowerCase()
  if (cache.has(key)) return cache.get(key) ?? null
  const f = opts.fetchImpl ?? fetch
  const now = opts.now ?? new Date()
  const order = looksLikeSmallBody(query) ? [horizons, sesame, mast] : [sesame, mast, horizons]
  for (const step of order) {
    try {
      const r = await step(f, query, now)
      if (r) {
        cache.set(key, r)
        return r
      }
    } catch {
      continue
    }
  }
  return null
}

export function parseCoordinates(q: string): { ra: number; dec: number } | null {
  const s = q.trim().replace(/[,;]/g, ' ').replace(/\s+/g, ' ')
  const dec2 = /^(-?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/.exec(s)
  if (dec2) {
    const ra = Number(dec2[1])
    const dec = Number(dec2[2])
    return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null
  }
  const sexa = /^(\d{1,2})[h:\s](\d{1,2})[m:\s](\d{1,2}(?:\.\d+)?)s?\s+([+-]?)(\d{1,2})[d°:\s](\d{1,2})['m:\s](\d{1,2}(?:\.\d+)?)["s]?$/i.exec(s)
  if (sexa) {
    const [, h, m, sec, sign, d, dm, ds] = sexa
    const ra = 15 * (Number(h) + Number(m) / 60 + Number(sec) / 3600)
    const dec = (sign === '-' ? -1 : 1) * (Number(d) + Number(dm) / 60 + Number(ds) / 3600)
    return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null
  }
  return null
}
