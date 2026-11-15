import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DB } from './db.js'
import { EXPLORE_ORDER, mjdIso, QUIET_STREAK, skyCardId, skyVisits, WARMUP_CARDS, WARMUP_KNOWN_SHARE, type SkyCard, type SkyFrame } from './explore.js'
import { ang2pixNest } from './healpix.js'
import type { DeckCard, Kit, ObjectSummary, Post } from './kit.js'
import { applyVote, goldRate, SwapCard, SwapUser, type Label } from './swap.js'
import {
  BADGES,
  COMMUNITY_GOALS,
  DAILY_CAP,
  dayKey,
  isInfraredOnly,
  levelFor,
  LEVELS,
  sawAllColours,
  scoreAction,
  type BadgeKey,
  type DayState,
  type XpAction,
  type XpResult,
} from './gamification.js'

export const TAGS = ['asteroid', 'artifact', 'brightness', 'unsure'] as const
export type Tag = (typeof TAGS)[number]

export const LEARNING_EVENTS = ['band_seen', 'spectrum_opened', 'object_viewed'] as const
export type LearningEvent = (typeof LEARNING_EVENTS)[number]

export interface User {
  id: string
  nickname: string
  created_at: number
}

export type Choice = 'moves' | 'still' | 'unsure'
export type VotePosition = { frame: number; x: number; y: number }

export const CHOICE_LABEL: Record<Choice, Label> = { moves: 'real', still: 'artifact', unsure: 'unsure' }

const OUTCOME: Record<string, 'open' | 'moves' | 'still' | 'undecided'> = { open: 'open', real: 'moves', artifact: 'still', inconclusive: 'undecided' }

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class Store {
  private swapUsers = new Map<string, SwapUser>()
  private swapCards = new Map<string, SwapCard>()
  private objectsById: Map<string, ObjectSummary>
  private skyCards = new Map<string, SkyCard>()
  private deckCells = new Map<string, number>()

  constructor(readonly db: DB, readonly kit: Kit, private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {
    this.objectsById = new Map(kit.objects.map((o) => [o.id, o]))
    for (const c of kit.deck) this.deckCells.set(c.id, ang2pixNest(EXPLORE_ORDER, c.ra, c.dec))
    this.loadSkyCards()
    this.backfillCells()
    this.rebuildSwap()
  }

  private loadSkyCards(): void {
    const rows = this.db.prepare('SELECT id, ra, dec, fov_deg, band, cell, size_px, frames, created_at FROM sky_cards').all() as (Omit<SkyCard, 'frames'> & { frames: string })[]
    for (const r of rows) this.skyCards.set(r.id, { ...r, frames: JSON.parse(r.frames) as SkyFrame[] })
  }

  private backfillCells(): void {
    const upd = this.db.prepare('UPDATE votes SET cell = ? WHERE card_id = ? AND cell IS NULL')
    this.db.transaction(() => {
      for (const [id, cell] of this.deckCells) upd.run(cell, id)
    })()
  }

  skyCard(id: string): SkyCard | undefined {
    return this.skyCards.get(id)
  }

  cellOf(cardId: string): number | null {
    return this.deckCells.get(cardId) ?? this.skyCards.get(cardId)?.cell ?? null
  }

  registerSkyCard(userId: string, input: { ra: number; dec: number; fov_deg: number; band: string; size_px: number; frames: SkyFrame[] }): SkyCard {
    const ra = Math.round((((input.ra % 360) + 360) % 360) * 1e4) / 1e4
    const dec = Math.round(input.dec * 1e4) / 1e4
    const id = skyCardId(ra, dec, input.fov_deg, input.band)
    let card = this.skyCards.get(id)
    if (!card) {
      const frames = [...input.frames].sort((a, b) => a.mjd - b.mjd)
      card = { id, ra, dec, fov_deg: input.fov_deg, band: input.band, cell: ang2pixNest(EXPLORE_ORDER, ra, dec), size_px: input.size_px, frames, created_at: this.now() }
      this.db
        .prepare('INSERT OR IGNORE INTO sky_cards (id, ra, dec, fov_deg, band, cell, size_px, frames, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ra, dec, card.fov_deg, card.band, card.cell, card.size_px, JSON.stringify(frames), userId, card.created_at)
      this.skyCards.set(id, card)
      this.swapCards.set(id, new SwapCard(null))
    }
    if (!this.db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, id)) this.issueCard(userId, id)
    return card
  }

  object(id: string): ObjectSummary | undefined {
    return this.objectsById.get(id)
  }

  rebuildSwap(): void {
    this.swapUsers = new Map()
    this.swapCards = new Map(this.kit.deck.map((c) => [c.id, new SwapCard(c.gold ?? null)]))
    for (const id of this.skyCards.keys()) this.swapCards.set(id, new SwapCard(null))
    const rows = this.db.prepare('SELECT user_id, card_id, label FROM votes WHERE counted = 1 ORDER BY id').all() as { user_id: string; card_id: string; label: Label }[]
    for (const r of rows) if (this.swapCards.has(r.card_id)) applyVote(this.swapUsers, this.swapCards, r.user_id, r.card_id, r.label)
  }

  createUser(nickname: string): { user: User; token: string } {
    const clean = nickname.trim()
    if (!/^[A-Za-z0-9_.]{3,24}$/.test(clean)) throw new HttpError(400, 'invalid_nickname')
    const exists = this.db.prepare('SELECT 1 FROM users WHERE nickname = ?').get(clean)
    if (exists) throw new HttpError(409, 'nickname_taken')
    const user: User = { id: randomUUID(), nickname: clean, created_at: this.now() }
    const token = this.db.transaction(() => {
      this.db.prepare("INSERT INTO users (id, nickname, token_hash, created_at) VALUES (?, ?, '', ?)").run(user.id, user.nickname, user.created_at)
      return this.createSession(user.id)
    })()
    return { user, token }
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('hex')
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(hashToken(token), userId, this.now())
    return token
  }

  endSession(token: string | undefined): void {
    if (!token) return
    const hash = hashToken(token)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
      this.db.prepare("UPDATE users SET token_hash = '' WHERE token_hash = ?").run(hash)
    })()
  }

  userByToken(token: string | undefined): User | null {
    if (!token) return null
    const row = this.db.prepare('SELECT u.id, u.nickname, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hashToken(token)) as User | undefined
    return row ? { id: row.id, nickname: row.nickname, created_at: row.created_at } : null
  }

  private dayState(userId: string): DayState {
    const day = dayKey(this.now())
    const today = this.db.prepare('SELECT action, COUNT(*) AS n, SUM(xp + streak_bonus) AS xp FROM xp_events WHERE user_id = ? AND day = ? AND reason != ? GROUP BY action').all(userId, day, 'too_fast') as {
      action: XpAction
      n: number
      xp: number
    }[]
    const last = this.db.prepare("SELECT day, streak FROM xp_events WHERE user_id = ? AND reason != 'too_fast' ORDER BY id DESC LIMIT 1").get(userId) as { day: string; streak: number } | undefined
    const countsToday: DayState['countsToday'] = {}
    let xpToday = 0
    for (const r of today) {
      countsToday[r.action] = r.n
      xpToday += r.xp ?? 0
    }
    return { day, xpToday, countsToday, lastActiveDay: last?.day ?? null, streak: last?.streak ?? 0 }
  }

  award(userId: string, action: XpAction, ref: string | null, opts: { ms?: number } = {}): XpResult {
    const repeat = ref !== null && action !== 'vote' && !!this.db.prepare('SELECT 1 FROM xp_events WHERE user_id = ? AND action = ? AND ref = ? LIMIT 1').get(userId, action, ref)
    const result = scoreAction(action, this.dayState(userId), { ms: opts.ms, repeat })
    this.db
      .prepare('INSERT INTO xp_events (user_id, action, ref, xp, streak_bonus, streak, reason, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, action, ref, result.xp, result.streakBonus, result.streak, result.reason, dayKey(this.now()), this.now())
    if (result.streak >= 7) this.grantBadge(userId, 'week_streak')
    return result
  }

  grantBadge(userId: string, badge: BadgeKey, withXp = true): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO badges (user_id, badge, created_at) VALUES (?, ?, ?)').run(userId, badge, this.now())
    if (r.changes === 0) return false
    if (withXp) this.award(userId, 'badge', badge)
    return true
  }

  totalXp(userId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(xp + streak_bonus), 0) AS xp FROM xp_events WHERE user_id = ?').get(userId) as { xp: number }
    return r.xp
  }

  private quietStreak(userId: string): boolean {
    const last = this.db.prepare('SELECT card_id, label FROM votes WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, QUIET_STREAK) as { card_id: string; label: string }[]
    return last.length === QUIET_STREAK && last.every((v) => this.skyCards.has(v.card_id) && v.label === 'artifact')
  }

  next(userId: string, opts: { explore?: boolean; known?: boolean } = {}): { card: DeckCard | null; sky: boolean; interesting: boolean } {
    const seen = new Set((this.db.prepare('SELECT card_id FROM votes WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id))
    if (opts.explore && this.quietStreak(userId)) {
      const mover = this.kit.deck.filter((c) => c.kind === 'mover' && c.gold === 'real' && !seen.has(c.id))
      const pick = mover[Math.floor(this.random() * mover.length)]
      if (pick) {
        this.issueCard(userId, pick.id)
        return { card: pick, sky: false, interesting: true }
      }
    }
    const canExplore = !!opts.explore && !opts.known && this.kit.indexCells.length > 0
    if (canExplore) {
      const n = seen.size
      const knownShare = n < WARMUP_CARDS ? WARMUP_KNOWN_SHARE : goldRate(n)
      if (this.random() >= knownShare) return { card: null, sky: true, interesting: false }
    }
    const card = this.nextCard(userId, { controlsOnly: canExplore && seen.size >= WARMUP_CARDS, seen })
    if (!card && canExplore) return { card: null, sky: true, interesting: false }
    return { card, sky: false, interesting: false }
  }

  nextCard(userId: string, opts: { controlsOnly?: boolean; seen?: Set<string> } = {}): DeckCard | null {
    const seen = opts.seen ?? new Set((this.db.prepare('SELECT card_id FROM votes WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id))
    const n = seen.size
    const gold: string[] = []
    const open: string[] = []
    for (const [id, c] of this.swapCards) {
      if (seen.has(id) || !this.kit.deckById.has(id)) continue
      if (c.gold) gold.push(id)
      else if (c.status === 'open') open.push(id)
    }
    const wantGold = opts.controlsOnly || this.random() < goldRate(n)
    let pool: string[]
    if ((wantGold && gold.length) || !open.length) pool = gold
    else {
      const least = Math.min(...open.map((id) => this.swapCards.get(id)?.nVotes ?? 0))
      pool = open.filter((id) => (this.swapCards.get(id)?.nVotes ?? 0) <= least + 1)
    }
    if (!pool.length) return null
    const id = pool[Math.floor(this.random() * pool.length)] as string
    const card = this.kit.deckById.get(id) ?? null
    if (card) this.issueCard(userId, card.id)
    return card
  }

  issueCard(userId: string, cardId: string, guided = false): void {
    this.db
      .prepare('INSERT INTO card_issues (user_id, card_id, issued_at, guided) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, card_id) DO UPDATE SET issued_at = excluded.issued_at, guided = excluded.guided')
      .run(userId, cardId, this.now(), guided ? 1 : 0)
  }

  guideCard(userId: string): DeckCard | null {
    const seen = new Set((this.db.prepare('SELECT card_id FROM votes WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id))
    const jump = (c: DeckCard) => {
      const [a, b] = c.marks ?? []
      return a && b ? Math.hypot(a.u - b.u, a.v - b.v) : 0
    }
    const pool = this.kit.deck
      .filter((c) => c.kind === 'mover' && c.gold === 'real' && (c.marks?.length ?? 0) >= 2 && !seen.has(c.id))
      .sort((a, b) => a.n_frames - b.n_frames || jump(b) - jump(a))
    const card = pool[0] ?? null
    if (card) this.issueCard(userId, card.id, true)
    return card
  }

  private isGuided(userId: string, cardId: string): boolean {
    const row = this.db.prepare('SELECT guided FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { guided: number } | undefined
    return row?.guided === 1
  }

  private elapsedSinceIssue(userId: string, cardId: string): number {
    const issue = this.db.prepare('SELECT issued_at FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { issued_at: number } | undefined
    if (!issue) throw new HttpError(409, 'card_not_issued')
    const last = this.db.prepare('SELECT MAX(created_at) AS t FROM votes WHERE user_id = ?').get(userId) as { t: number | null }
    return Math.max(0, this.now() - Math.max(issue.issued_at, last.t ?? -Infinity))
  }

  vote(userId: string, cardId: string, choice: Choice, glitch: boolean | null = null, position: VotePosition | null = null) {
    const card = this.kit.deckById.get(cardId)
    const sky = card ? undefined : this.skyCards.get(cardId)
    if (!card && !sky) throw new HttpError(404, 'unknown_card')
    if (position && (choice !== 'moves' || position.frame >= (card ? card.n_frames : skyVisits((sky as SkyCard).frames).length))) throw new HttpError(400, 'invalid_position')
    if (this.db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId)) throw new HttpError(409, 'already_voted')
    const label = CHOICE_LABEL[choice]
    const ms = this.elapsedSinceIssue(userId, cardId)
    const guided = this.isGuided(userId, cardId)
    const xp: XpResult = guided ? { xp: 0, streakBonus: 0, streak: 0, reason: 'guided' } : this.award(userId, 'vote', cardId, { ms })
    const counted = !guided && xp.reason !== 'too_fast'
    this.db
      .prepare('INSERT INTO votes (user_id, card_id, label, ms, counted, created_at, glitch, cell, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, cardId, label, ms, counted ? 1 : 0, this.now(), glitch === null ? null : glitch ? 1 : 0, this.cellOf(cardId), position ? JSON.stringify(position) : null)
    this.db.prepare('DELETE FROM card_issues WHERE user_id = ? AND card_id = ?').run(userId, cardId)
    const gold = card?.gold ?? null
    let outcome = { gold, correct: null as boolean | null, bits: 0 }
    if (counted) outcome = applyVote(this.swapUsers, this.swapCards, userId, cardId, label)
    else if (gold && label !== 'unsure') outcome.correct = label === gold
    const newBadges: BadgeKey[] = []
    if (counted && this.grantBadge(userId, 'first_vote')) newBadges.push('first_vote')
    const reveal = card ? this.reveal(card, outcome.correct, choice) : this.skyReveal(sky as SkyCard, choice)
    return { xp, counted, guided, reveal, newBadges }
  }

  skyStatus(id: string): string {
    const s = this.swapCards.get(id)
    if (!s) return 'open'
    return s.status === 'real' ? 'candidate' : s.status
  }

  skyReveal(card: SkyCard, choice: Choice) {
    const s = this.swapCards.get(card.id) ?? new SwapCard(null)
    const looked = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE card_id = ?').get(card.id) as { n: number }).n
    return {
      your_choice: choice,
      looked,
      outcome: OUTCOME[s.status] ?? 'open',
      kind: 'sky',
      band: card.band,
      size_arcmin: Math.round(card.fov_deg * 60 * 100) / 100,
      tile: card.size_px,
      size_px: card.size_px,
      frames: skyVisits(card.frames).map((v) => ({ t: mjdIso(v.mjd), mjd: Math.round(v.mjd * 1e6) / 1e6, n_exp: v.n_exp, wl_min: v.wl_min, wl_max: v.wl_max })),
      known: null,
      rate_arcsec_h: null,
      ra: card.ra,
      dec: card.dec,
      marks: [],
      control: null,
      p_real: Math.round(s.pReal * 1000) / 1000,
      votes: { real: s.nReal, artifact: s.nArt, unsure: s.nUnsure },
      status: this.skyStatus(card.id),
    }
  }

  candidates(limit = 100) {
    const out = []
    for (const card of this.skyCards.values()) {
      const s = this.swapCards.get(card.id)
      if (!s || s.status !== 'real') continue
      out.push({
        id: card.id,
        ra: card.ra,
        dec: card.dec,
        fov_deg: card.fov_deg,
        band: card.band,
        cell: card.cell,
        p_real: Math.round(s.pReal * 1000) / 1000,
        votes: { real: s.nReal, artifact: s.nArt, unsure: s.nUnsure },
        frames: card.frames.map((f, i) => ({ key: f.key, t: mjdIso(f.mjd), mjd: f.mjd, wl_um: f.wl_um, visit: f.visit ?? i })),
        status: 'candidate',
        catalog_check: null,
      })
    }
    return out.sort((a, b) => b.p_real - a.p_real).slice(0, limit)
  }

  exploreMap(userId: string | null) {
    const rows = this.db.prepare('SELECT cell, COUNT(*) AS n FROM votes WHERE cell IS NOT NULL GROUP BY cell').all() as { cell: number; n: number }[]
    const people = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE cell IS NOT NULL').get() as { n: number }).n
    const mine = userId ? (this.db.prepare('SELECT COUNT(DISTINCT cell) AS n FROM votes WHERE user_id = ? AND cell IS NOT NULL').get(userId) as { n: number }).n : 0
    const myLooks = userId ? (this.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE user_id = ? AND cell IS NOT NULL').get(userId) as { n: number }).n : 0
    return {
      order: EXPLORE_ORDER,
      indexed: this.kit.indexCells.length,
      cells: rows.map((r) => ({ cell: r.cell, looks: r.n })),
      looks: rows.reduce((a, r) => a + r.n, 0),
      people,
      mine: { cells: mine, looks: myLooks },
    }
  }

  setGlitch(userId: string, cardId: string, glitch: boolean | null): void {
    const r = this.db.prepare('UPDATE votes SET glitch = ? WHERE user_id = ? AND card_id = ?').run(glitch === null ? null : glitch ? 1 : 0, userId, cardId)
    if (r.changes === 0) throw new HttpError(404, 'no_vote')
  }

  reveal(card: DeckCard, correct: boolean | null, choice: Choice) {
    const s = this.swapCards.get(card.id) ?? new SwapCard(card.gold ?? null)
    const looked = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE card_id = ?').get(card.id) as { n: number }).n
    return {
      your_choice: choice,
      looked,
      outcome: card.gold ? null : OUTCOME[s.status] ?? 'open',
      kind: card.kind,
      band: card.band.replace('SPHEREx-', ''),
      size_arcmin: card.size_arcmin,
      tile: card.tile,
      size_px: card.size_px,
      frames: card.frames.map((f) => ({ t: f.t, mjd: f.mjd, n_exp: f.n_exp, wl_min: f.wl_min, wl_max: f.wl_max })),
      known: card.known ? { name: card.known.name, V: card.known.V ?? null, rate_arcsec_h: card.known.rate_arcsec_h ?? null } : null,
      rate_arcsec_h: card.rate_arcsec_h ?? null,
      ra: card.ra,
      dec: card.dec,
      marks: card.marks ?? [],
      control: card.gold ? { truth: card.gold, correct } : null,
      p_real: card.gold ? null : Math.round(s.pReal * 1000) / 1000,
      votes: { real: s.nReal, artifact: s.nArt, unsure: s.nUnsure },
      status: s.status,
    }
  }

  voteWeight(userId: string): { pR: number; pA: number } {
    const u = this.swapUsers.get(userId) ?? new SwapUser()
    return { pR: u.pR, pA: u.pA }
  }

  setTag(userId: string, postId: string, tag: Tag, on: boolean): XpResult | null {
    if (!this.kit.postsById.has(postId)) throw new HttpError(404, 'unknown_post')
    if (!on) {
      this.db.prepare('DELETE FROM tags WHERE user_id = ? AND post_id = ? AND tag = ?').run(userId, postId, tag)
      return null
    }
    const r = this.db.prepare('INSERT OR IGNORE INTO tags (user_id, post_id, tag, created_at) VALUES (?, ?, ?, ?)').run(userId, postId, tag, this.now())
    return r.changes ? this.award(userId, 'tag', `${postId}:${tag}`) : null
  }

  myTags(userId: string | null, postId: string): Tag[] {
    if (!userId) return []
    return (this.db.prepare('SELECT tag FROM tags WHERE user_id = ? AND post_id = ?').all(userId, postId) as { tag: Tag }[]).map((r) => r.tag)
  }

  tagCounts(postId: string): Record<Tag, number> {
    const out = Object.fromEntries(TAGS.map((t) => [t, 0])) as Record<Tag, number>
    for (const r of this.db.prepare('SELECT tag, COUNT(*) AS n FROM tags WHERE post_id = ? GROUP BY tag').all(postId) as { tag: Tag; n: number }[]) {
      if (r.tag in out) out[r.tag] = r.n
    }
    return out
  }

  tagSummary(userId: string | null, postId: string) {
    const mine = this.myTags(userId, postId)
    return { mine, counts: mine.length ? this.tagCounts(postId) : null }
  }

  saveMarks(userId: string, postId: string, marks: { frame: number; x: number; y: number }[]) {
    const post = this.kit.postsById.get(postId)
    if (!post) throw new HttpError(404, 'unknown_post')
    const valid = marks.filter((m) => m.frame >= 0 && m.frame < post.frames.length)
    if (!valid.length) throw new HttpError(400, 'no_valid_marks')
    const ins = this.db.prepare(
      'INSERT INTO marks (user_id, post_id, frame, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, post_id, frame) DO UPDATE SET x = excluded.x, y = excluded.y, created_at = excluded.created_at',
    )
    this.db.transaction(() => {
      for (const m of valid) ins.run(userId, postId, m.frame, m.x, m.y, this.now())
    })()
    const xp = this.award(userId, 'mark', postId)
    const newBadges: BadgeKey[] = []
    if (this.grantBadge(userId, 'first_motion')) newBadges.push('first_motion')
    return { saved: valid.length, xp, newBadges }
  }

  myMarks(userId: string | null, postId: string) {
    if (!userId) return []
    return this.db.prepare('SELECT frame, x, y FROM marks WHERE user_id = ? AND post_id = ? ORDER BY frame').all(userId, postId) as { frame: number; x: number; y: number }[]
  }

  communityMarks(postId: string) {
    const rows = this.db.prepare('SELECT frame, AVG(x) AS x, AVG(y) AS y, COUNT(*) AS n FROM marks WHERE post_id = ? GROUP BY frame ORDER BY frame').all(postId) as {
      frame: number
      x: number
      y: number
      n: number
    }[]
    const people = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM marks WHERE post_id = ?').get(postId) as { n: number }).n
    return { people, frames: rows }
  }

  setFollow(userId: string, objectId: string, on: boolean): XpResult | null {
    if (!this.objectsById.has(objectId)) throw new HttpError(404, 'unknown_object')
    if (!on) {
      this.db.prepare('DELETE FROM follows WHERE user_id = ? AND object_id = ?').run(userId, objectId)
      return null
    }
    const r = this.db.prepare('INSERT OR IGNORE INTO follows (user_id, object_id, created_at) VALUES (?, ?, ?)').run(userId, objectId, this.now())
    return r.changes ? this.award(userId, 'follow', objectId) : null
  }

  isFollowing(userId: string | null, objectId: string): boolean {
    if (!userId) return false
    return !!this.db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND object_id = ?').get(userId, objectId)
  }

  followers(objectId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE object_id = ?').get(objectId) as { n: number }).n
  }

  following(userId: string | null): string[] {
    if (!userId) return []
    return (this.db.prepare('SELECT object_id FROM follows WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { object_id: string }[]).map((r) => r.object_id)
  }

  learn(userId: string, event: LearningEvent, ref: string): BadgeKey[] {
    const earned: BadgeKey[] = []
    if (event === 'band_seen') {
      if (!/^D[1-6]$/.test(ref)) throw new HttpError(400, 'invalid_band')
    } else if (!this.objectsById.has(ref) && !this.kit.postsById.has(ref)) throw new HttpError(404, 'unknown_ref')
    this.db.prepare('INSERT OR IGNORE INTO learning (user_id, event, ref, created_at) VALUES (?, ?, ?, ?)').run(userId, event, ref, this.now())
    if (event === 'band_seen') {
      const seen = (this.db.prepare("SELECT ref FROM learning WHERE user_id = ? AND event = 'band_seen'").all(userId) as { ref: string }[]).map((r) => r.ref)
      if (sawAllColours(seen) && this.grantBadge(userId, 'all_colours', false)) earned.push('all_colours')
    }
    if (event === 'spectrum_opened' && this.grantBadge(userId, 'first_spectrum', false)) earned.push('first_spectrum')
    if (event === 'object_viewed') {
      const o = this.objectsById.get(ref)
      if (o && isInfraredOnly(this.kit.profiles.get(o.id)?.band_stats, o.verdict) && this.grantBadge(userId, 'infrared_only', false)) earned.push('infrared_only')
      if (o && o.saturation === 'heavy' && this.grantBadge(userId, 'too_bright', false)) earned.push('too_bright')
    }
    return earned
  }

  me(user: User) {
    const xp = this.totalXp(user.id)
    const lvl = levelFor(xp)
    const st = this.dayState(user.id)
    const badges = this.db.prepare('SELECT badge, created_at FROM badges WHERE user_id = ? ORDER BY created_at').all(user.id) as { badge: BadgeKey; created_at: number }[]
    const count = (sql: string) => (this.db.prepare(sql).get(user.id) as { n: number }).n
    const streak = st.lastActiveDay === st.day || (st.lastActiveDay && Date.parse(st.day) - Date.parse(st.lastActiveDay) <= 86400000) ? st.streak : 0
    return {
      user: { id: user.id, nickname: user.nickname, created_at: user.created_at },
      xp,
      xp_today: st.xpToday,
      daily_cap: DAILY_CAP,
      streak,
      level: { level: lvl.current.level, key: lvl.current.key, min_xp: lvl.current.minXp, next_min_xp: lvl.next?.minXp ?? null, progress: lvl.progress },
      levels: LEVELS.map((l) => ({ level: l.level, key: l.key, min_xp: l.minXp })),
      badges: BADGES.map((b) => ({ key: b, earned_at: badges.find((x) => x.badge === b)?.created_at ?? null })),
      counts: {
        votes: count('SELECT COUNT(*) AS n FROM votes WHERE user_id = ? AND counted = 1'),
        marks: count('SELECT COUNT(DISTINCT post_id) AS n FROM marks WHERE user_id = ?'),
        tags: count('SELECT COUNT(*) AS n FROM tags WHERE user_id = ?'),
        following: count('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?'),
      },
    }
  }

  history(userId: string, limit = 50) {
    const votes = this.db.prepare('SELECT card_id AS ref, label AS detail, created_at FROM votes WHERE user_id = ? AND counted = 1 ORDER BY id DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const marks = this.db.prepare('SELECT post_id AS ref, COUNT(*) AS detail, MAX(created_at) AS created_at FROM marks WHERE user_id = ? GROUP BY post_id ORDER BY created_at DESC LIMIT ?').all(userId, limit) as {
      ref: string
      detail: number
      created_at: number
    }[]
    const tags = this.db.prepare('SELECT post_id AS ref, tag AS detail, created_at FROM tags WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const items = [
      ...votes.filter((v) => this.kit.deckById.has(v.ref) || this.skyCards.has(v.ref)).map((v) => {
        const s = this.swapCards.get(v.ref)
        const status = this.skyCards.has(v.ref) ? this.skyStatus(v.ref) : s && !s.gold ? s.status : null
        return { type: 'vote' as const, ref: v.ref, detail: v.detail, created_at: v.created_at, status, post: null }
      }),
      ...marks.filter((m) => this.kit.postsById.has(m.ref)).map((m) => ({ type: 'mark' as const, ref: m.ref, detail: String(m.detail), created_at: m.created_at, status: null, post: this.postBrief(m.ref) })),
      ...tags.filter((t) => this.kit.postsById.has(t.ref)).map((t) => ({ type: 'tag' as const, ref: t.ref, detail: t.detail, created_at: t.created_at, status: null, post: this.postBrief(t.ref) })),
    ]
    return items.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  postBrief(postId: string): { id: string; title: string; object_id: string; cover: string } | null {
    const p = this.kit.postsById.get(postId)
    return p ? { id: p.id, title: p.title, object_id: p.object_id, cover: mediaUrl(p.object_id, p.cover) } : null
  }

  alerts(userId: string) {
    const read = new Set((this.db.prepare('SELECT alert_id FROM alerts_read WHERE user_id = ?').all(userId) as { alert_id: string }[]).map((r) => r.alert_id))
    const out: { id: string; type: 'new_data' | 'consensus' | 'candidate' | 'badge' | 'level' | 'goal'; ref: string; detail: string; created_at: number; read: boolean }[] = []
    const follows = this.db.prepare('SELECT object_id, created_at FROM follows WHERE user_id = ?').all(userId) as { object_id: string; created_at: number }[]
    for (const f of follows) {
      const o = this.objectsById.get(f.object_id)
      if (o && (o.has_new_data || Date.parse(o.last_seen) > f.created_at)) out.push({ id: `new:${o.id}:${o.last_seen}`, type: 'new_data', ref: o.id, detail: o.last_seen, created_at: Math.max(f.created_at, Date.parse(o.last_seen)), read: false })
    }
    const votes = this.db.prepare('SELECT card_id, label, created_at FROM votes WHERE user_id = ? AND counted = 1').all(userId) as { card_id: string; label: string; created_at: number }[]
    for (const v of votes) {
      const s = this.swapCards.get(v.card_id)
      if (s && this.skyCards.has(v.card_id)) {
        if (s.status === 'real') out.push({ id: `candidate:${v.card_id}`, type: 'candidate', ref: v.card_id, detail: `${this.skyCards.get(v.card_id)?.ra ?? 0},${this.skyCards.get(v.card_id)?.dec ?? 0}`, created_at: v.created_at, read: false })
      } else if (s && !s.gold && s.status !== 'open') out.push({ id: `consensus:${v.card_id}:${s.status}`, type: 'consensus', ref: v.card_id, detail: s.status, created_at: v.created_at, read: false })
    }
    const badges = this.db.prepare('SELECT badge, created_at FROM badges WHERE user_id = ?').all(userId) as { badge: string; created_at: number }[]
    for (const b of badges) out.push({ id: `badge:${b.badge}`, type: 'badge', ref: b.badge, detail: b.badge, created_at: b.created_at, read: false })
    const level = levelFor(this.totalXp(userId)).current
    if (level.level > 1) out.push({ id: `level:${level.level}`, type: 'level', ref: String(level.level), detail: level.key, created_at: this.now(), read: false })
    for (const g of this.goals()) if (g.count >= g.target) out.push({ id: `goal:${g.key}:${g.month}`, type: 'goal', ref: g.key, detail: String(g.target), created_at: this.now(), read: false })
    for (const a of out) a.read = read.has(a.id)
    return out.sort((a, b) => b.created_at - a.created_at)
  }

  markAlertsRead(userId: string, ids: string[]): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO alerts_read (user_id, alert_id, created_at) VALUES (?, ?, ?)')
    this.db.transaction(() => {
      for (const id of ids) ins.run(userId, id, this.now())
    })()
  }

  goals() {
    const d = new Date(this.now())
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const month = new Date(start).toISOString().slice(0, 7)
    const counts = {
      motions: (this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id, post_id FROM marks WHERE created_at >= ?)').get(start) as { n: number }).n,
      classifications: (this.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE counted = 1 AND created_at >= ?').get(start) as { n: number }).n,
      tags: (this.db.prepare('SELECT COUNT(*) AS n FROM tags WHERE created_at >= ?').get(start) as { n: number }).n,
    }
    return COMMUNITY_GOALS.map((g) => ({ key: g.key, target: g.target, count: counts[g.key], month }))
  }
}

export function mediaUrl(objectId: string, path: string): string {
  return `/kit/objects/${objectId}/${path}`
}

export function postsForObject(kit: Kit, objectId: string): Post[] {
  return kit.postsByObject.get(objectId) ?? []
}
