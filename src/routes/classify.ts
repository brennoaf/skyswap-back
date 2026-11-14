import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import type { DeckCard } from '../kit.js'
import * as S from '../schemas.js'
import type { RouteCtx } from './content.js'

export function publicCard(c: DeckCard) {
  return {
    id: c.id,
    sprite: `/kit/deck/${c.sprite.split('/').pop() ?? ''}`,
    n_frames: c.n_frames,
    offsets_s: c.frames.map((f) => Math.round(((f.mjd - (c.frames[0]?.mjd ?? f.mjd)) * 86400))),
  }
}

export const classifyRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get('/api/classify/next', { schema: { tags: ['classify'], response: { 200: S.NextCardResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const card = store.nextCard(user.id)
    return { done: !card, card: card ? publicCard(card) : null }
  })

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
