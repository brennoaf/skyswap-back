export type XpAction = 'vote' | 'mark' | 'tag' | 'follow' | 'badge'

export const BASE_XP: Record<XpAction, number> = { vote: 2, mark: 5, tag: 1, follow: 1, badge: 10 }
export const MIN_VOTE_MS = 1000
export const DAILY_CAP = 150
export const SOFT_LIMITS: Partial<Record<XpAction, { half: number; zero: number }>> = {
  vote: { half: 40, zero: 80 },
  tag: { half: 20, zero: 40 },
  mark: { half: 10, zero: 20 },
  follow: { half: 10, zero: 20 },
}
export const STREAK_STEP = 5
export const STREAK_MAX_DAYS = 6

export interface DayState {
  day: string
  xpToday: number
  countsToday: Partial<Record<XpAction, number>>
  lastActiveDay: string | null
  streak: number
}

export type XpReason = 'ok' | 'too_fast' | 'daily_cap' | 'diminished' | 'repeat'

export interface XpResult {
  xp: number
  streakBonus: number
  streak: number
  reason: XpReason
}

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function previousDay(day: string): string {
  return dayKey(Date.parse(`${day}T00:00:00Z`) - 86400000)
}

export function nextStreak(lastActiveDay: string | null, streak: number, today: string): number {
  if (lastActiveDay === today) return Math.max(1, streak)
  if (lastActiveDay && previousDay(today) === lastActiveDay) return streak + 1
  return 1
}

export function scoreAction(action: XpAction, state: DayState, opts: { ms?: number; repeat?: boolean } = {}): XpResult {
  const streak = nextStreak(state.lastActiveDay, state.streak, state.day)
  const firstToday = state.lastActiveDay !== state.day
  if (action === 'vote' && (opts.ms ?? Infinity) < MIN_VOTE_MS) return { xp: 0, streakBonus: 0, streak: state.lastActiveDay === state.day ? state.streak : streak, reason: 'too_fast' }
  if (opts.repeat) return { xp: 0, streakBonus: 0, streak, reason: 'repeat' }
  const streakBonus = firstToday ? STREAK_STEP * Math.min(streak, STREAK_MAX_DAYS) : 0
  const count = state.countsToday[action] ?? 0
  const limit = SOFT_LIMITS[action]
  let xp = BASE_XP[action]
  let reason: XpReason = 'ok'
  if (limit && count >= limit.zero) {
    xp = 0
    reason = 'diminished'
  } else if (limit && count >= limit.half) {
    xp = Math.floor(xp / 2)
    reason = 'diminished'
  }
  const room = Math.max(0, DAILY_CAP - state.xpToday)
  const total = Math.min(room, xp + streakBonus)
  if (total < xp + streakBonus) reason = 'daily_cap'
  const bonus = Math.min(streakBonus, total)
  return { xp: total - bonus, streakBonus: bonus, streak, reason }
}

export interface Level {
  level: number
  key: string
  minXp: number
}

export const LEVELS: Level[] = [
  { level: 1, key: 'watcher', minXp: 0 },
  { level: 2, key: 'blinker', minXp: 40 },
  { level: 3, key: 'spotter', minXp: 120 },
  { level: 4, key: 'tracker', minXp: 260 },
  { level: 5, key: 'analyst', minXp: 480 },
  { level: 6, key: 'researcher', minXp: 800 },
]

export type LabTool = 'fov' | 'gaia' | 'wise' | 'flags' | 'pixels' | 'spectrum' | 'lightcurve' | 'notes' | 'export'

export const LAB_UNLOCKS: Record<LabTool, number> = {
  fov: 1,
  gaia: 1,
  wise: 2,
  flags: 2,
  pixels: 3,
  spectrum: 4,
  lightcurve: 4,
  notes: 5,
  export: 6,
}

export function levelFor(xp: number): { current: Level; next: Level | null; progress: number } {
  let current = LEVELS[0] as Level
  for (const l of LEVELS) if (xp >= l.minXp) current = l
  const next = LEVELS.find((l) => l.level === current.level + 1) ?? null
  const progress = next ? (xp - current.minXp) / (next.minXp - current.minXp) : 1
  return { current, next, progress: Math.max(0, Math.min(1, progress)) }
}

export function unlockedTools(level: number, expert: boolean): LabTool[] {
  return (Object.keys(LAB_UNLOCKS) as LabTool[]).filter((t) => expert || LAB_UNLOCKS[t] <= level)
}

export type BadgeKey = 'first_vote' | 'all_colours' | 'first_spectrum' | 'infrared_only' | 'first_motion' | 'too_bright' | 'week_streak'

export const BADGES: BadgeKey[] = ['first_vote', 'first_motion', 'all_colours', 'first_spectrum', 'infrared_only', 'too_bright', 'week_streak']

export const BANDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const

export function sawAllColours(seen: Iterable<string>): boolean {
  const s = new Set(seen)
  return BANDS.every((b) => s.has(b))
}

export const DETECTION_SNR = 8
export const SHORT_BAND_LIMIT_SNR = 10

export type BandStats = Record<string, { snr_pass?: number | null }>

export function isInfraredOnly(bandStats: BandStats | undefined, verdict: string): boolean {
  if (!bandStats || verdict === 'not_detected') return false
  const snr = (b: string) => bandStats[b]?.snr_pass ?? -Infinity
  const long = Math.max(snr('D5'), snr('D6'))
  const short = Math.max(snr('D1'), snr('D2'), snr('D3'), snr('D4'))
  return long >= DETECTION_SNR && short < SHORT_BAND_LIMIT_SNR
}

export interface CommunityGoal {
  key: 'motions' | 'classifications' | 'tags'
  target: number
}

export const COMMUNITY_GOALS: CommunityGoal[] = [
  { key: 'motions', target: 1000 },
  { key: 'classifications', target: 5000 },
  { key: 'tags', target: 2000 },
]
