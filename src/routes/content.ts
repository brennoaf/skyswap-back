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
import { postsForObject, type Store } from '../store.js'

export interface RouteCtx {
  store: Store
  kit: Kit
  config: Config
  fetchImpl: typeof fetch
}

type FeedTab = 'for_you' | 'following' | 'new' | 'targets'
const STALE_ARCSEC = 3
export const CUTOUT_KEY = /^qr[23]\/level2\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.fits$/

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

export const contentRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store, kit, config, fetchImpl }) => {
  app.get('/api/health', { schema: { tags: ['meta'], response: { 200: S.HealthResponse } } }, async () => ({
    ok: true,
    version: kit.manifest.version,
    objects: kit.objects.length,
    posts: kit.posts.length,
    cards: kit.deck.length,
    images_indexed: kit.manifest.images_indexed,
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

  app.get('/api/stories', { schema: { tags: ['feed'], response: { 200: S.StoriesResponse } } }, async () => ({
    stories: orderedObjects(kit).map((o) => {
      const post = postsForObject(kit, o.id).find((p) => p.type === 'timelapse' && p.frames.length) ?? postsForObject(kit, o.id).find((p) => p.frames.length)
      const dto = post ? postDto(post) : null
      return { object: objectCard(o), post_id: post?.id ?? null, frames: (dto?.frames ?? []).map((f) => ({ src: f.src, t: f.t, band: f.band })) }
    }),
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
    const res = await imagesAt(join(kit.dataDir, 'index'), kit.wave, ra, dec, { online: config.online, fetchImpl })
    const images = band ? res.images.filter((i) => i.band === band) : res.images
    const bands: Record<string, number> = {}
    for (const i of res.images) bands[i.band] = (bands[i.band] ?? 0) + 1
    return {
      ra,
      dec,
      fov,
      band,
      source: res.source,
      cell: res.cell,
      total: images.length,
      releases: [...new Set(images.map((i) => i.release))].sort(),
      bands,
      images: images.slice(0, 2000),
      nearby: nearby(kit, ra, dec, Math.max(0.25, fov), new Date().toISOString()),
      total_file_bytes: totalFileBytes(images),
    }
  })

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
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30000)
      try {
        const r = await fetchImpl(`https://irsa.ipac.caltech.edu/ibe/data/spherex/${key}?center=${ra},${dec}d&size=${size}`, { signal: ctrl.signal })
        if (!r.ok) return reply.status(502).send({ error: 'irsa_failed' })
        const buf = Buffer.from(await r.arrayBuffer())
        return reply.header('content-type', 'application/fits').header('cache-control', 'public, max-age=604800').send(buf)
      } catch {
        return reply.status(504).send({ error: 'irsa_timeout' })
      } finally {
        clearTimeout(timer)
      }
    },
  )
}
