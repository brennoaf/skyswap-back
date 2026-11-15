import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Kit, ObjectProfile, Post } from './kit.js'
import { mediaUrl } from './store/base.js'

export const STORY_MAX_FRAMES = 8
const BANDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']
const SOLAR = new Set(['asteroid', 'comet', 'interstellar'])
const BRIGHTNESS = new Set(['variable', 'young_star'])
const NIGHT_DAYS = 1
const WISE_W2_UM = 4.6

type Mark = { x: number; y: number }
export type StoryFeature = { name_pt: string; name_en: string }
export const STORY_FEATURES = 3

export type StoryFrame = { src: string; t: string; telescope: string | null; mark: Mark | null }

export type StoryScreen =
  | { kind: 'blink'; topic: 'years' | 'passes' | 'night' | 'brightness'; band: string | null; wavelength_um: number | null; fixed: boolean; frames: StoryFrame[] }
  | { kind: 'still'; topic: 'difference'; band: string | null; src: string; hours: number | null }
  | { kind: 'curve'; band: string; saturated: boolean; points: { t: string; mag: number; err: number }[] }
  | { kind: 'colours'; frames: { band: string; src: string; um: [number, number] | null; mark: Mark | null }[]; signal: (number | null)[]; features: StoryFeature[] }
  | { kind: 'end'; motion: { measured_arcsec: number; err_arcsec: number; predicted_arcsec: number; days: number } | null; images: number; passes: number }

export function spread<T>(items: T[], max = STORY_MAX_FRAMES): T[] {
  if (items.length <= max) return items
  return Array.from({ length: max }, (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))] as T)
}

const markOf = (post: Post, index: number): Mark | null => {
  const m = post.marks.find((k) => k.frame === index)
  return m ? { x: m.x, y: m.y } : null
}

function frames(post: Post, picked: Frame[]): StoryFrame[] {
  return picked.map((f) => ({ src: mediaUrl(post.object_id, f.src), t: f.t, telescope: f.telescope ?? null, mark: markOf(post, post.frames.indexOf(f)) }))
}

function readScience<T>(kit: Kit, id: string, path: string | undefined): T | null {
  if (!path) return null
  const file = join(kit.dataDir, 'objects', id, path)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function motionScreen(posts: Post[]): StoryScreen | null {
  const long = posts.find((p) => p.type === 'long_baseline' && p.frames.length > 1)
  if (long) return { kind: 'blink', topic: 'years', band: null, wavelength_um: WISE_W2_UM, fixed: true, frames: frames(long, spread(long.frames)) }
  const blink = posts.find((p) => p.type === 'pass_blink' && p.frames.length > 1)
  return blink ? { kind: 'blink', topic: 'passes', band: blink.band, wavelength_um: null, fixed: true, frames: frames(blink, spread(blink.frames)) } : null
}

export function nightFrames(list: Frame[]): Frame[] {
  let best: Frame[] = []
  for (const band of BANDS) {
    const same = list.filter((f) => f.band === band).sort((a, b) => a.mjd - b.mjd)
    for (let i = 0; i < same.length; i++) {
      const start = same[i] as Frame
      const night = same.slice(i).filter((f) => f.mjd - start.mjd <= NIGHT_DAYS)
      if (night.length > best.length) best = night
    }
  }
  return best.length > 1 ? spread(best) : []
}

function solarScreens(posts: Post[]): StoryScreen[] {
  const out: StoryScreen[] = []
  const lapse = posts.find((p) => p.type === 'timelapse')
  const night = lapse ? nightFrames(lapse.frames) : []
  if (lapse && night.length) out.push({ kind: 'blink', topic: 'night', band: night[0]?.band ?? null, wavelength_um: null, fixed: false, frames: frames(lapse, night) })
  const diff = posts.find((p) => p.type === 'difference' && p.frames.length)
  if (diff?.frames[0]) {
    const hours = (Date.parse(diff.date_range[1]) - Date.parse(diff.date_range[0])) / 3_600_000
    out.push({ kind: 'still', topic: 'difference', band: diff.band, src: mediaUrl(diff.object_id, diff.frames[0].src), hours: Number.isFinite(hours) && hours > 0 && hours < 48 ? hours : null })
  }
  return out
}

type CurvePoint = { t: string; mag_ab: number; err: number; saturated?: boolean }

function brightnessScreens(kit: Kit, profile: ObjectProfile, posts: Post[]): StoryScreen[] {
  const out: StoryScreen[] = []
  const blink = posts.find((p) => p.type === 'pass_blink' && p.frames.length > 1)
  if (blink) out.push({ kind: 'blink', topic: 'brightness', band: blink.band, wavelength_um: null, fixed: false, frames: frames(blink, spread(blink.frames)) })
  const post = posts.find((p) => p.type === 'lightcurve')
  const curve = readScience<{ bands: Record<string, CurvePoint[]> }>(kit, profile.id, profile.measurements?.lightcurve)
  const band = post?.band ?? blink?.band ?? null
  const points = band ? (curve?.bands?.[band] ?? []).filter((p) => Number.isFinite(p.mag_ab) && Number.isFinite(p.err)) : []
  if (band && points.length > 1) out.push({ kind: 'curve', band, saturated: points.some((p) => p.saturated), points: points.map((p) => ({ t: p.t, mag: p.mag_ab, err: p.err })) })
  return out
}

type FeaturesFile = { judged?: boolean; features?: { name_pt: string; name_en: string; sigma?: number }[] }

export function featureNames(file: FeaturesFile | null): StoryFeature[] {
  if (!file?.judged) return []
  const out: StoryFeature[] = []
  for (const f of file.features ?? []) if (f.name_pt && f.name_en && !out.some((o) => o.name_en === f.name_en)) out.push({ name_pt: f.name_pt, name_en: f.name_en })
  return out.slice(0, STORY_FEATURES)
}

function coloursScreen(kit: Kit, profile: ObjectProfile, posts: Post[]): StoryScreen | null {
  const post = posts.find((p) => p.type === 'band_compare' && p.frames.length)
  if (!post) return null
  const byBand = BANDS.map((band) => post.frames.find((f) => f.band === band)).filter((f): f is Frame => !!f)
  if (byBand.length < BANDS.length) return null
  return {
    kind: 'colours',
    frames: byBand.map((f) => ({ band: f.band, src: mediaUrl(post.object_id, f.src), um: f.wavelength_um, mark: markOf(post, post.frames.indexOf(f)) })),
    signal: BANDS.map((b) => {
      const v = profile.band_stats?.[b]?.snr_pass
      return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null
    }),
    features: featureNames(readScience<FeaturesFile>(kit, profile.id, profile.measurements?.features)),
  }
}

type Position = { t: string; ra: number; dec: number }
type MotionFile = { predicted?: Position[]; measured?: Position[]; comparison?: { uncertainty_arcsec?: number } }

export function skyShiftArcsec(a: { ra: number; dec: number }, b: { ra: number; dec: number }): number {
  const dec = (((a.dec + b.dec) / 2) * Math.PI) / 180
  const dx = (b.ra - a.ra) * Math.cos(dec)
  const dy = b.dec - a.dec
  return Math.hypot(dx, dy) * 3600
}

export function motionSummary(m: MotionFile | null): Extract<StoryScreen, { kind: 'end' }>['motion'] {
  const meas = m?.measured ?? []
  const pred = m?.predicted ?? []
  const u = m?.comparison?.uncertainty_arcsec
  const a = meas[0]
  const b = meas[meas.length - 1]
  const pa = pred[0]
  const pb = pred[pred.length - 1]
  if (!a || !b || !pa || !pb || a === b || typeof u !== 'number' || !Number.isFinite(u)) return null
  const days = (Date.parse(b.t) - Date.parse(a.t)) / 86_400_000
  if (!(days > 0)) return null
  return { measured_arcsec: skyShiftArcsec(a, b), err_arcsec: u * Math.SQRT2, predicted_arcsec: skyShiftArcsec(pa, pb), days }
}

export function buildStoryScreens(kit: Kit, id: string): StoryScreen[] {
  const profile = kit.profiles.get(id)
  if (!profile) return []
  const posts = kit.postsByObject.get(id) ?? []
  const lead = SOLAR.has(profile.kind) ? solarScreens(posts) : BRIGHTNESS.has(profile.kind) ? brightnessScreens(kit, profile, posts) : [motionScreen(posts)].filter((s): s is StoryScreen => !!s)
  const colours = coloursScreen(kit, profile, posts)
  const moving = !SOLAR.has(profile.kind) && !BRIGHTNESS.has(profile.kind)
  const motion = moving ? motionSummary(readScience<MotionFile>(kit, id, profile.measurements?.motion)) : null
  const body = [...lead.slice(0, 2), ...(colours ? [colours] : [])]
  return [...body, { kind: 'end', motion, images: profile.n_images, passes: profile.n_passes }]
}
