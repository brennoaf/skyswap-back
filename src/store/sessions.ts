import { randomBytes, randomUUID } from 'node:crypto'
import { clampTzOffset } from '../gamification.js'
import { hashToken, HttpError, StorePart, type User } from './base.js'

export class Sessions extends StorePart {
  private tz = new Map<string, number>()

  creditVisible(userId: string): boolean {
    return !!(this.q('SELECT credit_visible FROM users WHERE id = ?').get(userId) as { credit_visible: number } | undefined)?.credit_visible
  }

  setCreditVisible(userId: string, visible: boolean): void {
    this.q('UPDATE users SET credit_visible = ? WHERE id = ?').run(visible ? 1 : 0, userId)
  }

  createUser(nickname: string, avatarId?: string): { user: User; token: string } {
    const clean = nickname.trim()
    if (!/^[A-Za-z0-9_.]{3,24}$/.test(clean)) throw new HttpError(400, 'invalid_nickname')
    const exists = this.q('SELECT 1 FROM users WHERE nickname = ?').get(clean)
    if (exists) throw new HttpError(409, 'nickname_taken')
    const user: User = { id: randomUUID(), nickname: clean, created_at: this.now(), avatar: null }
    const token = this.db.transaction(() => {
      this.q("INSERT INTO users (id, nickname, token_hash, created_at) VALUES (?, ?, '', ?)").run(user.id, user.nickname, user.created_at)
      if (avatarId && !this.avatars.choose(user.id, avatarId)) throw new HttpError(409, 'avatar_taken')
      return this.createSession(user.id)
    })()
    return { user: { ...user, avatar: this.avatars.ofUser(user.id) }, token }
  }

  setAvatar(user: User, avatarId: string): User {
    this.db.transaction(() => {
      if (!this.avatars.choose(user.id, avatarId)) throw new HttpError(409, 'avatar_taken')
    })()
    return { ...user, avatar: this.avatars.ofUser(user.id) }
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('hex')
    this.q('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(hashToken(token), userId, this.now())
    return token
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
    const row = this.q('SELECT u.id, u.nickname, u.created_at, u.tz_offset_min FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hashToken(token)) as (User & { tz_offset_min: number }) | undefined
    if (!row) return null
    this.tz.set(row.id, row.tz_offset_min)
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
