import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Avatars } from './avatars.js'

sharp.cache(false)
sharp.concurrency(1)

const SEARCH_URL = 'https://images-api.nasa.gov/search'
const ASSET_URL = 'https://images-api.nasa.gov/asset'
const USER_AGENT = 'skyswap-avatars'
const PAGE_SIZE = 100

export const OUT_PX = 224
export const STOCK_TARGET = 500
export const STOCK_LOW = 400
const MIN_SHORT_SIDE = 1200
const MIN_CROP_SIDE = 200
const MAX_DOWNLOAD_BYTES = 40_000_000
const MAX_PIXELS = 200_000_000
const TRIES_PER_IMAGE = 30
const REQUEST_TIMEOUT_MS = 180_000
const PACE_MS = 1000
const IDLE_MS = 10 * 60_000
const EXHAUSTED_MS = 6 * 60 * 60_000
const FIRST_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 60 * 60_000

export const LIST_QUERIES = [
  'hubble nebula',
  'hubble galaxy',
  'hubble star cluster',
  'webb nebula',
  'webb galaxy',
  'supernova remnant',
  'star forming region',
  'galaxy cluster',
  'nebula',
  'spiral galaxy',
  'elliptical galaxy',
  'star cluster',
  'globular cluster',
  'chandra x-ray',
  'spitzer infrared',
  'supernova',
  'NGC',
  'messier',
  'hubble',
  'galex',
  'milky way',
]

const BLOCKED_IDS = new Set<string>()
const BLOCKED_WORDS =
  /team|engineer|astronaut|technician|conference|audience|briefing|portrait|workers|ceremony|mirror|servicing|shuttle|launch|crew|administrator|scientist|clean ?room|logo|infographic|chart|diagram|illustration|artist|concept|poster|anniversary|telescope (is|being)|spacecraft|observatory|hearing|visit|screening|auditorium|embassy|campus|cinema|memorial|\bevent\b|award|facility|cryogenic|assembly|testing|\btest\b|history of/i
const PLACES_NOT_SKY = new Set(['HQ', 'KSC', 'JSC', 'MSFC'])
const NOT_A_PHOTO = /artist.{0,3}s? (concept|impression|rendering|illustration)|\billustration (shows|of|depicts)\b|this (illustration|diagram|chart|graph|plot)\b|\b(left|right|top|bottom|middle) panel\b|\bpanels\b|\binset\b/i
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'" }
const PHOTO_LAB_ID = /^(KSC-|NHQ|\d+HQ$|GSFC_\d{8}_\d{4}-\d)/
const THIRD_PARTY = /copyright|©|\(c\)\s|all rights reserved|courtesy of|getty|reuters|associated press|\bap photo\b/i
const CREDIT = /\b(?:image\s+)?credits?\s*:\s*(.+?)(?:\s{2,}|\n|<|$)/i
const AGENCY = /\b(NASA|ESA|CSA|STScI|JPL|Hubble|Webb|JWST|Chandra|CXC|Spitzer|GSFC|Goddard)\b/i
const MAX_CREDIT = 160

export interface NasaItem {
  nasa_id: string
  title?: string
  date_created?: string
  description?: string
  keywords?: string[]
  center?: string
  photographer?: string
  secondary_creator?: string
}

export interface Spot {
  cx: number
  cy: number
  side: number
  rotation: number
}

export interface Metrics {
  mean: number
  std: number
  edges: number
  saturation: number
  dark: number
  white: number
}

export interface RefillStats {
  pages: number
  listed: number
  cut: Record<string, number>
  images: number
  small: number
  noCrop: number
  unreadable: number
  tries: number
  passed: number
  added: number
  downloadedBytes: number
  cropBytes: number
  failures: number
}

export interface RefillOptions {
  random?: () => number
  paceMs?: number
  target?: number
  low?: number
  onProgress?: (event: 'added' | 'failed' | 'full' | 'exhausted', stats: RefillStats, free: number) => void
}

class NasaUnavailable extends Error {}

const decode = (text: string) => text.replace(/&(amp|quot|apos|lt|gt|nbsp|#39);/g, (_, name: string) => ENTITIES[name] ?? '')

function plainCredit(item: NasaItem): string | null {
  const found = CREDIT.exec(item.description ?? '')?.[1]?.trim()
  return found ? decode(found).replace(/\s+acknowledge?ment.*$/i, '').replace(/[.,;\s]+$/, '') : null
}

export function cutReason(item: NasaItem): string | null {
  if (PHOTO_LAB_ID.test(item.nasa_id) || (item.center && PLACES_NOT_SKY.has(item.center))) return 'not_sky'
  if (BLOCKED_IDS.has(item.nasa_id)) return 'blocked_id'
  if (!item.title || /^\d+$/.test(item.title)) return 'no_title'
  if (BLOCKED_WORDS.test(item.title) || BLOCKED_WORDS.test((item.keywords ?? []).join(' '))) return 'blocked_word'
  if ([item.title, item.description, item.photographer, item.secondary_creator].some((text) => text && THIRD_PARTY.test(text))) return 'third_party'
  const credit = plainCredit(item)
  if (credit && !AGENCY.test(credit)) return 'third_party'
  if (item.description && NOT_A_PHOTO.test(item.description)) return 'not_a_photo'
  return null
}

export function creditFor(item: NasaItem): string {
  const credit = plainCredit(item) ?? item.secondary_creator ?? item.photographer ?? (item.center ? `NASA/${item.center}` : 'NASA')
  if (credit.length <= MAX_CREDIT) return credit
  const cut = credit.slice(0, MAX_CREDIT)
  const end = cut.lastIndexOf(',')
  return (end > 0 ? cut.slice(0, end) : cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))).trim()
}

export function drawSpot(width: number, height: number, random: () => number): Spot {
  const largest = Math.min(width, height) / Math.SQRT2
  const side = largest <= MIN_CROP_SIDE ? largest : Math.exp(Math.log(MIN_CROP_SIDE) + random() * (Math.log(largest) - Math.log(MIN_CROP_SIDE)))
  const rotation = random() * 360
  const theta = (rotation * Math.PI) / 180
  const half = (side * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)))) / 2
  return { cx: half + random() * (width - 2 * half), cy: half + random() * (height - 2 * half), side, rotation }
}

export async function renderCrop(source: Buffer, width: number, height: number, spot: Spot): Promise<Buffer> {
  const theta = (spot.rotation * Math.PI) / 180
  const half = (spot.side * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)))) / 2
  const left = Math.max(0, Math.floor(spot.cx - half))
  const top = Math.max(0, Math.floor(spot.cy - half))
  const boxW = Math.min(width - left, Math.ceil(2 * half) + 1)
  const boxH = Math.min(height - top, Math.ceil(2 * half) + 1)
  const scale = Math.min(1, (OUT_PX * 2) / spot.side)
  const box = await sharp(source, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
    .extract({ left, top, width: boxW, height: boxH })
    .resize(Math.max(1, Math.round(boxW * scale)), Math.max(1, Math.round(boxH * scale)))
    .flatten({ background: '#000000' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const raw = { width: box.info.width, height: box.info.height, channels: box.info.channels }
  const turned = await sharp(box.data, { raw }).rotate(spot.rotation, { background: '#000000' }).raw().toBuffer({ resolveWithObject: true })
  const inner = Math.max(1, Math.floor(spot.side * scale) - 2)
  const out = await sharp(turned.data, { raw: { width: turned.info.width, height: turned.info.height, channels: turned.info.channels } })
    .extract({ left: Math.max(0, Math.round((turned.info.width - inner) / 2)), top: Math.max(0, Math.round((turned.info.height - inner) / 2)), width: inner, height: inner })
    .resize(OUT_PX, OUT_PX)
    .removeAlpha()
    .raw()
    .toBuffer()
  return out
}

export function cropMetrics(rgb: Buffer, size = OUT_PX): Metrics {
  const n = size * size
  const gray = new Float64Array(n)
  let sum = 0
  let squares = 0
  let saturation = 0
  let dark = 0
  let white = 0
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3] as number
    const g = rgb[i * 3 + 1] as number
    const b = rgb[i * 3 + 2] as number
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    gray[i] = y
    sum += y
    squares += y * y
    const top = Math.max(r, g, b)
    if (top > 0) saturation += (255 * (top - Math.min(r, g, b))) / top
    if (y < 18) dark++
    if (y >= 245) white++
  }
  let edges = 0
  for (let row = 1; row < size - 1; row++) {
    for (let col = 1; col < size - 1; col++) {
      const at = row * size + col
      let around = 0
      for (const step of [-size - 1, -size, -size + 1, -1, 1, size - 1, size, size + 1]) around += gray[at + step] as number
      edges += Math.max(0, Math.min(255, 8 * (gray[at] as number) - around))
    }
  }
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, squares / n - mean * mean)), edges: edges / ((size - 2) * (size - 2)), saturation: saturation / n, dark: dark / n, white: white / n }
}

export function goodCrop(m: Metrics): boolean {
  return m.mean > 28 && m.mean < 190 && m.std > 24 && m.dark < 0.55 && m.white < 0.2 && m.saturation > 35 && m.edges > 6
}

function pickFiles(hrefs: string[]): { files: string[]; whole: string | null } {
  const images = hrefs.map((h) => h.replace(/^http:\/\//, 'https://')).filter((h) => /\.(jpe?g|png)$/i.test(h))
  const tier = (name: string) => images.find((h) => h.includes(`~${name}.`))
  const files = ['orig', 'large', 'medium'].map(tier).filter((h): h is string => !!h)
  return { files, whole: tier('large') ?? tier('orig') ?? tier('medium') ?? null }
}

export class AvatarRefill {
  readonly stats: RefillStats = { pages: 0, listed: 0, cut: {}, images: 0, small: 0, noCrop: 0, unreadable: 0, tries: 0, passed: 0, added: 0, downloadedBytes: 0, cropBytes: 0, failures: 0 }
  private readonly random: () => number
  private readonly paceMs: number
  private readonly target: number
  private readonly low: number
  private readonly tried = new Set<string>()
  private queue: NasaItem[] = []
  private pages: { query: string; page: number }[] | null = null
  private filling = false
  private backoff = 0
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private stopped = true

  constructor(
    private readonly avatars: Avatars,
    private readonly dir: string,
    private readonly fetchImpl: typeof fetch,
    private readonly options: RefillOptions = {},
  ) {
    this.random = options.random ?? Math.random
    this.paceMs = options.paceMs ?? PACE_MS
    this.target = options.target ?? STOCK_TARGET
    this.low = options.low ?? STOCK_LOW
  }

  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.running = this.step()
        .catch(() => IDLE_MS)
        .then((next) => this.schedule(next))
    }, delay)
    this.timer.unref()
  }

  private report(event: 'added' | 'failed' | 'full' | 'exhausted'): void {
    this.options.onProgress?.(event, this.stats, this.avatars.freeCount())
  }

  async step(): Promise<number> {
    const free = this.avatars.freeCount()
    if (this.filling && free >= this.target) {
      this.filling = false
      this.report('full')
    }
    if (!this.filling && free < this.low) this.filling = true
    if (!this.filling) return IDLE_MS
    try {
      const item = await this.nextItem()
      if (!item) {
        this.report('exhausted')
        this.tried.clear()
        this.pages = null
        return EXHAUSTED_MS
      }
      await this.addFrom(item)
      this.backoff = 0
      return this.paceMs
    } catch (err) {
      if (!(err instanceof NasaUnavailable)) throw err
      this.stats.failures++
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff ? this.backoff * 2 : FIRST_BACKOFF_MS)
      this.report('failed')
      return this.backoff
    }
  }

  private async request(url: string): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      throw new NasaUnavailable(url)
    }
    if (res.status === 429 || res.status >= 500) throw new NasaUnavailable(url)
    return res
  }

  private async json<T>(url: string): Promise<T> {
    const res = await this.request(url)
    if (!res.ok) throw new NasaUnavailable(url)
    try {
      return (await res.json()) as T
    } catch {
      throw new NasaUnavailable(url)
    }
  }

  private searchUrl(query: string, page: number, size: number): string {
    return `${SEARCH_URL}?${new URLSearchParams({ q: query, media_type: 'image', page_size: String(size), page: String(page) })}`
  }

  private async listPages(): Promise<{ query: string; page: number }[]> {
    const pages: { query: string; page: number }[] = []
    for (const query of LIST_QUERIES) {
      const found = await this.json<{ collection: { metadata: { total_hits: number } } }>(this.searchUrl(query, 1, 1))
      const count = Math.ceil(Math.min(found.collection.metadata.total_hits, 10000) / PAGE_SIZE)
      for (let page = 1; page <= count; page++) pages.push({ query, page })
    }
    return pages
  }

  private async nextItem(): Promise<NasaItem | null> {
    this.pages ??= await this.listPages()
    for (;;) {
      const item = this.queue.pop()
      if (item) {
        if (!this.tried.has(item.nasa_id) && !this.avatars.inStock(item.nasa_id, item.title ?? '')) return item
        continue
      }
      if (!this.pages.length) return null
      const at = Math.floor(this.random() * this.pages.length)
      const [next] = this.pages.splice(at, 1)
      if (!next) return null
      try {
        const data = await this.json<{ collection: { items: { data: NasaItem[] }[] } }>(this.searchUrl(next.query, next.page, PAGE_SIZE))
        this.stats.pages++
        const fresh: NasaItem[] = []
        for (const entry of data.collection.items) {
          const meta = entry.data[0]
          if (!meta) continue
          this.stats.listed++
          const reason = cutReason(meta)
          if (reason) this.stats.cut[reason] = (this.stats.cut[reason] ?? 0) + 1
          else fresh.push(meta)
        }
        for (let i = fresh.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1))
          const a = fresh[i] as NasaItem
          fresh[i] = fresh[j] as NasaItem
          fresh[j] = a
        }
        this.queue = fresh
      } catch (err) {
        this.pages.push(next)
        throw err
      }
    }
  }

  private async download(url: string): Promise<Buffer | null> {
    const res = await this.request(url)
    if (!res.ok || !res.body) return null
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) {
      await res.body.cancel()
      return null
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length
        this.stats.downloadedBytes += chunk.length
        if (size > MAX_DOWNLOAD_BYTES) return null
        chunks.push(chunk)
      }
    } catch {
      throw new NasaUnavailable(url)
    }
    return Buffer.concat(chunks)
  }

  private async addFrom(item: NasaItem): Promise<void> {
    try {
      const asset = await this.json<{ collection: { items: { href: string }[] } }>(`${ASSET_URL}/${encodeURIComponent(item.nasa_id)}`)
      await this.cropFrom(item, asset.collection.items.map((i) => i.href))
    } catch (err) {
      if (err instanceof NasaUnavailable) {
        this.queue.unshift(item)
        throw err
      }
      this.stats.unreadable++
    }
    this.tried.add(item.nasa_id)
  }

  private async cropFrom(item: NasaItem, hrefs: string[]): Promise<void> {
    const { files, whole } = pickFiles(hrefs)
    let source: Buffer | null = null
    for (const file of files) {
      source = await this.download(file)
      if (source) break
    }
    if (!source || !whole) {
      this.stats.unreadable++
      return
    }
    this.stats.images++
    const { width, height } = await sharp(source, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata()
    if (Math.min(width, height) < MIN_SHORT_SIDE) {
      this.stats.small++
      return
    }
    for (let i = 0; i < TRIES_PER_IMAGE; i++) {
      const spot = drawSpot(width, height, this.random)
      const rgb = await renderCrop(source, width, height, spot)
      this.stats.tries++
      if (!goodCrop(cropMetrics(rgb))) continue
      this.stats.passed++
      await this.store(item, whole, width, height, spot, rgb)
      return
    }
    this.stats.noCrop++
  }

  private async store(item: NasaItem, whole: string, width: number, height: number, spot: Spot, rgb: Buffer): Promise<void> {
    const jpeg = await sharp(rgb, { raw: { width: OUT_PX, height: OUT_PX, channels: 3 } }).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
    const id = randomUUID()
    const path = join(this.dir, `${id}.jpg`)
    writeFileSync(path, jpeg)
    try {
      const date = /^\d{4}-\d\d-\d\d/.exec(item.date_created ?? '')?.[0] ?? null
      this.avatars.add({ id, nasa_id: item.nasa_id, title: decode(item.title ?? '').slice(0, 200), date, credit: creditFor(item), image_url: whole, width, height, ...spot, bytes: jpeg.length })
    } catch (err) {
      rmSync(path, { force: true })
      throw err
    }
    this.stats.added++
    this.stats.cropBytes += jpeg.length
    this.report('added')
  }
}
