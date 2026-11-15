import { Avatars } from './avatars.js'
import type { DB } from './db.js'
import type { Findings } from './findings.js'
import type { Kit, ObjectSummary } from './kit.js'
import { Deck } from './store/deck.js'
import { Sessions } from './store/sessions.js'
import { Social } from './store/social.js'
import { Xp } from './store/xp.js'

export * from './store/base.js'

export class Store {
  readonly avatars: Avatars
  readonly findings: Findings
  private readonly objects: Map<string, ObjectSummary>
  private readonly sessions: Sessions
  private readonly xp: Xp
  private readonly deck: Deck
  private readonly social: Social

  constructor(readonly db: DB, readonly kit: Kit, now: () => number = Date.now, random: () => number = Math.random) {
    this.avatars = new Avatars(db, now)
    this.objects = new Map(kit.objects.map((o) => [o.id, o]))
    const ctx = { db, kit, now, random, avatars: this.avatars, objects: this.objects }
    this.sessions = new Sessions(ctx)
    this.xp = new Xp(ctx, this.sessions)
    this.deck = new Deck(ctx, this.xp)
    this.social = new Social(ctx, this.xp, this.deck)
    this.findings = this.deck.findings
  }

  object(id: string): ObjectSummary | undefined {
    return this.objects.get(id)
  }

  creditVisible(...args: Parameters<Sessions['creditVisible']>) {
    return this.sessions.creditVisible(...args)
  }

  setCreditVisible(...args: Parameters<Sessions['setCreditVisible']>) {
    return this.sessions.setCreditVisible(...args)
  }

  createUser(...args: Parameters<Sessions['createUser']>) {
    return this.sessions.createUser(...args)
  }

  setAvatar(...args: Parameters<Sessions['setAvatar']>) {
    return this.sessions.setAvatar(...args)
  }

  createSession(...args: Parameters<Sessions['createSession']>) {
    return this.sessions.createSession(...args)
  }

  endSession(...args: Parameters<Sessions['endSession']>) {
    return this.sessions.endSession(...args)
  }

  userByToken(...args: Parameters<Sessions['userByToken']>) {
    return this.sessions.userByToken(...args)
  }

  setTimezone(...args: Parameters<Sessions['setTimezone']>) {
    return this.sessions.setTimezone(...args)
  }

  timezone(...args: Parameters<Sessions['timezone']>) {
    return this.sessions.timezone(...args)
  }

  award(...args: Parameters<Xp['award']>) {
    return this.xp.award(...args)
  }

  grantBadge(...args: Parameters<Xp['grantBadge']>) {
    return this.xp.grantBadge(...args)
  }

  totalXp(...args: Parameters<Xp['totalXp']>) {
    return this.xp.totalXp(...args)
  }

  learn(...args: Parameters<Xp['learn']>) {
    return this.xp.learn(...args)
  }

  me(...args: Parameters<Xp['me']>) {
    return this.xp.me(...args)
  }

  findingCard(...args: Parameters<Deck['findingCard']>) {
    return this.deck.findingCard(...args)
  }

  votedPositions(...args: Parameters<Deck['votedPositions']>) {
    return this.deck.votedPositions(...args)
  }

  swapCardFor(...args: Parameters<Deck['swapCardFor']>) {
    return this.deck.swapCardFor(...args)
  }

  seedExampleFindings(...args: Parameters<Deck['seedExampleFindings']>) {
    return this.deck.seedExampleFindings(...args)
  }

  skyThumb(cardId: string) {
    return this.deck.skyThumb(cardId)
  }

  objectIdFor(name: string) {
    return this.deck.objectIdFor(name)
  }

  myCards(...args: Parameters<Deck['myCards']>) {
    return this.deck.myCards(...args)
  }

  myCard(...args: Parameters<Deck['myCard']>) {
    return this.deck.myCard(...args)
  }

  setNote(...args: Parameters<Deck['setNote']>) {
    return this.deck.setNote(...args)
  }

  skyCard(...args: Parameters<Deck['skyCard']>) {
    return this.deck.skyCard(...args)
  }

  cellOf(...args: Parameters<Deck['cellOf']>) {
    return this.deck.cellOf(...args)
  }

  registerSkyCard(...args: Parameters<Deck['registerSkyCard']>) {
    return this.deck.registerSkyCard(...args)
  }

  rebuildSwap(...args: Parameters<Deck['rebuildSwap']>) {
    return this.deck.rebuildSwap(...args)
  }

  openCards(...args: Parameters<Deck['openCards']>) {
    return this.deck.openCards(...args)
  }

  next(...args: Parameters<Deck['next']>) {
    return this.deck.next(...args)
  }

  nextCard(...args: Parameters<Deck['nextCard']>) {
    return this.deck.nextCard(...args)
  }

  issueCard(...args: Parameters<Deck['issueCard']>) {
    return this.deck.issueCard(...args)
  }

  sharedCard(...args: Parameters<Deck['sharedCard']>) {
    return this.deck.sharedCard(...args)
  }

  guideLessons(...args: Parameters<Deck['guideLessons']>) {
    return this.deck.guideLessons(...args)
  }

  guideExamples(...args: Parameters<Deck['guideExamples']>) {
    return this.deck.guideExamples(...args)
  }

  cardShown(...args: Parameters<Deck['cardShown']>) {
    return this.deck.cardShown(...args)
  }

  vote(...args: Parameters<Deck['vote']>) {
    return this.deck.vote(...args)
  }

  cardStatus(...args: Parameters<Deck['cardStatus']>) {
    return this.deck.cardStatus(...args)
  }

  skyStatus(...args: Parameters<Deck['skyStatus']>) {
    return this.deck.skyStatus(...args)
  }

  skyReveal(...args: Parameters<Deck['skyReveal']>) {
    return this.deck.skyReveal(...args)
  }

  candidates(...args: Parameters<Deck['candidates']>) {
    return this.deck.candidates(...args)
  }

  exploreMap(...args: Parameters<Deck['exploreMap']>) {
    return this.deck.exploreMap(...args)
  }

  setGlitch(...args: Parameters<Deck['setGlitch']>) {
    return this.deck.setGlitch(...args)
  }

  reveal(...args: Parameters<Deck['reveal']>) {
    return this.deck.reveal(...args)
  }

  voteWeight(...args: Parameters<Deck['voteWeight']>) {
    return this.deck.voteWeight(...args)
  }

  setTag(...args: Parameters<Social['setTag']>) {
    return this.social.setTag(...args)
  }

  myTags(...args: Parameters<Social['myTags']>) {
    return this.social.myTags(...args)
  }

  tagCounts(...args: Parameters<Social['tagCounts']>) {
    return this.social.tagCounts(...args)
  }

  tagSummary(...args: Parameters<Social['tagSummary']>) {
    return this.social.tagSummary(...args)
  }

  saveMarks(...args: Parameters<Social['saveMarks']>) {
    return this.social.saveMarks(...args)
  }

  myMarks(...args: Parameters<Social['myMarks']>) {
    return this.social.myMarks(...args)
  }

  communityMarks(...args: Parameters<Social['communityMarks']>) {
    return this.social.communityMarks(...args)
  }

  setFollow(...args: Parameters<Social['setFollow']>) {
    return this.social.setFollow(...args)
  }

  isFollowing(...args: Parameters<Social['isFollowing']>) {
    return this.social.isFollowing(...args)
  }

  followers(...args: Parameters<Social['followers']>) {
    return this.social.followers(...args)
  }

  following(...args: Parameters<Social['following']>) {
    return this.social.following(...args)
  }

  history(...args: Parameters<Social['history']>) {
    return this.social.history(...args)
  }

  postBrief(...args: Parameters<Social['postBrief']>) {
    return this.social.postBrief(...args)
  }

  alerts(...args: Parameters<Social['alerts']>) {
    return this.social.alerts(...args)
  }

  markAlertsRead(...args: Parameters<Social['markAlertsRead']>) {
    return this.social.markAlertsRead(...args)
  }

  goals(...args: Parameters<Social['goals']>) {
    return this.social.goals(...args)
  }
}
