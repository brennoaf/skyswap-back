import { prepared, type DB } from './db.js'

export const COMMENT_MAX_CHARS = 2000
export const COMMENT_MAX_DEPTH = 6
export const REPORTS_TO_HIDE = 3
export const COMMENTS_PER_MINUTE = 5
const MINUTE_MS = 60_000

export type CommentSort = 'best' | 'new'
export type CommentState = 'ok' | 'deleted' | 'hidden'
export type AddError = 'empty' | 'too_long' | 'bad_parent' | 'too_deep' | 'too_many'

export interface CommentNode {
  id: number
  parent_id: number | null
  depth: number
  replies: number
  author: string | null
  avatar: string | null
  body: string | null
  created_at: number
  score: number
  my_vote: number
  state: CommentState
  mine: boolean
  reported: boolean
}

type Tree = CommentNode & { children: Tree[] }

interface Row {
  id: number
  parent_id: number | null
  user_id: string
  body: string
  created_at: number
  deleted: number
  nickname: string
  avatar_id: string | null
  score: number
  my_vote: number | null
  reports: number
  reported: number
}

export class Comments {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  private q(sql: string) {
    return prepared(this.db, sql)
  }

  thread(target: string, userId: string | null, sort: CommentSort = 'best'): { count: number; comments: CommentNode[] } {
    const rows = this.q(
      `SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at, c.deleted, u.nickname, a.id AS avatar_id,
         COALESCE((SELECT SUM(value) FROM comment_votes v WHERE v.comment_id = c.id), 0) AS score,
         (SELECT value FROM comment_votes v WHERE v.comment_id = c.id AND v.user_id = @user) AS my_vote,
         (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) AS reports,
         EXISTS (SELECT 1 FROM comment_reports r WHERE r.comment_id = c.id AND r.user_id = @user) AS reported
       FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN avatars a ON a.owner_id = c.user_id
       WHERE c.target = @target`,
    ).all({ target, user: userId ?? '' }) as Row[]
    const nodes = new Map<number, Tree>()
    for (const r of rows) {
      const state: CommentState = r.deleted ? 'deleted' : r.reports >= REPORTS_TO_HIDE ? 'hidden' : 'ok'
      const mine = !!userId && r.user_id === userId
      const shown = state === 'ok' || (state === 'hidden' && mine)
      nodes.set(r.id, {
        id: r.id,
        parent_id: r.parent_id,
        author: state === 'deleted' ? null : r.nickname,
        avatar: state === 'deleted' || !r.avatar_id ? null : `/kit/avatars/${r.avatar_id}.jpg`,
        body: shown ? r.body : null,
        created_at: r.created_at,
        score: r.score,
        my_vote: r.my_vote ?? 0,
        state,
        mine,
        reported: !!r.reported,
        depth: 0,
        replies: 0,
        children: [],
      })
    }
    const roots: Tree[] = []
    for (const n of nodes.values()) {
      const parent = n.parent_id === null ? undefined : nodes.get(n.parent_id)
      if (parent) parent.children.push(n)
      else roots.push(n)
    }
    const order = (a: Tree, b: Tree) => (sort === 'new' ? b.created_at - a.created_at : b.score - a.score || a.created_at - b.created_at) || a.id - b.id
    const tidy = (list: Tree[]): Tree[] =>
      list
        .map((n) => ({ ...n, children: tidy(n.children) }))
        .filter((n) => n.state !== 'deleted' || n.children.length > 0)
        .sort(order)
    const flat: CommentNode[] = []
    const walk = (list: Tree[], depth: number) => {
      for (const { children, ...n } of list) {
        flat.push({ ...n, depth, replies: children.length })
        walk(children, depth + 1)
      }
    }
    walk(tidy(roots), 0)
    return { count: this.count(target), comments: flat }
  }

  count(target: string): number {
    return (
      this.q(
        `SELECT COUNT(*) AS n FROM comments c WHERE c.target = ? AND c.deleted = 0
           AND (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) < ${REPORTS_TO_HIDE}`,
      ).get(target) as { n: number }
    ).n
  }

  targetOf(commentId: number): { target: string; user_id: string; deleted: number } | null {
    return (this.q('SELECT target, user_id, deleted FROM comments WHERE id = ?').get(commentId) as { target: string; user_id: string; deleted: number } | undefined) ?? null
  }

  add(target: string, userId: string, text: string, parentId: number | null = null): { id: number } | { error: AddError } {
    const body = text.trim()
    if (!body) return { error: 'empty' }
    if ([...body].length > COMMENT_MAX_CHARS) return { error: 'too_long' }
    if (parentId !== null) {
      const parent = this.targetOf(parentId)
      if (!parent || parent.target !== target) return { error: 'bad_parent' }
      if (this.depth(parentId) + 1 >= COMMENT_MAX_DEPTH) return { error: 'too_deep' }
    }
    const recent = (this.q('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?').get(userId, this.now() - MINUTE_MS) as { n: number }).n
    if (recent >= COMMENTS_PER_MINUTE) return { error: 'too_many' }
    const r = this.q('INSERT INTO comments (target, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(target, parentId, userId, body, this.now())
    return { id: Number(r.lastInsertRowid) }
  }

  private depth(id: number): number {
    let d = 0
    let cur: number | null = id
    while (cur !== null && d <= COMMENT_MAX_DEPTH) {
      const row = this.q('SELECT parent_id FROM comments WHERE id = ?').get(cur) as { parent_id: number | null } | undefined
      cur = row?.parent_id ?? null
      if (cur !== null) d++
    }
    return d
  }

  vote(commentId: number, userId: string, value: -1 | 0 | 1): void {
    if (value === 0) this.q('DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?').run(commentId, userId)
    else this.q('INSERT INTO comment_votes (comment_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(comment_id, user_id) DO UPDATE SET value = excluded.value').run(commentId, userId, value, this.now())
  }

  report(commentId: number, userId: string): void {
    this.q('INSERT OR IGNORE INTO comment_reports (comment_id, user_id, created_at) VALUES (?, ?, ?)').run(commentId, userId, this.now())
  }

  remove(commentId: number): void {
    this.q("UPDATE comments SET deleted = 1, body = '' WHERE id = ?").run(commentId)
  }

  clear(target: string): void {
    this.q('DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM comments WHERE target = ?)').run(target)
    this.q('DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE target = ?)').run(target)
    this.q('UPDATE comments SET parent_id = NULL WHERE target = ?').run(target)
    this.q('DELETE FROM comments WHERE target = ?').run(target)
    this.q('DELETE FROM post_votes WHERE target = ?').run(target)
  }

  votePost(target: string, userId: string, value: -1 | 0 | 1): void {
    if (value === 0) this.q('DELETE FROM post_votes WHERE target = ? AND user_id = ?').run(target, userId)
    else this.q('INSERT INTO post_votes (target, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(target, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at').run(target, userId, value, this.now())
  }

  summary(target: string, userId: string | null): { votes: number; my_vote: number; comments: number } {
    const score = (this.q('SELECT COALESCE(SUM(value), 0) AS s FROM post_votes WHERE target = ?').get(target) as { s: number }).s
    const mine = userId ? (this.q('SELECT value FROM post_votes WHERE target = ? AND user_id = ?').get(target, userId) as { value: number } | undefined) : undefined
    return { votes: score, my_vote: mine?.value ?? 0, comments: this.count(target) }
  }

  activity(since: number): { target: string; user_id: string; created_at: number; weight: number }[] {
    return this.q(
      `SELECT target, user_id, created_at, 2 AS weight FROM comments WHERE created_at >= @since AND deleted = 0
       UNION ALL SELECT target, user_id, created_at, 1 AS weight FROM post_votes WHERE created_at >= @since AND value > 0`,
    ).all({ since }) as { target: string; user_id: string; created_at: number; weight: number }[]
  }
}
