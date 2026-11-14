import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = { ...loadConfig(), dbPath: ':memory:', online: false }
const { app } = await buildApp({ config })
const out = resolve(process.argv[2] ?? 'openapi.json')
writeFileSync(out, JSON.stringify(app.swagger(), null, 2))
await app.close()
process.stdout.write(`OpenAPI written to ${out}\n`)
