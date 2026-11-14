import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import type { DeckCard } from '../kit.js'
import * as S from '../schemas.js'
import type { RouteCtx } from './content.js'

export function publicCard(c: DeckCard) {
  return {
    id: c.id,
    sprite: `/kit/deck/${c.sprite.split('/').pop() ?? ''}`,
    tile: c.tile,
    n_frames: c.n_frames,
    frames: c.frames.map((f) => ({ t: f.t, mjd: f.mjd, n_exp: f.n_exp })),
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
    const r = store.vote(user.id, req.body.card_id, req.body.label)
    return { counted: r.counted, xp: r.xp, reveal: r.reveal, new_badges: r.newBadges }
  })
}
