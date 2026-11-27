// The local SQLite database: <dataDir>/oneseat.db, WAL mode, versioned migrations.
// Business tables come from the contracts; "_os_" tables are harness-private.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUSINESS_SCHEMA_SQL } from "@oneseat/contracts";

export const DB_FILE = "oneseat.db";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync, ctx: { fts5: boolean }): void;
}

const PRIVATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _os_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '{"kind":"main"}',
  loaded_skills TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS _os_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES _os_sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS _os_messages_session ON _os_messages(session_id, id);
CREATE TABLE IF NOT EXISTS _os_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _os_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  effects TEXT NOT NULL,
  approved INTEGER,
  is_error INTEGER NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS _os_action_log_run ON _os_action_log(run_id);
CREATE TABLE IF NOT EXISTS _os_schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  task TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _os_artifacts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  app TEXT NOT NULL,
  html TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "business schema and private tables",
    up(db) {
      db.exec(BUSINESS_SCHEMA_SQL);
      db.exec(PRIVATE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "memory full-text index",
    up(db, ctx) {
      if (!ctx.fts5) return;
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS _os_memory_fts USING fts5(content, tags, content='_os_memory', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS _os_memory_ai AFTER INSERT ON _os_memory BEGIN
          INSERT INTO _os_memory_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS _os_memory_ad AFTER DELETE ON _os_memory BEGIN
          INSERT INTO _os_memory_fts(_os_memory_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
        END;
        INSERT INTO _os_memory_fts(_os_memory_fts) VALUES ('rebuild');
      `);
    },
  },
];

export interface OpenDbOptions {
  /** Force the LIKE fallback for memory search (tests). */
  disableFts?: boolean;
}

/** Owns the read-write connection and a read-only connection for db_query. */
export class OneSeatDb {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly fts5: boolean;
  private ro: DatabaseSync | undefined;

  private constructor(path: string, db: DatabaseSync, fts5: boolean) {
    this.path = path;
    this.db = db;
    this.fts5 = fts5;
  }

  static open(dataDir: string, opts: OpenDbOptions = {}): OneSeatDb {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, DB_FILE);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    const fts5 = !opts.disableFts && detectFts5(db);
    const d = new OneSeatDb(path, db, fts5);
    d.migrate();
    return d;
  }

  /** Apply pending migrations in order, each in its own transaction. */
  migrate(migrations: Migration[] = MIGRATIONS): number[] {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS _os_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const done = new Set(
      (this.db.prepare("SELECT version FROM _os_migrations").all() as { version: number }[]).map((r) => r.version),
    );
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      this.db.exec("BEGIN");
      try {
        m.up(this.db, { fts5: this.fts5 });
        this.db
          .prepare("INSERT INTO _os_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, new Date().toISOString());
        this.db.exec("COMMIT");
        applied.push(m.version);
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    return applied;
  }

  versions(): number[] {
    return (this.db.prepare("SELECT version FROM _os_migrations ORDER BY version").all() as { version: number }[]).map(
      (r) => r.version,
    );
  }

  /** Whether the memory FTS index exists (FTS5 compiled in and migration applied). */
  get hasMemoryFts(): boolean {
    return (
      this.fts5 &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_os_memory_fts'").get() !== undefined
    );
  }

  /** A read-only connection: writes fail at the SQLite level. */
  readOnly(): DatabaseSync {
    if (!this.ro) {
      this.ro = new DatabaseSync(this.path, { readOnly: true });
      this.ro.exec("PRAGMA busy_timeout = 5000");
    }
    return this.ro;
  }

  close(): void {
    try {
      this.ro?.close();
    } catch {
      /* already closed */
    }
    this.ro = undefined;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function detectFts5(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp._os_fts_probe USING fts5(x); DROP TABLE temp._os_fts_probe;");
    return true;
  } catch {
    return false;
  }
}
