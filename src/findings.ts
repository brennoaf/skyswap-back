import { createHash } from 'node:crypto'
import { CHECK_SERVICES, separationDeg, type Checker, type CheckOutcome, type CheckPoint, type CheckResult, type CheckService, type CheckTarget } from './checks.js'
import { prepared, type DB } from './db.js'
import type { SkySpot } from './explore.js'
import type { CardWcs } from './kit.js'

export const FINDING_STATES = ['candidate', 'known', 'likely_artifact', 'package_ready', 'in_review', 'published', 'discarded'] as const
export type FindingState = (typeof FINDING_STATES)[number]

const HUMAN_STATES: FindingState[] = ['in_review', 'published', 'discarded']
const STATE_FROM_CHECKS: CheckService[] = ['gaia', 'asteroids']
const MATCH_DEG = 25 / 3600
const SAME_EPOCH_DAYS = 1e-4
const EPOCH_SERVICES: CheckService[] = ['asteroids']
const MAX_NAMES = 5
const RETRY_BASE_MS = 30 * 60_000
const MAX_ATTEMPTS = 8
const PAGE = 12

const DAY_MS = 86_400_000
const POPULAR_WINDOW_MS = 14 * DAY_MS
const POPULAR_HALF_LIFE_MS = 7 * DAY_MS
const POPULAR_DISCOUNT = 0.3
const POPULAR_DISCOUNTED: FindingState[] = ['likely_artifact', 'known']

export const EXAMPLE_PREFIX = 'example:'
const NOTE_STATES: FindingState[] = ['candidate', 'known', 'package_ready', 'in_review', 'published']
const NOTE_HIDE_AT = 3
export const DOUBT_REASONS = ['image_defect', 'known_asteroid', 'variable_star', 'other'] as const
export type DoubtReason = (typeof DOUBT_REASONS)[number]
export type ReactionKind = 'interesting' | 'doubt'
export type FeedTab = 'new' | 'popular' | 'open' | 'solved'
export const OPEN_STATES: FindingState[] = ['candidate', 'package_ready', 'in_review']
export const SOLVED_STATES: FindingState[] = ['known', 'published', 'likely_artifact', 'discarded']

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
  size_px: number
  wcs: CardWcs | null
}

export type CrowdMark = { user: string; frame: number; x: number; y: number }

const TRACK_STATES: FindingState[] = ['candidate', 'known', 'package_ready', 'in_review', 'published']
export const MIN_TRACK_PEOPLE = 5

export interface FindingDeps {
  status: (cardId: string) => string | undefined
  card: (cardId: string) => FindingCard | null
  positions: (cardId: string) => { mjd: number; ra: number; dec: number }[]
  marks: (cardId: string) => CrowdMark[]
  spot: (cardId: string) => SkySpot | null
  objectFor: (name: string) => string | null
  hasThumb: (cardId: string) => boolean
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
  const row = prepared(db, 'SELECT 1 FROM findings WHERE card_id = ?').get(cardId)
  if (!row) throw new Error('unknown_finding')
  transition(db, cardId, state, { reason: opts.reason ?? null, source: 'human', url: opts.url ?? null, now: opts.now, dataVersion: opts.dataVersion })
}

function transition(db: DB, cardId: string, state: FindingState, e: { reason: string | null; source: string; url?: string | null; now: number; dataVersion: string; example?: boolean }): void {
  db.transaction(() => {
    prepared(db, 'UPDATE findings SET state = ?, reason = ?, updated_at = ? WHERE card_id = ?').run(state, e.reason, e.now, cardId)
    prepared(db, 'INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(cardId, state, e.reason, e.source, e.url ?? null, e.dataVersion, e.example ? 1 : 0, e.now)
  })()
}

export class Findings {
  private checker: Checker | null = null
  onError: (err: unknown, cardId: string) => void = () => undefined
  private running = new Map<string, Promise<void>>()

  constructor(
    private db: DB,
    private now: () => number,
    private deps: FindingDeps,
  ) {}

  private q(sql: string) {
    return prepared(this.db, sql)
  }

  attachChecker(checker: Checker): void {
    this.checker = checker
  }

  private row(cardId: string): FindingRow | undefined {
    return this.q('SELECT * FROM findings WHERE card_id = ?').get(cardId) as FindingRow | undefined
  }

  sync(cardId: string): void {
    const status = this.deps.status(cardId)
    const card = this.deps.card(cardId)
    if (!card || status === 'gold') return
    const f = this.row(cardId)
    const base = { now: this.now(), dataVersion: this.deps.dataVersion }
    if (!f) {
      if (status !== 'real') return
      this.q('INSERT INTO findings (card_id, state, reason, example, credits, created_at, updated_at) VALUES (?, ?, NULL, 0, NULL, ?, ?)').run(cardId, 'candidate', base.now, base.now)
      this.q('INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, NULL, ?, NULL, ?, 0, ?)').run(cardId, 'candidate', 'votes', base.dataVersion, base.now)
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
    this.q(
        `INSERT INTO finding_checks (card_id, service, result, names, note, points, checked_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(card_id, service) DO UPDATE SET result = excluded.result, names = excluded.names, note = excluded.note, points = excluded.points, checked_at = excluded.checked_at, attempts = attempts + 1`,
      )
      .run(cardId, service, result, JSON.stringify(names), note, JSON.stringify(points), this.now())
  }

  private target(card: FindingCard, mjd: number): CheckTarget {
    return { ra: card.ra, dec: card.dec, fov_deg: card.fov_deg, mjd }
  }

  private epochs(card: FindingCard): number[] {
    return [...new Set(card.mjds)].sort((a, b) => a - b)
  }

  scheduleChecks(cardId: string): void {
    if (!this.checker || this.running.has(cardId)) return
    const work = this.runChecks(cardId)
      .catch((err: unknown) => this.onError(err, cardId))
      .finally(() => this.running.delete(cardId))
    this.running.set(cardId, work)
  }

  private async checkService(checker: Checker, service: CheckService, card: FindingCard): Promise<CheckOutcome> {
    const epochs = this.epochs(card)
    const middle = epochs[Math.floor(epochs.length / 2)] ?? 0
    if (!EPOCH_SERVICES.includes(service) || epochs.length < 2) return checker(service, this.target(card, middle))
    const names = new Set<string>()
    const points: CheckPoint[] = []
    for (const mjd of epochs) {
      const out = await checker(service, this.target(card, mjd))
      if (out.result === 'unavailable') return out
      for (const n of out.names) names.add(n)
      for (const p of out.points ?? []) points.push({ ...p, mjd })
    }
    return { result: points.length || names.size ? 'found' : 'nothing', names: [...names].slice(0, MAX_NAMES), note: null, points }
  }

  private async runChecks(cardId: string): Promise<void> {
    const card = this.deps.card(cardId)
    const checker = this.checker
    if (!card || !checker) return
    const existing = new Map((this.q('SELECT service, result FROM finding_checks WHERE card_id = ?').all(cardId) as { service: CheckService; result: CheckResult }[]).map((r) => [r.service, r.result]))
    await Promise.all(
      CHECK_SERVICES.filter((s) => existing.get(s) === undefined || existing.get(s) === 'unavailable').map(async (service) => {
        let out: CheckOutcome
        try {
          out = await this.checkService(checker, service, card)
        } catch (err) {
          this.onError(err, cardId)
          out = { result: 'unavailable', names: [], note: 'error' }
        }
        this.saveCheck(cardId, service, out.result, out.names, out.note, out.points)
      }),
    )
    this.applyChecks(cardId)
  }

  private applyChecks(cardId: string): void {
    const f = this.row(cardId)
    if (!f || f.state !== 'candidate') return
    const seen = this.deps.positions(cardId)
    if (!seen.length) return
    const rows = this.q('SELECT service, points FROM finding_checks WHERE card_id = ? AND result = ?').all(cardId, 'found') as { service: CheckService; points: string | null }[]
    for (const r of rows) {
      if (!STATE_FROM_CHECKS.includes(r.service)) continue
      const hit = (JSON.parse(r.points ?? '[]') as CheckPoint[]).find((p) => seen.some((at) => (p.mjd === undefined || Math.abs(p.mjd - at.mjd) <= SAME_EPOCH_DAYS) && separationDeg(p.ra, p.dec, at.ra, at.dec) <= MATCH_DEG))
      if (hit) return transition(this.db, cardId, 'known', { now: this.now(), dataVersion: this.deps.dataVersion, reason: hit.name, source: 'check' })
    }
  }

  retryDue(): void {
    const rows = this.q("SELECT card_id, attempts, checked_at, note FROM finding_checks WHERE result = 'unavailable' AND service != 'quality' AND attempts < ?").all(MAX_ATTEMPTS) as { card_id: string; attempts: number; checked_at: number; note: string | null }[]
    for (const r of rows) if (r.note !== 'offline' && this.now() - r.checked_at >= RETRY_BASE_MS * 2 ** (r.attempts - 1)) this.scheduleChecks(r.card_id)
    const unfinished = this.q('SELECT f.card_id FROM findings f WHERE f.example = 0 AND (SELECT COUNT(*) FROM finding_checks c WHERE c.card_id = f.card_id) < ?').all(CHECK_SERVICES.length) as { card_id: string }[]
    for (const r of unfinished) this.scheduleChecks(r.card_id)
  }

  async drain(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  decide(cardId: string, state: FindingState, opts: { reason?: string | null; url?: string | null } = {}): void {
    decideFinding(this.db, cardId, state, { ...opts, now: this.now(), dataVersion: this.deps.dataVersion })
  }

  expose(userId: string, cardIds: string[], source: 'feed' | 'link'): void {
    const ins = this.q('INSERT OR IGNORE INTO card_exposures (user_id, card_id, source, created_at) VALUES (?, ?, ?, ?)')
    this.db.transaction(() => {
      for (const id of cardIds) if (!id.startsWith(EXAMPLE_PREFIX)) ins.run(userId, id, source, this.now())
    })()
  }

  isExposed(userId: string, cardId: string): boolean {
    return !!this.q('SELECT 1 FROM card_exposures WHERE user_id = ? AND card_id = ?').get(userId, cardId)
  }

  exposedCards(userId: string): string[] {
    return (this.q('SELECT card_id FROM card_exposures WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id)
  }

  private credits(f: FindingRow): { names: string[]; anonymous: number } {
    if (f.credits) return { names: JSON.parse(f.credits) as string[], anonymous: 0 }
    const rows = this.q(
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

  private firstRow(f: FindingRow) {
    return this.q("SELECT u.id AS user_id, u.nickname, u.credit_visible, v.created_at, v.note FROM votes v JOIN users u ON u.id = v.user_id WHERE v.card_id = ? AND v.counted = 1 AND v.label = 'real' ORDER BY v.id LIMIT 1").get(f.card_id) as
      | { user_id: string; nickname: string; credit_visible: number; created_at: number; note: string | null }
      | undefined
  }

  private noteShown(f: FindingRow, r: { credit_visible: number; note: string | null }): boolean {
    if (!r.note || !r.credit_visible || f.example || !NOTE_STATES.includes(f.state)) return false
    return this.count('SELECT COUNT(*) AS n FROM note_reports WHERE card_id = ?', f.card_id) < NOTE_HIDE_AT
  }

  private firstVote(f: FindingRow): { nickname: string | null; at: number; note: string | null } | null {
    const r = this.firstRow(f)
    return r ? { nickname: r.credit_visible ? r.nickname : null, at: r.created_at, note: this.noteShown(f, r) ? r.note : null } : null
  }

  reportNote(userId: string, cardId: string): boolean {
    const f = this.row(cardId)
    const r = f ? this.firstRow(f) : undefined
    if (!f || !r || !this.noteShown(f, r)) return false
    this.q('INSERT OR IGNORE INTO note_reports (user_id, card_id, created_at) VALUES (?, ?, ?)').run(userId, cardId, this.now())
    return true
  }

  noteAlerts(userId: string): { card_id: string; created_at: number }[] {
    const rows = this.q("SELECT f.* FROM findings f WHERE f.example = 0 AND f.card_id IN (SELECT card_id FROM votes WHERE user_id = ? AND counted = 1 AND label = 'real' AND note IS NOT NULL)").all(userId) as FindingRow[]
    return rows.flatMap((f) => {
      const r = this.firstRow(f)
      return r && r.user_id === userId && this.noteShown(f, r) ? [{ card_id: f.card_id, created_at: f.created_at }] : []
    })
  }

  private checkRows(cardId: string): CheckRow[] {
    return this.q('SELECT service, result, names, note, checked_at, attempts FROM finding_checks WHERE card_id = ?').all(cardId) as CheckRow[]
  }

  setReaction(userId: string, cardId: string, kind: ReactionKind, on: boolean, reason: DoubtReason | null = null, position: { frame: number; x: number; y: number } | null = null): void {
    if (!on) {
      this.q('DELETE FROM reactions WHERE user_id = ? AND card_id = ? AND kind = ?').run(userId, cardId, kind)
      return
    }
    this.q(
        `INSERT INTO reactions (user_id, card_id, kind, reason, position, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, card_id, kind) DO UPDATE SET reason = excluded.reason, position = COALESCE(excluded.position, position)`,
      )
      .run(userId, cardId, kind, kind === 'doubt' ? reason : null, kind === 'doubt' && position ? JSON.stringify(position) : null, this.now())
  }

  secondLook(userId: string, cardId: string, label: string): boolean {
    if (this.q('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId)) return false
    this.q('INSERT INTO second_looks (user_id, card_id, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, card_id) DO UPDATE SET label = excluded.label').run(userId, cardId, label, this.now())
    return true
  }

  setFollow(userId: string, cardId: string, on: boolean): void {
    if (on) this.q('INSERT OR IGNORE INTO finding_follows (user_id, card_id, created_at) VALUES (?, ?, ?)').run(userId, cardId, this.now())
    else this.q('DELETE FROM finding_follows WHERE user_id = ? AND card_id = ?').run(userId, cardId)
  }

  private count(sql: string, ...args: unknown[]): number {
    return (this.q(sql).get(...args) as { n: number }).n
  }

  social(cardId: string, userId: string | null) {
    const reasons = this.q("SELECT reason, COUNT(*) AS n FROM reactions WHERE card_id = ? AND kind = 'doubt' GROUP BY reason").all(cardId) as { reason: DoubtReason; n: number }[]
    const byReason = Object.fromEntries(DOUBT_REASONS.map((r) => [r, reasons.find((x) => x.reason === r)?.n ?? 0])) as Record<DoubtReason, number>
    return {
      interesting: this.count("SELECT COUNT(*) AS n FROM reactions WHERE card_id = ? AND kind = 'interesting'", cardId),
      doubts: reasons.reduce((sum, r) => sum + r.n, 0),
      doubt_reasons: byReason,
      also_seen: this.count('SELECT COUNT(*) AS n FROM second_looks WHERE card_id = ?', cardId),
      blind_answers: this.count('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE card_id = ? AND counted = 1', cardId),
      mine: userId ? this.mine(cardId, userId) : null,
    }
  }

  private mine(cardId: string, userId: string) {
    const rows = this.q('SELECT kind, reason FROM reactions WHERE card_id = ? AND user_id = ?').all(cardId, userId) as { kind: ReactionKind; reason: DoubtReason | null }[]
    const look = this.q('SELECT label FROM second_looks WHERE card_id = ? AND user_id = ?').get(cardId, userId) as { label: string } | undefined
    const vote = this.q('SELECT label FROM votes WHERE card_id = ? AND user_id = ?').get(cardId, userId) as { label: string } | undefined
    return {
      interesting: rows.some((r) => r.kind === 'interesting'),
      doubt: rows.find((r) => r.kind === 'doubt')?.reason ?? null,
      second_look: look?.label ?? null,
      vote: vote?.label ?? null,
      following: !!this.q('SELECT 1 FROM finding_follows WHERE card_id = ? AND user_id = ?').get(cardId, userId),
    }
  }

  people(cardId: string) {
    const compare = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })
    const split = (rows: { nickname: string; credit_visible: number }[]) => rows.filter((r) => r.credit_visible)
    const interesting = this.q("SELECT u.nickname, u.credit_visible FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.card_id = ? AND r.kind = 'interesting'").all(cardId) as { nickname: string; credit_visible: number }[]
    const doubts = this.q("SELECT u.nickname, u.credit_visible, r.reason FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.card_id = ? AND r.kind = 'doubt'").all(cardId) as { nickname: string; credit_visible: number; reason: string }[]
    const looks = this.q('SELECT u.nickname, u.credit_visible FROM second_looks s JOIN users u ON u.id = s.user_id WHERE s.card_id = ?').all(cardId) as { nickname: string; credit_visible: number }[]
    const shownInteresting = split(interesting)
    const shownDoubts = doubts.filter((d) => d.credit_visible)
    const shownLooks = split(looks)
    return {
      interesting: shownInteresting.map((r) => r.nickname).sort(compare),
      interesting_anonymous: interesting.length - shownInteresting.length,
      doubts: shownDoubts.map((d) => ({ name: d.nickname, reason: d.reason })).sort((a, b) => compare(a.name, b.name)),
      doubts_anonymous: doubts.length - shownDoubts.length,
      also_seen: shownLooks.map((r) => r.nickname).sort(compare),
      also_seen_anonymous: looks.length - shownLooks.length,
    }
  }

  private popularity(): Map<string, number> {
    const now = this.now()
    const since = now - POPULAR_WINDOW_MS
    const rows = this.q(
        `SELECT a.card_id, a.user_id, a.created_at, a.weight, f.state FROM (
           SELECT card_id, user_id, created_at, 3 AS weight FROM second_looks WHERE created_at >= @since
           UNION ALL SELECT card_id, user_id, created_at, CASE kind WHEN 'doubt' THEN 2 ELSE 1 END AS weight FROM reactions WHERE created_at >= @since
         ) a JOIN findings f ON f.card_id = a.card_id`,
      )
      .all({ since }) as { card_id: string; user_id: string; created_at: number; weight: number; state: FindingState }[]
    const states = new Map<string, FindingState>()
    const best = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const value = r.weight * 0.5 ** ((now - r.created_at) / POPULAR_HALF_LIFE_MS)
      const people = best.get(r.card_id) ?? new Map<string, number>()
      people.set(r.user_id, Math.max(people.get(r.user_id) ?? 0, value))
      best.set(r.card_id, people)
      states.set(r.card_id, r.state)
    }
    const scores = new Map<string, number>()
    for (const [cardId, people] of best) {
      const state = states.get(cardId)
      if (!state) continue
      const sum = [...people.values()].reduce((a, b) => a + b, 0)
      scores.set(cardId, POPULAR_DISCOUNTED.includes(state) ? sum * POPULAR_DISCOUNT : sum)
    }
    return scores
  }

  hasPopular(): boolean {
    return !!this.q(
      `SELECT 1 FROM findings f WHERE EXISTS (SELECT 1 FROM second_looks s WHERE s.card_id = f.card_id AND s.created_at >= @since)
         OR EXISTS (SELECT 1 FROM reactions r WHERE r.card_id = f.card_id AND r.created_at >= @since) LIMIT 1`,
    ).get({ since: this.now() - POPULAR_WINDOW_MS })
  }

  unseen(userId: string | null, limit: number): string[] {
    const rows = this.q("SELECT card_id FROM findings WHERE state NOT IN ('likely_artifact', 'discarded') ORDER BY updated_at DESC, card_id").all() as { card_id: string }[]
    return rows
      .map((r) => r.card_id)
      .filter((id) => !!this.deps.card(id) && !(userId && this.isExposed(userId, id)))
      .slice(0, limit)
  }

  highlight(userId: string | null) {
    for (const f of this.q("SELECT * FROM findings WHERE state = 'published' ORDER BY updated_at DESC, card_id").all() as FindingRow[]) {
      const card = this.deps.card(f.card_id)
      if (card) return this.summary(f, card, userId)
    }
    return null
  }

  private summary(f: FindingRow, card: FindingCard, userId: string | null) {
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
      first_vote: this.firstVote(f),
      social: this.social(f.card_id, userId),
      photo: card.sprite ?? (this.deps.hasThumb(card.id) ? `/api/community/findings/${encodeURIComponent(card.id)}/photo` : null),
      photo_cols: card.sprite ? card.mjds.length : 1,
      mark: this.firstMark(card.id),
      object_id: f.state === 'known' && f.reason ? this.deps.objectFor(f.reason) : null,
    }
  }

  private firstMark(cardId: string): { x: number; y: number } | null {
    const here = this.deps.marks(cardId).filter((m) => m.frame === 0)
    if (!here.length) return null
    const mid = (v: number[]) => {
      const s = [...v].sort((a, b) => a - b)
      const m = s.length >> 1
      return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
    }
    return { x: mid(here.map((m) => m.x)), y: mid(here.map((m) => m.y)) }
  }

  forObject(objectId: string): string | null {
    const rows = this.q("SELECT card_id, reason FROM findings WHERE state = 'known' AND example = 0 AND reason IS NOT NULL ORDER BY updated_at DESC, card_id").all() as { card_id: string; reason: string }[]
    return rows.find((r) => this.deps.objectFor(r.reason) === objectId && this.deps.card(r.card_id))?.card_id ?? null
  }

  private popularRows(cursor: number): FindingRow[] {
    const scores = this.popularity()
    const ids = [...scores.keys()].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b))
    return ids.slice(cursor, cursor + PAGE + 1).flatMap((id) => {
      const f = this.row(id)
      return f ? [f] : []
    })
  }

  feed(cursor = 0, opts: { tab?: FeedTab; userId?: string | null } = {}) {
    const states = opts.tab === 'open' ? OPEN_STATES : opts.tab === 'solved' ? SOLVED_STATES : null
    const rows =
      opts.tab === 'popular'
        ? this.popularRows(cursor)
        : states
          ? (this.q(`SELECT * FROM findings WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY updated_at DESC, card_id LIMIT ? OFFSET ?`).all(...states, PAGE + 1, cursor) as FindingRow[])
          : (this.q('SELECT * FROM findings ORDER BY updated_at DESC, card_id LIMIT ? OFFSET ?').all(PAGE + 1, cursor) as FindingRow[])
    const items = rows.slice(0, PAGE).flatMap((f) => {
      const card = this.deps.card(f.card_id)
      return card ? [this.summary(f, card, opts.userId ?? null)] : []
    })
    return { items, next_cursor: rows.length > PAGE ? cursor + PAGE : null }
  }

  detail(cardId: string, userId: string | null = null) {
    const f = this.row(cardId)
    const card = f ? this.deps.card(cardId) : null
    if (!f || !card) return null
    const events = this.q('SELECT state, reason, source, url, data_version, created_at FROM finding_events WHERE card_id = ? ORDER BY id').all(cardId) as { state: string; reason: string | null; source: string; url: string | null; data_version: string; created_at: number }[]
    const credits = this.credits(f)
    const checks = this.checkRows(cardId)
    return {
      ...this.summary(f, card, userId),
      fov_deg: card.fov_deg,
      offsets_s: card.offsets_s,
      checks: CHECK_SERVICES.map((service) => {
        const c = checks.find((x) => x.service === service)
        return { service, result: c?.result ?? null, names: c ? (JSON.parse(c.names) as string[]) : [], note: c?.note ?? null, checked_at: c?.checked_at ?? null }
      }),
      events,
      credits: credits.names,
      credits_anonymous: credits.anonymous,
      data_version: events[events.length - 1]?.data_version ?? this.deps.dataVersion,
      tracks: this.tracks(f, card, userId),
    }
  }

  private tracks(f: FindingRow, card: FindingCard, userId: string | null) {
    if (f.example || !TRACK_STATES.includes(f.state)) return null
    const marks = this.deps.marks(card.id)
    const people = new Set(marks.map((m) => m.user))
    if (people.size < MIN_TRACK_PEOPLE) return null
    return {
      people: people.size,
      you: !!userId && people.has(userId),
      size_px: card.size_px,
      wcs: card.wcs,
      spot: this.deps.spot(card.id),
      frames: card.mjds.map((mjd, frame) => {
        const here = marks.filter((m) => m.frame === frame)
        const mine = userId ? here.find((m) => m.user === userId) : undefined
        return { mjd, points: here.map((m) => ({ u: m.x, v: m.y })), mine: mine ? { u: mine.x, v: mine.y } : null }
      }),
    }
  }

  stateOf(cardId: string): FindingState | null {
    return this.row(cardId)?.state ?? null
  }

  eventsForAlerts(userId: string): { id: string; card_id: string; state: string; reason: string | null; created_at: number; followed: number }[] {
    return this.q(
        `SELECT 'finding:' || e.id AS id, e.card_id, e.state, e.reason, e.created_at, 0 AS followed FROM finding_events e
         WHERE e.example = 0 AND e.card_id IN (SELECT card_id FROM votes WHERE user_id = @user AND counted = 1)
         UNION ALL
         SELECT 'finding:' || e.id AS id, e.card_id, e.state, e.reason, e.created_at, 1 AS followed FROM finding_events e
         JOIN finding_follows ff ON ff.card_id = e.card_id AND ff.user_id = @user
         WHERE e.example = 0 AND e.created_at > ff.created_at AND e.card_id NOT IN (SELECT card_id FROM votes WHERE user_id = @user AND counted = 1)`,
      )
      .all({ user: userId }) as { id: string; card_id: string; state: string; reason: string | null; created_at: number; followed: number }[]
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
      this.q('INSERT OR REPLACE INTO findings (card_id, state, reason, example, credits, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, plan.state, plan.reason, JSON.stringify(['exemplo_a', 'exemplo_b', 'exemplo_c']), at, at)
      this.q('INSERT INTO finding_events (card_id, state, reason, source, url, data_version, example, created_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)').run(id, plan.state, plan.reason, 'example', this.deps.dataVersion, at)
      for (const [service, result, names] of plan.checks) this.saveCheck(id, service, result, names, service === 'quality' ? 'no_flags_for_card' : 'example')
      made += 1
    })
    return made
  }

  clearExamples(): number {
    const ids = (this.q('SELECT card_id FROM findings WHERE example = 1').all() as { card_id: string }[]).map((r) => r.card_id)
    this.db.transaction(() => {
      for (const id of ids) {
        this.q('DELETE FROM finding_events WHERE card_id = ?').run(id)
        this.q('DELETE FROM finding_checks WHERE card_id = ?').run(id)
        this.q('DELETE FROM reactions WHERE card_id = ?').run(id)
        this.q('DELETE FROM second_looks WHERE card_id = ?').run(id)
        this.q('DELETE FROM finding_follows WHERE card_id = ?').run(id)
        this.q('DELETE FROM findings WHERE card_id = ?').run(id)
      }
    })()
    return ids.length
  }
}
