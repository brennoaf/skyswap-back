import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeName, repairDeep } from './lib/text.js'

export type Kind = 'star' | 'brown_dwarf' | 'variable' | 'young_star' | 'asteroid' | 'comet' | 'interstellar' | 'candidate'
export type Verdict = 'clear' | 'with_help' | 'indicative' | 'not_measurable' | 'not_detected'
export type PostType = 'timelapse' | 'pass_blink' | 'band_compare' | 'difference' | 'composite' | 'spectrum' | 'lightcurve' | 'motion' | 'long_baseline'

export interface Mags { J: number | null; H: number | null; K: number | null; W1: number | null; W2: number | null }

export interface ObjectSummary {
  id: string
  handle: string
  name: string
  aliases: string[]
  kind: Kind
  official_target: boolean
  ra: number
  dec: number
  epoch: string
  pm_ra_cosdec: number | null
  pm_dec: number | null
  parallax: number | null
  mags: Mags
  saturation: 'none' | 'partial' | 'heavy'
  saturation_source: 'measured' | 'predicted'
  verdict: Verdict
  best_bands: string[]
  n_images: number
  n_passes: number
  first_seen: string
  last_seen: string
  avatar: string
  has_new_data: boolean
}

export interface Fact { label: string; value: number | string; unit: string | null; source_id: string }
export interface Source { id: string; label: string; url: string }

export interface ObjectProfile extends ObjectSummary {
  bio: string
  facts: Fact[]
  sources: Source[]
  measurements: { motion?: string; lightcurve?: string; spectra?: string }
  limits: string[]
  field: { fov_deg: number; ra: number | null; dec: number | null }
  band_stats?: Record<string, { snr_pass?: number | null; found_frac?: number | null }>
}

export interface FrameFlags { saturated_frac: number; cosmic_ray: boolean; satellite: boolean; persistence: boolean }

export interface Frame {
  src: string
  t: string
  mjd: number
  band: string
  wavelength_um: [number, number] | null
  release: string
  fov_deg: number
  flags: FrameFlags
  kind: 'exposure' | 'coadd' | 'difference'
  telescope?: 'WISE' | 'NEOWISE' | 'SPHEREx'
  n_exp?: number
}

export interface Post {
  id: string
  object_id: string
  type: PostType
  title: string
  caption: string
  band: string | null
  wavelength_um: [number, number] | null
  date_range: [string, string]
  cover: string
  frames: Frame[]
  chart: string | null
  marks: { frame: number; x: number; y: number }[]
  flags_summary: { saturated: number; cosmic_ray: number; satellite: number; persistence: number }
}

export interface DeckFrame { t: string; mjd: number; wl_min: number; wl_max: number; n_exp: number; visit: number }

export interface DeckCard {
  id: string
  name: string
  seq: string
  kind: string
  band: string
  sprite: string
  tile: number
  n_frames: number
  frames: DeckFrame[]
  ra: number
  dec: number
  rate_arcsec_h: number | null
  pipeline: Record<string, number>
  known: { name: string; V?: number; sep_arcsec?: number; rate_arcsec_h?: number } | null
  gold: 'real' | 'artifact' | null
  gold_reason: string | null
  size_px: number
  size_arcmin: number
  marks: { u: number; v: number }[] | null
}

export interface Manifest {
  version: string
  generated_at: string
  releases: string[]
  objects: number
  posts: number
  images_indexed: number
  deck_cards?: number
  notes: string[]
}

export interface Kit {
  dataDir: string
  manifest: Manifest
  objects: ObjectSummary[]
  profiles: Map<string, ObjectProfile>
  posts: Post[]
  postsById: Map<string, Post>
  postsByObject: Map<string, Post[]>
  deck: DeckCard[]
  deckById: Map<string, DeckCard>
  wave: unknown
  indexCells: number[]
}

export function orderPosts(posts: Post[]): Post[] {
  return [...posts.filter((p) => p.type === 'long_baseline'), ...posts.filter((p) => p.type !== 'long_baseline')]
}

function readJson<T>(path: string): T {
  return repairDeep(JSON.parse(readFileSync(path, 'utf8')) as T)
}

export function loadKit(dataDir: string): Kit {
  const manifest = readJson<Manifest>(join(dataDir, 'manifest.json'))
  const objects = readJson<ObjectSummary[]>(join(dataDir, 'objects', 'index.json'))
  const profiles = new Map<string, ObjectProfile>()
  const posts: Post[] = []
  const postsByObject = new Map<string, Post[]>()
  for (const o of objects) {
    const dir = join(dataDir, 'objects', o.id)
    const profilePath = join(dir, 'profile.json')
    profiles.set(o.id, existsSync(profilePath) ? { ...o, ...readJson<ObjectProfile>(profilePath) } : (o as ObjectProfile))
    const postsPath = join(dir, 'posts.json')
    const list = orderPosts(existsSync(postsPath) ? readJson<Omit<Post, 'object_id'>[]>(postsPath).map((p) => ({ ...p, object_id: o.id })) : [])
    postsByObject.set(o.id, list)
    posts.push(...list)
  }
  const deckPath = join(dataDir, 'deck', 'cards.json')
  const deck = existsSync(deckPath) ? readJson<DeckCard[]>(deckPath) : []
  const wavePath = join(dataDir, 'index', 'wave.json')
  const indexPath = join(dataDir, 'index', 'manifest.json')
  const indexCells = existsSync(indexPath)
    ? Object.keys((JSON.parse(readFileSync(indexPath, 'utf8')) as { tiles_index?: Record<string, unknown> }).tiles_index ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b)
    : []
  return {
    dataDir,
    manifest,
    objects,
    profiles,
    posts,
    postsById: new Map(posts.map((p) => [p.id, p])),
    postsByObject,
    deck,
    deckById: new Map(deck.map((c) => [c.id, c])),
    wave: existsSync(wavePath) ? JSON.parse(readFileSync(wavePath, 'utf8')) : [],
    indexCells,
  }
}

export function findObjectsByName(kit: Kit, query: string): ObjectSummary[] {
  const q = normalizeName(query)
  if (!q) return []
  const scored: [number, ObjectSummary][] = []
  for (const o of kit.objects) {
    const names = [o.name, o.handle, o.id, ...o.aliases].map(normalizeName)
    if (names.some((n) => n === q)) scored.push([0, o])
    else if (names.some((n) => n.startsWith(q))) scored.push([1, o])
    else if (q.length >= 3 && names.some((n) => n.includes(q))) scored.push([2, o])
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, o]) => o)
}

export function angularSeparationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180
  const s = Math.sin(((dec2 - dec1) * r) / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / r
}

export function epochYear(epoch: string): number {
  const m = /([0-9]{4}(?:\.[0-9]+)?)/.exec(epoch)
  return m?.[1] ? Number(m[1]) : 2016
}

export function propagatePosition(o: Pick<ObjectSummary, 'ra' | 'dec' | 'epoch' | 'pm_ra_cosdec' | 'pm_dec'>, isoDate: string): { ra: number; dec: number; shiftArcsec: number } {
  if (o.pm_ra_cosdec == null || o.pm_dec == null) return { ra: o.ra, dec: o.dec, shiftArcsec: 0 }
  const year = 1970 + Date.parse(isoDate) / (365.25 * 86400000)
  const dt = year - epochYear(o.epoch)
  const dra = (o.pm_ra_cosdec / 3.6e6) * dt / Math.cos((o.dec * Math.PI) / 180)
  const ddec = (o.pm_dec / 3.6e6) * dt
  return { ra: o.ra + dra, dec: o.dec + ddec, shiftArcsec: (Math.hypot(o.pm_ra_cosdec, o.pm_dec) / 1000) * Math.abs(dt) }
}
