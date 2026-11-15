import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Avatars, AvatarDto } from '../avatars.js'
import { prepared, type DB } from '../db.js'
import type { SkySpot } from '../explore.js'
import type { DeckCard, Kit, ObjectSummary, Post } from '../kit.js'
import type { Label } from '../swap.js'

export const TAGS = ['asteroid', 'artifact', 'brightness', 'unsure'] as const
export type Tag = (typeof TAGS)[number]

export const LEARNING_EVENTS = ['band_seen', 'spectrum_opened', 'object_viewed'] as const
export type LearningEvent = (typeof LEARNING_EVENTS)[number]

export interface User {
  id: string
  nickname: string
  created_at: number
  avatar: AvatarDto | null
}

export type Choice = 'moves' | 'still' | 'unsure'
export type NextSlot = { card: DeckCard | null; sky: boolean; spot: SkySpot | null }
export type VotePosition = { frame: number; x: number; y: number }

export const CHOICE_LABEL: Record<Choice, Label> = { moves: 'real', still: 'artifact', unsure: 'unsure' }

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mediaUrl(objectId: string, path: string): string {
  return `/kit/objects/${objectId}/${path}`
}

export function postsForObject(kit: Kit, objectId: string): Post[] {
  return kit.postsByObject.get(objectId) ?? []
}

export interface StoreContext {
  db: DB
  kit: Kit
  now: () => number
  random: () => number
  avatars: Avatars
  objects: Map<string, ObjectSummary>
}

export abstract class StorePart {
  constructor(protected readonly ctx: StoreContext) {}

  protected get db(): DB {
    return this.ctx.db
  }

  protected get kit(): Kit {
    return this.ctx.kit
  }

  protected get avatars(): Avatars {
    return this.ctx.avatars
  }

  protected get objectsById(): Map<string, ObjectSummary> {
    return this.ctx.objects
  }

  protected now(): number {
    return this.ctx.now()
  }

  protected random(): number {
    return this.ctx.random()
  }

  protected q(sql: string): Database.Statement {
    return prepared(this.ctx.db, sql)
  }
}
