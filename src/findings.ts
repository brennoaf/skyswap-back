import { createHash } from 'node:crypto'
import { CHECK_SERVICES, separationDeg, type Checker, type CheckPoint, type CheckResult, type CheckService, type CheckTarget } from './checks.js'
import type { DB } from './db.js'

export const FINDING_STATES = ['candidate', 'known', 'likely_artifact', 'package_ready', 'in_review', 'published', 'discarded'] as const
export type FindingState = (typeof FINDING_STATES)[number]

const HUMAN_STATES: FindingState[] = ['in_review', 'published', 'discarded']
const STATE_FROM_CHECKS: CheckService[] = ['gaia', 'asteroids']
const MATCH_DEG = 25 / 3600
const RETRY_BASE_MS = 30 * 60_000
const MAX_ATTEMPTS = 8
const PAGE = 12

export const EXAMPLE_PREFIX = 'example:'

export interface FindingCard {
  id: string
  kind: 'sky' | 'deck'
  ra: number
  dec: number
  fov_deg: number
  band: string
  mjds: number[]
  sprite: string | null
  offsets_s: number[]
  known: string | null
}

export interface FindingDeps {
  status: (cardId: string) => string | undefined
  card: (cardId: string) => FindingCard | null
  position: (cardId: string) => { ra: number; dec: number } | null
  dataVersion: string
}

interface FindingRow {
  card_id: string
  state: FindingState
  reason: string | null
  example: number
  credits: string | null
  created_at: number
  updated_at: number
}

interface CheckRow {
  service: CheckService
  result: CheckResult
  names: string
  note: string | null
  checked_at: number
  attempts: number
}

function stableOrder(cardId: string, userId: string): string {
  return createHash('sha1').update(`${cardId}:${userId}`).digest('hex')
}

export function decideFinding(db: DB, cardId: string, state: FindingState, opts: { reason?: string | null; url?: string | null; now: number; dataVersion: string }): void {
  if (!HUMAN_STATES.includes(state)) throw new Error('human_states_only')
  if (state === 'published' && !/^https?:\/\/\S+$/.test(opts.url ?? '')) throw new Error('published_needs_source')
  const row = db.prepare('SELECT 1 FROM findings WHERE card_id = ?').get(cardId)
  if (!row) throw new Error('unknown_finding')
  transition(db, cardId, state, { reason: opts.reason ?? null, source: 'human', url: opts.url ?? null, now: opts.now, dataVersion: opts.dataVersion })
}

function transition(db: DB, cardId: string, state: FindingState, e: { reason: string | null; source: string; url?: string | null; now: number; dataVersion: string; example?: boolean }): void {
  db.transaction(() => {
    db.prepare('UPDATE findings SET state = ?, reason = ?, updated_at = ? WHERE card_id = ?').run(state, e.reason, e.now, cardId)
    db.prepare('INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(cardId, state, e.reason, e.source, e.url ?? null, e.dataVersion, e.example ? 1 : 0, e.now)
  })()
}

export class Findings {
  private checker: Checker | null = null
  private running = new Map<string, Promise<void>>()

  constructor(
    private db: DB,
    private now: () => number,
    private deps: FindingDeps,
  ) {}

  attachChecker(checker: Checker): void {
    this.checker = checker
  }

  private row(cardId: string): FindingRow | undefined {
    return this.db.prepare('SELECT * FROM findings WHERE card_id = ?').get(cardId) as FindingRow | undefined
  }

  sync(cardId: string): void {
    const status = this.deps.status(cardId)
    const card = this.deps.card(cardId)
    if (!card || status === 'gold') return
    const f = this.row(cardId)
    const base = { now: this.now(), dataVersion: this.deps.dataVersion }
    if (!f) {
      if (status !== 'real') return
      this.db.prepare('INSERT INTO findings (card_id, state, reason, example, credits, created_at, updated_at) VALUES (?, ?, NULL, 0, NULL, ?, ?)').run(cardId, 'candidate', base.now, base.now)
      this.db.prepare('INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, NULL, ?, NULL, ?, 0, ?)').run(cardId, 'candidate', 'votes', base.dataVersion, base.now)
      if (card.known) {
        this.saveCheck(cardId, 'asteroids', 'found', [card.known], 'data_kit')
        transition(this.db, cardId, 'known', { ...base, reason: card.known, source: 'check' })
      }
      this.scheduleChecks(cardId)
      return
    }
    if (HUMAN_STATES.includes(f.state)) return
    if (f.state === 'candidate') this.applyChecks(cardId)
    if (status === 'artifact' && f.state !== 'likely_artifact') transition(this.db, cardId, 'likely_artifact', { ...base, reason: 'votes', source: 'votes' })
    else if (status === 'real' && f.state === 'likely_artifact' && f.reason === 'votes') transition(this.db, cardId, 'candidate', { ...base, reason: null, source: 'votes' })
  }

  syncAll(cardIds: Iterable<string>): void {
    for (const id of cardIds) this.sync(id)
  }

  private saveCheck(cardId: string, service: CheckService, result: CheckResult, names: string[], note: string | null, points: CheckPoint[] = []): void {
    this.db
      .prepare(
        `INSERT INTO finding_checks (card_id, service, result, names, note, points, checked_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(card_id, service) DO UPDATE SET result = excluded.result, names = excluded.names, note = excluded.note, points = excluded.points, checked_at = excluded.checked_at, attempts = attempts + 1`,
      )
      .run(cardId, service, result, JSON.stringify(names), note, JSON.stringify(points), this.now())
  }

  private target(card: FindingCard): CheckTarget {
    const sorted = [...card.mjds].sort((a, b) => a - b)
    return { ra: card.ra, dec: card.dec, fov_deg: card.fov_deg, mjd: sorted[Math.floor(sorted.length / 2)] ?? 0 }
  }

  scheduleChecks(cardId: string): void {
    if (!this.checker || this.running.has(cardId)) return
    const work = this.runChecks(cardId).finally(() => this.running.delete(cardId))
    this.running.set(cardId, work)
  }

  private async runChecks(cardId: string): Promise<void> {
    const card = this.deps.card(cardId)
    const checker = this.checker
    if (!card || !checker) return
    const existing = new Map((this.db.prepare('SELECT service, result FROM finding_checks WHERE card_id = ?').all(cardId) as { service: CheckService; result: CheckResult }[]).map((r) => [r.service, r.result]))
    const target = this.target(card)
    await Promise.all(
      CHECK_SERVICES.filter((s) => existing.get(s) === undefined || existing.get(s) === 'unavailable').map(async (service) => {
        const out = await checker(service, target)
        this.saveCheck(cardId, service, out.result, out.names, out.note, out.points)
      }),
    )
    this.applyChecks(cardId)
  }

  private applyChecks(cardId: string): void {
    const f = this.row(cardId)
    if (!f || f.state !== 'candidate') return
    const at = this.deps.position(cardId)
    if (!at) return
    const rows = this.db.prepare('SELECT service, points FROM finding_checks WHERE card_id = ? AND result = ?').all(cardId, 'found') as { service: CheckService; points: string | null }[]
    for (const r of rows) {
      if (!STATE_FROM_CHECKS.includes(r.service)) continue
      const hit = (JSON.parse(r.points ?? '[]') as CheckPoint[]).find((p) => separationDeg(p.ra, p.dec, at.ra, at.dec) <= MATCH_DEG)
      if (hit) return transition(this.db, cardId, 'known', { now: this.now(), dataVersion: this.deps.dataVersion, reason: hit.name, source: 'check' })
    }
  }

  retryDue(): void {
    const rows = this.db.prepare("SELECT card_id, attempts, checked_at, note FROM finding_checks WHERE result = 'unavailable' AND service != 'quality' AND attempts < ?").all(MAX_ATTEMPTS) as { card_id: string; attempts: number; checked_at: number; note: string | null }[]
    for (const r of rows) if (r.note !== 'offline' && this.now() - r.checked_at >= RETRY_BASE_MS * 2 ** (r.attempts - 1)) this.scheduleChecks(r.card_id)
  }

  async drain(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  decide(cardId: string, state: FindingState, opts: { reason?: string | null; url?: string | null } = {}): void {
    decideFinding(this.db, cardId, state, { ...opts, now: this.now(), dataVersion: this.deps.dataVersion })
  }

  expose(userId: string, cardIds: string[], source: 'feed' | 'link'): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO card_exposures (user_id, card_id, source, created_at) VALUES (?, ?, ?, ?)')
    this.db.transaction(() => {
      for (const id of cardIds) if (!id.startsWith(EXAMPLE_PREFIX)) ins.run(userId, id, source, this.now())
    })()
  }

  isExposed(userId: string, cardId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM card_exposures WHERE user_id = ? AND card_id = ?').get(userId, cardId)
  }

  exposedCards(userId: string): string[] {
    return (this.db.prepare('SELECT card_id FROM card_exposures WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id)
  }

  private credits(f: FindingRow): { names: string[]; anonymous: number } {
    if (f.credits) return { names: JSON.parse(f.credits) as string[], anonymous: 0 }
    const rows = this.db
      .prepare(
        `SELECT DISTINCT u.id, u.nickname, u.credit_visible FROM users u
         WHERE u.id IN (
           SELECT user_id FROM votes WHERE card_id = @id AND counted = 1 AND created_at <= @at AND (label = 'real' OR position IS NOT NULL)
           UNION SELECT created_by FROM sky_cards WHERE id = @id AND created_by IS NOT NULL
         )`,
      )
      .all({ id: f.card_id, at: f.created_at }) as { id: string; nickname: string; credit_visible: number }[]
    const visible = rows.filter((r) => r.credit_visible).sort((a, b) => stableOrder(f.card_id, a.id).localeCompare(stableOrder(f.card_id, b.id)))
    return { names: visible.map((r) => r.nickname), anonymous: rows.length - visible.length }
  }

  private firstVote(f: FindingRow): { nickname: string | null; at: number } | null {
    const r = this.db.prepare("SELECT u.nickname, u.credit_visible, v.created_at FROM votes v JOIN users u ON u.id = v.user_id WHERE v.card_id = ? AND v.counted = 1 AND v.label = 'real' ORDER BY v.id LIMIT 1").get(f.card_id) as { nickname: string; credit_visible: number; created_at: number } | undefined
    return r ? { nickname: r.credit_visible ? r.nickname : null, at: r.created_at } : null
  }

  private checkRows(cardId: string): CheckRow[] {
    return this.db.prepare('SELECT service, result, names, note, checked_at, attempts FROM finding_checks WHERE card_id = ?').all(cardId) as CheckRow[]
  }

  private summary(f: FindingRow, card: FindingCard) {
    const checks = this.checkRows(f.card_id)
    const credits = this.credits(f)
    const times = card.mjds.map((m) => new Date((m - 40587) * 86_400_000).toISOString())
    return {
      id: f.card_id,
      kind: card.kind,
      state: f.state,
      reason: f.reason,
      example: !!f.example,
      ra: card.ra,
      dec: card.dec,
      band: card.band,
      sprite: card.sprite,
      passes: card.mjds.length,
      first_t: times[0] ?? null,
      last_t: times[times.length - 1] ?? null,
      updated_at: f.updated_at,
      checks_done: checks.filter((c) => c.result !== 'unavailable').length,
      checks_total: CHECK_SERVICES.length,
      credit_names: credits.names.slice(0, 2),
      credit_others: Math.max(0, credits.names.length - 2) + credits.anonymous,
    }
  }

  feed(cursor = 0) {
    const rows = this.db.prepare('SELECT * FROM findings ORDER BY updated_at DESC, card_id LIMIT ? OFFSET ?').all(PAGE + 1, cursor) as FindingRow[]
    const items = rows.slice(0, PAGE).flatMap((f) => {
      const card = this.deps.card(f.card_id)
      return card ? [this.summary(f, card)] : []
    })
    return { items, next_cursor: rows.length > PAGE ? cursor + PAGE : null }
  }

  detail(cardId: string) {
    const f = this.row(cardId)
    const card = f ? this.deps.card(cardId) : null
    if (!f || !card) return null
    const events = this.db.prepare('SELECT state, reason, source, url, data_version, created_at FROM finding_events WHERE card_id = ? ORDER BY id').all(cardId) as { state: string; reason: string | null; source: string; url: string | null; data_version: string; created_at: number }[]
    const credits = this.credits(f)
    return {
      ...this.summary(f, card),
      fov_deg: card.fov_deg,
      offsets_s: card.offsets_s,
      checks: CHECK_SERVICES.map((service) => {
        const c = this.checkRows(cardId).find((x) => x.service === service)
        return { service, result: c?.result ?? null, names: c ? (JSON.parse(c.names) as string[]) : [], note: c?.note ?? null, checked_at: c?.checked_at ?? null }
      }),
      events,
      credits: credits.names,
      credits_anonymous: credits.anonymous,
      first_vote: this.firstVote(f),
      data_version: events[events.length - 1]?.data_version ?? this.deps.dataVersion,
    }
  }

  stateOf(cardId: string): FindingState | null {
    return this.row(cardId)?.state ?? null
  }

  eventsForAlerts(userId: string): { id: string; card_id: string; state: string; reason: string | null; created_at: number }[] {
    return this.db
      .prepare(
        `SELECT 'finding:' || e.id AS id, e.card_id, e.state, e.reason, e.created_at FROM finding_events e
         WHERE e.example = 0 AND e.card_id IN (SELECT card_id FROM votes WHERE user_id = ? AND counted = 1)`,
      )
      .all(userId) as { id: string; card_id: string; state: string; reason: string | null; created_at: number }[]
  }

  seedExamples(cards: FindingCard[]): number {
    const now = this.now()
    const plans: { state: FindingState; reason: string | null; checks: [CheckService, CheckResult, string[]][] }[] = [
      { state: 'candidate', reason: null, checks: [['gaia', 'nothing', []], ['simbad', 'nothing', []], ['asteroids', 'unavailable', []], ['quality', 'unavailable', []]] },
      { state: 'known', reason: '433 Eros', checks: [['gaia', 'nothing', []], ['simbad', 'found', ['433 Eros']], ['asteroids', 'found', ['433 Eros']], ['quality', 'unavailable', []]] },
      { state: 'likely_artifact', reason: 'votes', checks: [['gaia', 'nothing', []], ['simbad', 'nothing', []], ['asteroids', 'nothing', []], ['quality', 'unavailable', []]] },
    ]
    let made = 0
    plans.forEach((plan, i) => {
      const card = cards[i]
      if (!card) return
      const id = `${EXAMPLE_PREFIX}${card.id}`
      const at = now - i * 3_600_000
      this.db.prepare('INSERT OR REPLACE INTO findings (card_id, state, reason, example, credits, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, plan.state, plan.reason, JSON.stringify(['exemplo_a', 'exemplo_b', 'exemplo_c']), at, at)
      this.db.prepare('INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)').run(id, plan.state, plan.reason, 'example', this.deps.dataVersion, at)
      for (const [service, result, names] of plan.checks) this.saveCheck(id, service, result, names, service === 'quality' ? 'no_flags_for_card' : 'example')
      made += 1
    })
    return made
  }

  clearExamples(): number {
    const ids = (this.db.prepare('SELECT card_id FROM findings WHERE example = 1').all() as { card_id: string }[]).map((r) => r.card_id)
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare('DELETE FROM finding_events WHERE card_id = ?').run(id)
        this.db.prepare('DELETE FROM finding_checks WHERE card_id = ?').run(id)
        this.db.prepare('DELETE FROM findings WHERE card_id = ?').run(id)
      }
    })()
    return ids.length
  }
}
