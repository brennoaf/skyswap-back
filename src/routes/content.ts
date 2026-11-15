import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.js'
import { objectCard, postDto } from '../dto.js'
import { angularSeparationDeg, epochYear, findObjectsByName, propagatePosition, type Kit, type ObjectSummary, type Post } from '../kit.js'
import { parseCoordinates, resolveName } from '../resolve.js'
import * as S from '../schemas.js'
import { imagesAt, totalFileBytes } from '../sky.js'
import { CubeReader, tileFor } from '../cube.js'
import { midDate, movedAway, objectAt, SOLAR_SYSTEM_KINDS } from '../spectrum-target.js'
import { DiskCache } from '../disk-cache.js'
import type { IndexService } from '../index-service.js'
import { HttpError, postsForObject, type Store } from '../store.js'
import { buildStoryScreens } from '../stories.js'
import { riceDecodeRows } from '../vendor/rice.js'

export interface RouteCtx {
  store: Store
  kit: Kit
  config: Config
  fetchImpl: typeof fetch
  cache: DiskCache
  index: IndexService
}

export const S3_BASE = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
export const S3_MAX_RANGE = 16 * 1024 * 1024
export const DETECTOR_PX = 2040
export const CROP_MAX_PX = 640

export function cropColumns(rows: Buffer, h: number, x0: number, w: number, nx = DETECTOR_PX): Buffer {
  const out = Buffer.allocUnsafe(h * w * 4)
  for (let y = 0; y < h; y++) rows.copy(out, y * w * 4, (y * nx + x0) * 4, (y * nx + x0 + w) * 4)
  return out
}

export function cropFlags(span: Uint8Array, nrows: number, skip: number, h: number, x0: number, w: number, nx = DETECTOR_PX): Buffer {
  const all = (riceDecodeRows(span, nrows, nx) as { data: Int32Array }).data
  const out = Buffer.allocUnsafe(h * w * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.writeInt32BE(all[(skip + y) * nx + x0 + x] as number, (y * w + x) * 4)
  return out
}

type FeedTab = 'for_you' | 'following' | 'new' | 'targets'
const STALE_ARCSEC = 3
const STORY_FINDS = 3
export const HIPS_BASE = 'https://irsa.ipac.caltech.edu/data/hips/CDS/'
export const HIPS_SURVEYS: Record<string, { path: string; maxOrder: number }> = {
  wise: { path: 'AllWISE/W2', maxOrder: 8 },
  '2mass-j': { path: '2MASS/J', maxOrder: 9 },
  '2mass-h': { path: '2MASS/H', maxOrder: 9 },
  '2mass-k': { path: '2MASS/K', maxOrder: 9 },
}
export const CUTOUT_KEY = /^(qr[23]|dr1)\/level2\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.fits$/

export function isSafeCutoutKey(key: string): boolean {
  return !key.includes('..') && !key.includes('\\') && !key.includes('//') && CUTOUT_KEY.test(key)
}

function orderedObjects(kit: Kit): ObjectSummary[] {
  return [...kit.objects].sort((a, b) => Number(b.has_new_data) - Number(a.has_new_data) || Number(b.official_target) - Number(a.official_target) || b.last_seen.localeCompare(a.last_seen))
}

function roundRobin(kit: Kit, objects: ObjectSummary[]): Post[] {
  const lists = objects.map((o) => postsForObject(kit, o.id))
  const out: Post[] = []
  const max = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i] as Post)
  return out
}

function nearby(kit: Kit, ra: number, dec: number, radiusDeg: number, at: string) {
  return kit.objects
    .map((o) => {
      const p = propagatePosition(o, at)
      return { o, sep: angularSeparationDeg(ra, dec, p.ra, p.dec) }
    })
    .filter((x) => x.sep <= radiusDeg)
    .sort((a, b) => a.sep - b.sep)
    .map((x) => ({ ...objectCard(x.o), separation_deg: x.sep }))
}

export const contentRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store, kit, config, fetchImpl, cache, index }) => {
  const inflight = new Map<string, Promise<Buffer>>()
  const cube = new CubeReader(fetchImpl, cache)
  const cached = async (key: string, load: () => Promise<Buffer>): Promise<{ buf: Buffer; hit: boolean }> => {
    const hit = await cache.get(key)
    if (hit) return { buf: hit, hit: true }
    let p = inflight.get(key)
    if (!p) {
      p = load().then(async (buf) => {
        await cache.put(key, buf)
        return buf
      })
      inflight.set(key, p)
      p.finally(() => inflight.delete(key)).catch(() => undefined)
    }
    return { buf: await p, hit: false }
  }

  app.get('/api/health', { schema: { tags: ['meta'], response: { 200: S.HealthResponse } } }, async () => ({
    ok: true,
    version: kit.manifest.version,
    objects: kit.objects.length,
    posts: kit.posts.length,
    cards: kit.deck.length,
    images_indexed: kit.index.images,
    notes: kit.manifest.notes,
  }))

  app.get(
    '/api/feed',
    {
      schema: {
        tags: ['feed'],
        querystring: Type.Object({
          tab: Type.Optional(Type.Union([Type.Literal('for_you'), Type.Literal('following'), Type.Literal('new'), Type.Literal('targets')])),
          cursor: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
        }),
        response: { 200: S.FeedResponse },
      },
    },
    async (req) => {
      const tab: FeedTab = req.query.tab ?? 'for_you'
      const cursor = req.query.cursor ?? 0
      const limit = req.query.limit ?? 8
      const userId = req.user?.id ?? null
      let posts: Post[]
      let notice: string | null = null
      if (tab === 'following') {
        const ids = new Set(store.following(userId))
        posts = roundRobin(kit, orderedObjects(kit).filter((o) => ids.has(o.id)))
        if (!ids.size) notice = 'follow_some'
      } else if (tab === 'targets') {
        posts = roundRobin(kit, orderedObjects(kit).filter((o) => o.official_target))
      } else if (tab === 'new') {
        const since = Date.now() - 7 * 86400000
        posts = kit.posts.filter((p) => Date.parse(p.date_range[1] ?? '') >= since)
        if (!posts.length) {
          notice = 'no_new_this_week'
          posts = [...kit.posts].sort((a, b) => (b.date_range[1] ?? '').localeCompare(a.date_range[1] ?? '')).slice(0, 36)
        }
      } else posts = roundRobin(kit, orderedObjects(kit))
      const page = posts.slice(cursor, cursor + limit)
      return {
        tab,
        notice,
        next_cursor: cursor + limit < posts.length ? cursor + limit : null,
        items: page.map((p) => ({ post: postDto(p), object: objectCard(store.object(p.object_id) as ObjectSummary), tags: store.tagSummary(userId, p.id) })),
      }
    },
  )

  const storyScreens = new Map(kit.objects.map((o) => [o.id, buildStoryScreens(kit, o.id)]))
  app.get('/api/stories', { schema: { tags: ['feed'], response: { 200: S.StoriesResponse } } }, async (req) => ({
    stories: orderedObjects(kit)
      .map((o) => ({ object: objectCard(o), screens: storyScreens.get(o.id) ?? [] }))
      .filter((s) => s.screens.length > 1),
    finds: store.findings.unseen(req.user?.id ?? null, STORY_FINDS),
  }))

  app.get('/api/objects', { schema: { tags: ['objects'], response: { 200: S.ObjectsResponse } } }, async () => ({ objects: orderedObjects(kit).map(objectCard) }))

  app.get(
    '/api/objects/:id',
    { schema: { tags: ['objects'], params: Type.Object({ id: Type.String({ maxLength: 80 }) }), response: { 200: S.ObjectProfileDto, 404: S.ErrorBody } } },
    async (req, reply) => {
      const p = kit.profiles.get(req.params.id)
      if (!p) return reply.status(404).send({ error: 'unknown_object' })
      const base = `/kit/objects/${p.id}/`
      const sciDir = join(kit.dataDir, 'objects', p.id)
      return {
        ...p,
        mags: { ...p.mags },
        avatar: base + p.avatar,
        pack: existsSync(join(sciDir, 'science', 'pack.json')) ? `${base}science/pack.json` : null,
        overlays: {
          gaia: existsSync(join(sciDir, 'overlays', 'gaia.json')) ? `${base}overlays/gaia.json` : null,
          wise: existsSync(join(sciDir, 'overlays', 'wise.json')) ? `${base}overlays/wise.json` : null,
        },
        measurements: Object.fromEntries(Object.entries(p.measurements ?? {}).map(([k, v]) => [k, base + v])),
        stats: { posts: postsForObject(kit, p.id).length, passes: p.n_passes, followers: store.followers(p.id) },
        finding: store.findings.forObject(p.id),
        following: store.isFollowing(req.user?.id ?? null, p.id),
      }
    },
  )

  app.get(
    '/api/objects/:id/posts',
    { schema: { tags: ['objects'], params: Type.Object({ id: Type.String({ maxLength: 80 }) }), response: { 200: S.ObjectPostsResponse, 404: S.ErrorBody } } },
    async (req, reply) => {
      if (!store.object(req.params.id)) return reply.status(404).send({ error: 'unknown_object' })
      return { posts: postsForObject(kit, req.params.id).map(postDto) }
    },
  )

  app.get(
    '/api/posts/:id',
    { schema: { tags: ['posts'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), response: { 200: S.PostDetail, 404: S.ErrorBody } } },
    async (req, reply) => {
      const p = kit.postsById.get(req.params.id)
      if (!p) return reply.status(404).send({ error: 'unknown_post' })
      const userId = req.user?.id ?? null
      const mine = store.myMarks(userId, p.id)
      return {
        post: postDto(p),
        object: objectCard(store.object(p.object_id) as ObjectSummary),
        tags: store.tagSummary(userId, p.id),
        my_marks: mine,
        community_marks: mine.length ? store.communityMarks(p.id) : null,
      }
    },
  )

  app.get(
    '/api/search',
    { schema: { tags: ['search'], querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 120 }) }), response: { 200: S.SearchResponse } } },
    async (req) => {
      const q = req.query.q.trim()
      const now = new Date().toISOString()
      const coords = parseCoordinates(q)
      if (coords) {
        return {
          query: q,
          resolved: true,
          objects: nearby(kit, coords.ra, coords.dec, 1, now),
          spot: { name: null, ra: coords.ra, dec: coords.dec, source: 'coordinates', epoch: null, moved_arcsec: null, stale: false, moving: false },
        }
      }
      const local = findObjectsByName(kit, q)
      if (local.length) {
        const top = local[0] as ObjectSummary
        const at = propagatePosition(top, top.last_seen)
        const moving = top.pm_ra_cosdec == null && ['asteroid', 'comet', 'interstellar'].includes(top.kind)
        return {
          query: q,
          resolved: true,
          objects: local.map((o) => ({ ...objectCard(o), separation_deg: null })),
          spot: { name: top.name, ra: at.ra, dec: at.dec, source: 'kit', epoch: epochYear(top.epoch), moved_arcsec: at.shiftArcsec, stale: at.shiftArcsec > STALE_ARCSEC, moving },
        }
      }
      if (!config.online) return { query: q, resolved: false, objects: [], spot: null }
      const r = await resolveName(q, { fetchImpl })
      if (!r) return { query: q, resolved: false, objects: [], spot: null }
      const at = propagatePosition({ ra: r.ra, dec: r.dec, epoch: `J${r.epoch}`, pm_ra_cosdec: r.pm_ra_cosdec, pm_dec: r.pm_dec }, now)
      return {
        query: q,
        resolved: true,
        objects: nearby(kit, at.ra, at.dec, 0.5, now),
        spot: { name: r.name, ra: at.ra, dec: at.dec, source: r.source, epoch: r.epoch, moved_arcsec: r.pm_ra_cosdec == null ? null : at.shiftArcsec, stale: at.shiftArcsec > STALE_ARCSEC || (r.pm_ra_cosdec == null && !r.moving), moving: r.moving },
      }
    },
  )

  app.get('/api/sky', { schema: { tags: ['sky'], querystring: S.SkyQuery, response: { 200: S.SkyResponse } } }, async (req) => {
    const { ra, dec } = req.query
    const fov = req.query.fov ?? 0.1
    const band = req.query.band ?? null
    const res = await imagesAt(join(kit.dataDir, 'index'), kit.wave, ra, dec, { online: config.online, fetchImpl, afterMjd: kit.index.until_mjd, ask: (q) => index.ask(q) })
    const images = band ? res.images.filter((i) => i.band === band) : res.images
    const bands: Record<string, number> = {}
    for (const i of res.images) bands[i.band] = (bands[i.band] ?? 0) + 1
    return {
      ra,
      dec,
      fov,
      band,
      source: res.source,
      incomplete: res.incomplete,
      cell: res.cell,
      point_bytes: res.cell === null ? null : res.homes.reduce((a, h) => a + (kit.index.photo_bytes.get(h) ?? 0), kit.index.cell_bytes.get(res.cell) ?? 0),
      total: images.length,
      releases: [...new Set(images.map((i) => i.release))].sort(),
      bands,
      images: images.slice(0, 2000),
      nearby: nearby(kit, ra, dec, Math.max(0.25, fov), new Date().toISOString()),
      total_file_bytes: totalFileBytes(images),
    }
  })

  app.get(
    '/api/sky/spectrum',
    {
      schema: {
        tags: ['sky'],
        summary: 'All 102 SPHEREx colours at one sky point, read from the IRSA DR1 all-sky cube (a quick look, not a measurement)',
        querystring: Type.Object({ ra: Type.Number({ minimum: 0, maximum: 360 }), dec: Type.Number({ minimum: -90, maximum: 90 }), obj: Type.Optional(Type.String({ maxLength: 64 })), v: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })) }),
        response: { 200: S.PointSpectrum, 404: S.ErrorBody, 502: S.ErrorBody, 503: S.ErrorBody },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!config.online) return reply.status(503).send({ error: 'offline' })
      const o = req.query.obj ? kit.objects.find((x) => x.id === req.query.obj) : undefined
      if (req.query.obj && !o) return reply.status(404).send({ error: 'object_not_found' })
      try {
        if (o) {
          let layout = await cube.layout(tileFor(o.ra, o.dec))
          let at = objectAt(o, midDate(layout.date_beg, layout.date_end))
          const moved = tileFor(at.ra, at.dec)
          if (moved !== layout.ipix) {
            layout = await cube.layout(moved)
            at = objectAt(o, midDate(layout.date_beg, layout.date_end))
          }
          const out = await cube.point(at.ra, at.dec)
          const object = { id: o.id, name: o.name, at: midDate(out.date_beg, out.date_end), shift_arcsec: at.shift_arcsec, solar_system: SOLAR_SYSTEM_KINDS.includes(o.kind) }
          return reply.header('cache-control', 'public, max-age=86400').send({ ...out, object, elsewhere: [] })
        }
        const out = await cube.point(req.query.ra, req.query.dec)
        const elsewhere = movedAway(kit.objects, req.query.ra, req.query.dec, midDate(out.date_beg, out.date_end), out.pixel_arcsec, new Date().toISOString())
        return reply.header('cache-control', 'public, max-age=86400').send({ ...out, object: null, elsewhere })
      } catch {
        return reply.status(502).send({ error: 'cube_failed' })
      }
    },
  )

  app.get(
    '/api/index/at',
    {
      schema: {
        tags: ['sky'],
        querystring: Type.Object({
          ra: Type.Number({ minimum: 0, maximum: 360 }),
          dec: Type.Number({ minimum: -90, maximum: 90 }),
          band: Type.Optional(Type.String({ pattern: '^D[1-6]$' })),
          t1: Type.Optional(Type.Number()),
          t2: Type.Optional(Type.Number()),
          max: Type.Optional(Type.Integer({ minimum: 2, maximum: 2000 })),
        }),
        response: { 200: S.IndexAtResponse },
      },
    },
    async (req) => {
      const { ra, dec, band, t1, t2 } = req.query
      const a = await index.ask({ indexDir: join(kit.dataDir, 'index'), ra, dec, band, t1, t2, max: req.query.max ?? 400 })
      return { cell: a.cell, total: a.total, sampled: a.sampled, rows: a.rows }
    },
  )

  app.get(
    '/api/cutout',
    {
      schema: {
        tags: ['sky'],
        querystring: Type.Object({
          key: Type.String({ pattern: CUTOUT_KEY.source, maxLength: 200 }),
          ra: Type.Number({ minimum: 0, maximum: 360 }),
          dec: Type.Number({ minimum: -90, maximum: 90 }),
          size: Type.Optional(Type.Number({ minimum: 0.01, maximum: 0.25 })),
        }),
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { key, ra, dec } = req.query
      if (!isSafeCutoutKey(key)) return reply.status(400).send({ error: 'invalid_key' })
      if (!config.online) return reply.status(503).send({ error: 'offline' })
      const size = req.query.size ?? 0.1
      try {
        const { buf, hit } = await cached(DiskCache.keyOf('irsa', key, ra.toFixed(5), dec.toFixed(5), size), async () => {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 30000)
          try {
            const r = await fetchImpl(`https://irsa.ipac.caltech.edu/ibe/data/spherex/${key}?center=${ra},${dec}d&size=${size}`, { signal: ctrl.signal })
            if (!r.ok) throw new HttpError(502, 'irsa_failed')
            return Buffer.from(await r.arrayBuffer())
          } finally {
            clearTimeout(timer)
          }
        })
        return reply.header('content-type', 'application/fits').header('cache-control', 'public, max-age=604800').header('x-cache', hit ? 'hit' : 'miss').send(buf)
      } catch (err) {
        if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
        return reply.status(504).send({ error: 'irsa_timeout' })
      }
    },
  )

  app.get(
    '/api/crop/*',
    {
      schema: {
        hide: true,
        querystring: Type.Object({
          off: Type.String({ pattern: '^\\d{1,12}(,\\d{1,12}){0,2}$' }),
          x0: Type.Integer({ minimum: 0, maximum: DETECTOR_PX - 1 }),
          y0: Type.Integer({ minimum: 0, maximum: DETECTOR_PX - 1 }),
          w: Type.Integer({ minimum: 1, maximum: CROP_MAX_PX }),
          h: Type.Integer({ minimum: 1, maximum: CROP_MAX_PX }),
          rice: Type.Optional(Type.String({ pattern: '^\\d{1,12},\\d{1,8},\\d{1,4},\\d{1,4}$' })),
          desc: Type.Optional(Type.String({ pattern: '^\\d{1,12},\\d{1,12}$' })),
        }),
      },
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const key = (req.params as { '*': string })['*']
      if (!isSafeCutoutKey(key)) return reply.status(400).send({ error: 'invalid_key' })
      const { x0, y0, w, h } = req.query
      if (x0 + w > DETECTOR_PX || y0 + h > DETECTOR_PX) return reply.status(400).send({ error: 'outside_detector' })
      const offs = req.query.off.split(',').map(Number)
      const [riceStart, riceLen, riceRows, riceSkip] = (req.query.rice ?? '').split(',').map(Number) as [number, number, number, number]
      const rice = req.query.rice !== undefined
      if (rice && (riceLen < 1 || riceLen > S3_MAX_RANGE || riceRows > DETECTOR_PX || riceSkip + h > riceRows)) return reply.status(400).send({ error: 'invalid_rice' })
      const [descStart, heapStart] = (req.query.desc ?? '').split(',').map(Number) as [number, number]
      const desc = req.query.desc !== undefined && !rice
      const ck = DiskCache.keyOf('crop', key, offs.join('.'), x0, y0, w, h, req.query.rice ?? '', req.query.desc ?? '')
      const hit = await cache.get(ck)
      if (!hit && !config.online) return reply.status(503).send({ error: 'offline' })
      try {
        const res = hit
          ? { buf: hit, hit: true }
          : await cached(ck, async () => {
              const rowBytes = DETECTOR_PX * 4
              const range = async (start: number, len: number) => {
                const ctrl = new AbortController()
                const timer = setTimeout(() => ctrl.abort(), 20000)
                try {
                  const r = await fetchImpl(S3_BASE + key, { headers: { Range: `bytes=${start}-${start + len - 1}` }, signal: ctrl.signal })
                  if (r.status !== 206) throw new HttpError(502, 's3_failed')
                  const got = Buffer.from(await r.arrayBuffer())
                  if (got.length !== len) throw new HttpError(502, 's3_short_read')
                  return got
                } finally {
                  clearTimeout(timer)
                }
              }
              const planes = offs.map(async (off) => cropColumns(await range(off + y0 * rowBytes, h * rowBytes), h, x0, w))
              if (rice) planes.push(range(riceStart, riceLen).then((span) => cropFlags(span, riceRows, riceSkip, h, x0, w)))
              if (desc)
                planes.push(
                  range(descStart, h * 8).then(async (table) => {
                    const first = table.readInt32BE(4)
                    const len = table.readInt32BE((h - 1) * 8 + 4) + table.readInt32BE((h - 1) * 8) - first
                    if (first < 0 || len < 1 || len > S3_MAX_RANGE) throw new HttpError(502, 's3_bad_table')
                    return cropFlags(await range(heapStart + first, len), h, 0, h, x0, w)
                  }),
                )
              return Buffer.concat(await Promise.all(planes))
            })
        return reply.header('content-type', 'application/octet-stream').header('cache-control', 'public, max-age=604800, immutable').header('x-cache', res.hit ? 'hit' : 'miss').send(res.buf)
      } catch (err) {
        if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
        return reply.status(504).send({ error: 's3_timeout' })
      }
    },
  )

  app.get(
    '/api/hips/:survey/:order/:npix',
    {
      schema: { hide: true, params: Type.Object({ survey: Type.String({ maxLength: 12 }), order: Type.Integer({ minimum: 0, maximum: 9 }), npix: Type.Integer({ minimum: 0 }) }) },
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { survey, order, npix } = req.params
      const s = HIPS_SURVEYS[survey]
      if (!s || order > s.maxOrder || npix >= 12 * 4 ** order) return reply.status(400).send({ error: 'invalid_tile' })
      const ck = DiskCache.keyOf('hips', survey, order, npix)
      const hit = await cache.get(ck)
      if (!hit && !config.online) return reply.status(503).send({ error: 'offline' })
      try {
        const buf = hit ?? (await cached(ck, async () => {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 20000)
          try {
            const r = await fetchImpl(`${HIPS_BASE}${s.path}/Norder${order}/Dir${Math.floor(npix / 10000) * 10000}/Npix${npix}.jpg`, { signal: ctrl.signal })
            if (r.status === 404) throw new HttpError(404, 'no_tile')
            if (!r.ok) throw new HttpError(502, 'hips_failed')
            return Buffer.from(await r.arrayBuffer())
          } finally {
            clearTimeout(timer)
          }
        })).buf
        return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=2592000, immutable').header('x-cache', hit ? 'hit' : 'miss').send(buf)
      } catch (err) {
        if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
        return reply.status(504).send({ error: 'hips_timeout' })
      }
    },
  )

  app.get('/api/s3/*', { schema: { hide: true }, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = (req.params as { '*': string })['*']
    if (!isSafeCutoutKey(key)) return reply.status(400).send({ error: 'invalid_key' })
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    const start = Number(m?.[1])
    const end = Number(m?.[2])
    if (!m || end < start || end - start + 1 > S3_MAX_RANGE) return reply.status(416).send({ error: 'range_required' })
    const ck = DiskCache.keyOf('s3', key, start, end)
    const hit = await cache.get(ck)
    if (!hit && !config.online) return reply.status(503).send({ error: 'offline' })
    try {
      const res = hit
        ? { buf: hit, hit: true }
        : await cached(ck, async () => {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 20000)
            try {
              const r = await fetchImpl(S3_BASE + key, { headers: { Range: `bytes=${start}-${end}` }, signal: ctrl.signal })
              if (r.status !== 206) throw new HttpError(502, 's3_failed')
              const buf = Buffer.from(await r.arrayBuffer())
              if (buf.length !== end - start + 1) throw new HttpError(502, 's3_short_read')
              return buf
            } finally {
              clearTimeout(timer)
            }
          })
      return reply
        .status(206)
        .header('content-type', 'application/octet-stream')
        .header('content-range', `bytes ${start}-${end}/*`)
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'public, max-age=604800, immutable')
        .header('x-cache', res.hit ? 'hit' : 'miss')
        .send(res.buf)
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
      return reply.status(504).send({ error: 's3_timeout' })
    }
  })
}
