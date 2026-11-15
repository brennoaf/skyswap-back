import {
  BADGES,
  DAILY_CAP,
  dayKey,
  INACTIVE_REASONS,
  isInfraredOnly,
  levelFor,
  LEVELS,
  sawAllColours,
  scoreAction,
  type BadgeKey,
  type DayState,
  type XpAction,
  type XpResult,
} from '../gamification.js'
import { HttpError, StorePart, type LearningEvent, type StoreContext, type User } from './base.js'
import type { Sessions } from './sessions.js'

export class Xp extends StorePart {
  constructor(ctx: StoreContext, private readonly sessions: Sessions) {
    super(ctx)
  }

  today(userId: string): string {
    return dayKey(this.now(), this.sessions.timezone(userId))
  }

  private dayState(userId: string): DayState {
    const day = this.today(userId)
    const today = this.q("SELECT action, COUNT(*) AS n, SUM(xp + streak_bonus) AS xp FROM xp_events WHERE user_id = ? AND day = ? AND reason NOT IN ('too_fast', 'repeat') GROUP BY action").all(userId, day) as {
      action: XpAction
      n: number
      xp: number
    }[]
    const last = this.q("SELECT day, streak FROM xp_events WHERE user_id = ? AND reason NOT IN ('too_fast', 'repeat') ORDER BY id DESC LIMIT 1").get(userId) as { day: string; streak: number } | undefined
    const countsToday: DayState['countsToday'] = {}
    let xpToday = 0
    for (const r of today) {
      countsToday[r.action] = r.n
      xpToday += r.xp ?? 0
    }
    return { day, xpToday, countsToday, lastActiveDay: last?.day ?? null, streak: last?.streak ?? 0 }
  }

  award(userId: string, action: XpAction, ref: string | null, opts: { ms?: number } = {}): XpResult {
    const repeat = ref !== null && action !== 'vote' && !!this.q('SELECT 1 FROM xp_events WHERE user_id = ? AND action = ? AND ref = ? LIMIT 1').get(userId, action, ref)
    const result = scoreAction(action, this.dayState(userId), { ms: opts.ms, repeat })
    this.q('INSERT INTO xp_events (user_id, action, ref, xp, streak_bonus, streak, reason, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, action, ref, result.xp, result.streakBonus, result.streak, result.reason, this.today(userId), this.now())
    if (result.streak >= 7 && !INACTIVE_REASONS.includes(result.reason)) this.grantBadge(userId, 'week_streak')
    return result
  }

  grantBadge(userId: string, badge: BadgeKey, withXp = true): boolean {
    const r = this.q('INSERT OR IGNORE INTO badges (user_id, badge, created_at) VALUES (?, ?, ?)').run(userId, badge, this.now())
    if (r.changes === 0) return false
    if (withXp) this.award(userId, 'badge', badge)
    return true
  }

  totalXp(userId: string): number {
    const r = this.q('SELECT COALESCE(SUM(xp + streak_bonus), 0) AS xp FROM xp_events WHERE user_id = ?').get(userId) as { xp: number }
    return r.xp
  }

  learn(userId: string, event: LearningEvent, ref: string): BadgeKey[] {
    const earned: BadgeKey[] = []
    if (event === 'band_seen') {
      if (!/^D[1-6]$/.test(ref)) throw new HttpError(400, 'invalid_band')
    } else if (!this.objectsById.has(ref) && !this.kit.postsById.has(ref)) throw new HttpError(404, 'unknown_ref')
    this.q('INSERT OR IGNORE INTO learning (user_id, event, ref, created_at) VALUES (?, ?, ?, ?)').run(userId, event, ref, this.now())
    if (event === 'band_seen') {
      const seen = (this.q("SELECT ref FROM learning WHERE user_id = ? AND event = 'band_seen'").all(userId) as { ref: string }[]).map((r) => r.ref)
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
    const badges = this.q('SELECT badge, created_at FROM badges WHERE user_id = ? ORDER BY created_at').all(user.id) as { badge: BadgeKey; created_at: number }[]
    const count = (sql: string) => (this.q(sql).get(user.id) as { n: number }).n
    const streak = st.lastActiveDay === st.day || (st.lastActiveDay && Date.parse(st.day) - Date.parse(st.lastActiveDay) <= 86400000) ? st.streak : 0
    return {
      user: { id: user.id, nickname: user.nickname, created_at: user.created_at, avatar: user.avatar },
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
}
