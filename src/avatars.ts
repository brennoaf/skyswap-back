import type { DB } from './db.js'

export interface AvatarDto {
  id: string
  url: string
  title: string
  date: string | null
  credit: string
  image_url: string
}

export interface NewAvatar {
  id: string
  nasa_id: string
  title: string
  date: string | null
  credit: string
  image_url: string
  width: number
  height: number
  cx: number
  cy: number
  side: number
  rotation: number
  bytes: number
}

type Row = Omit<AvatarDto, 'url'>

const COLUMNS = 'id, title, date, credit, image_url'
const dto = (row: Row): AvatarDto => ({ ...row, url: `/kit/avatars/${row.id}.jpg` })

export class Avatars {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  freeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM avatars WHERE owner_id IS NULL').get() as { n: number }).n
  }

  private draw(count: number, not: string[]): Row[] {
    const marks = not.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM (SELECT * FROM avatars WHERE owner_id IS NULL AND id NOT IN (${marks}) ORDER BY RANDOM()) GROUP BY nasa_id ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...not, count) as Row[]
  }

  offer(count: number, not: string[] = []): AvatarDto[] {
    const rows = this.draw(count, not)
    if (rows.length < count && not.length) {
      const have = new Set(rows.map((r) => r.id))
      for (const r of this.draw(count, [])) if (rows.length < count && !have.has(r.id)) rows.push(r)
    }
    return rows.map(dto)
  }

  ofUser(userId: string): AvatarDto | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM avatars WHERE owner_id = ?`).get(userId) as Row | undefined
    return row ? dto(row) : null
  }

  inStock(nasaId: string, title: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM avatars WHERE owner_id IS NULL AND (nasa_id = ? OR title = ? COLLATE NOCASE) LIMIT 1').get(nasaId, title)
  }

  add(a: NewAvatar): void {
    this.db
      .prepare(
        `INSERT INTO avatars (id, nasa_id, title, date, credit, image_url, width, height, cx, cy, side, rotation, bytes, created_at)
         VALUES (@id, @nasa_id, @title, @date, @credit, @image_url, @width, @height, @cx, @cy, @side, @rotation, @bytes, @created_at)`,
      )
      .run({ ...a, created_at: this.now() })
  }

  choose(userId: string, avatarId: string): boolean {
    this.db.prepare('UPDATE avatars SET owner_id = NULL WHERE owner_id = ?').run(userId)
    return this.db.prepare('UPDATE avatars SET owner_id = ? WHERE id = ? AND owner_id IS NULL').run(userId, avatarId).changes === 1
  }
}
