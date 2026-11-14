import { resolve } from 'node:path'

export interface Config {
  port: number
  host: string
  dataDir: string
  dbPath: string
  webOrigin: string
  cookieSecret: string
  online: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '127.0.0.1',
    dataDir: resolve(env.SKYSWAP_DATA ?? resolve(import.meta.dirname, '..', '..', 'data')),
    dbPath: env.SKYSWAP_DB ?? resolve(import.meta.dirname, '..', 'var', 'skyswap.sqlite'),
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3000',
    cookieSecret: env.COOKIE_SECRET ?? 'skyswap-local-prototype-secret',
    online: env.SKYSWAP_OFFLINE !== '1',
  }
}
