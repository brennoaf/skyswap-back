import { COMMUNITY_GOALS, levelFor, type BadgeKey, type XpResult } from '../gamification.js'
import { HttpError, mediaUrl, StorePart, TAGS, type StoreContext, type Tag } from './base.js'
import type { Deck } from './deck.js'
import type { Xp } from './xp.js'

export class Social extends StorePart {
  constructor(ctx: StoreContext, private readonly xp: Xp, private readonly deck: Deck) {
    super(ctx)
  }

  setTag(userId: string, postId: string, tag: Tag, on: boolean): XpResult | null {
    if (!this.kit.postsById.has(postId)) throw new HttpError(404, 'unknown_post')
    if (!on) {
      this.q('DELETE FROM tags WHERE user_id = ? AND post_id = ? AND tag = ?').run(userId, postId, tag)
      return null
    }
    const r = this.q('INSERT OR IGNORE INTO tags (user_id, post_id, tag, created_at) VALUES (?, ?, ?, ?)').run(userId, postId, tag, this.now())
    return r.changes ? this.xp.award(userId, 'tag', `${postId}:${tag}`) : null
  }

  myTags(userId: string | null, postId: string): Tag[] {
    if (!userId) return []
    return (this.q('SELECT tag FROM tags WHERE user_id = ? AND post_id = ?').all(userId, postId) as { tag: Tag }[]).map((r) => r.tag)
  }

  tagCounts(postId: string): Record<Tag, number> {
    const out = Object.fromEntries(TAGS.map((t) => [t, 0])) as Record<Tag, number>
    for (const r of this.q('SELECT tag, COUNT(*) AS n FROM tags WHERE post_id = ? GROUP BY tag').all(postId) as { tag: Tag; n: number }[]) {
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
    const ins = this.q(
      'INSERT INTO marks (user_id, post_id, frame, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, post_id, frame) DO UPDATE SET x = excluded.x, y = excluded.y, created_at = excluded.created_at',
    )
    this.db.transaction(() => {
      for (const m of valid) ins.run(userId, postId, m.frame, m.x, m.y, this.now())
    })()
    const xp = this.xp.award(userId, 'mark', postId)
    const newBadges: BadgeKey[] = []
    if (this.xp.grantBadge(userId, 'first_motion')) newBadges.push('first_motion')
    return { saved: valid.length, xp, newBadges }
  }

  myMarks(userId: string | null, postId: string) {
    if (!userId) return []
    return this.q('SELECT frame, x, y FROM marks WHERE user_id = ? AND post_id = ? ORDER BY frame').all(userId, postId) as { frame: number; x: number; y: number }[]
  }

  communityMarks(postId: string) {
    const rows = this.q('SELECT frame, AVG(x) AS x, AVG(y) AS y, COUNT(*) AS n FROM marks WHERE post_id = ? GROUP BY frame ORDER BY frame').all(postId) as {
      frame: number
      x: number
      y: number
      n: number
    }[]
    const people = (this.q('SELECT COUNT(DISTINCT user_id) AS n FROM marks WHERE post_id = ?').get(postId) as { n: number }).n
    return { people, frames: rows }
  }

  setFollow(userId: string, objectId: string, on: boolean): XpResult | null {
    if (!this.objectsById.has(objectId)) throw new HttpError(404, 'unknown_object')
    if (!on) {
      this.q('DELETE FROM follows WHERE user_id = ? AND object_id = ?').run(userId, objectId)
      return null
    }
    const r = this.q('INSERT OR IGNORE INTO follows (user_id, object_id, created_at) VALUES (?, ?, ?)').run(userId, objectId, this.now())
    return r.changes ? this.xp.award(userId, 'follow', objectId) : null
  }

  isFollowing(userId: string | null, objectId: string): boolean {
    if (!userId) return false
    return !!this.q('SELECT 1 FROM follows WHERE user_id = ? AND object_id = ?').get(userId, objectId)
  }

  followers(objectId: string): number {
    return (this.q('SELECT COUNT(*) AS n FROM follows WHERE object_id = ?').get(objectId) as { n: number }).n
  }

  following(userId: string | null): string[] {
    if (!userId) return []
    return (this.q('SELECT object_id FROM follows WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { object_id: string }[]).map((r) => r.object_id)
  }

  history(userId: string, limit = 50) {
    const votes = this.q('SELECT card_id AS ref, label AS detail, created_at FROM votes WHERE user_id = ? AND counted = 1 ORDER BY id DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const marks = this.q('SELECT post_id AS ref, COUNT(*) AS detail, MAX(created_at) AS created_at FROM marks WHERE user_id = ? GROUP BY post_id ORDER BY created_at DESC LIMIT ?').all(userId, limit) as {
      ref: string
      detail: number
      created_at: number
    }[]
    const tags = this.q('SELECT post_id AS ref, tag AS detail, created_at FROM tags WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as { ref: string; detail: string; created_at: number }[]
    const items = [
      ...votes.filter((v) => this.kit.deckById.has(v.ref) || this.deck.hasSkyCard(v.ref)).map((v) => {
        const s = this.deck.swapCardFor(v.ref)
        const status = this.deck.hasSkyCard(v.ref) ? this.deck.skyStatus(v.ref) : s && !s.gold ? s.status : null
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
    const read = new Set((this.q('SELECT alert_id FROM alerts_read WHERE user_id = ?').all(userId) as { alert_id: string }[]).map((r) => r.alert_id))
    const out: { id: string; type: 'new_data' | 'consensus' | 'finding' | 'finding_followed' | 'note' | 'badge' | 'level' | 'goal'; ref: string; detail: string; created_at: number; read: boolean }[] = []
    const follows = this.q('SELECT object_id, created_at FROM follows WHERE user_id = ?').all(userId) as { object_id: string; created_at: number }[]
    for (const f of follows) {
      const o = this.objectsById.get(f.object_id)
      if (o && (o.has_new_data || Date.parse(o.last_seen) > f.created_at)) out.push({ id: `new:${o.id}:${o.last_seen}`, type: 'new_data', ref: o.id, detail: o.last_seen, created_at: Math.max(f.created_at, Date.parse(o.last_seen)), read: false })
    }
    const votes = this.q('SELECT card_id, label, created_at FROM votes WHERE user_id = ? AND counted = 1').all(userId) as { card_id: string; label: string; created_at: number }[]
    for (const v of votes) {
      const s = this.deck.swapCardFor(v.card_id)
      if (s && !s.gold && s.status !== 'open' && s.status !== 'real') out.push({ id: `consensus:${v.card_id}:${s.status}`, type: 'consensus', ref: v.card_id, detail: s.status, created_at: v.created_at, read: false })
    }
    for (const e of this.deck.findings.eventsForAlerts(userId)) out.push({ id: e.id, type: e.followed ? 'finding_followed' : 'finding', ref: e.card_id, detail: e.state, created_at: e.created_at, read: false })
    for (const n of this.deck.findings.noteAlerts(userId)) out.push({ id: `note:${n.card_id}`, type: 'note', ref: n.card_id, detail: 'note', created_at: n.created_at, read: false })
    const badges = this.q('SELECT badge, created_at FROM badges WHERE user_id = ?').all(userId) as { badge: string; created_at: number }[]
    for (const b of badges) out.push({ id: `badge:${b.badge}`, type: 'badge', ref: b.badge, detail: b.badge, created_at: b.created_at, read: false })
    const level = levelFor(this.xp.totalXp(userId)).current
    if (level.level > 1) out.push({ id: `level:${level.level}`, type: 'level', ref: String(level.level), detail: level.key, created_at: this.now(), read: false })
    for (const g of this.goals()) if (g.count >= g.target) out.push({ id: `goal:${g.key}:${g.month}`, type: 'goal', ref: g.key, detail: String(g.target), created_at: this.now(), read: false })
    for (const a of out) a.read = read.has(a.id)
    return out.sort((a, b) => b.created_at - a.created_at)
  }

  markAlertsRead(userId: string, ids: string[]): void {
    const ins = this.q('INSERT OR IGNORE INTO alerts_read (user_id, alert_id, created_at) VALUES (?, ?, ?)')
    this.db.transaction(() => {
      for (const id of ids) ins.run(userId, id, this.now())
    })()
  }

  goals() {
    const d = new Date(this.now())
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const month = new Date(start).toISOString().slice(0, 7)
    const counts = {
      motions: (this.q('SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id, post_id FROM marks WHERE created_at >= ?)').get(start) as { n: number }).n,
      classifications: (this.q('SELECT COUNT(*) AS n FROM votes WHERE counted = 1 AND created_at >= ?').get(start) as { n: number }).n,
      tags: (this.q('SELECT COUNT(*) AS n FROM tags WHERE created_at >= ?').get(start) as { n: number }).n,
    }
    return COMMUNITY_GOALS.map((g) => ({ key: g.key, target: g.target, count: counts[g.key], month }))
  }
}
