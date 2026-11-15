import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireUser, SESSION_COOKIE, writeLimit } from '../app.js'
import * as A from '../auth-schemas.js'
import { deviceOf } from '../device.js'
import * as S from '../schemas.js'
import { HttpError } from '../store.js'
import type { RouteCtx } from './content.js'

export const COOKIE_OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365 }
const RP_NAME = 'SkySwap'
const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } }
const polling = { rateLimit: { max: 120, timeWindow: '1 minute' } }

export const authRoutes: FastifyPluginAsyncTypebox<RouteCtx> = async (app, { store, config }) => {
  const signIn = (req: FastifyRequest, reply: FastifyReply, token: string) => {
    const previous = req.cookies[SESSION_COOKIE]
    if (previous) store.endSession(previous)
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS)
  }
  const device = (req: FastifyRequest) => deviceOf(req.headers['user-agent'])
  const expected = { expectedOrigin: config.origins, expectedRPID: config.rpId }

  app.get('/api/auth/account', { schema: { tags: ['account'], response: { 200: A.AccountResponse, 401: S.ErrorBody } } }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    reply.header('cache-control', 'no-store')
    return store.auth.account(user.id, req.cookies[SESSION_COOKIE])
  })

  app.delete(
    '/api/auth/devices/:id',
    { schema: { tags: ['account'], params: Type.Object({ id: Type.String({ maxLength: 40 }) }), response: { 200: A.RemoveDeviceResponse, 401: S.ErrorBody, 404: S.ErrorBody } }, config: writeLimit },
    async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return reply
      const result = store.auth.removeDevice(user.id, req.params.id, req.cookies[SESSION_COOKIE])
      if (result.current) reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return result
    },
  )

  app.post('/api/auth/passkey/register/options', { schema: { tags: ['account'], response: { 200: A.PasskeyOptions, 401: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: config.rpId,
      userName: user.nickname,
      userDisplayName: user.nickname,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: store.auth.passkeysOf(user.id),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      preferredAuthenticatorType: 'localDevice',
    })
    return { flow: store.auth.saveChallenge('register', options.challenge, user.id), options: options as unknown as Record<string, unknown> }
  })

  app.post('/api/auth/passkey/register/verify', { schema: { tags: ['account'], body: A.PasskeyBody, response: { 200: A.OkResponse, 400: S.ErrorBody, 401: S.ErrorBody, 409: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    const challenge = store.auth.takeChallenge(req.body.flow, 'register', user.id)
    const result = await verifyRegistrationResponse({ response: req.body.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge, ...expected, requireUserVerification: false }).catch(() => null)
    if (!result?.verified) throw new HttpError(400, 'passkey_rejected')
    const { credential } = result.registrationInfo
    store.auth.addPasskey(user.id, store.auth.sessionId(req.cookies[SESSION_COOKIE]), credential)
    return { ok: true }
  })

  app.post('/api/auth/passkey/login/options', { schema: { tags: ['account'], response: { 200: A.PasskeyOptions } }, config: polling }, async () => {
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'preferred' })
    return { flow: store.auth.saveChallenge('login', options.challenge, null), options: options as unknown as Record<string, unknown> }
  })

  app.post('/api/auth/passkey/login/verify', { schema: { tags: ['account'], body: A.PasskeyBody, response: { 200: S.SessionResponse, 400: S.ErrorBody, 401: S.ErrorBody } }, config: strict }, async (req, reply) => {
    const challenge = store.auth.takeChallenge(req.body.flow, 'login', null)
    const response = req.body.response as unknown as AuthenticationResponseJSON
    const key = typeof response.id === 'string' ? store.auth.passkey(response.id) : null
    if (!key) throw new HttpError(401, 'passkey_unknown')
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      ...expected,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: key.transports },
      requireUserVerification: false,
    }).catch(() => null)
    if (!result?.verified) throw new HttpError(401, 'passkey_rejected')
    const { user, token } = store.auth.loginWithPasskey(key.id, result.authenticationInfo.newCounter, device(req))
    signIn(req, reply, token)
    return { user }
  })

  app.post('/api/auth/recovery-code', { schema: { tags: ['account'], response: { 200: A.RecoveryCode, 401: S.ErrorBody } }, config: strict }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    reply.header('cache-control', 'no-store')
    return { code: store.auth.newRecoveryCode(user.id) }
  })

  app.post('/api/auth/recover', { schema: { tags: ['account'], body: A.RecoverBody, response: { 200: A.RecoverResponse, 401: S.ErrorBody } }, config: strict }, async (req, reply) => {
    const { user, token, code } = store.auth.recover(req.body.nickname, req.body.code, device(req))
    signIn(req, reply, token)
    reply.header('cache-control', 'no-store')
    return { user, code }
  })

  app.post('/api/auth/link', { schema: { tags: ['account'], response: { 200: A.LinkCreated } }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    return store.auth.createLink(device(req))
  })

  app.post('/api/auth/link/claim', { schema: { tags: ['account'], body: A.LinkPollBody, response: { 200: A.LinkClaim, 404: S.ErrorBody, 409: S.ErrorBody, 410: S.ErrorBody } }, config: polling }, async (req, reply) => {
    const state = store.auth.claimLink(req.body.poll)
    if (state.status === 'waiting') return { status: state.status, user: null }
    signIn(req, reply, state.token)
    return { status: state.status, user: state.user }
  })

  app.post('/api/auth/link/inspect', { schema: { tags: ['account'], body: A.LinkCodeBody, response: { 200: A.LinkInfo, 401: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody, 410: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    return store.auth.inspectLink(req.body.code)
  })

  app.post('/api/auth/link/approve', { schema: { tags: ['account'], body: A.LinkCodeBody, response: { 200: A.OkResponse, 401: S.ErrorBody, 404: S.ErrorBody, 409: S.ErrorBody, 410: S.ErrorBody } }, config: writeLimit }, async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return reply
    store.auth.approveLink(user.id, req.body.code)
    return { ok: true }
  })
}
