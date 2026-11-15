import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import * as S from '../schemas.js'
import type { RouteCtx } from './content.js'

export const communityRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get(
    '/api/community/feed',
    { schema: { tags: ['community'], querystring: Type.Object({ tab: Type.Optional(Type.Literal('new')), cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), response: { 200: S.CommunityFeed } } },
    async (req) => {
      const page = store.findings.feed(req.query.cursor ?? 0)
      if (req.user) store.findings.expose(req.user.id, page.items.map((i) => i.id), 'feed')
      return page
    },
  )

  app.get(
    '/api/community/findings/:id',
    { schema: { tags: ['community'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), response: { 200: S.FindingDetail, 404: S.ErrorBody } } },
    async (req, reply) => {
      const finding = store.findings.detail(req.params.id)
      if (!finding) return reply.status(404).send({ error: 'unknown_finding' })
      if (req.user) store.findings.expose(req.user.id, [finding.id], 'link')
      return finding
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
