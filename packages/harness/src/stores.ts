// Typed access to the harness-private tables.

import type { ActionLogEntry, AppJson, Message, Schedule, TaskRequest, ToolEffect } from "@oneseat/contracts";
import type { OneSeatDb } from "./db.js";
import type { Redactor } from "./util.js";

export interface LoadedSkill {
  name: string;
  reason: "router" | "forced";
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  origin: NonNullable<TaskRequest["origin"]>;
  loadedSkills: LoadedSkill[];
}

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  model: string;
  origin: string;
  loaded_skills: string;
}

export class SessionStore {
  constructor(private readonly d: OneSeatDb) {}

  get(id: string): SessionRecord | undefined {
    const r = this.d.db.prepare("SELECT * FROM _os_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      provider: r.provider,
      model: r.model,
      origin: JSON.parse(r.origin) as SessionRecord["origin"],
      loadedSkills: JSON.parse(r.loaded_skills) as LoadedSkill[],
    };
  }

  create(id: string, task: Pick<TaskRequest, "provider" | "model" | "origin">): SessionRecord {
    const now = new Date().toISOString();
    this.d.db
      .prepare(
        "INSERT INTO _os_sessions (id, created_at, updated_at, provider, model, origin, loaded_skills) VALUES (?, ?, ?, ?, ?, ?, '[]')",
      )
      .run(id, now, now, task.provider, task.model, JSON.stringify(task.origin ?? { kind: "main" }));
    return this.get(id)!;
  }

  setLoadedSkills(id: string, skills: LoadedSkill[]): void {
    this.d.db
      .prepare("UPDATE _os_sessions SET loaded_skills = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(skills), new Date().toISOString(), id);
  }

  appendMessages(sessionId: string, runId: string, messages: Message[]): void {
    if (messages.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.d.db.prepare(
      "INSERT INTO _os_messages (session_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.d.db.exec("BEGIN");
    try {
      for (const m of messages) stmt.run(sessionId, runId, m.role, JSON.stringify(m.content), now);
      this.d.db.prepare("UPDATE _os_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      throw e;
    }
  }

  messages(sessionId: string): Message[] {
    const rows = this.d.db
      .prepare("SELECT role, content FROM _os_messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as { role: Message["role"]; content: string }[];
    return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) as Message["content"] }));
  }
}

// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: number;
  content: string;
  tags: string[];
  createdAt: string;
}

export class MemoryStore {
  constructor(private readonly d: OneSeatDb) {}

  get usesFts(): boolean {
    return this.d.hasMemoryFts;
  }

  save(content: string, tags: string[] = [], sessionId?: string): number {
    const r = this.d.db
      .prepare("INSERT INTO _os_memory (content, tags, session_id, created_at) VALUES (?, ?, ?, ?)")
      .run(content, tags.join(","), sessionId ?? null, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  search(query: string, limit = 10): MemoryItem[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
    type Row = { id: number; content: string; tags: string; created_at: string };
    let rows: Row[];
    if (terms.length === 0) {
      rows = this.d.db
        .prepare("SELECT id, content, tags, created_at FROM _os_memory ORDER BY id DESC LIMIT ?")
        .all(limit) as Row[];
    } else if (this.usesFts) {
      const match = terms.map((t) => `"${t}"*`).join(" OR ");
      rows = this.d.db
        .prepare(
          `SELECT m.id, m.content, m.tags, m.created_at FROM _os_memory_fts f JOIN _os_memory m ON m.id = f.rowid
           WHERE _os_memory_fts MATCH ? ORDER BY bm25(_os_memory_fts), m.id DESC LIMIT ?`,
        )
        .all(match, limit) as Row[];
    } else {
      const hay = "lower(content || ' ' || tags)";
      const score = terms.map(() => `(CASE WHEN ${hay} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(" + ");
      const likes = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      rows = this.d.db
        .prepare(
          `SELECT id, content, tags, created_at, (${score}) AS score FROM _os_memory
           WHERE (${score}) > 0 ORDER BY score DESC, id DESC LIMIT ?`,
        )
        .all(...likes, ...likes, limit) as Row[];
    }
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------

export class ActionLog {
  constructor(
    private readonly d: OneSeatDb,
    private readonly redactor: Redactor,
  ) {}

  write(entry: Omit<ActionLogEntry, "at"> & { at?: string }): void {
    this.d.db
      .prepare(
        "INSERT INTO _os_action_log (at, run_id, tool, effects, approved, is_error, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.at ?? new Date().toISOString(),
        entry.runId,
        entry.tool,
        JSON.stringify(entry.effects),
        entry.approved === null ? null : entry.approved ? 1 : 0,
        entry.isError ? 1 : 0,
        this.redactor.redact(entry.summary),
      );
  }

  /** Newest first. */
  list(limit = 100, runId?: string): ActionLogEntry[] {
    type Row = { at: string; run_id: string; tool: string; effects: string; approved: number | null; is_error: number; summary: string };
    const n = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = (
      runId
        ? this.d.db.prepare("SELECT * FROM _os_action_log WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, n)
        : this.d.db.prepare("SELECT * FROM _os_action_log ORDER BY id DESC LIMIT ?").all(n)
    ) as Row[];
    return rows.map((r) => ({
      at: r.at,
      runId: r.run_id,
      tool: r.tool,
      effects: JSON.parse(r.effects) as ToolEffect[],
      approved: r.approved === null ? null : r.approved === 1,
      isError: r.is_error === 1,
      summary: r.summary,
    }));
  }
}

// ---------------------------------------------------------------------------

export interface ArtifactDraft {
  id: string;
  app: AppJson;
  html: string;
  runId: string;
  sessionId: string;
  createdAt: string;
}

export class ArtifactDrafts {
  constructor(private readonly d: OneSeatDb) {}

  save(draft: Omit<ArtifactDraft, "createdAt">): ArtifactDraft {
    const createdAt = new Date().toISOString();
    this.d.db
      .prepare("INSERT INTO _os_artifacts (id, app_id, app, html, run_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(draft.id, draft.app.id, JSON.stringify(draft.app), draft.html, draft.runId, draft.sessionId, createdAt);
    return { ...draft, createdAt };
  }

  get(id: string): ArtifactDraft | undefined {
    const r = this.d.db.prepare("SELECT * FROM _os_artifacts WHERE id = ?").get(id) as
      | { id: string; app: string; html: string; run_id: string; session_id: string; created_at: string }
      | undefined;
    if (!r) return undefined;
    return { id: r.id, app: JSON.parse(r.app) as AppJson, html: r.html, runId: r.run_id, sessionId: r.session_id, createdAt: r.created_at };
  }

  list(): Omit<ArtifactDraft, "html">[] {
    const rows = this.d.db
      .prepare("SELECT id, app, run_id, session_id, created_at FROM _os_artifacts ORDER BY created_at DESC, id")
      .all() as { id: string; app: string; run_id: string; session_id: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, app: JSON.parse(r.app) as AppJson, runId: r.run_id, sessionId: r.session_id, createdAt: r.created_at }));
  }
}

// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  cron: string;
  task: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

export class ScheduleStore {
  constructor(private readonly d: OneSeatDb) {}

  private toSchedule(r: ScheduleRow): Schedule {
    const s: Schedule = { id: r.id, cron: r.cron, task: JSON.parse(r.task) as Schedule["task"], enabled: r.enabled === 1 };
    if (r.last_run_at) s.lastRunAt = r.last_run_at;
    if (r.next_run_at) s.nextRunAt = r.next_run_at;
    return s;
  }

  list(): Schedule[] {
    return (this.d.db.prepare("SELECT * FROM _os_schedules ORDER BY created_at, id").all() as unknown as ScheduleRow[]).map(
      (r) => this.toSchedule(r),
    );
  }

  get(id: string): Schedule | undefined {
    const r = this.d.db.prepare("SELECT * FROM _os_schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return r ? this.toSchedule(r) : undefined;
  }

  put(s: Schedule): Schedule {
    const now = new Date().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO _os_schedules (id, cron, task, enabled, last_run_at, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cron = excluded.cron, task = excluded.task, enabled = excluded.enabled,
           last_run_at = excluded.last_run_at, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.cron, JSON.stringify(s.task), s.enabled ? 1 : 0, s.lastRunAt ?? null, s.nextRunAt ?? null, now, now);
    return this.get(s.id)!;
  }

  remove(id: string): boolean {
    return Number(this.d.db.prepare("DELETE FROM _os_schedules WHERE id = ?").run(id).changes) > 0;
  }
}
