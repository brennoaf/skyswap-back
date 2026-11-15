import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import * as S from '../schemas.js'
import { CHOICE_LABEL } from '../store.js'
import type { RouteCtx } from './content.js'

export const communityRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get(
    '/api/community/feed',
    { schema: { tags: ['community'], querystring: Type.Object({ tab: Type.Optional(Type.Union([Type.Literal('new'), Type.Literal('popular')])), cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), response: { 200: S.CommunityFeed } } },
    async (req) => {
      const page = store.findings.feed(req.query.cursor ?? 0, { tab: req.query.tab ?? 'new', userId: req.user?.id ?? null })
      if (req.user) store.findings.expose(req.user.id, page.items.map((i) => i.id), 'feed')
      return page
    },
  )

  app.get(
    '/api/community/findings/:id',
    { schema: { tags: ['community'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), response: { 200: S.FindingDetail, 404: S.ErrorBody } } },
    async (req, reply) => {
      const finding = store.findings.detail(req.params.id, req.user?.id ?? null)
      if (!finding) return reply.status(404).send({ error: 'unknown_finding' })
      if (req.user) store.findings.expose(req.user.id, [finding.id], 'link')
      return finding
    },
  )

  app.get('/api/community/overview', { schema: { tags: ['community'], response: { 200: S.CommunityOverview } } }, async (req) => {
    const userId = req.user?.id ?? null
    const highlight = store.findings.highlight(userId)
    if (userId && highlight) store.findings.expose(userId, [highlight.id], 'feed')
    return { open_cards: store.openCards(userId), highlight, has_popular: store.findings.hasPopular() }
  })

  const FindingParams = Type.Object({ id: Type.String({ maxLength: 120 }) })

  app.get('/api/community/findings/:id/people', { schema: { tags: ['community'], params: FindingParams, response: { 200: S.FindingPeople, 404: S.ErrorBody } } }, async (req, reply) => {
    if (!store.findings.stateOf(req.params.id)) return reply.status(404).send({ error: 'unknown_finding' })
    return store.findings.people(req.params.id)
  })

  app.post(
    '/api/community/findings/:id/reaction',
    { config: writeLimit, schema: { tags: ['community'], params: FindingParams, body: S.ReactionBody, response: { 200: S.FindingSocial, 400: S.ErrorBody, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const { id } = req.params
      if (!store.findings.stateOf(id)) return reply.status(404).send({ error: 'unknown_finding' })
      const { kind, on, reason, position } = req.body
      if (kind === 'doubt' && on && !reason) return reply.status(400).send({ error: 'reason_required' })
      store.findings.expose(user.id, [id], 'link')
      store.findings.setReaction(user.id, id, kind, on, reason ?? null, position ?? null)
      return store.findings.social(id, user.id)
    },
  )

  app.post(
    '/api/community/findings/:id/second-look',
    { config: writeLimit, schema: { tags: ['community'], params: FindingParams, body: S.SecondLookBody, response: { 200: S.FindingSocial, 401: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const { id } = req.params
      if (!store.findings.stateOf(id)) return reply.status(404).send({ error: 'unknown_finding' })
      if (!store.findings.secondLook(user.id, id, CHOICE_LABEL[req.body.choice])) return reply.status(409).send({ error: 'already_voted' })
      store.findings.expose(user.id, [id], 'link')
      return store.findings.social(id, user.id)
    },
  )

  app.post(
    '/api/community/findings/:id/follow',
    { config: writeLimit, schema: { tags: ['community'], params: FindingParams, body: S.FindingFollowBody, response: { 200: S.FindingSocial, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const { id } = req.params
      if (!store.findings.stateOf(id)) return reply.status(404).send({ error: 'unknown_finding' })
      store.findings.setFollow(user.id, id, req.body.on)
      return store.findings.social(id, user.id)
    },
  )

  app.get(
    '/api/me/cards',
    { schema: { tags: ['me'], querystring: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), response: { 200: S.MyCards, 401: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      return store.myCards(user.id, req.query.cursor ?? 0)
    },
  )

  app.get('/api/me/credit', { schema: { tags: ['me'], response: { 200: S.CreditResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    return { visible: store.creditVisible(user.id) }
  })

  app.put('/api/me/credit', { config: writeLimit, schema: { tags: ['me'], body: S.CreditResponse, response: { 200: S.CreditResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    store.setCreditVisible(user.id, req.body.visible)
    return { visible: req.body.visible }
  })
}
