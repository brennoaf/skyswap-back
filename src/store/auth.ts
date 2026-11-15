import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { hashToken, HttpError, StorePart, type StoreContext, type User } from './base.js'
import type { Sessions, SessionMeta, SessionVia } from './sessions.js'

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const LINK_TTL_MS = 2 * 60_000
export const LINK_CLAIM_GRACE_MS = 60_000
export const CHALLENGE_TTL_MS = 5 * 60_000
const RECOVERY_GROUPS = 3
const LINK_GROUPS = 2
const SCRYPT_KEYLEN = 32

export type ChallengePurpose = 'register' | 'login'
export type LinkState = { status: 'waiting' } | { status: 'approved'; user: User; token: string }

export interface DeviceRow {
  id: string
  device: string
  via: SessionVia
  created_at: number
  last_seen: number
  current: boolean
  passkey: boolean
}

export interface StoredPasskey {
  id: string
  user_id: string
  public_key: Buffer
  counter: number
  transports: string[]
}

export function makeCode(groups: number): string {
  const parts: string[] = []
  for (let g = 0; g < groups; g++) {
    let part = ''
    for (let i = 0; i < 4; i++) part += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    parts.push(part)
  }
  return parts.join('-')
}

export function normalizeCode(input: string, groups: number): string | null {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length !== groups * 4 || [...clean].some((c) => !CODE_ALPHABET.includes(c))) return null
  return clean.match(/.{4}/g)?.join('-') ?? null
}

function hashSecret(code: string): string {
  const salt = randomBytes(16)
  return `s1$${salt.toString('hex')}$${scryptSync(code, salt, SCRYPT_KEYLEN).toString('hex')}`
}

function secretMatches(code: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 's1' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(code, Buffer.from(salt, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

export class Auth extends StorePart {
  constructor(ctx: StoreContext, private readonly sessions: Sessions) {
    super(ctx)
  }

  sessionId(token: string | undefined): string | null {
    return this.sessions.sessionId(token)
  }

  account(userId: string, token: string | undefined): { passkeys: number; recovery: boolean; answers: number; devices: DeviceRow[] } {
    const current = this.sessions.sessionId(token)
    const devices = (
      this.q(
        'SELECT s.id, s.device, s.via, s.created_at, COALESCE(s.last_seen, s.created_at) AS last_seen, EXISTS (SELECT 1 FROM passkeys p WHERE p.session_id = s.id) AS passkey FROM sessions s WHERE s.user_id = ? ORDER BY COALESCE(s.last_seen, s.created_at) DESC',
      ).all(userId) as (Omit<DeviceRow, 'current' | 'passkey'> & { passkey: number })[]
    ).map((d) => ({ ...d, passkey: !!d.passkey, current: d.id === current }))
    devices.sort((a, b) => Number(b.current) - Number(a.current))
    const passkeys = (this.q('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId) as { n: number }).n
    const recovery = !!this.q('SELECT 1 FROM recovery_codes WHERE user_id = ?').get(userId)
    const answers = (this.q('SELECT COUNT(*) AS n FROM votes WHERE user_id = ? AND practice = 0').get(userId) as { n: number }).n
    return { passkeys, recovery, answers, devices }
  }

  removeDevice(userId: string, id: string, token: string | undefined): { current: boolean } {
    const current = this.sessions.sessionId(token) === id
    return this.db.transaction(() => {
      const gone = this.q('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId)
      if (!gone.changes) throw new HttpError(404, 'unknown_device')
      if (!current) this.q('DELETE FROM passkeys WHERE session_id = ? AND user_id = ?').run(id, userId)
      return { current }
    })()
  }

  saveChallenge(purpose: ChallengePurpose, challenge: string, userId: string | null): string {
    const id = randomBytes(16).toString('hex')
    const now = this.now()
    this.q('DELETE FROM auth_challenges WHERE expires_at < ?').run(now)
    this.q('INSERT INTO auth_challenges (id, purpose, challenge, user_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, purpose, challenge, userId, now + CHALLENGE_TTL_MS)
    return id
  }

  takeChallenge(id: string, purpose: ChallengePurpose, userId: string | null): string {
    const row = this.q('SELECT challenge, user_id, expires_at FROM auth_challenges WHERE id = ? AND purpose = ?').get(id, purpose) as { challenge: string; user_id: string | null; expires_at: number } | undefined
    this.q('DELETE FROM auth_challenges WHERE id = ?').run(id)
    if (!row || row.expires_at < this.now() || row.user_id !== userId) throw new HttpError(400, 'challenge_expired')
    return row.challenge
  }

  passkeysOf(userId: string): { id: string; transports: string[] }[] {
    return (this.q('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId) as { id: string; transports: string | null }[]).map((p) => ({ id: p.id, transports: p.transports ? (JSON.parse(p.transports) as string[]) : [] }))
  }

  addPasskey(userId: string, sessionId: string | null, credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }): void {
    if (this.q('SELECT 1 FROM passkeys WHERE id = ?').get(credential.id)) throw new HttpError(409, 'passkey_exists')
    this.q('INSERT INTO passkeys (id, user_id, public_key, counter, transports, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      credential.id,
      userId,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.length ? JSON.stringify(credential.transports) : null,
      sessionId,
      this.now(),
    )
  }

  passkey(id: string): StoredPasskey | null {
    const row = this.q('SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?').get(id) as (Omit<StoredPasskey, 'transports'> & { transports: string | null }) | undefined
    if (!row) return null
    return { ...row, transports: row.transports ? (JSON.parse(row.transports) as string[]) : [] }
  }

  loginWithPasskey(id: string, counter: number, device: string): { user: User; token: string } {
    return this.db.transaction(() => {
      const key = this.passkey(id)
      if (!key) throw new HttpError(401, 'passkey_unknown')
      const session = this.sessions.openSession(key.user_id, { device, via: 'passkey' })
      this.q('UPDATE passkeys SET counter = ?, last_used = ?, session_id = ? WHERE id = ?').run(counter, this.now(), session.id, id)
      return { user: this.userOf(key.user_id), token: session.token }
    })()
  }

  newRecoveryCode(userId: string): string {
    const code = makeCode(RECOVERY_GROUPS)
    this.q('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at').run(userId, hashSecret(code), this.now())
    return code
  }

  recover(nickname: string, input: string, device: string): { user: User; token: string; code: string } {
    const code = normalizeCode(input, RECOVERY_GROUPS)
    const row = this.q('SELECT u.id, r.code_hash FROM users u JOIN recovery_codes r ON r.user_id = u.id WHERE u.nickname = ?').get(nickname.trim()) as { id: string; code_hash: string } | undefined
    if (!code || !row || !secretMatches(code, row.code_hash)) throw new HttpError(401, 'recovery_failed')
    return this.db.transaction(() => {
      const token = this.sessions.createSession(row.id, { device, via: 'recovery' })
      return { user: this.userOf(row.id), token, code: this.newRecoveryCode(row.id) }
    })()
  }

  createLink(device: string): { code: string; poll: string; expires_at: number } {
    const now = this.now()
    this.q('DELETE FROM device_links WHERE expires_at < ?').run(now - LINK_CLAIM_GRACE_MS)
    const poll = randomBytes(32).toString('hex')
    let code = makeCode(LINK_GROUPS)
    while (this.q('SELECT 1 FROM device_links WHERE code_hash = ?').get(hashToken(code))) code = makeCode(LINK_GROUPS)
    const expires = now + LINK_TTL_MS
    this.q('INSERT INTO device_links (code_hash, poll_hash, device, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hashToken(code), hashToken(poll), device, now, expires)
    return { code, poll, expires_at: expires }
  }

  inspectLink(input: string): { device: string; expires_at: number } {
    const link = this.openLink(input)
    return { device: link.device, expires_at: link.expires_at }
  }

  approveLink(userId: string, input: string): void {
    const link = this.openLink(input)
    const done = this.q('UPDATE device_links SET approved_by = ?, approved_at = ? WHERE code_hash = ? AND approved_by IS NULL').run(userId, this.now(), link.code_hash)
    if (!done.changes) throw new HttpError(409, 'link_used')
  }

  claimLink(poll: string): LinkState {
    const row = this.q('SELECT code_hash, device, expires_at, approved_by, claimed_at FROM device_links WHERE poll_hash = ?').get(hashToken(poll)) as
      | { code_hash: string; device: string; expires_at: number; approved_by: string | null; claimed_at: number | null }
      | undefined
    if (!row) throw new HttpError(404, 'link_not_found')
    if (row.claimed_at !== null) throw new HttpError(409, 'link_used')
    const now = this.now()
    if (!row.approved_by) {
      if (now >= row.expires_at) throw new HttpError(410, 'link_expired')
      return { status: 'waiting' }
    }
    if (now >= row.expires_at + LINK_CLAIM_GRACE_MS) throw new HttpError(410, 'link_expired')
    const userId = row.approved_by
    return this.db.transaction(() => {
      const done = this.q('UPDATE device_links SET claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL').run(now, row.code_hash)
      if (!done.changes) throw new HttpError(409, 'link_used')
      const meta: SessionMeta = { device: row.device, via: 'qr' }
      return { status: 'approved' as const, user: this.userOf(userId), token: this.sessions.createSession(userId, meta) }
    })()
  }

  private openLink(input: string): { code_hash: string; device: string; expires_at: number } {
    const code = normalizeCode(input, LINK_GROUPS)
    const row = code
      ? (this.q('SELECT code_hash, device, expires_at, approved_by FROM device_links WHERE code_hash = ?').get(hashToken(code)) as { code_hash: string; device: string; expires_at: number; approved_by: string | null } | undefined)
      : undefined
    if (!row) throw new HttpError(404, 'link_not_found')
    if (row.approved_by) throw new HttpError(409, 'link_used')
    if (this.now() >= row.expires_at) throw new HttpError(410, 'link_expired')
    return row
  }

  private userOf(userId: string): User {
    const row = this.q('SELECT id, nickname, created_at FROM users WHERE id = ?').get(userId) as Omit<User, 'avatar'>
    return { ...row, avatar: this.avatars.ofUser(userId) }
  }
}
