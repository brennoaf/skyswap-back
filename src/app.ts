import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { openDb, type DB } from './db.js'
import { loadKit, type Kit } from './kit.js'
import { HttpError, Store, type User } from './store.js'
import * as S from './schemas.js'
import { contentRoutes } from './routes/content.js'
import { socialRoutes } from './routes/social.js'
import { classifyRoutes } from './routes/classify.js'

export const SESSION_COOKIE = 'ss_session'

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null
  }
}

export interface AppDeps {
  config: Config
  kit?: Kit
  db?: DB
  now?: () => number
  random?: () => number
  fetchImpl?: typeof fetch
}

export async function buildApp(deps: AppDeps) {
  const { config } = deps
  const kit = deps.kit ?? loadKit(config.dataDir)
  const db = deps.db ?? openDb(config.dbPath)
  const store = new Store(db, kit, deps.now, deps.random)
  const app = Fastify({ logger: false, trustProxy: true }).withTypeProvider<TypeBoxTypeProvider>()

  await app.register(cookie, { secret: config.cookieSecret })
  await app.register(cors, { origin: [config.webOrigin], credentials: true })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' })
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'SkySwap API', version: '0.1.0', description: 'Sky objects from real NASA SPHEREx images, served from the SkySwap data kit.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
    },
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  for (const schema of [S.ErrorBody, S.ObjectCard, S.FrameDto, S.TagSummary, S.PostDto, S.FeedItem, S.XpDto, S.UserDto, S.Reveal, S.DeckCardPublic, S.SpotDto]) app.addSchema(schema)

  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    req.user = store.userByToken(req.cookies[SESSION_COOKIE])
  })

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
    if (err.validation) return reply.status(400).send({ error: 'invalid_request' })
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited' })
    return reply.status(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : 'internal_error' })
  })

  const staticOpts = { decorateReply: false, maxAge: 86400 * 1000, immutable: false }
  await app.register(fastifyStatic, { root: join(kit.dataDir, 'objects'), prefix: '/kit/objects/', ...staticOpts })
  if (existsSync(join(kit.dataDir, 'deck', 'media'))) await app.register(fastifyStatic, { root: join(kit.dataDir, 'deck', 'media'), prefix: '/kit/deck/', ...staticOpts })
  if (existsSync(join(kit.dataDir, 'index', 'tiles'))) await app.register(fastifyStatic, { root: join(kit.dataDir, 'index', 'tiles'), prefix: '/kit/index/tiles/', ...staticOpts })
  app.get('/kit/index/wave.json', { schema: { hide: true } }, async (_req, reply) => reply.header('cache-control', 'public, max-age=86400').send(kit.wave))

  const ctx = { store, kit, config, fetchImpl: deps.fetchImpl ?? fetch }
  await app.register(contentRoutes, ctx)
  await app.register(socialRoutes, ctx)
  await app.register(classifyRoutes, ctx)

  await app.ready()
  return { app, store, kit, db }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) {
    void reply.status(401).send({ error: 'login_required' })
    return null
  }
  return req.user
}

export const writeLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } }
