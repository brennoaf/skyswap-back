import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { openDb, type DB } from './db.js'
import { DiskCache } from './disk-cache.js'
import { loadKit, type Kit } from './kit.js'
import { HttpError, Store, type User } from './store.js'
import * as S from './schemas.js'
import { contentRoutes } from './routes/content.js'
import { socialRoutes } from './routes/social.js'
import { classifyRoutes } from './routes/classify.js'
import { communityRoutes } from './routes/community.js'
import { makeChecker } from './checks.js'
import { AvatarRefill, type RefillOptions } from './avatar-refill.js'

export const SESSION_COOKIE = 'ss_session'
const CHECK_RETRY_MS = 10 * 60_000
export const TRUSTED_PROXY = '127.0.0.1'

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
  cache?: DiskCache
  refill?: RefillOptions
}

export async function buildApp(deps: AppDeps) {
  const { config } = deps
  const kit = deps.kit ?? loadKit(config.dataDir)
  const db = deps.db ?? openDb(config.dbPath)
  const store = new Store(db, kit, deps.now, deps.random)
  const app = Fastify({ logger: false, trustProxy: TRUSTED_PROXY }).withTypeProvider<TypeBoxTypeProvider>()

  await app.register(cookie, { secret: config.cookieSecret })
  await app.register(cors, { origin: [config.webOrigin], credentials: true })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' })
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'SkySwap API', version: '0.1.0', description: 'Sky objects from real NASA SPHEREx images, served from the SkySwap data kit.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) },
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  for (const schema of [S.FindingSummary, S.CommunityFeed, S.FindingDetail, S.MyCards, S.CreditResponse, S.ErrorBody, S.ObjectCard, S.FrameDto, S.TagSummary, S.PostDto, S.FeedItem, S.XpDto, S.UserDto, S.Reveal, S.DeckCardPublic, S.SpotDto]) app.addSchema(schema)

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
  if (existsSync(join(kit.dataDir, 'index', 'tiles'))) await app.register(fastifyStatic, { root: join(kit.dataDir, 'index', 'tiles'), prefix: '/kit/index/tiles/', decorateReply: false, maxAge: 0, etag: true, lastModified: true })
  app.get('/kit/index/wave.json', { schema: { hide: true } }, async (_req, reply) => reply.header('cache-control', 'public, max-age=86400').send(kit.wave))
  mkdirSync(config.avatarDir, { recursive: true })
  await app.register(fastifyStatic, { root: config.avatarDir, prefix: '/kit/avatars/', decorateReply: false, maxAge: 30 * 86400 * 1000, immutable: true })
  const cellsPath = join(kit.dataDir, 'index', 'cells.json')
  app.get('/kit/index/cells.json', { schema: { hide: true } }, async (req, reply) => {
    if (!existsSync(cellsPath)) return reply.status(404).send({ error: 'not_found' })
    const st = statSync(cellsPath)
    const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`
    reply.header('cache-control', 'public, max-age=0, must-revalidate').header('etag', etag)
    if (req.headers['if-none-match'] === etag) return reply.status(304).send()
    return reply.type('application/json').send(await readFile(cellsPath))
  })

  const cache = deps.cache ?? new DiskCache(config.cacheDir, config.cacheBytes)
  const ctx = { store, kit, config, fetchImpl: deps.fetchImpl ?? fetch, cache }
  store.findings.attachChecker(makeChecker(ctx.fetchImpl, config.online))
  store.findings.retryDue()
  const retry = setInterval(() => store.findings.retryDue(), CHECK_RETRY_MS)
  retry.unref()
  const refill = new AvatarRefill(store.avatars, config.avatarDir, ctx.fetchImpl, deps.refill)
  app.addHook('onClose', async () => {
    clearInterval(retry)
    await refill.stop()
    await store.findings.drain()
  })
  await app.register(contentRoutes, ctx)
  await app.register(socialRoutes, ctx)
  await app.register(classifyRoutes, ctx)
  await app.register(communityRoutes, ctx)

  await app.ready()
  return { app, store, kit, db, cache, refill }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) {
    void reply.status(401).send({ error: 'login_required' })
    return null
  }
  return req.user
}

export const writeLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } }
