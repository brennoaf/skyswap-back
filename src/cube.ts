import { DiskCache } from './disk-cache.js'
import { ang2pixNest } from './healpix.js'
import { LruCache } from './sky.js'

export const CUBE_BASE = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/'
export const CUBE_ORDER = 5
export const MAX_RANGES = 100
const BLOCK = 2880
const CHUNK = 4 * BLOCK
const MAX_HEADER_BLOCKS = 40
const MAX_HDUS = 8
const PART_OVERHEAD = 256
const LAYOUT_CACHE = 256

export const FLAG_BITS = { transient: 1, overflow: 2, surError: 4, nonfunc: 64, missing: 512, bloom: 1 << 26, snowball: 1 << 27 }
const BRIGHT = FLAG_BITS.overflow | FLAG_BITS.bloom
const BAD = BRIGHT | FLAG_BITS.surError | FLAG_BITS.nonfunc | FLAG_BITS.missing | FLAG_BITS.snowball

export type Fetch = typeof fetch

export function cubeTileUrl(ipix: number): string {
  return `${CUBE_BASE}Dir${Math.floor(ipix / 10000) * 10000}/Npix${ipix}_cube.fits`
}

export function cardValue(raw: string): string {
  const s = raw.trimStart()
  if (s.startsWith("'")) {
    let out = ''
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'"
          i++
        } else break
      } else out += s[i]
    }
    return out.trimEnd()
  }
  return (s.split('/')[0] ?? '').trim()
}

export function parseHeader(buf: Buffer, start = 0): { cards: Map<string, string>; dataStart: number } | null {
  const cards = new Map<string, string>()
  for (let i = start; i + 80 <= buf.length; i += 80) {
    const line = buf.subarray(i, i + 80).toString('latin1')
    const key = line.slice(0, 8).trim()
    if (key === 'END') return { cards, dataStart: start + Math.ceil((i + 80 - start) / BLOCK) * BLOCK }
    if (line.slice(8, 10) === '= ') cards.set(key, cardValue(line.slice(10)))
  }
  return null
}

const num = (cards: Map<string, string>, key: string, fallback = NaN): number => {
  const v = cards.get(key)
  return v === undefined ? fallback : Number(v)
}

export function dataBytes(cards: Map<string, string>): number {
  const n = num(cards, 'NAXIS', 0)
  if (!n) return 0
  let size = 1
  for (let i = 1; i <= n; i++) size *= num(cards, `NAXIS${i}`, 0)
  return (Math.abs(num(cards, 'BITPIX', 8)) / 8) * num(cards, 'GCOUNT', 1) * (num(cards, 'PCOUNT', 0) + size)
}

export interface HpxWcs {
  crpix: [number, number]
  pc: [[number, number], [number, number]]
  cdelt: [number, number]
  h: number
  k: number
}

export function hpxWcs(cards: Map<string, string>): HpxWcs | null {
  if (cards.get('CTYPE1') !== 'RA---HPX' || cards.get('CTYPE2') !== 'DEC--HPX') return null
  if (num(cards, 'CRVAL1', 0) !== 0 || num(cards, 'CRVAL2', 0) !== 0 || num(cards, 'LONPOLE', 0) !== 0) return null
  const h = num(cards, 'PV2_1', 4)
  const k = num(cards, 'PV2_2', 3)
  if (!(h > 0) || !(k > 0) || k % 2 !== 1) return null
  return {
    crpix: [num(cards, 'CRPIX1'), num(cards, 'CRPIX2')],
    pc: [
      [num(cards, 'PC1_1', 1), num(cards, 'PC1_2', 0)],
      [num(cards, 'PC2_1', 0), num(cards, 'PC2_2', 1)],
    ],
    cdelt: [num(cards, 'CDELT1', 1), num(cards, 'CDELT2', 1)],
    h,
    k,
  }
}

export function hpxProject(raDeg: number, decDeg: number, h: number, k: number): [number, number] {
  const phi = ((((raDeg + 180) % 360) + 360) % 360) - 180
  const s = Math.sin((decDeg * Math.PI) / 180)
  if (Math.abs(s) <= (k - 1) / k) return [phi, ((90 * k) / h) * s]
  const sigma = Math.sqrt(k * (1 - Math.abs(s)))
  const phiC = -180 + (2 * Math.floor(((phi + 180) * h) / 360) + 1) * (180 / h)
  return [phiC + (phi - phiC) * sigma, Math.sign(s) * (180 / h) * ((k + 1) / 2 - sigma)]
}

export function worldToPixel(w: HpxWcs, raDeg: number, decDeg: number, size: number): [number, number] {
  const [x0, y] = hpxProject(raDeg, decDeg, w.h, w.k)
  const [[a, b], [c, d]] = w.pc
  const det = a * d - b * c
  const mid = (size - 1) / 2
  let best: [number, number] = [NaN, NaN]
  let dist = Infinity
  for (const x of [x0, x0 - 360, x0 + 360]) {
    const u = x / w.cdelt[0]
    const v = y / w.cdelt[1]
    const px = w.crpix[0] + (d * u - b * v) / det - 1
    const py = w.crpix[1] + (-c * u + a * v) / det - 1
    const dd = Math.max(Math.abs(px - mid), Math.abs(py - mid))
    if (dd < dist) {
      dist = dd
      best = [px, py]
    }
  }
  return best
}

async function readCapped(r: Response, cap: number, ctrl: AbortController): Promise<Buffer> {
  const reader = r.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      ctrl.abort()
      throw new Error('cube_too_big')
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

export async function fetchRanges(url: string, ranges: [number, number][], fetchImpl: Fetch, timeoutMs = 30000): Promise<Map<number, Buffer>> {
  if (!ranges.length) return new Map()
  if (ranges.length > MAX_RANGES) throw new Error('too_many_ranges')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { headers: { Range: `bytes=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}` }, signal: ctrl.signal })
    if (r.status !== 206) {
      ctrl.abort()
      throw new Error(`cube_status_${r.status}`)
    }
    const want = ranges.reduce((s, [a, b]) => s + b - a + 1, 0)
    const body = await readCapped(r, want + ranges.length * PART_OVERHEAD + 1024, ctrl)
    const out = new Map<number, Buffer>()
    const type = r.headers.get('content-type') ?? ''
    const boundary = /boundary=("?)([^";]+)\1/i.exec(type)?.[2]
    if (!boundary) {
      const m = /bytes (\d+)-(\d+)/.exec(r.headers.get('content-range') ?? '')
      if (!m) throw new Error('cube_no_range')
      out.set(Number(m[1]), body)
      return out
    }
    const text = body.toString('latin1')
    let at = 0
    for (;;) {
      const head = text.indexOf(`--${boundary}`, at)
      if (head < 0) break
      const lineEnd = text.indexOf('\r\n', head)
      if (lineEnd < 0 || text.startsWith('--', head + boundary.length + 2)) break
      const blank = text.indexOf('\r\n\r\n', lineEnd)
      if (blank < 0) break
      const m = /content-range:\s*bytes (\d+)-(\d+)/i.exec(text.slice(lineEnd, blank))
      if (!m) throw new Error('cube_bad_part')
      const a = Number(m[1])
      const len = Number(m[2]) - a + 1
      out.set(a, body.subarray(blank + 4, blank + 4 + len))
      at = blank + 4 + len
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

export interface CubeExt {
  dataStart: number
  bitpix: number
  nx: number
  ny: number
  nz: number
  bzero: number
  bscale: number
}

export interface CubeChannel {
  band: string
  wavelength_um: number
  wl_min_um: number
  wl_max_um: number
}

export interface CubeLayout {
  ipix: number
  image: CubeExt
  nhits: CubeExt
  flags: CubeExt
  wcs: HpxWcs
  order: number
  channels: CubeChannel[]
  blank: number[]
  date_beg: string | null
  date_end: string | null
}

function ext(cards: Map<string, string>, dataStart: number): CubeExt {
  return { dataStart, bitpix: num(cards, 'BITPIX'), nx: num(cards, 'NAXIS1'), ny: num(cards, 'NAXIS2'), nz: num(cards, 'NAXIS3', 1), bzero: num(cards, 'BZERO', 0), bscale: num(cards, 'BSCALE', 1) }
}

const FORM_BYTES: Record<string, number> = { I: 2, J: 4, K: 8, E: 4, D: 8, B: 1 }

export function parseTable(cards: Map<string, string>, data: Buffer): Record<string, number>[] {
  const rowLen = num(cards, 'NAXIS1')
  const rows = num(cards, 'NAXIS2')
  const cols: { name: string; type: string; at: number }[] = []
  let at = 0
  for (let i = 1; i <= num(cards, 'TFIELDS', 0); i++) {
    const m = /^(\d*)([A-Z])/.exec(cards.get(`TFORM${i}`) ?? '')
    if (!m) return []
    const repeat = m[1] ? Number(m[1]) : 1
    const type = m[2] as string
    cols.push({ name: (cards.get(`TTYPE${i}`) ?? '').trim(), type, at })
    at += repeat * (FORM_BYTES[type] ?? 1)
  }
  const out: Record<string, number>[] = []
  for (let r = 0; r < rows; r++) {
    const base = r * rowLen
    const row: Record<string, number> = {}
    for (const c of cols) {
      const o = base + c.at
      if (o + (FORM_BYTES[c.type] ?? 1) > data.length) return out
      row[c.name] = c.type === 'I' ? data.readInt16BE(o) : c.type === 'J' ? data.readInt32BE(o) : c.type === 'E' ? data.readFloatBE(o) : c.type === 'D' ? data.readDoubleBE(o) : c.type === 'K' ? Number(data.readBigInt64BE(o)) : data.readUInt8(o)
    }
    out.push(row)
  }
  return out
}

export async function readLayout(ipix: number, fetchImpl: Fetch): Promise<CubeLayout> {
  const url = cubeTileUrl(ipix)
  let buf: Buffer = Buffer.alloc(0)
  let bufStart = 0
  const ensure = async (start: number, len: number) => {
    if (start >= bufStart && start + len <= bufStart + buf.length) return
    const got = await fetchRanges(url, [[start, start + len - 1]], fetchImpl)
    buf = got.get(start) ?? Buffer.alloc(0)
    bufStart = start
  }
  const exts = new Map<string, { cards: Map<string, string>; dataStart: number }>()
  let primary: Map<string, string> | null = null
  let off = 0
  for (let hdu = 0; hdu < MAX_HDUS; hdu++) {
    let parsed: ReturnType<typeof parseHeader> = null
    for (let blocks = CHUNK / BLOCK; blocks <= MAX_HEADER_BLOCKS && !parsed; blocks *= 2) {
      await ensure(off, blocks * BLOCK)
      parsed = parseHeader(buf.subarray(off - bufStart))
      if (!parsed && buf.length - (off - bufStart) < blocks * BLOCK) break
    }
    if (!parsed) break
    const dataStart = off + parsed.dataStart
    if (hdu === 0) primary = parsed.cards
    const name = parsed.cards.get('EXTNAME')
    if (name) exts.set(name, { cards: parsed.cards, dataStart })
    if (name === 'SPECTRAL_CHANNELS') {
      const size = dataBytes(parsed.cards)
      await ensure(dataStart, size)
      const rows = parseTable(parsed.cards, buf.subarray(dataStart - bufStart, dataStart - bufStart + size))
      const image = exts.get('IMAGE')
      const nhits = exts.get('NHITS')
      const flags = exts.get('FLAGS')
      const wcs = image ? hpxWcs(image.cards) : null
      if (!image || !nhits || !flags || !wcs) break
      const blankList = (primary?.get('BLANKCH') ?? '').split(',').map((s) => s.trim())
      const channels = rows.map((r) => ({ band: `D${r.DETECTOR}`, wavelength_um: r.WAVELENGTH as number, wl_min_um: r.WL_MIN as number, wl_max_um: r.WL_MAX as number }))
      const blank = rows.flatMap((r, i) => (blankList.includes(`D${r.DETECTOR}:${String(r.SUBCHAN).padStart(2, '0')}`) ? [i] : []))
      return {
        ipix,
        image: ext(image.cards, image.dataStart),
        nhits: ext(nhits.cards, nhits.dataStart),
        flags: ext(flags.cards, flags.dataStart),
        wcs,
        order: num(image.cards, 'ORDER', CUBE_ORDER),
        channels,
        blank,
        date_beg: primary?.get('DATE-BEG') ?? null,
        date_end: primary?.get('DATE-END') ?? null,
      }
    }
    off = dataStart + Math.ceil(dataBytes(parsed.cards) / BLOCK) * BLOCK
  }
  throw new Error('cube_bad_layout')
}

export type ChannelState = 'ok' | 'blank' | 'empty' | 'flagged'

export interface PointChannel extends CubeChannel {
  value: number | null
  hits: number
  state: ChannelState
  bright: boolean
}

export interface PointSpectrum {
  ra: number
  dec: number
  tile: number
  pixel: [number, number]
  pixel_arcsec: number
  date_beg: string | null
  date_end: string | null
  bright: boolean
  channels: PointChannel[]
}

function decode(e: CubeExt, b: Buffer): number {
  const raw = e.bitpix === -32 ? b.readFloatBE(0) : e.bitpix === -64 ? b.readDoubleBE(0) : e.bitpix === 32 ? b.readInt32BE(0) : e.bitpix === 16 ? b.readInt16BE(0) : b.readUInt8(0)
  return e.bscale * raw + e.bzero
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i] as T)
      }
    }),
  )
  return out
}

export function pixelArcsec(order: number, tileSize: number): number {
  return Math.sqrt((4 * Math.PI) / (12 * (2 ** order * tileSize) ** 2)) * (180 / Math.PI) * 3600
}

export function tileFor(ra: number, dec: number): number {
  return ang2pixNest(CUBE_ORDER, ra, dec)
}

export function pixelOf(layout: CubeLayout, ra: number, dec: number) {
  const { nx, ny } = layout.image
  const [px, py] = worldToPixel(layout.wcs, ra, dec, nx)
  return { px, py, ix: Math.min(nx - 1, Math.max(0, Math.round(px))), iy: Math.min(ny - 1, Math.max(0, Math.round(py))) }
}

export async function readChannels(layout: CubeLayout, ix: number, iy: number, fetchImpl: Fetch, concurrency = 4): Promise<PointChannel[]> {
  const { image, nhits, flags } = layout
  const at = (e: CubeExt, z: number) => e.dataStart + (Math.abs(e.bitpix) / 8) * (z * e.nx * e.ny + iy * e.nx + ix)
  const ranges: [number, number][] = []
  for (const e of [image, nhits, flags]) for (let z = 0; z < image.nz; z++) ranges.push([at(e, z), at(e, z) + Math.abs(e.bitpix) / 8 - 1])
  const chunks: [number, number][][] = []
  for (let i = 0; i < ranges.length; i += MAX_RANGES) chunks.push(ranges.slice(i, i + MAX_RANGES))
  const url = cubeTileUrl(layout.ipix)
  const parts = new Map<number, Buffer>()
  for (const got of await mapLimit(chunks, concurrency, (c) => fetchRanges(url, c, fetchImpl))) for (const [k, v] of got) parts.set(k, v)
  const read = (e: CubeExt, z: number): number => {
    const b = parts.get(at(e, z))
    if (!b || b.length < Math.abs(e.bitpix) / 8) throw new Error('cube_missing_part')
    return decode(e, b)
  }
  return layout.channels.slice(0, image.nz).map((ch, z) => {
    const v = read(image, z)
    const hits = read(nhits, z)
    const flag = read(flags, z)
    const state: ChannelState = layout.blank.includes(z) ? 'blank' : !Number.isFinite(v) || hits <= 0 ? 'empty' : (flag & BAD) !== 0 ? 'flagged' : 'ok'
    return { ...ch, value: state === 'ok' ? v : null, hits, state, bright: (flag & BRIGHT) !== 0 }
  })
}

function spectrum(layout: CubeLayout, ra: number, dec: number, px: number, py: number, channels: PointChannel[]): PointSpectrum {
  return {
    ra,
    dec,
    tile: layout.ipix,
    pixel: [px, py],
    pixel_arcsec: pixelArcsec(layout.order, layout.image.nx),
    date_beg: layout.date_beg,
    date_end: layout.date_end,
    bright: channels.some((c) => c.bright),
    channels,
  }
}

export async function readPoint(layout: CubeLayout, ra: number, dec: number, fetchImpl: Fetch): Promise<PointSpectrum> {
  const { px, py, ix, iy } = pixelOf(layout, ra, dec)
  return spectrum(layout, ra, dec, px, py, await readChannels(layout, ix, iy, fetchImpl))
}

export class CubeReader {
  private readonly layouts = new LruCache<number, CubeLayout>(LAYOUT_CACHE)
  private readonly inflight = new Map<string, Promise<unknown>>()
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly disk: DiskCache | null,
    private readonly maxRunning = 3,
  ) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.inflight.get(key) as Promise<T> | undefined
    if (!p) {
      p = load()
      this.inflight.set(key, p)
      p.finally(() => this.inflight.delete(key)).catch(() => undefined)
    }
    return p
  }

  private async gate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxRunning) await new Promise<void>((r) => this.waiting.push(r))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }

  private async json<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = await this.disk?.get(key)
    if (hit) return JSON.parse(hit.toString('utf8')) as T
    const v = await this.gate(load)
    await this.disk?.put(key, Buffer.from(JSON.stringify(v)))
    return v
  }

  async layout(ipix: number): Promise<CubeLayout> {
    const kept = this.layouts.get(ipix)
    if (kept) return kept
    const key = DiskCache.keyOf('cube-layout', CUBE_BASE, ipix)
    const layout = await this.once(key, () => this.json(key, () => readLayout(ipix, this.fetchImpl)))
    this.layouts.set(ipix, layout)
    return layout
  }

  async point(ra: number, dec: number): Promise<PointSpectrum> {
    const layout = await this.layout(tileFor(ra, dec))
    const { px, py, ix, iy } = pixelOf(layout, ra, dec)
    const key = DiskCache.keyOf('cube-point', CUBE_BASE, layout.ipix, ix, iy)
    const channels = await this.once(key, () => this.json(key, () => readChannels(layout, ix, iy, this.fetchImpl)))
    return spectrum(layout, ra, dec, px, py, channels)
  }
}
