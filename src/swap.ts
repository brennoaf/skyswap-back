export type Label = 'real' | 'artifact' | 'unsure'
export type CardStatus = 'gold' | 'real' | 'artifact' | 'inconclusive' | 'open'

export const PRIOR = 0.1
export const LR_MIN = 1 / 20
export const LR_MAX = 20
export const RETIRE_REAL_P = 0.95
export const RETIRE_REAL_MIN = 5
export const RETIRE_ART_P = 0.01
export const RETIRE_ART_MIN = 3
export const MAX_VOTES = 15
export const MIN_PHOTOS_TO_CONFIRM = 3

export const logit = (p: number): number => Math.log(p / (1 - p))
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

export class SwapUser {
  seenReal = 0
  hitReal = 0
  seenArt = 0
  hitArt = 0
  votes = 0
  unsure = 0
  bits = 0

  get pR(): number {
    return (this.hitReal + 1) / (this.seenReal + 2)
  }

  get pA(): number {
    return (this.hitArt + 1) / (this.seenArt + 2)
  }

  get goldSeen(): number {
    return this.seenReal + this.seenArt
  }

  get goldAccuracy(): number | null {
    const g = this.goldSeen
    return g === 0 ? null : (this.hitReal + this.hitArt) / g
  }
}

export class SwapCard {
  logOdds = logit(PRIOR)
  nReal = 0
  nArt = 0
  nUnsure = 0

  constructor(readonly gold: 'real' | 'artifact' | null = null) {}

  get pReal(): number {
    return sigmoid(this.logOdds)
  }

  get nVotes(): number {
    return this.nReal + this.nArt + this.nUnsure
  }

  get status(): CardStatus {
    if (this.gold) return 'gold'
    const decisive = this.nReal + this.nArt
    if (this.pReal >= RETIRE_REAL_P && decisive >= RETIRE_REAL_MIN) return 'real'
    if (this.pReal <= RETIRE_ART_P && decisive >= RETIRE_ART_MIN) return 'artifact'
    if (this.nVotes >= MAX_VOTES) return 'inconclusive'
    return 'open'
  }
}

export function voteDelta(user: SwapUser, label: Label): number {
  let lr: number
  if (label === 'real') lr = user.pR / (1 - user.pA)
  else if (label === 'artifact') lr = (1 - user.pR) / user.pA
  else return 0
  return Math.log(Math.min(Math.max(lr, LR_MIN), LR_MAX))
}

export interface VoteOutcome {
  gold: 'real' | 'artifact' | null
  correct: boolean | null
  bits: number
}

export function applyVote(users: Map<string, SwapUser>, cards: Map<string, SwapCard>, userId: string, cardId: string, label: Label): VoteOutcome {
  let u = users.get(userId)
  if (!u) {
    u = new SwapUser()
    users.set(userId, u)
  }
  const c = cards.get(cardId)
  if (!c) throw new Error(`unknown card ${cardId}`)
  u.votes += 1
  if (label === 'unsure') {
    u.unsure += 1
    c.nUnsure += 1
    return { gold: c.gold, correct: null, bits: 0 }
  }
  if (label === 'real') c.nReal += 1
  else c.nArt += 1
  if (c.gold) {
    const correct = label === c.gold
    if (c.gold === 'real') {
      u.seenReal += 1
      u.hitReal += correct ? 1 : 0
    } else {
      u.seenArt += 1
      u.hitArt += correct ? 1 : 0
    }
    return { gold: c.gold, correct, bits: 0 }
  }
  const before = c.logOdds
  c.logOdds += voteDelta(u, label)
  const bits = Math.abs(c.logOdds - before) / Math.log(2)
  u.bits += bits
  return { gold: null, correct: null, bits }
}

export function goldRate(nUserVotes: number): number {
  if (nUserVotes < 10) return 0.5
  if (nUserVotes < 30) return 0.25
  if (nUserVotes < 100) return 0.15
  return 0.1
}
