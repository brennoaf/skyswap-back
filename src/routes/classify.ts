import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import { EXPLORE_ORDER, skyVisits } from '../explore.js'
import type { DeckCard } from '../kit.js'
import * as S from '../schemas.js'
import { isSafeCutoutKey, type RouteCtx } from './content.js'

export function publicCard(c: DeckCard) {
  return {
    id: c.id,
    sprite: `/kit/deck/${c.sprite.split('/').pop() ?? ''}`,
    n_frames: c.n_frames,
    offsets_s: c.frames.map((f) => Math.round(((f.mjd - (c.frames[0]?.mjd ?? f.mjd)) * 86400))),
  }
}

export const classifyRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store, kit }) => {
  app.get('/api/classify/next', { schema: { tags: ['classify'], querystring: S.NextCardQuery, response: { 200: S.NextCardResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const r = store.next(user.id, { explore: req.query.explore, known: req.query.known })
    return { done: !r.card && !r.sky, card: r.card ? publicCard(r.card) : null, sky: r.sky, interesting: r.interesting }
  })

  app.post('/api/classify/sky', { schema: { tags: ['classify'], body: S.SkyCardBody, response: { 200: S.SkyCardResponse, 400: S.ErrorBody, 401: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    if (!req.body.frames.every((f) => isSafeCutoutKey(f.key))) return reply.status(400).send({ error: 'invalid_key' })
    if (skyVisits(req.body.frames).length < 2) return reply.status(400).send({ error: 'need_two_visits' })
    const card = store.registerSkyCard(user.id, req.body)
    const visits = skyVisits(card.frames)
    const t0 = visits[0]?.mjd ?? 0
    return { id: card.id, ra: card.ra, dec: card.dec, cell: card.cell, offsets_s: visits.map((v) => Math.round((v.mjd - t0) * 86400)) }
  })

  app.get('/api/explore/cells', { schema: { tags: ['explore'], response: { 200: S.ExploreCellsResponse } } }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600')
    return { order: EXPLORE_ORDER, cells: kit.indexCells }
  })

  app.get('/api/explore/map', { schema: { tags: ['explore'], response: { 200: S.ExploreMapResponse } } }, async (req) => store.exploreMap(req.user?.id ?? null))

  app.get('/api/candidates', { schema: { tags: ['explore'], querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }), response: { 200: S.CandidatesResponse } } }, async (req) => ({
    candidates: store.candidates(req.query.limit ?? 100),
  }))

  app.post('/api/classify/votes', { schema: { tags: ['classify'], body: S.VoteBody, response: { 200: S.VoteResponse, 401: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const r = store.vote(user.id, req.body.card_id, req.body.choice, req.body.glitch ?? null)
    return { counted: r.counted, guided: r.guided, xp: r.xp, reveal: r.reveal, new_badges: r.newBadges }
  })

  app.post(
    '/api/classify/votes/:id/glitch',
    { schema: { tags: ['classify'], params: Type.Object({ id: Type.String({ maxLength: 64 }) }), body: S.GlitchBody, response: { 200: Type.Object({ ok: Type.Boolean() }), 401: S.ErrorBody, 404: S.ErrorBody } }, config: writeLimit },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      store.setGlitch(user.id, req.params.id, req.body.glitch)
      return { ok: true }
    },
  )

  app.get('/api/classify/guide', { schema: { tags: ['classify'], response: { 200: S.GuideResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const card = store.guideCard(user.id)
    return { card: card ? publicCard(card) : null, marks: card?.marks ?? [] }
  })
}
