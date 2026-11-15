import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { decideFinding, type FindingState } from './findings.js'
import { loadKit } from './kit.js'
import { Store } from './store.js'

const [command, id, state] = process.argv.slice(2)
const option = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv[i + 1] ?? null) : null
}

const config = loadConfig()
const db = openDb(config.dbPath)
const kit = loadKit(config.dataDir)

if (command === 'set' && id && state) {
  decideFinding(db, id, state as FindingState, { reason: option('reason'), url: option('url'), now: Date.now(), dataVersion: kit.manifest.version })
  process.stdout.write(`${id} is now ${state}\n`)
} else if (command === 'seed-examples') {
  process.stdout.write(`${new Store(db, kit).seedExampleFindings()} example findings added\n`)
} else if (command === 'clear-examples') {
  process.stdout.write(`${new Store(db, kit).findings.clearExamples()} example findings removed\n`)
} else {
  process.stdout.write('Usage: findings set <id> <in_review|published|discarded> [--reason text] [--url source] | seed-examples | clear-examples\n')
  process.exitCode = 1
}
db.close()
