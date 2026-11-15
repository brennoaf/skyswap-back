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

export const TILE_ROWS_BUDGET = Number(process.env.SKYSWAP_INDEX_ROWS ?? 120_000)
export const POINT_ROWS_BUDGET = 40_000
export const VISIT_GAP_DAYS = 30 / 1440
export const PER_VISIT = 4
export const RUN_VISITS = 4
export const RUN_DAYS = 8 / 24

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
  for (const r of rows) {
    const list = byBand.get(r.band)
    if (list) list.push(r)
    else byBand.set(r.band, [r])
  }
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
    for (const i of blockStarts(capped.map(midMjd), n)) for (let k = i; k < Math.min(capped.length, i + RUN_VISITS); k++) out.push(...(capped[k] as IndexRow[]))
  }
  return [...new Set(out)].sort((a, b) => a.mjd - b.mjd)
}

const midMjd = (v: IndexRow[]) => v.reduce((a, r) => a + r.mjd, 0) / Math.max(1, v.length)
export function blockStarts(mids: number[], visitBudget: number): number[] {
  const last = Math.max(0, mids.length - RUN_VISITS)
  const blocks = Math.max(1, Math.floor(visitBudget / RUN_VISITS))
  if (blocks === 1) return [tightStart(mids, 0, 0, last)]
  const starts = new Set<number>()
  const step = last / (blocks - 1)
  for (let b = 0; b < blocks; b++) {
    const target = Math.round(b * step)
    const reach = Math.floor(step / 2)
    starts.add(tightStart(mids, target, Math.max(0, target - reach), Math.min(last, target + reach)))
  }
  return [...starts]
}

function tightStart(mids: number[], target: number, lo: number, hi: number): number {
  const tight = (i: number) => i + 2 < mids.length && (mids[i + 2] as number) - (mids[i] as number) <= RUN_DAYS
  for (let d = 0; target - d >= lo || target + d <= hi; d++) {
    if (target - d >= lo && tight(target - d)) return target - d
    if (target + d <= hi && tight(target + d)) return target + d
  }
  return target
}

const POINTS_KEPT = 32
const points = new Map<string, { cell: number; hits: IndexRow[] }>()

function trimPoints(keep: string): void {
  let total = 0
  for (const p of points.values()) total += p.hits.length
  for (const [key, p] of points) {
    if (points.size <= POINTS_KEPT && total <= POINT_ROWS_BUDGET) break
    if (key === keep) continue
    points.delete(key)
    total -= p.hits.length
  }
}

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
    trimPoints(key)
  }
  const hits = all.hits.filter((r) => (!f.band || r.band === f.band) && (f.t1 == null || r.mjd >= f.t1) && (f.t2 == null || r.mjd <= f.t2))
  return { cell, hits }
}

export interface PointQuery {
  indexDir: string
  ra: number
  dec: number
  band?: string | null
  t1?: number | null
  t2?: number | null
  max?: number | null
  pick?: string[] | null
}

export interface PointAnswer {
  cell: number
  total: number
  sampled: boolean
  rows: IndexRow[]
}

const waves = new Map<string, Promise<unknown>>()

function waveOf(indexDir: string): Promise<unknown> {
  let p = waves.get(indexDir)
  if (!p) {
    p = readFile(join(indexDir, 'wave.json'), 'utf8').then(
      (t) => JSON.parse(t) as unknown,
      () => [],
    )
    waves.set(indexDir, p)
  }
  return p
}

export async function answerPoint(q: PointQuery, wave?: unknown): Promise<PointAnswer> {
  const { cell, hits } = await lookupPoint(q.indexDir, wave ?? (await waveOf(q.indexDir)), q.ra, q.dec, { band: q.band, t1: q.t1, t2: q.t2 })
  const kept = q.max ? sampleRows(hits, q.max) : hits
  const pick = q.pick
  const rows = pick ? kept.map((r) => Object.fromEntries(pick.map((k) => [k, r[k]])) as IndexRow) : kept
  return { cell, total: hits.length, sampled: kept.length < hits.length, rows }
}
