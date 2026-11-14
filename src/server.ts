import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const { app } = await buildApp({ config })
await app.listen({ port: config.port, host: config.host })
process.stdout.write(`SkySwap API on http://${config.host}:${config.port} (docs at /docs)\n`)
