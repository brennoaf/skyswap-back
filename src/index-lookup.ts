import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homesOf, joinPhotos, nearRows, placeRows, readParquet } from './vendor/spherex.js'
import { ang2pixNest } from './vendor/sky.js'

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

export const INDEX_ROWS_BUDGET = Number(process.env.SKYSWAP_INDEX_ROWS ?? 120_000)
export const POINT_ROWS_BUDGET = 40_000
export const VISIT_GAP_DAYS = 30 / 1440
export const PER_VISIT = 4
export const RUN_VISITS = 4
export const RUN_DAYS = 8 / 24

type ReadFn = (path: string) => Promise<Buffer>
type Part = 'cells' | 'photos'
type Filter = { band?: string | null; t1?: number | null; t2?: number | null }

export class IndexRowCache {
  private entries = new Map<string, Promise<IndexRow[] | null>>()
  private sizes = new Map<string, number>()
  private total = 0
  reads = 0

  constructor(readonly budgetRows = INDEX_ROWS_BUDGET, private readonly read: ReadFn = readFile) {}

  get rows(): number {
    return this.total
  }

  load(indexDir: string, part: Part, id: number): Promise<IndexRow[] | null> {
    const key = `${indexDir}|${part}|${id}`
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    const p = this.parse(join(indexDir, part, 'o5', `${id}.parquet`)).then((rows) => {
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
    return (await readParquet(file)) as IndexRow[]
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

export const indexRows = new IndexRowCache()

export async function cellRows(indexDir: string, wave: unknown, ra: number, dec: number, cache = indexRows): Promise<{ cell: number; homes: number[]; hits: IndexRow[] }> {
  const cell = ang2pixNest(5, ra, dec) as number
  const rows = await cache.load(indexDir, 'cells', cell)
  if (!rows) return { cell, homes: [], hits: [] }
  const near = nearRows(rows, ra, dec) as IndexRow[]
  const homes = homesOf(near) as number[]
  const photos = await Promise.all(
    homes.map(async (h) => {
      const p = await cache.load(indexDir, 'photos', h)
      if (!p) throw new Error(`photos ${h} missing`)
      return p
    }),
  )
  return { cell, homes, hits: placeRows(joinPhotos(near, homes, photos), wave, ra, dec) as IndexRow[] }
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
const points = new Map<string, { cell: number; homes: number[]; hits: IndexRow[] }>()

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

export async function lookupPoint(indexDir: string, wave: unknown, ra: number, dec: number, f: Filter = {}, cache = indexRows) {
  const key = `${indexDir}|${ra.toFixed(6)}|${dec.toFixed(6)}`
  let all = points.get(key)
  if (all) {
    points.delete(key)
    points.set(key, all)
  } else {
    all = await cellRows(indexDir, wave, ra, dec, cache)
    points.set(key, all)
    trimPoints(key)
  }
  const hits = all.hits.filter((r) => (!f.band || r.band === f.band) && (f.t1 == null || r.mjd >= f.t1) && (f.t2 == null || r.mjd <= f.t2))
  return { cell: all.cell, homes: all.homes, hits }
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
  homes: number[]
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
  const { cell, homes, hits } = await lookupPoint(q.indexDir, wave ?? (await waveOf(q.indexDir)), q.ra, q.dec, { band: q.band, t1: q.t1, t2: q.t2 })
  const kept = q.max ? sampleRows(hits, q.max) : hits
  const pick = q.pick
  const rows = pick ? kept.map((r) => Object.fromEntries(pick.map((k) => [k, r[k]])) as IndexRow) : kept
  return { cell, homes, total: hits.length, sampled: kept.length < hits.length, rows }
}
