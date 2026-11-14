import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
     token_hash TEXT NOT NULL,
     expert INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE votes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL REFERENCES users(id),
     card_id TEXT NOT NULL,
     label TEXT NOT NULL CHECK (label IN ('real','artifact','unsure')),
     ms INTEGER NOT NULL,
     counted INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, card_id)
   );
   CREATE TABLE marks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL REFERENCES users(id),
     post_id TEXT NOT NULL,
     frame INTEGER NOT NULL,
     x REAL NOT NULL,
     y REAL NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, post_id, frame)
   );
   CREATE INDEX marks_post ON marks(post_id);
   CREATE TABLE tags (
     user_id TEXT NOT NULL REFERENCES users(id),
     post_id TEXT NOT NULL,
     tag TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, post_id, tag)
   );
   CREATE INDEX tags_post ON tags(post_id);
   CREATE TABLE follows (
     user_id TEXT NOT NULL REFERENCES users(id),
     object_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, object_id)
   );
   CREATE INDEX follows_object ON follows(object_id);
   CREATE TABLE xp_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL REFERENCES users(id),
     action TEXT NOT NULL,
     ref TEXT,
     xp INTEGER NOT NULL,
     streak_bonus INTEGER NOT NULL,
     streak INTEGER NOT NULL,
     reason TEXT NOT NULL,
     day TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX xp_user_day ON xp_events(user_id, day);
   CREATE TABLE badges (
     user_id TEXT NOT NULL REFERENCES users(id),
     badge TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, badge)
   );
   CREATE TABLE learning (
     user_id TEXT NOT NULL REFERENCES users(id),
     event TEXT NOT NULL,
     ref TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, event, ref)
   );
   CREATE TABLE alerts_read (
     user_id TEXT NOT NULL REFERENCES users(id),
     alert_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, alert_id)
   );`,
]

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  const current = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string)
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1)
    })()
  }
}
