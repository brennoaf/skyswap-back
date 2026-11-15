import { randomBytes, randomUUID } from 'node:crypto'
import { clampTzOffset } from '../gamification.js'
import { hashToken, HttpError, StorePart, type User } from './base.js'

export type SessionVia = 'nickname' | 'passkey' | 'qr' | 'recovery'
export type SessionMeta = { device?: string; via?: SessionVia }

const SEEN_EVERY_MS = 60 * 60_000

export class Sessions extends StorePart {
  private tz = new Map<string, number>()

  creditVisible(userId: string): boolean {
    return !!(this.q('SELECT credit_visible FROM users WHERE id = ?').get(userId) as { credit_visible: number } | undefined)?.credit_visible
  }

  setCreditVisible(userId: string, visible: boolean): void {
    this.q('UPDATE users SET credit_visible = ? WHERE id = ?').run(visible ? 1 : 0, userId)
  }

  createUser(nickname: string, avatarId?: string, device?: string): { user: User; token: string } {
    const clean = nickname.trim()
    if (!/^[A-Za-z0-9_.]{3,24}$/.test(clean)) throw new HttpError(400, 'invalid_nickname')
    const exists = this.q('SELECT 1 FROM users WHERE nickname = ?').get(clean)
    if (exists) throw new HttpError(409, 'nickname_taken')
    const user: User = { id: randomUUID(), nickname: clean, created_at: this.now(), avatar: null }
    const token = this.db.transaction(() => {
      this.q("INSERT INTO users (id, nickname, token_hash, created_at) VALUES (?, ?, '', ?)").run(user.id, user.nickname, user.created_at)
      if (avatarId && !this.avatars.choose(user.id, avatarId)) throw new HttpError(409, 'avatar_taken')
      return this.createSession(user.id, { device })
    })()
    return { user: { ...user, avatar: this.avatars.ofUser(user.id) }, token }
  }

  setAvatar(user: User, avatarId: string): User {
    this.db.transaction(() => {
      if (!this.avatars.choose(user.id, avatarId)) throw new HttpError(409, 'avatar_taken')
    })()
    return { ...user, avatar: this.avatars.ofUser(user.id) }
  }

  createSession(userId: string, meta: SessionMeta = {}): string {
    return this.openSession(userId, meta).token
  }

  openSession(userId: string, meta: SessionMeta = {}): { token: string; id: string } {
    const token = randomBytes(32).toString('hex')
    const id = randomBytes(9).toString('hex')
    const now = this.now()
    this.q('INSERT INTO sessions (token_hash, user_id, created_at, id, device, via, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hashToken(token), userId, now, id, meta.device ?? 'other:other', meta.via ?? 'nickname', now)
    return { token, id }
  }

  sessionId(token: string | undefined): string | null {
    if (!token) return null
    return (this.q('SELECT id FROM sessions WHERE token_hash = ?').get(hashToken(token)) as { id: string } | undefined)?.id ?? null
  }

  endSession(token: string | undefined): void {
    if (!token) return
    const hash = hashToken(token)
    this.db.transaction(() => {
      this.q('DELETE FROM sessions WHERE token_hash = ?').run(hash)
      this.q("UPDATE users SET token_hash = '' WHERE token_hash = ?").run(hash)
    })()
  }

  userByToken(token: string | undefined): User | null {
    if (!token) return null
    const hash = hashToken(token)
    const row = this.q('SELECT u.id, u.nickname, u.created_at, u.tz_offset_min, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hash) as (User & { tz_offset_min: number; last_seen: number | null }) | undefined
    if (!row) return null
    this.tz.set(row.id, row.tz_offset_min)
    const now = this.now()
    if (row.last_seen === null || now - row.last_seen >= SEEN_EVERY_MS) this.q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash)
    return { id: row.id, nickname: row.nickname, created_at: row.created_at, avatar: this.avatars.ofUser(row.id) }
  }

  setTimezone(userId: string, offsetMin: number): void {
    const offset = clampTzOffset(offsetMin)
    if (this.timezone(userId) === offset) return
    this.q('UPDATE users SET tz_offset_min = ? WHERE id = ?').run(offset, userId)
    this.tz.set(userId, offset)
  }

  timezone(userId: string): number {
    const known = this.tz.get(userId)
    if (known !== undefined) return known
    const row = this.q('SELECT tz_offset_min FROM users WHERE id = ?').get(userId) as { tz_offset_min: number } | undefined
    const offset = row?.tz_offset_min ?? 0
    this.tz.set(userId, offset)
    return offset
  }
}
