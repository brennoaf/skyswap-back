import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { requireUser, writeLimit } from '../app.js'
import * as S from '../schemas.js'
import { CHOICE_LABEL } from '../store.js'
import { RETIRE_REAL_MIN } from '../swap.js'
import type { RouteCtx } from './content.js'

export const communityRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get(
    '/api/community/feed',
    { schema: { tags: ['community'], querystring: Type.Object({ tab: Type.Optional(Type.Union([Type.Literal('new'), Type.Literal('popular'), Type.Literal('open'), Type.Literal('solved')])), cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), response: { 200: S.CommunityFeed } } },
    async (req) => {
      const page = store.findings.feed(req.query.cursor ?? 0, { tab: req.query.tab ?? 'new', userId: req.user?.id ?? null })
      if (req.user) store.findings.expose(req.user.id, page.items.flatMap((i) => ('type' in i && i.type === 'app' ? [] : [i.id])), 'feed')
      return page
    },
  )

  const ThreadParams = Type.Object({ id: Type.String({ maxLength: 120 }) })
  const CommentParams = Type.Object({ cid: Type.Integer({ minimum: 1 }) })
  const ADD_ERRORS = { empty: 400, too_long: 400, bad_parent: 400, too_deep: 400, too_many: 429 } as const

  app.get(
    '/api/community/threads/:id',
    { schema: { tags: ['community'], params: ThreadParams, querystring: Type.Object({ sort: Type.Optional(Type.Union([Type.Literal('best'), Type.Literal('new')])) }), response: { 200: S.Thread, 404: S.ErrorBody } } },
    async (req, reply) => {
      if (!store.findings.isTarget(req.params.id)) return reply.status(404).send({ error: 'unknown_post' })
      if (req.user && !store.findings.isAppPost(req.params.id)) store.findings.expose(req.user.id, [req.params.id], 'link')
      return store.findings.comments.thread(req.params.id, req.user?.id ?? null, req.query.sort ?? 'best')
    },
  )

  app.post(
    '/api/community/threads/:id/comments',
    { config: writeLimit, schema: { tags: ['community'], params: ThreadParams, body: S.CommentBody, response: { 200: Type.Object({ id: Type.Integer() }), 400: S.ErrorBody, 401: S.ErrorBody, 404: S.ErrorBody, 429: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      if (!store.findings.isTarget(req.params.id)) return reply.status(404).send({ error: 'unknown_post' })
      const res = store.findings.comments.add(req.params.id, user.id, req.body.body, req.body.parent_id ?? null)
      if ('error' in res) return reply.status(ADD_ERRORS[res.error]).send({ error: res.error })
      return res
    },
  )

  app.post(
    '/api/community/threads/:id/vote',
    { config: writeLimit, schema: { tags: ['community'], params: ThreadParams, body: S.TalkVoteBody, response: { 200: S.ThreadSummary, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      if (!store.findings.isTarget(req.params.id)) return reply.status(404).send({ error: 'unknown_post' })
      store.findings.comments.votePost(req.params.id, user.id, req.body.value)
      return store.findings.comments.summary(req.params.id, user.id)
    },
  )

  app.post(
    '/api/community/comments/:cid/vote',
    { config: writeLimit, schema: { tags: ['community'], params: CommentParams, body: S.TalkVoteBody, response: { 200: Type.Object({ ok: Type.Boolean() }), 400: S.ErrorBody, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const c = store.findings.comments.targetOf(req.params.cid)
      if (!c || c.deleted) return reply.status(404).send({ error: 'unknown_comment' })
      if (c.user_id === user.id) return reply.status(400).send({ error: 'own_comment' })
      store.findings.comments.vote(req.params.cid, user.id, req.body.value)
      return { ok: true }
    },
  )

  app.post(
    '/api/community/comments/:cid/report',
    { config: writeLimit, schema: { tags: ['community'], params: CommentParams, response: { 200: Type.Object({ ok: Type.Boolean() }), 400: S.ErrorBody, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const c = store.findings.comments.targetOf(req.params.cid)
      if (!c || c.deleted) return reply.status(404).send({ error: 'unknown_comment' })
      if (c.user_id === user.id) return reply.status(400).send({ error: 'own_comment' })
      store.findings.comments.report(req.params.cid, user.id)
      return { ok: true }
    },
  )

  app.delete(
    '/api/community/comments/:cid',
    { config: writeLimit, schema: { tags: ['community'], params: CommentParams, response: { 200: Type.Object({ ok: Type.Boolean() }), 401: S.ErrorBody, 403: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const c = store.findings.comments.targetOf(req.params.cid)
      if (!c || c.deleted) return reply.status(404).send({ error: 'unknown_comment' })
      if (c.user_id !== user.id) return reply.status(403).send({ error: 'not_yours' })
      store.findings.comments.remove(req.params.cid)
      return { ok: true }
    },
  )

  app.get(
    '/api/community/findings/:id/finders',
    { schema: { tags: ['community'], params: ThreadParams, response: { 200: S.Finders, 404: S.ErrorBody } } },
    async (req, reply) => store.findings.finders(req.params.id) ?? reply.status(404).send({ error: 'unknown_finding' }),
  )

  app.get(
    '/api/community/posts/:id',
    { schema: { tags: ['community'], params: ThreadParams, response: { 200: S.AppPostItem, 404: S.ErrorBody } } },
    async (req, reply) => store.appPost(req.params.id, req.user?.id ?? null) ?? reply.status(404).send({ error: 'unknown_post' }),
  )

  app.get(
    '/api/accounts/:handle',
    { schema: { tags: ['community'], params: Type.Object({ handle: Type.String({ maxLength: 40 }) }), response: { 200: S.AccountPage, 404: S.ErrorBody } } },
    async (req, reply) => {
      const page = store.appAccountPage(req.params.handle, req.user?.id ?? null)
      return page ?? reply.status(404).send({ error: 'unknown_account' })
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

  app.get('/api/community/findings/:id/photo', { schema: { hide: true, params: Type.Object({ id: Type.String({ maxLength: 120 }) }) } }, async (req, reply) => {
    const photo = store.skyThumb(req.params.id)
    if (!photo) return reply.status(404).send({ error: 'no_photo' })
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=86400').send(photo)
  })

  app.get('/api/community/overview', { schema: { tags: ['community'], response: { 200: S.CommunityOverview } } }, async (req) => {
    const userId = req.user?.id ?? null
    const highlight = store.findings.highlight(userId)
    if (userId && highlight) store.findings.expose(userId, [highlight.id], 'feed')
    return { open_cards: store.openCards(userId), close_votes: RETIRE_REAL_MIN, highlight, has_popular: store.findings.hasPopular() }
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
      const app = store.findings.isAppPost(id)
      if (!app && !store.findings.stateOf(id)) return reply.status(404).send({ error: 'unknown_finding' })
      const { kind, on, reason, position } = req.body
      if (app && kind !== 'interesting') return reply.status(400).send({ error: 'interesting_only' })
      if (kind === 'doubt' && on && !reason) return reply.status(400).send({ error: 'reason_required' })
      if (!app) store.findings.expose(user.id, [id], 'link')
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

  app.get(
    '/api/me/cards/:id',
    { schema: { tags: ['me'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), response: { 200: S.MyCardDetail, 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      return store.myCard(user.id, req.params.id)
    },
  )

  app.put(
    '/api/me/cards/:id/note',
    { config: writeLimit, schema: { tags: ['me'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), body: S.NoteBody, response: { 200: S.NoteBody, 400: S.ErrorBody, 401: S.ErrorBody, 403: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      return { note: store.setNote(user.id, req.params.id, req.body.note) }
    },
  )

  app.post(
    '/api/community/findings/:id/note-report',
    { config: writeLimit, schema: { tags: ['community'], params: FindingParams, response: { 200: Type.Object({ ok: Type.Boolean() }), 401: S.ErrorBody, 404: S.ErrorBody } } },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      if (!store.findings.reportNote(user.id, req.params.id)) return reply.status(404).send({ error: 'no_note' })
      return { ok: true }
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
