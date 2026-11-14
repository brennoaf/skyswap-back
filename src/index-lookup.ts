import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parquetReadObjects } from 'hyparquet'
import { ang2pixNest, insideQuad, wavelengthAt, world2pix } from './vendor/sky.js'

export type IndexRow = Record<string, unknown> & {
  key: string
  band: string
  mjd: number
  dqa?: string
  c_ra: number[]
  c_dec: number[]
  wcs: number[]
  sip: number[]
  wave_id: number
  px?: number
  py?: number
  lam?: number
}

export const TILE_ROWS_BUDGET = 200_000
export const VISIT_GAP_DAYS = 30 / 1440
export const PER_VISIT = 4

type Wave = Record<number, unknown>
type ReadFn = (path: string) => Promise<Buffer>

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number | bigint>, (x) => Number(x))
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'bigint' ? Number(x) : x))
  return v
}

export class TileRowCache {
  private entries = new Map<string, Promise<IndexRow[] | null>>()
  private sizes = new Map<string, number>()
  private total = 0
  reads = 0

  constructor(readonly budgetRows = TILE_ROWS_BUDGET, private readonly read: ReadFn = readFile) {}

  get rows(): number {
    return this.total
  }

  load(indexDir: string, cell: number): Promise<IndexRow[] | null> {
    const key = `${indexDir}|${cell}`
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    const p = this.parse(join(indexDir, 'tiles', 'o5', `${cell}.parquet`)).then((rows) => {
      if (this.entries.get(key) === p) {
        const n = rows?.length ?? 0
        this.sizes.set(key, n)
        this.total += n
        this.evict(key)
      }
      return rows
    })
    p.catch(() => this.entries.delete(key))
    this.entries.set(key, p)
    return p
  }

  private async parse(path: string): Promise<IndexRow[] | null> {
    let buf: Buffer
    try {
      buf = await this.read(path)
    } catch {
      return null
    }
    this.reads++
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    const rows = (await parquetReadObjects({ file, rowFormat: 'object' })) as Record<string, unknown>[]
    for (const r of rows) for (const k in r) r[k] = plain(r[k])
    return rows as IndexRow[]
  }

  private evict(keep: string): void {
    for (const key of [...this.entries.keys()]) {
      if (this.total <= this.budgetRows) break
      if (key === keep) continue
      const n = this.sizes.get(key)
      if (n === undefined) continue
      this.entries.delete(key)
      this.sizes.delete(key)
      this.total -= n
    }
  }
}

export const tileRows = new TileRowCache()

export function pointRows(rows: IndexRow[], wave: unknown, ra: number, dec: number, f: { band?: string | null; t1?: number | null; t2?: number | null } = {}): IndexRow[] {
  const grids = wave as Wave
  const out: IndexRow[] = []
  for (const r of rows) {
    if (f.band && r.band !== f.band) continue
    if (f.t1 != null && r.mjd < f.t1) continue
    if (f.t2 != null && r.mjd > f.t2) continue
    if (!insideQuad(ra, dec, r.c_ra, r.c_dec)) continue
    const [x, y] = world2pix(r.wcs, r.sip, ra, dec) as [number, number]
    out.push({ ...r, px: x, py: y, lam: wavelengthAt(grids[r.wave_id], x, y) as number })
  }
  return out.sort((a, b) => a.mjd - b.mjd)
}

export function sampleRows(rows: IndexRow[], max: number): IndexRow[] {
  if (rows.length <= max) return rows
  const byBand = new Map<string, IndexRow[]>()
  for (const r of rows) byBand.set(r.band, [...(byBand.get(r.band) ?? []), r])
  const quota = Math.max(PER_VISIT, Math.floor(max / byBand.size))
  const out: IndexRow[] = []
  for (const list of byBand.values()) {
    const visits: IndexRow[][] = []
    for (const r of list) {
      const cur = visits[visits.length - 1]
      const last = cur?.[cur.length - 1]
      if (cur && last && r.mjd - last.mjd <= VISIT_GAP_DAYS) cur.push(r)
      else visits.push([r])
    }
    const capped = visits.map((v) => v.slice(0, PER_VISIT))
    const size = capped.reduce((a, v) => a + v.length, 0)
    if (size <= quota) {
      out.push(...capped.flat())
      continue
    }
    const avg = size / capped.length
    const n = Math.max(2, Math.min(capped.length, Math.floor(quota / avg)))
    const seen = new Set<number>()
    for (let i = 0; i < n; i++) seen.add(Math.round((i * (capped.length - 1)) / (n - 1)))
    for (const i of seen) out.push(...(capped[i] as IndexRow[]))
  }
  return out.sort((a, b) => a.mjd - b.mjd)
}

const POINTS_KEPT = 32
const points = new Map<string, { cell: number; hits: IndexRow[] }>()

export async function lookupPoint(indexDir: string, wave: unknown, ra: number, dec: number, f: { band?: string | null; t1?: number | null; t2?: number | null } = {}, cache = tileRows) {
  const cell = ang2pixNest(5, ra, dec) as number
  const key = `${indexDir}|${ra.toFixed(6)}|${dec.toFixed(6)}`
  let all = points.get(key)
  if (all) {
    points.delete(key)
    points.set(key, all)
  } else {
    const rows = await cache.load(indexDir, cell)
    all = { cell, hits: rows ? pointRows(rows, wave, ra, dec) : [] }
    points.set(key, all)
    while (points.size > POINTS_KEPT) {
      const oldest = points.keys().next().value
      if (oldest === undefined) break
      points.delete(oldest)
    }
  }
  const hits = all.hits.filter((r) => (!f.band || r.band === f.band) && (f.t1 == null || r.mjd >= f.t1) && (f.t2 == null || r.mjd <= f.t2))
  return { cell, hits }
}
