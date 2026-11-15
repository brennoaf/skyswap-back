import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import { EXPLORE_ORDER, mjdIso, skyVisits } from '../explore.js'
import type { DeckCard } from '../kit.js'
import { snapMarks } from '../marks.js'
import * as S from '../schemas.js'
import { isSafeCutoutKey, type RouteCtx } from './content.js'

export function publicCard(c: DeckCard) {
  return {
    id: c.id,
    sprite: `/kit/deck/${c.sprite.split('/').pop() ?? ''}`,
    n_frames: c.n_frames,
    offsets_s: c.frames.map((f) => Math.round(((f.mjd - (c.frames[0]?.mjd ?? f.mjd)) * 86400))),
    t0: mjdIso(c.frames[0]?.mjd ?? 0),
  }
}

export const classifyRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store, kit }) => {
  app.get('/api/classify/next', { schema: { tags: ['classify'], querystring: S.NextCardQuery, response: { 200: S.NextCardResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const r = store.next(user.id, { explore: req.query.explore, known: req.query.known, open: req.query.open, not: (req.query.not ?? '').split(',').filter(Boolean) })
    return { done: !r.card && !r.sky, card: r.card ? publicCard(r.card) : null, sky: r.sky, spot: r.spot }
  })

  app.get('/api/classify/shared/:id', { schema: { tags: ['classify'], params: Type.Object({ id: Type.String({ maxLength: 64 }) }), response: { 200: S.SharedCardResponse, 401: S.ErrorBody, 404: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const shared = store.sharedCard(user.id, req.params.id)
    if (!shared) return reply.status(404).send({ error: 'unknown_card' })
    return { card: publicCard(shared.card), answered: shared.answered }
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
    reply.header('cache-control', 'no-cache')
    return { order: EXPLORE_ORDER, cells: kit.indexCells, bytes: kit.indexCells.map((c) => kit.index.cell_bytes.get(c) ?? 0), photo_bytes: kit.indexCells.map((c) => kit.index.photo_bytes.get(c) ?? 0) }
  })

  app.get('/api/explore/map', { schema: { tags: ['explore'], response: { 200: S.ExploreMapResponse } } }, async (req) => store.exploreMap(req.user?.id ?? null))

  app.get('/api/candidates', { schema: { tags: ['explore'], querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }), response: { 200: S.CandidatesResponse } } }, async (req) => ({
    candidates: store.candidates(req.query.limit ?? 100),
  }))

  app.post('/api/classify/votes', { schema: { tags: ['classify'], body: S.VoteBody, response: { 200: S.VoteResponse, 400: S.ErrorBody, 401: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const positions = req.body.positions
    if (positions && !positions.every((p, i) => !p || p.frame === i)) return reply.status(400).send({ error: 'invalid_position' })
    const marks = positions ? await snapMarks(kit.dataDir, kit.deckById.get(req.body.card_id) ?? null, positions) : undefined
    const r = store.vote(user.id, req.body.card_id, req.body.choice, req.body.glitch ?? null, req.body.position ?? null, { heldMs: req.body.held_ms ?? 0, thinkMs: req.body.think_ms, answeredAt: req.body.answered_at, hints: req.body.hints ?? null, marks })
    return { counted: r.counted, guided: r.guided, xp: r.xp, reveal: r.reveal, new_badges: r.newBadges, first: r.first }
  })

  app.post('/api/classify/shown', { schema: { tags: ['classify'], body: S.CardShownBody, response: { 200: Type.Object({ ok: Type.Boolean() }), 401: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    store.cardShown(user.id, req.body.card_id)
    return { ok: true }
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
    return {
      lessons: store.guideLessons(user.id).map((l) => ({ lesson: l.lesson, card: publicCard(l.card), marks: l.lesson === 'still' ? [] : (l.card.marks ?? []) })),
      examples: store.guideExamples().map((e) => ({ example: e.example, card: publicCard(e.card), marks: e.example === 'moves' ? (e.card.marks ?? []) : [] })),
    }
  })
}
