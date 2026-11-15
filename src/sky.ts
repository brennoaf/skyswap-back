import { answerPoint, type PointAnswer, type PointQuery } from './index-lookup.js'

const IMAGE_FIELDS = ['key', 'release', 'band', 'mjd', 'lam', 'lam_min', 'lam_max', 'obsid', 'dqa', 'file_size']

export interface SkyImage {
  key: string
  release: string
  band: string
  mjd: number
  iso: string
  lam_um: number | null
  lam_min: number
  lam_max: number
  obs_id: string | null
  file_size: number | null
}

export interface SkyResult {
  source: 'fragment' | 'sia' | 'none'
  cell: number | null
  images: SkyImage[]
  incomplete: boolean
}

export interface SiaAnswer {
  images: SkyImage[]
  failed: boolean
}

interface TileHit {
  key: string
  release: string
  band: string
  mjd: number
  lam: number
  lam_min: number
  lam_max: number
  obsid?: string
  dqa?: string
  file_size?: number | null
}


export function mjdToIso(mjd: number): string {
  return new Date((mjd - 40587) * 86400000).toISOString()
}

export async function imagesFromFragment(indexDir: string, wave: unknown, ra: number, dec: number, ask?: (q: PointQuery) => Promise<PointAnswer>): Promise<{ cell: number; images: SkyImage[] }> {
  const query = { indexDir, ra, dec, pick: IMAGE_FIELDS }
  const q = ask ? await ask(query) : await answerPoint(query, wave)
  const images = (q.rows as unknown as TileHit[])
    .filter((h) => !h.dqa || h.dqa === 'Pass')
    .map((h) => ({
      key: h.key,
      release: h.release,
      band: h.band,
      mjd: h.mjd,
      iso: mjdToIso(h.mjd),
      lam_um: Number.isFinite(h.lam) ? h.lam : null,
      lam_min: h.lam_min,
      lam_max: h.lam_max,
      obs_id: h.obsid ?? null,
      file_size: typeof h.file_size === 'number' && Number.isFinite(h.file_size) && h.file_size > 0 ? h.file_size : null,
    }))
  return { cell: q.cell, images }
}

export function parseVotable(xml: string): Record<string, string>[] {
  const fields = [...xml.matchAll(/<FIELD\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1] as string)
  const rows: Record<string, string>[] = []
  for (const tr of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const cells = [...(tr[1] as string).matchAll(/<TD>([\s\S]*?)<\/TD>|<TD\/>/g)].map((m) => (m[1] ?? '').trim())
    rows.push(Object.fromEntries(fields.map((f, i) => [f, cells[i] ?? ''])))
  }
  return rows
}

const SIA_COLLECTIONS = ['spherex_qr3', 'spherex_qr3_deep', 'spherex_qr2', 'spherex_qr2_deep']

export async function imagesFromSia(ra: number, dec: number, fetchImpl: typeof fetch = fetch): Promise<SiaAnswer> {
  const all: SkyImage[] = []
  let failed = false
  await Promise.all(
    SIA_COLLECTIONS.map(async (collection) => {
      const url = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=${collection}&POS=CIRCLE+${ra}+${dec}+0.0003&RESPONSEFORMAT=VOTABLE`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30000)
      try {
        const r = await fetchImpl(url, { signal: ctrl.signal })
        if (!r.ok) {
          failed = true
          return
        }
        for (const row of parseVotable(await r.text())) {
          const access = row.access_url ?? ''
          const key = access.split('/spherex/')[1]
          const mjd = Number(row.t_min)
          if (!key || !Number.isFinite(mjd)) continue
          all.push({
            key,
            release: key.split('/')[0] ?? collection,
            band: (row.energy_bandpassname ?? '').replace('SPHEREx-', ''),
            mjd,
            iso: mjdToIso(mjd),
            lam_um: null,
            lam_min: Number(row.em_min) * 1e6,
            lam_max: Number(row.em_max) * 1e6,
            obs_id: row.obs_id ?? null,
            file_size: null,
          })
        }
      } catch {
        failed = true
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return { images: all.sort((a, b) => a.mjd - b.mjd), failed }
}

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
  }

  get size(): number {
    return this.entries.size
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

export function totalFileBytes(images: Pick<SkyImage, 'file_size'>[]): number | null {
  let total = 0
  for (const i of images) {
    if (i.file_size == null) return null
    total += i.file_size
  }
  return total
}

export const SIA_CACHE_MAX = 500
export const SIA_TTL_MS = 6 * 3_600_000
export const SIA_EMPTY_TTL_MS = 5 * 60_000
export const siaCache = new LruCache<string, { images: SkyImage[]; expires: number }>(SIA_CACHE_MAX)

export async function imagesAt(indexDir: string, wave: unknown, ra: number, dec: number, opts: { online: boolean; fetchImpl?: typeof fetch; afterMjd?: number | null; now?: () => number; ask?: (q: PointQuery) => Promise<PointAnswer> }): Promise<SkyResult> {
  const frag = await imagesFromFragment(indexDir, wave, ra, dec, opts.ask)
  if (frag.images.length) return { source: 'fragment', cell: frag.cell, images: frag.images, incomplete: false }
  if (!opts.online) return { source: 'none', cell: frag.cell, images: [], incomplete: true }
  const now = (opts.now ?? Date.now)()
  const key = `${ra.toFixed(4)},${dec.toFixed(4)}`
  const kept = siaCache.get(key)
  let images = kept && kept.expires > now ? kept.images : null
  let incomplete = false
  if (!images) {
    const answer = await imagesFromSia(ra, dec, opts.fetchImpl)
    images = answer.images
    incomplete = answer.failed
    if (!answer.failed) siaCache.set(key, { images, expires: now + (images.length ? SIA_TTL_MS : SIA_EMPTY_TTL_MS) })
  }
  const after = opts.afterMjd
  const fresh = after == null ? images : images.filter((i) => i.mjd > after)
  return { source: fresh.length ? 'sia' : 'none', cell: frag.cell, images: fresh, incomplete }
}
