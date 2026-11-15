import { resolve } from 'node:path'

export interface Config {
  port: number
  host: string
  dataDir: string
  dbPath: string
  webOrigin: string
  cookieSecret: string
  online: boolean
  cacheDir: string
  cacheBytes: number
  indexWorker: boolean
  avatarDir: string
  logLevel: LogLevel
  rpId: string
  origins: string[]
  testRun: boolean
}

const LOG_LEVELS = ['error', 'warn', 'info', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '127.0.0.1',
    dataDir: resolve(env.SKYSWAP_DATA ?? resolve(import.meta.dirname, '..', '..', 'data')),
    dbPath: env.SKYSWAP_DB ?? resolve(import.meta.dirname, '..', 'var', 'skyswap.sqlite'),
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3000',
    cookieSecret: env.COOKIE_SECRET ?? 'skyswap-local-prototype-secret',
    online: env.SKYSWAP_OFFLINE !== '1',
    cacheDir: env.SKYSWAP_CACHE_DIR ?? resolve(import.meta.dirname, '..', 'var', 'cutouts'),
    cacheBytes: Number(env.SKYSWAP_CACHE_MB ?? 512) * 1024 * 1024,
    indexWorker: env.SKYSWAP_INDEX_WORKER ? env.SKYSWAP_INDEX_WORKER !== '0' : !env.VITEST,
    avatarDir: env.SKYSWAP_AVATAR_DIR ?? resolve(import.meta.dirname, '..', 'var', 'avatars'),
    logLevel: LOG_LEVELS.find((l) => l === env.SKYSWAP_LOG) ?? 'error',
    rpId: env.SKYSWAP_RP_ID ?? 'localhost',
    origins: (env.SKYSWAP_ORIGIN ?? 'http://localhost:3000').split(',').map((o) => o.trim()).filter(Boolean),
    testRun: env.SKYSWAP_E2E === '1',
  }
}
