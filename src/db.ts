import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

export const MIGRATIONS: string[] = [
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
  `CREATE TABLE card_issues (
     user_id TEXT NOT NULL REFERENCES users(id),
     card_id TEXT NOT NULL,
     issued_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, card_id)
   );`,
  `CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   INSERT OR IGNORE INTO sessions (token_hash, user_id, created_at) SELECT token_hash, id, created_at FROM users WHERE token_hash != '';`,
  `ALTER TABLE votes ADD COLUMN glitch INTEGER;
   ALTER TABLE card_issues ADD COLUMN guided INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE sky_cards (
     id TEXT PRIMARY KEY,
     ra REAL NOT NULL,
     dec REAL NOT NULL,
     fov_deg REAL NOT NULL,
     band TEXT NOT NULL,
     cell INTEGER NOT NULL,
     size_px INTEGER NOT NULL,
     frames TEXT NOT NULL,
     created_by TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX sky_cards_cell ON sky_cards(cell);
   ALTER TABLE votes ADD COLUMN cell INTEGER;
   CREATE INDEX votes_cell ON votes(cell);`,
  `ALTER TABLE votes ADD COLUMN position TEXT;`,
  `CREATE TABLE findings (
     card_id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     reason TEXT,
     example INTEGER NOT NULL DEFAULT 0,
     credits TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX findings_updated ON findings(updated_at DESC);
   CREATE TABLE finding_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     card_id TEXT NOT NULL,
     state TEXT NOT NULL,
     reason TEXT,
     source TEXT NOT NULL,
     url TEXT,
     data_version TEXT NOT NULL,
     example INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX finding_events_card ON finding_events(card_id, id);
   CREATE TRIGGER finding_events_keep_update BEFORE UPDATE ON finding_events BEGIN SELECT RAISE(ABORT, 'finding_events is append-only'); END;
   CREATE TRIGGER finding_events_keep_delete BEFORE DELETE ON finding_events WHEN OLD.example = 0 BEGIN SELECT RAISE(ABORT, 'finding_events is append-only'); END;
   CREATE TABLE finding_checks (
     card_id TEXT NOT NULL,
     service TEXT NOT NULL,
     result TEXT NOT NULL CHECK (result IN ('found', 'nothing', 'unavailable')),
     names TEXT NOT NULL,
     note TEXT,
     checked_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL,
     PRIMARY KEY (card_id, service)
   );
   CREATE TABLE card_exposures (
     user_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, card_id)
   );
   ALTER TABLE users ADD COLUMN credit_visible INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE finding_checks ADD COLUMN points TEXT;`,
  `CREATE TABLE reactions (
     user_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('interesting', 'doubt')),
     reason TEXT,
     position TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, card_id, kind)
   );
   CREATE INDEX reactions_card ON reactions (card_id);
   CREATE TABLE second_looks (
     user_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     label TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, card_id)
   );
   CREATE INDEX second_looks_card ON second_looks (card_id);
   CREATE TABLE finding_follows (
     user_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, card_id)
   );`,
  `ALTER TABLE votes ADD COLUMN hints INTEGER;`,
  `CREATE TABLE avatars (
     id TEXT PRIMARY KEY,
     nasa_id TEXT NOT NULL,
     title TEXT NOT NULL,
     date TEXT,
     credit TEXT NOT NULL,
     image_url TEXT NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     cx REAL NOT NULL,
     cy REAL NOT NULL,
     side REAL NOT NULL,
     rotation REAL NOT NULL,
     bytes INTEGER NOT NULL,
     owner_id TEXT UNIQUE REFERENCES users(id),
     created_at INTEGER NOT NULL
   );
   CREATE INDEX avatars_nasa ON avatars (nasa_id);
   CREATE INDEX avatars_free ON avatars (owner_id) WHERE owner_id IS NULL;`,
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
