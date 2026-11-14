import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DB } from './db.js'
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

  constructor(readonly db: DB, readonly kit: Kit, private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {
    this.objectsById = new Map(kit.objects.map((o) => [o.id, o]))
    this.rebuildSwap()
  }

  object(id: string): ObjectSummary | undefined {
    return this.objectsById.get(id)
  }

  rebuildSwap(): void {
    this.swapUsers = new Map()
    this.swapCards = new Map(this.kit.deck.map((c) => [c.id, new SwapCard(c.gold ?? null)]))
    const rows = this.db.prepare('SELECT user_id, card_id, label FROM votes WHERE counted = 1 ORDER BY id').all() as { user_id: string; card_id: string; label: Label }[]
    for (const r of rows) if (this.swapCards.has(r.card_id)) applyVote(this.swapUsers, this.swapCards, r.user_id, r.card_id, r.label)
  }

  createUser(nickname: string): { user: User; token: string } {
    const clean = nickname.trim()
    if (!/^[A-Za-z0-9_.]{3,24}$/.test(clean)) throw new HttpError(400, 'invalid_nickname')
    const exists = this.db.prepare('SELECT 1 FROM users WHERE nickname = ?').get(clean)
    if (exists) throw new HttpError(409, 'nickname_taken')
    const token = randomBytes(32).toString('hex')
    const user: User = { id: randomUUID(), nickname: clean, created_at: this.now() }
    this.db.prepare('INSERT INTO users (id, nickname, token_hash, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.nickname, hashToken(token), user.created_at)
    return { user, token }
  }

  userByToken(token: string | undefined): User | null {
    if (!token) return null
    const row = this.db.prepare('SELECT id, nickname, created_at FROM users WHERE token_hash = ?').get(hashToken(token)) as User | undefined
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

  grantBadge(userId: string, badge: BadgeKey): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO badges (user_id, badge, created_at) VALUES (?, ?, ?)').run(userId, badge, this.now())
    if (r.changes === 0) return false
    this.award(userId, 'badge', badge)
    return true
  }

  totalXp(userId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(xp + streak_bonus), 0) AS xp FROM xp_events WHERE user_id = ?').get(userId) as { xp: number }
    return r.xp
  }

  nextCard(userId: string): DeckCard | null {
    const seen = new Set((this.db.prepare('SELECT card_id FROM votes WHERE user_id = ?').all(userId) as { card_id: string }[]).map((r) => r.card_id))
    const n = seen.size
    const gold: string[] = []
    const open: string[] = []
    for (const [id, c] of this.swapCards) {
      if (seen.has(id)) continue
      if (c.gold) gold.push(id)
      else if (c.status === 'open') open.push(id)
    }
    const wantGold = this.random() < goldRate(n)
    let pool: string[]
    if ((wantGold && gold.length) || !open.length) pool = gold
    else {
      const least = Math.min(...open.map((id) => this.swapCards.get(id)?.nVotes ?? 0))
      pool = open.filter((id) => (this.swapCards.get(id)?.nVotes ?? 0) <= least + 1)
    }
    if (!pool.length) return null
    const id = pool[Math.floor(this.random() * pool.length)] as string
    return this.kit.deckById.get(id) ?? null
  }

  vote(userId: string, cardId: string, label: Label, ms: number) {
    const card = this.kit.deckById.get(cardId)
    if (!card) throw new HttpError(404, 'unknown_card')
    if (this.db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId)) throw new HttpError(409, 'already_voted')
    const xp = this.award(userId, 'vote', cardId, { ms })
    const counted = xp.reason !== 'too_fast'
    this.db.prepare('INSERT INTO votes (user_id, card_id, label, ms, counted, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, cardId, label, ms, counted ? 1 : 0, this.now())
    let outcome = { gold: card.gold ?? null, correct: null as boolean | null, bits: 0 }
    if (counted) outcome = applyVote(this.swapUsers, this.swapCards, userId, cardId, label)
    else if (card.gold && label !== 'unsure') outcome.correct = label === card.gold
    const newBadges: BadgeKey[] = []
    if (counted && this.grantBadge(userId, 'first_vote')) newBadges.push('first_vote')
    return { xp, counted, reveal: this.reveal(card, outcome.correct), newBadges }
  }

  reveal(card: DeckCard, correct: boolean | null) {
    const s = this.swapCards.get(card.id) ?? new SwapCard(card.gold ?? null)
    return {
      kind: card.kind,
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
      if (sawAllColours(seen) && this.grantBadge(userId, 'all_colours')) earned.push('all_colours')
    }
    if (event === 'spectrum_opened' && this.grantBadge(userId, 'first_spectrum')) earned.push('first_spectrum')
    if (event === 'object_viewed') {
      const o = this.objectsById.get(ref)
      if (o && isInfraredOnly(this.kit.profiles.get(o.id)?.band_stats, o.verdict) && this.grantBadge(userId, 'infrared_only')) earned.push('infrared_only')
      if (o && o.saturation === 'heavy' && this.grantBadge(userId, 'too_bright')) earned.push('too_bright')
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
        votes: count('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?'),
        marks: count('SELECT COUNT(DISTINCT post_id) AS n FROM marks WHERE user_id = ?'),
        tags: count('SELECT COUNT(*) AS n FROM tags WHERE user_id = ?'),
        following: count('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?'),
      },
    }
  }

  history(userId: string, limit = 50) {
    const votes = this.db.prepare('SELECT card_id AS ref, label AS detail, created_at FROM votes WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const marks = this.db.prepare('SELECT post_id AS ref, COUNT(*) AS detail, MAX(created_at) AS created_at FROM marks WHERE user_id = ? GROUP BY post_id ORDER BY created_at DESC LIMIT ?').all(userId, limit) as {
      ref: string
      detail: number
      created_at: number
    }[]
    const tags = this.db.prepare('SELECT post_id AS ref, tag AS detail, created_at FROM tags WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const items = [
      ...votes.map((v) => {
        const s = this.swapCards.get(v.ref)
        return { type: 'vote' as const, ref: v.ref, detail: v.detail, created_at: v.created_at, status: s && !s.gold ? s.status : null, post: null }
      }),
      ...marks.map((m) => ({ type: 'mark' as const, ref: m.ref, detail: String(m.detail), created_at: m.created_at, status: null, post: this.postBrief(m.ref) })),
      ...tags.map((t) => ({ type: 'tag' as const, ref: t.ref, detail: t.detail, created_at: t.created_at, status: null, post: this.postBrief(t.ref) })),
    ]
    return items.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  postBrief(postId: string): { id: string; title: string; object_id: string; cover: string } | null {
    const p = this.kit.postsById.get(postId)
    return p ? { id: p.id, title: p.title, object_id: p.object_id, cover: mediaUrl(p.object_id, p.cover) } : null
  }

  alerts(userId: string) {
    const read = new Set((this.db.prepare('SELECT alert_id FROM alerts_read WHERE user_id = ?').all(userId) as { alert_id: string }[]).map((r) => r.alert_id))
    const out: { id: string; type: 'new_data' | 'consensus' | 'badge' | 'level' | 'goal'; ref: string; detail: string; created_at: number; read: boolean }[] = []
    const follows = this.db.prepare('SELECT object_id, created_at FROM follows WHERE user_id = ?').all(userId) as { object_id: string; created_at: number }[]
    for (const f of follows) {
      const o = this.objectsById.get(f.object_id)
      if (o && (o.has_new_data || Date.parse(o.last_seen) > f.created_at)) out.push({ id: `new:${o.id}:${o.last_seen}`, type: 'new_data', ref: o.id, detail: o.last_seen, created_at: Math.max(f.created_at, Date.parse(o.last_seen)), read: false })
    }
    const votes = this.db.prepare('SELECT card_id, label, created_at FROM votes WHERE user_id = ? AND counted = 1').all(userId) as { card_id: string; label: string; created_at: number }[]
    for (const v of votes) {
      const s = this.swapCards.get(v.card_id)
      if (s && !s.gold && s.status !== 'open') out.push({ id: `consensus:${v.card_id}:${s.status}`, type: 'consensus', ref: v.card_id, detail: s.status, created_at: v.created_at, read: false })
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
