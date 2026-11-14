import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import { requireUser, SESSION_COOKIE, writeLimit } from '../app.js'
import { objectCard } from '../dto.js'
import type { ObjectSummary } from '../kit.js'
import * as S from '../schemas.js'
import type { User } from '../store.js'
import type { RouteCtx } from './content.js'

const COOKIE_OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365 }

export const socialRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get('/api/session', { schema: { tags: ['session'], response: { 200: S.SessionResponse } } }, async (req) => ({ user: req.user }))

  app.post('/api/session', { schema: { tags: ['session'], body: S.SessionBody, response: { 200: S.SessionResponse, 409: S.ErrorBody } }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { user, token } = store.createUser(req.body.nickname)
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS)
    return { user }
  })

  app.delete('/api/session', { schema: { tags: ['session'], response: { 200: S.SessionResponse } } }, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { user: null }
  })

  app.post(
    '/api/posts/:id/tags',
    { schema: { tags: ['posts'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), body: S.TagBody, response: { 200: S.TagResponse } }, config: writeLimit },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const xp = store.setTag(user.id, req.params.id, req.body.tag, req.body.on)
      return { tags: store.tagSummary(user.id, req.params.id), xp }
    },
  )

  app.post(
    '/api/posts/:id/marks',
    { schema: { tags: ['posts'], params: Type.Object({ id: Type.String({ maxLength: 120 }) }), body: S.MarksBody, response: { 200: S.MarksResponse } }, config: writeLimit },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const r = store.saveMarks(user.id, req.params.id, req.body.marks)
      return { saved: r.saved, xp: r.xp, new_badges: r.newBadges, my_marks: store.myMarks(user.id, req.params.id), community_marks: store.communityMarks(req.params.id) }
    },
  )

  app.post(
    '/api/objects/:id/follow',
    { schema: { tags: ['objects'], params: Type.Object({ id: Type.String({ maxLength: 80 }) }), body: S.FollowBody, response: { 200: S.FollowResponse } }, config: writeLimit },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const xp = store.setFollow(user.id, req.params.id, req.body.on)
      return { following: store.isFollowing(user.id, req.params.id), followers: store.followers(req.params.id), xp }
    },
  )

  app.post('/api/learn', { schema: { tags: ['me'], body: S.LearnBody, response: { 200: S.LearnResponse } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    return { new_badges: store.learn(user.id, req.body.event, req.body.ref) }
  })

  const meBody = (user: User) => ({
    ...store.me(user),
    following: store
      .following(user.id)
      .map((id) => store.object(id))
      .filter((o): o is ObjectSummary => !!o)
      .map(objectCard),
    history: store.history(user.id),
  })

  app.get('/api/me', { schema: { tags: ['me'], response: { 200: S.MeResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    return meBody(user)
  })

  app.get('/api/alerts', { schema: { tags: ['alerts'], response: { 200: S.AlertsResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const alerts = store.alerts(user.id).map((a) => {
      const o = a.type === 'new_data' ? store.object(a.ref) : undefined
      return { ...a, object: o ? objectCard(o) : null }
    })
    return { alerts, unread: alerts.filter((a) => !a.read).length }
  })

  app.post('/api/alerts/read', { schema: { tags: ['alerts'], body: S.AlertsReadBody, response: { 200: Type.Object({ ok: Type.Boolean() }) } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    store.markAlertsRead(user.id, req.body.ids)
    return { ok: true }
  })

  app.get('/api/community/goals', { schema: { tags: ['community'], response: { 200: S.GoalsResponse } } }, async () => ({ goals: store.goals() }))

}
