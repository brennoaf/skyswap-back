import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const { app, refill } = await buildApp({
  config,
  refill: {
    onProgress: (event, stats, free) => {
      if (event !== 'added' || stats.added % 25 === 0) process.stdout.write(`avatars ${event}: ${free} in stock ${JSON.stringify(stats)}\n`)
    },
  },
})
await app.listen({ port: config.port, host: config.host })
if (config.online) refill.start()
process.stdout.write(`SkySwap API on http://${config.host}:${config.port} (docs at /docs)\n`)
