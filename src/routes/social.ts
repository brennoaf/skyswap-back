import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import { requireUser, SESSION_COOKIE, writeLimit } from '../app.js'
import { objectCard } from '../dto.js'
import type { ObjectSummary } from '../kit.js'
import * as S from '../schemas.js'
import type { User } from '../store.js'
import type { RouteCtx } from './content.js'

const COOKIE_OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365 }
const OFFER_SIZE = 3
const MAX_NOT = 30

export const socialRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store }) => {
  app.get('/api/session', { schema: { tags: ['session'], response: { 200: S.SessionResponse } } }, async (req) => ({ user: req.user }))

  app.post('/api/session', { schema: { tags: ['session'], body: S.SessionBody, response: { 200: S.SessionResponse, 409: S.ErrorBody } }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { user, token } = store.createUser(req.body.nickname, req.body.avatar_id)
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS)
    return { user }
  })

  app.delete('/api/session', { schema: { tags: ['session'], response: { 200: S.SessionResponse } } }, async (req, reply) => {
    store.endSession(req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { user: null }
  })

  app.get('/api/avatars/offer', { schema: { tags: ['session'], querystring: S.AvatarOfferQuery, response: { 200: S.AvatarOffer } }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    return { avatars: store.avatars.offer(OFFER_SIZE, (req.query.not ?? '').split(',').filter(Boolean).slice(0, MAX_NOT)) }
  })

  app.put('/api/me/avatar', { schema: { tags: ['me'], body: S.AvatarBody, response: { 200: S.SessionResponse, 401: S.ErrorBody, 409: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    return { user: store.setAvatar(user, req.body.avatar_id) }
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
