import { EXAMPLE_PREFIX, Findings, type CrowdMark, type FindingCard } from '../findings.js'
import {
  EXPLORE_ORDER,
  GOLD_CLASS_LEAD,
  KNOWN_GOLD_SHARE,
  mjdIso,
  QUIET_STREAK,
  SKY_QUIET_KEPT,
  SKY_REVISIT_MAX_SPAN_DAYS,
  SKY_REVISIT_PROBE,
  SKY_REVISIT_QUIET_SHARE,
  SKY_REVISIT_SHARE,
  skyCardId,
  skySpot,
  skyVisits,
  WARMUP_CARDS,
  WARMUP_KNOWN_SHARE,
  type SkyCard,
  type SkyFrame,
  type SkySpot,
} from '../explore.js'
import type { BadgeKey, XpResult } from '../gamification.js'
import { ang2pixNest } from '../healpix.js'
import type { DeckCard } from '../kit.js'
import { cleanNote } from '../notes.js'
import { applyVote, goldRate, MAX_VOTES, MIN_PHOTOS_TO_CONFIRM, SwapCard, SwapUser, type CardStatus, type Label } from '../swap.js'
import { CHOICE_LABEL, HttpError, StorePart, type Choice, type NextSlot, type StoreContext, type VotePosition } from './base.js'
import type { Xp } from './xp.js'
import { steadyTrack, type StoredMark } from '../marks.js'

const OUTCOME: Record<string, 'open' | 'moves' | 'still' | 'undecided'> = { open: 'open', real: 'moves', artifact: 'still', inconclusive: 'undecided' }

type Gold = 'real' | 'artifact'

const MY_CARDS_PAGE = 30
const CLOCK_SLACK_MS = 120_000

type VoteTiming = { heldMs?: number; thinkMs?: number; answeredAt?: number }

const CLEAN_STILL_CARD = '7d86b2dc7f97'
const EXAMPLE_CARDS = [
  { example: 'still', id: 'f30fa0536263' },
  { example: 'moves', id: 'cc97c9bb4195' },
  { example: 'particle', id: 'ba2c9d5325f4' },
  { example: 'streak', id: '8e93269ec7ac' },
] as const
const EXAMPLE_IDS: ReadonlySet<string> = new Set(EXAMPLE_CARDS.map((e) => e.id))

export class Deck extends StorePart {
  private swapUsers = new Map<string, SwapUser>()
  private swapCards = new Map<string, SwapCard>()
  private skyCards = new Map<string, SkyCard>()
  readonly findings: Findings
  private deckCells = new Map<string, number>()
  private hotSky = new Set<string>()
  private quietSky = new Set<string>()
  private candidateSky = new Set<string>()

  constructor(ctx: StoreContext, private readonly xp: Xp) {
    super(ctx)
    for (const c of this.kit.deck) this.deckCells.set(c.id, ang2pixNest(EXPLORE_ORDER, c.ra, c.dec))
    this.loadSkyCards()
    this.backfillCells()
    this.rebuildSwap()
    this.findings = new Findings(this.db, () => this.now(), {
      status: (id) => this.cardStatus(id),
      card: (id) => this.findingCard(id),
      positions: (id) => this.votedPositions(id),
      marks: (id) => this.crowdMarks(id),
      spot: (id) => {
        const sky = this.skyCards.get(id)
        return sky ? skySpot(sky) : null
      },
      dataVersion: this.kit.manifest?.version ?? 'unknown',
    })
    this.findings.syncAll(this.swapCards.keys())
  }

  hasSkyCard(id: string): boolean {
    return this.skyCards.has(id)
  }

  inKit(cardId: string): boolean {
    const id = cardId.startsWith(EXAMPLE_PREFIX) ? cardId.slice(EXAMPLE_PREFIX.length) : cardId
    return this.kit.deckById.has(id) || this.skyCards.has(id)
  }

  findingCard(cardId: string): FindingCard | null {
    const deckId = cardId.startsWith(EXAMPLE_PREFIX) ? cardId.slice(EXAMPLE_PREFIX.length) : cardId
    const deck = this.kit.deckById.get(deckId)
    if (deck) {
      if (deck.gold) return null
      const t0 = deck.frames[0]?.mjd ?? 0
      return { id: cardId, kind: 'deck', ra: deck.ra, dec: deck.dec, fov_deg: deck.size_arcmin / 60, band: deck.band.replace('SPHEREx-', ''), mjds: deck.frames.map((f) => f.mjd), sprite: `/kit/deck/${deck.sprite.split('/').pop() ?? ''}`, offsets_s: deck.frames.map((f) => Math.round((f.mjd - t0) * 86400)), known: deck.known ? this.knownName(deck.known.name) : null, size_px: deck.size_px, wcs: deck.wcs ?? null }
    }
    const sky = this.skyCards.get(cardId)
    if (!sky) return null
    const visits = skyVisits(sky.frames)
    const t0 = visits[0]?.mjd ?? 0
    return { id: cardId, kind: 'sky', ra: sky.ra, dec: sky.dec, fov_deg: sky.fov_deg, band: sky.band, mjds: visits.map((v) => v.mjd), sprite: null, offsets_s: visits.map((v) => Math.round((v.mjd - t0) * 86400)), known: null, size_px: sky.size_px, wcs: null }
  }

  crowdMarks(cardId: string): CrowdMark[] {
    const rows = this.q("SELECT user_id, position, positions FROM votes WHERE card_id = ? AND counted = 1 AND label = 'real' AND (track_ok IS NULL OR track_ok = 1) AND (position IS NOT NULL OR positions IS NOT NULL)").all(cardId) as { user_id: string; position: string | null; positions: string | null }[]
    return rows.flatMap((r) => {
      if (r.positions) return (JSON.parse(r.positions) as (StoredMark | null)[]).flatMap((m, frame) => (m ? [{ user: r.user_id, frame, x: m.ax, y: m.ay }] : []))
      const p = JSON.parse(r.position as string) as VotePosition
      return [{ user: r.user_id, ...p }]
    })
  }

  votedPositions(cardId: string): { mjd: number; ra: number; dec: number }[] {
    const sky = this.skyCards.get(cardId)
    if (!sky) return []
    const byFrame = new Map<number, VotePosition[]>()
    for (const p of this.crowdMarks(cardId)) {
      const list = byFrame.get(p.frame)
      if (list) list.push(p)
      else byFrame.set(p.frame, [p])
    }
    const visits = skyVisits(sky.frames)
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0.5
    const out: { mjd: number; ra: number; dec: number }[] = []
    for (const [frame, points] of byFrame) {
      const visit = visits[frame]
      if (!visit) continue
      const dx = (median(points.map((p) => p.x)) - 0.5) * sky.fov_deg
      const dy = (0.5 - median(points.map((p) => p.y))) * sky.fov_deg
      out.push({ mjd: visit.mjd, ra: sky.ra - dx / Math.max(0.01, Math.cos((sky.dec * Math.PI) / 180)), dec: sky.dec + dy })
    }
    return out.sort((a, b) => a.mjd - b.mjd)
  }

  swapCardFor(cardId: string): SwapCard | undefined {
    return this.swapCards.get(cardId)
  }

  seedExampleFindings(): number {
    return this.findings.seedExamples(this.kit.deck.filter((c) => !c.gold).slice(0, 3).map((c) => this.findingCard(c.id)).filter((c): c is FindingCard => !!c))
  }

  myCards(userId: string, cursor: number) {
    const rows = this.q(
      `SELECT v.id, v.card_id, v.label, v.counted, v.practice, v.created_at, f.state AS finding, s.thumb
       FROM votes v LEFT JOIN findings f ON f.card_id = v.card_id LEFT JOIN sky_cards s ON s.id = v.card_id
       WHERE v.user_id = ? AND (? = 0 OR v.id < ?) ORDER BY v.id DESC LIMIT ?`,
    ).all(userId, cursor, cursor, MY_CARDS_PAGE + 1) as { id: number; card_id: string; label: string; counted: number; practice: number; created_at: number; finding: string | null; thumb: string | null }[]
    const page = rows.slice(0, MY_CARDS_PAGE)
    const items = page.map((v) => {
      const practice = v.practice === 1
      const quiet = !v.counted || !!this.swapCards.get(v.card_id)?.gold
      const deck = this.kit.deckById.get(v.card_id)
      const retired = !deck && !this.skyCards.has(v.card_id)
      return { card_id: v.card_id, label: v.label, created_at: v.created_at, practice, finding: practice || quiet || retired ? null : v.finding, thumb: deck ? `/kit/deck/${deck.sprite.split('/').pop() ?? ''}` : v.thumb, thumb_cols: deck ? deck.n_frames : 0, retired }
    })
    return { items, next_cursor: rows.length > MY_CARDS_PAGE ? (page[page.length - 1]?.id ?? null) : null }
  }

  myCard(userId: string, cardId: string) {
    const vote = this.q('SELECT label, note FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { label: string; note: string | null } | undefined
    if (!vote) throw new HttpError(404, 'not_answered')
    const choice: Choice = vote.label === 'real' ? 'moves' : vote.label === 'artifact' ? 'still' : 'unsure'
    const card = this.kit.deckById.get(cardId)
    const sky = this.skyCards.get(cardId)
    if (!card && !sky) throw new HttpError(404, 'card_retired')
    const reveal = card ? this.reveal(card, null, choice) : this.skyReveal(sky as SkyCard, choice)
    return { label: vote.label, reveal: { ...reveal, control: null, marks: [] }, note: vote.note, note_editable: vote.label === 'real' && this.isFirstYes(userId, cardId) && !this.findings.stateOf(cardId) }
  }

  setNote(userId: string, cardId: string, raw: string | null): string | null {
    const vote = this.q('SELECT label FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { label: string } | undefined
    if (!vote || vote.label !== 'real') throw new HttpError(404, 'not_answered')
    if (!this.isFirstYes(userId, cardId)) throw new HttpError(403, 'not_first')
    if (this.findings.stateOf(cardId)) throw new HttpError(409, 'note_locked')
    const note = cleanNote(raw)
    if (note === 'invalid') throw new HttpError(400, 'invalid_note')
    this.q('UPDATE votes SET note = ? WHERE user_id = ? AND card_id = ?').run(note, userId, cardId)
    return note
  }

  private loadSkyCards(): void {
    const rows = this.q('SELECT id, ra, dec, fov_deg, band, cell, size_px, frames, created_at FROM sky_cards').all() as (Omit<SkyCard, 'frames'> & { frames: string })[]
    for (const r of rows) this.skyCards.set(r.id, { ...r, frames: JSON.parse(r.frames) as SkyFrame[] })
  }

  private backfillCells(): void {
    const upd = this.q('UPDATE votes SET cell = ? WHERE card_id = ? AND cell IS NULL')
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

  registerSkyCard(userId: string, input: { ra: number; dec: number; fov_deg: number; band: string; size_px: number; frames: SkyFrame[]; thumb?: string }): SkyCard {
    const ra = Math.round((((input.ra % 360) + 360) % 360) * 1e4) / 1e4
    const dec = Math.round(input.dec * 1e4) / 1e4
    const id = skyCardId(ra, dec, input.fov_deg, input.band)
    let card = this.skyCards.get(id)
    if (!card) {
      if (skyVisits(input.frames).length < MIN_PHOTOS_TO_CONFIRM) throw new HttpError(400, 'need_three_visits')
      const frames = [...input.frames].sort((a, b) => a.mjd - b.mjd)
      card = { id, ra, dec, fov_deg: input.fov_deg, band: input.band, cell: ang2pixNest(EXPLORE_ORDER, ra, dec), size_px: input.size_px, frames, created_at: this.now() }
      this.q('INSERT OR IGNORE INTO sky_cards (id, ra, dec, fov_deg, band, cell, size_px, frames, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ra, dec, card.fov_deg, card.band, card.cell, card.size_px, JSON.stringify(frames), userId, card.created_at)
      this.skyCards.set(id, card)
      this.swapCards.set(id, new SwapCard(null))
    }
    if (!this.q('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, id)) this.issueCard(userId, id)
    if (input.thumb) this.q('UPDATE sky_cards SET thumb = ? WHERE id = ? AND thumb IS NULL').run(input.thumb, id)
    return card
  }

  rebuildSwap(): void {
    this.swapUsers = new Map()
    this.swapCards = new Map(this.kit.deck.map((c) => [c.id, new SwapCard(c.gold ?? null)]))
    for (const id of this.skyCards.keys()) this.swapCards.set(id, new SwapCard(null))
    const rows = this.q('SELECT user_id, card_id, label FROM votes WHERE counted = 1 ORDER BY id').all() as { user_id: string; card_id: string; label: Label }[]
    for (const r of rows) if (this.swapCards.has(r.card_id)) applyVote(this.swapUsers, this.swapCards, r.user_id, r.card_id, r.label)
    this.hotSky = new Set()
    this.quietSky = new Set()
    this.candidateSky = new Set()
    for (const id of this.skyCards.keys()) this.trackSky(id)
  }

  private trackSky(id: string): void {
    const s = this.swapCards.get(id)
    if (!s || !this.skyCards.has(id)) return
    const status = this.cardStatus(id)
    const open = status === 'open'
    if (status === 'real') this.candidateSky.add(id)
    else this.candidateSky.delete(id)
    const card = this.skyCards.get(id)
    const mjds = card ? card.frames.map((f) => f.mjd) : []
    const again = open && !!card && skyVisits(card.frames).length >= MIN_PHOTOS_TO_CONFIRM && Math.max(...mjds) - Math.min(...mjds) <= SKY_REVISIT_MAX_SPAN_DAYS
    if (again && s.nReal > 0) this.hotSky.add(id)
    else this.hotSky.delete(id)
    this.quietSky.delete(id)
    if (!again || s.nReal > 0 || s.nVotes === 0) return
    this.quietSky.add(id)
    while (this.quietSky.size > SKY_QUIET_KEPT) {
      const oldest = this.quietSky.values().next()
      if (oldest.done) break
      this.quietSky.delete(oldest.value)
    }
  }

  private quietStreak(userId: string): boolean {
    const last = this.q('SELECT card_id, label FROM votes WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, QUIET_STREAK) as { card_id: string; label: string }[]
    return last.length === QUIET_STREAK && last.every((v) => this.skyCards.has(v.card_id) && v.label === 'artifact')
  }

  private deckSeen(userId: string, extra: string[] = []): Set<string> {
    const seen = new Set(extra)
    for (const r of this.q("SELECT card_id FROM votes WHERE user_id = ? AND (card_id < 'sky-' OR card_id >= 'sky.')").all(userId) as { card_id: string }[]) seen.add(r.card_id)
    for (const r of this.q('SELECT card_id FROM card_issues WHERE user_id = ? AND guided = 1').all(userId) as { card_id: string }[]) seen.add(r.card_id)
    for (const id of this.findings.exposedCards(userId)) seen.add(id)
    return seen
  }

  private voteCount(userId: string): number {
    return (this.q('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?').get(userId) as { n: number }).n
  }

  private servable(card: DeckCard): boolean {
    return !EXAMPLE_IDS.has(card.id) && card.n_frames >= (this.kit.manifest.deck_min_frames ?? 0)
  }

  private isOpenDeckCard(card: DeckCard, seen: Set<string>): boolean {
    return !card.gold && this.servable(card) && !seen.has(card.id) && this.cardStatus(card.id) === 'open'
  }

  private canClose(card: DeckCard, seen: Set<string>): boolean {
    return card.n_frames >= MIN_PHOTOS_TO_CONFIRM && this.isOpenDeckCard(card, seen)
  }

  openCards(userId: string | null): number {
    const seen = userId ? this.deckSeen(userId) : new Set<string>()
    let n = 0
    for (const c of this.kit.deck) if (this.canClose(c, seen)) n += 1
    return n
  }

  next(userId: string, opts: { explore?: boolean; known?: boolean; open?: boolean; not?: string[] } = {}): NextSlot {
    const seen = this.deckSeen(userId, opts.not)
    const n = this.voteCount(userId)
    const canExplore = !!opts.explore && !opts.known && this.kit.indexCells.length > 0
    if (opts.open && this.kit.deck.some((c) => this.canClose(c, seen))) return { card: this.pickKnown(userId, seen, goldRate(n), false, true), sky: false, spot: null }
    if (opts.explore && this.quietStreak(userId)) {
      const movers = this.kit.deck.filter((c) => c.kind === 'mover' && c.gold === 'real' && !seen.has(c.id) && this.servable(c))
      const pick = movers[Math.floor(this.random() * movers.length)]
      if (pick) {
        this.issueCard(userId, pick.id)
        return { card: pick, sky: false, spot: null }
      }
    }
    const warm = n < WARMUP_CARDS
    if (canExplore) {
      const knownShare = warm ? WARMUP_KNOWN_SHARE : Math.min(1, goldRate(n) / KNOWN_GOLD_SHARE)
      if (this.random() >= knownShare) return this.skySlot(userId)
    }
    const card = this.pickKnown(userId, seen, canExplore && !warm ? KNOWN_GOLD_SHARE : goldRate(n), canExplore)
    if (!card && canExplore) return this.skySlot(userId)
    return { card, sky: false, spot: null }
  }

  nextCard(userId: string): DeckCard | null {
    return this.pickKnown(userId, this.deckSeen(userId), goldRate(this.voteCount(userId)), false)
  }

  private pickKnown(userId: string, seen: Set<string>, goldShare: number, hasSky: boolean, closable = false): DeckCard | null {
    const gold: Record<Gold, DeckCard[]> = { real: [], artifact: [] }
    const served: Record<Gold, number> = { real: 0, artifact: 0 }
    const open: DeckCard[] = []
    for (const c of this.kit.deck) {
      if (!this.servable(c)) continue
      if (!c.gold) {
        if (closable ? this.canClose(c, seen) : this.isOpenDeckCard(c, seen)) open.push(c)
      } else if (seen.has(c.id)) served[c.gold] += 1
      else gold[c.gold].push(c)
    }
    const wantGold = gold.real.length + gold.artifact.length > 0 && this.random() < goldShare
    let pool: DeckCard[] = wantGold || !open.length ? this.goldPool(gold, served, hasSky || open.length > 0) : []
    if (!pool.length && open.length) {
      const votes = (c: DeckCard) => this.swapCards.get(c.id)?.nVotes ?? 0
      const least = Math.min(...open.map(votes))
      pool = open.filter((c) => votes(c) <= least + 1)
    }
    const card = pool[Math.floor(this.random() * pool.length)] ?? null
    if (card) this.issueCard(userId, card.id)
    return card
  }

  private goldPool(gold: Record<Gold, DeckCard[]>, served: Record<Gold, number>, balanced: boolean): DeckCard[] {
    const other = (g: Gold): Gold => (g === 'real' ? 'artifact' : 'real')
    const first: Gold = served.real < served.artifact ? 'real' : served.artifact < served.real ? 'artifact' : this.random() < 0.5 ? 'real' : 'artifact'
    for (const g of [first, other(first)]) if (gold[g].length && (!balanced || !gold[other(g)].length || served[g] - served[other(g)] < GOLD_CLASS_LEAD)) return gold[g]
    return []
  }

  private skySlot(userId: string): NextSlot {
    return { card: null, sky: true, spot: this.random() < SKY_REVISIT_SHARE ? this.revisit(userId) : null }
  }

  private revisit(userId: string): SkySpot | null {
    const p = (id: string) => this.swapCards.get(id)?.pReal ?? 0
    const votes = (id: string) => this.swapCards.get(id)?.nVotes ?? 0
    const hot = () => [...this.hotSky].sort((a, b) => p(b) - p(a) || votes(b) - votes(a)).slice(0, SKY_REVISIT_PROBE)
    const quiet = () => {
      const ids = [...this.quietSky]
      const start = Math.floor(this.random() * ids.length)
      return [...ids.slice(start), ...ids.slice(0, start)].slice(0, SKY_REVISIT_PROBE)
    }
    const taken = this.q('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ? UNION ALL SELECT 1 FROM card_issues WHERE user_id = ? AND card_id = ? LIMIT 1')
    for (const pool of this.random() < SKY_REVISIT_QUIET_SHARE ? [quiet, hot] : [hot, quiet]) {
      for (const id of pool()) {
        const card = this.skyCards.get(id)
        if (!card || taken.get(userId, id, userId, id)) continue
        this.issueCard(userId, id)
        return skySpot(card)
      }
    }
    return null
  }

  issueCard(userId: string, cardId: string, guided = false, shared = false): void {
    this.q('INSERT INTO card_issues (user_id, card_id, issued_at, guided, shared) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, card_id) DO UPDATE SET issued_at = excluded.issued_at, guided = MAX(card_issues.guided, excluded.guided), shared = excluded.shared')
      .run(userId, cardId, this.now(), guided ? 1 : 0, shared ? 1 : 0)
    this.q('INSERT OR IGNORE INTO card_firsts (user_id, card_id, first_at) VALUES (?, ?, ?)').run(userId, cardId, this.now())
  }

  sharedCard(userId: string, cardId: string): { card: DeckCard; answered: 'moves' | 'still' | 'glitch' | 'unsure' | null } | null {
    const card = this.kit.deckById.get(cardId)
    if (!card || !this.servable(card)) return null
    const past = this.q('SELECT label, glitch FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { label: Label; glitch: number | null } | undefined
    if (past) return { card, answered: past.glitch ? 'glitch' : past.label === 'real' ? 'moves' : past.label === 'artifact' ? 'still' : 'unsure' }
    this.issueCard(userId, cardId, false, true)
    return { card, answered: null }
  }

  guideLessons(userId: string): { lesson: 'moves' | 'still' | 'glitch'; card: DeckCard }[] {
    const voted = new Set((this.q("SELECT card_id FROM votes WHERE user_id = ? AND (card_id < 'sky-' OR card_id >= 'sky.')").all(userId) as { card_id: string }[]).map((r) => r.card_id))
    const issued = new Set((this.q('SELECT card_id FROM card_issues WHERE user_id = ? AND guided = 1').all(userId) as { card_id: string }[]).map((r) => r.card_id))
    const jump = (c: DeckCard) => {
      const [a, b] = c.marks ?? []
      return a && b ? Math.hypot(a.u - b.u, a.v - b.v) : 0
    }
    const snr = (c: DeckCard) => c.pipeline.snr ?? 0
    const pick = (test: (c: DeckCard) => boolean, order: (a: DeckCard, b: DeckCard) => number) => this.kit.deck.filter((c) => test(c) && !voted.has(c.id) && this.servable(c)).sort((a, b) => Number(issued.has(b.id)) - Number(issued.has(a.id)) || order(a, b))[0]
    const plan = [
      { lesson: 'moves' as const, card: pick((c) => c.kind === 'mover' && c.gold === 'real' && (c.marks?.length ?? 0) >= 2, (a, b) => a.n_frames - b.n_frames || jump(b) - jump(a)) },
      { lesson: 'still' as const, card: pick((c) => c.kind === 'residual' && c.gold === 'artifact', (a, b) => Number(b.id === CLEAN_STILL_CARD) - Number(a.id === CLEAN_STILL_CARD) || snr(b) - snr(a)) },
      { lesson: 'glitch' as const, card: pick((c) => c.kind === 'single' && c.gold === 'artifact', (a, b) => a.n_frames - b.n_frames || snr(b) - snr(a)) },
    ]
    return plan.flatMap((p) => {
      if (!p.card) return []
      this.issueCard(userId, p.card.id, true)
      return [{ lesson: p.lesson, card: p.card }]
    })
  }

  guideExamples(): { example: (typeof EXAMPLE_CARDS)[number]['example']; card: DeckCard }[] {
    return EXAMPLE_CARDS.flatMap((e) => {
      const card = this.kit.deckById.get(e.id)
      return card ? [{ example: e.example, card }] : []
    })
  }

  cardShown(userId: string, cardId: string): void {
    this.q('UPDATE card_issues SET issued_at = ? WHERE user_id = ? AND card_id = ?').run(this.now(), userId, cardId)
  }

  private isShared(userId: string, cardId: string): boolean {
    const row = this.q('SELECT shared FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { shared: number } | undefined
    return row?.shared === 1
  }

  private isGuided(userId: string, cardId: string): boolean {
    const row = this.q('SELECT guided FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { guided: number } | undefined
    return row?.guided === 1
  }

  private elapsedSinceIssue(userId: string, cardId: string): number {
    const issue = this.q('SELECT issued_at FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { issued_at: number } | undefined
    if (!issue) throw new HttpError(409, 'card_not_issued')
    const last = this.q('SELECT MAX(created_at - COALESCE(held_ms, 0)) AS t FROM votes WHERE user_id = ?').get(userId) as { t: number | null }
    return Math.max(0, this.now() - Math.max(issue.issued_at, last.t ?? -Infinity))
  }

  private lookTime(userId: string, cardId: string, meta: VoteTiming): { ms: number; heldMs: number; answeredAt: number | null } {
    if (meta.thinkMs === undefined || meta.answeredAt === undefined) {
      const elapsed = this.elapsedSinceIssue(userId, cardId)
      const heldMs = Math.min(elapsed, Math.max(0, meta.heldMs ?? 0))
      return { ms: elapsed - heldMs, heldMs, answeredAt: null }
    }
    if (!this.q('SELECT 1 FROM card_issues WHERE user_id = ? AND card_id = ?').get(userId, cardId)) throw new HttpError(409, 'card_not_issued')
    const heldMs = Math.max(0, meta.heldMs ?? 0)
    const answeredAt = meta.answeredAt
    const first = this.q('SELECT first_at FROM card_firsts WHERE user_id = ? AND card_id = ?').get(userId, cardId) as { first_at: number } | undefined
    const last = this.q('SELECT MAX(answered_at) AS t FROM votes WHERE user_id = ?').get(userId) as { t: number | null }
    const fits = answeredAt <= this.now() + CLOCK_SLACK_MS && (!first || answeredAt - meta.thinkMs >= first.first_at - CLOCK_SLACK_MS) && (last.t === null || answeredAt > last.t)
    if (!fits) return { ms: 0, heldMs, answeredAt: null }
    const gap = last.t === null ? Infinity : answeredAt - last.t
    return { ms: Math.max(0, Math.min(meta.thinkMs, gap)), heldMs, answeredAt }
  }

  vote(userId: string, cardId: string, choice: Choice, glitch: boolean | null = null, single: VotePosition | null = null, meta: VoteTiming & { hints?: boolean | null; marks?: (StoredMark | null)[] } = {}) {
    const card = this.kit.deckById.get(cardId)
    const sky = card ? undefined : this.skyCards.get(cardId)
    if (!card && !sky) throw new HttpError(404, 'unknown_card')
    const frameTimes = card ? card.frames.map((f) => f.mjd * 24) : skyVisits((sky as SkyCard).frames).map((v) => v.mjd * 24)
    const marks = meta.marks ?? null
    if (marks && (choice !== 'moves' || marks.length !== frameTimes.length || marks.filter(Boolean).length < 2)) throw new HttpError(400, 'invalid_position')
    if (single && (choice !== 'moves' || single.frame >= frameTimes.length)) throw new HttpError(400, 'invalid_position')
    const firstMark = marks ? marks.findIndex(Boolean) : -1
    const position: VotePosition | null = marks ? { frame: firstMark, x: (marks[firstMark] as StoredMark).ax, y: (marks[firstMark] as StoredMark).ay } : single
    const trackOk = marks ? steadyTrack(marks, frameTimes) : null
    const label = CHOICE_LABEL[choice]
    const { xp, counted, guided, first, newBadges } = this.db.transaction(() => {
      if (this.q('SELECT 1 FROM votes WHERE user_id = ? AND card_id = ?').get(userId, cardId)) throw new HttpError(409, 'already_voted')
      const { ms, heldMs, answeredAt } = this.lookTime(userId, cardId, meta)
      const guided = this.isGuided(userId, cardId)
      const shared = this.isShared(userId, cardId)
      const exposed = this.findings.isExposed(userId, cardId)
      const xp: XpResult = guided ? { xp: 0, streakBonus: 0, streak: 0, reason: 'guided' } : exposed ? { xp: 0, streakBonus: 0, streak: 0, reason: 'exposed' } : this.xp.award(userId, 'vote', cardId, { ms })
      const counted = !guided && !exposed && xp.reason !== 'too_fast'
      const none = !this.q("SELECT 1 FROM votes WHERE card_id = ? AND counted = 1 AND label = 'real'").get(cardId)
      this.q('INSERT INTO votes (user_id, card_id, label, ms, counted, created_at, glitch, cell, position, hints, held_ms, via, practice, answered_at, positions, track_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        userId,
        cardId,
        label,
        ms,
        counted ? 1 : 0,
        this.now(),
        glitch === null ? null : glitch ? 1 : 0,
        this.cellOf(cardId),
        position ? JSON.stringify(position) : null,
        meta.hints === undefined || meta.hints === null ? null : meta.hints ? 1 : 0,
        heldMs,
        shared ? 'share' : null,
        guided ? 1 : 0,
        answeredAt,
        marks ? JSON.stringify(marks) : null,
        trackOk === null ? null : trackOk ? 1 : 0,
      )
      this.q('DELETE FROM card_issues WHERE user_id = ? AND card_id = ?').run(userId, cardId)
      const newBadges: BadgeKey[] = []
      if (counted && this.xp.grantBadge(userId, 'first_vote')) newBadges.push('first_vote')
      return { xp, counted, guided, first: counted && label === 'real' && none && !card?.known, newBadges }
    })()
    const gold = card?.gold ?? null
    let outcome = { gold, correct: null as boolean | null, bits: 0 }
    if (counted) {
      outcome = applyVote(this.swapUsers, this.swapCards, userId, cardId, label)
      this.trackSky(cardId)
      this.findings.sync(cardId)
    } else if (gold && label !== 'unsure') outcome.correct = label === gold
    const reveal = card ? this.reveal(card, outcome.correct, choice) : this.skyReveal(sky as SkyCard, choice)
    return { xp, counted, guided, reveal, newBadges, first }
  }

  private isFirstYes(userId: string, cardId: string): boolean {
    if (this.kit.deckById.get(cardId)?.known) return false
    const row = this.q("SELECT user_id FROM votes WHERE card_id = ? AND counted = 1 AND label = 'real' ORDER BY id LIMIT 1").get(cardId) as { user_id: string } | undefined
    return row?.user_id === userId
  }

  skyStatus(id: string): string {
    const s = this.swapCards.get(id)
    if (!s) return 'open'
    const status = this.cardStatus(id) ?? 'open'
    return status === 'real' ? 'candidate' : status
  }

  photosOf(id: string): number {
    const deck = this.kit.deckById.get(id)
    if (deck) return deck.n_frames
    const sky = this.skyCards.get(id)
    return sky ? skyVisits(sky.frames).length : 0
  }

  cardStatus(id: string): CardStatus | undefined {
    const s = this.swapCards.get(id)
    if (!s) return undefined
    if (s.status === 'real' && this.photosOf(id) < MIN_PHOTOS_TO_CONFIRM) return s.nVotes >= MAX_VOTES ? 'inconclusive' : 'open'
    return s.status
  }

  skyReveal(card: SkyCard, choice: Choice) {
    const s = this.swapCards.get(card.id) ?? new SwapCard(null)
    const looked = (this.q('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE card_id = ?').get(card.id) as { n: number }).n
    return {
      your_choice: choice,
      looked,
      outcome: OUTCOME[this.cardStatus(card.id) ?? 'open'] ?? 'open',
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
    for (const id of this.candidateSky) {
      const card = this.skyCards.get(id)
      const s = this.swapCards.get(id)
      if (!card || !s) continue
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
    const rows = this.q('SELECT cell, COUNT(*) AS n FROM votes WHERE cell IS NOT NULL GROUP BY cell').all() as { cell: number; n: number }[]
    const people = (this.q('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE cell IS NOT NULL').get() as { n: number }).n
    const mine = userId ? (this.q('SELECT COUNT(DISTINCT cell) AS n FROM votes WHERE user_id = ? AND cell IS NOT NULL').get(userId) as { n: number }).n : 0
    const myLooks = userId ? (this.q('SELECT COUNT(*) AS n FROM votes WHERE user_id = ? AND cell IS NOT NULL').get(userId) as { n: number }).n : 0
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
    const r = this.q('UPDATE votes SET glitch = ? WHERE user_id = ? AND card_id = ?').run(glitch === null ? null : glitch ? 1 : 0, userId, cardId)
    if (r.changes === 0) throw new HttpError(404, 'no_vote')
  }

  private knownObject(name: string) {
    return this.kit.objects.find((o) => o.name === name || o.name.startsWith(`${name} `) || o.aliases.includes(name)) ?? null
  }

  private knownName(name: string): string {
    return this.knownObject(name)?.name ?? name
  }

  reveal(card: DeckCard, correct: boolean | null, choice: Choice) {
    const s = this.swapCards.get(card.id) ?? new SwapCard(card.gold ?? null)
    const looked = (this.q('SELECT COUNT(DISTINCT user_id) AS n FROM votes WHERE card_id = ?').get(card.id) as { n: number }).n
    return {
      your_choice: choice,
      looked,
      outcome: card.gold ? null : OUTCOME[this.cardStatus(card.id) ?? 'open'] ?? 'open',
      kind: card.kind,
      band: card.band.replace('SPHEREx-', ''),
      size_arcmin: card.size_arcmin,
      tile: card.tile,
      size_px: card.size_px,
      frames: card.frames.map((f) => ({ t: f.t, mjd: f.mjd, n_exp: f.n_exp, wl_min: f.wl_min, wl_max: f.wl_max })),
      known: card.known ? { name: this.knownName(card.known.name), object_id: this.knownObject(card.known.name)?.id ?? null, V: card.known.V ?? null, rate_arcsec_h: card.known.rate_arcsec_h ?? null } : null,
      rate_arcsec_h: card.rate_arcsec_h ?? null,
      ra: card.ra,
      dec: card.dec,
      marks: card.marks ?? [],
      control: card.gold ? { truth: card.gold, correct } : null,
      p_real: card.gold ? null : Math.round(s.pReal * 1000) / 1000,
      votes: { real: s.nReal, artifact: s.nArt, unsure: s.nUnsure },
      status: this.cardStatus(card.id) ?? s.status,
    }
  }

  voteWeight(userId: string): { pR: number; pA: number } {
    const u = this.swapUsers.get(userId) ?? new SwapUser()
    return { pR: u.pR, pA: u.pA }
  }
}
