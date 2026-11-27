import { describe, expect, it } from "vitest";
import { BUSINESS_TABLES } from "@oneseat/contracts";
import { OneSeatDb, MIGRATIONS } from "../src/db.js";
import { ActionLog, ArtifactDrafts, MemoryStore, ScheduleStore, SessionStore } from "../src/stores.js";
import { Redactor } from "../src/util.js";
import { onCleanup, tmpDir } from "./helpers.js";

function open(disableFts = false): OneSeatDb {
  const d = OneSeatDb.open(tmpDir(), { disableFts });
  onCleanup(() => d.close());
  return d;
}

describe("OneSeatDb", () => {
  it("creates the business schema and private tables in WAL mode with versions", () => {
    const d = open();
    expect((d.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    const names = (d.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name);
    for (const t of BUSINESS_TABLES) expect(names).toContain(t);
    for (const t of ["_os_sessions", "_os_messages", "_os_memory", "_os_action_log", "_os_schedules", "_os_artifacts", "_os_migrations", "customer_ltv"])
      expect(names).toContain(t);
    expect(d.versions()).toEqual([1, 2]);
    expect(d.fts5).toBe(true);
    expect(d.hasMemoryFts).toBe(true);
    // Re-running migrations is a no-op.
    expect(d.migrate()).toEqual([]);
  });

  it("reopens an existing database and applies only new migrations", () => {
    const dir = tmpDir();
    const a = OneSeatDb.open(dir);
    a.db.prepare("INSERT INTO brand (key, value) VALUES ('company_name', 'Acme')").run();
    a.close();
    a.close(); // idempotent
    const b = OneSeatDb.open(dir);
    onCleanup(() => b.close());
    expect(b.db.prepare("SELECT value FROM brand").get()).toEqual({ value: "Acme" });
    const applied = b.migrate([...MIGRATIONS, { version: 3, name: "extra", up: (db) => db.exec("CREATE TABLE IF NOT EXISTS extra (x)") }]);
    expect(applied).toEqual([3]);
    expect(() => b.migrate([{ version: 4, name: "bad", up: (db) => db.exec("THIS IS NOT SQL") }])).toThrow();
    expect(b.versions()).toEqual([1, 2, 3]);
  });

  it("gives a read-only connection that cannot write", () => {
    const d = open();
    expect(() => d.readOnly().exec("INSERT INTO brand (key, value) VALUES ('a', 'b')")).toThrow(/readonly/);
    expect(d.readOnly()).toBe(d.readOnly());
  });

  it("works without FTS5", () => {
    const d = open(true);
    expect(d.fts5).toBe(false);
    expect(d.hasMemoryFts).toBe(false);
    expect(d.versions()).toEqual([1, 2]);
  });
});

describe("stores", () => {
  it("sessions keep messages and loaded skills", () => {
    const d = open();
    const s = new SessionStore(d);
    expect(s.get("nope")).toBeUndefined();
    const rec = s.create("ses_1", { provider: "anthropic", model: "claude-opus-5-5" });
    expect(rec).toMatchObject({ id: "ses_1", provider: "anthropic", origin: { kind: "main" }, loadedSkills: [] });
    s.appendMessages("ses_1", "run_1", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "db_query", input: { sql: "SELECT 1" }, providerMeta: { sig: "x" } }] },
    ]);
    s.appendMessages("ses_1", "run_1", []);
    expect(s.messages("ses_1")).toHaveLength(2);
    expect(s.messages("ses_1")[1]!.content[0]).toMatchObject({ providerMeta: { sig: "x" } });
    s.setLoadedSkills("ses_1", [{ name: "a", reason: "forced" }]);
    expect(s.get("ses_1")!.loadedSkills).toEqual([{ name: "a", reason: "forced" }]);
    expect(() => s.appendMessages("missing", "r", [{ role: "user", content: [] }])).toThrow();
  });

  it("memory search uses FTS5 with prefix matching, or LIKE as a fallback", () => {
    for (const disableFts of [false, true]) {
      const m = new MemoryStore(open(disableFts));
      expect(m.usesFts).toBe(!disableFts);
      m.save("Ada prefers invoices by email", ["billing", "ada"]);
      m.save("Office closes at 5pm on Fridays", ["hours"]);
      m.save("100% of invoices are net 30", []);
      expect(m.search("invoices").map((x) => x.content).sort()).toEqual(["100% of invoices are net 30", "Ada prefers invoices by email"]);
      expect(m.search("invoic")[0]).toBeDefined();
      expect(m.search("friday")[0]!.content).toContain("Fridays");
      expect(m.search("billing")[0]!.tags).toEqual(["billing", "ada"]);
      expect(m.search("100%")[0]!.content).toContain("100%");
      expect(m.search("zebra")).toEqual([]);
      expect(m.search("   ")).toHaveLength(3);
      expect(m.search("invoices", 1)).toHaveLength(1);
    }
  });

  it("action log stores entries newest first, redacted", () => {
    const d = open();
    const log = new ActionLog(d, new Redactor());
    log.write({ runId: "r1", tool: "a", effects: ["read"], approved: null, isError: false, summary: "first token=abcdef123" });
    log.write({ runId: "r2", tool: "b", effects: ["send"], approved: true, isError: false, summary: "second", at: "2026-01-01T00:00:00.000Z" });
    log.write({ runId: "r2", tool: "c", effects: ["delete"], approved: false, isError: true, summary: "third" });
    const all = log.list();
    expect(all.map((e) => e.tool)).toEqual(["c", "b", "a"]);
    expect(all[2]!.summary).toBe("first token=[REDACTED]");
    expect(all[1]).toEqual({ at: "2026-01-01T00:00:00.000Z", runId: "r2", tool: "b", effects: ["send"], approved: true, isError: false, summary: "second" });
    expect(all[0]!.approved).toBe(false);
    expect(log.list(1)).toHaveLength(1);
    expect(log.list(10, "r2")).toHaveLength(2);
  });

  it("drafts and schedules round-trip", () => {
    const d = open();
    const drafts = new ArtifactDrafts(d);
    const app = { id: "x", name: "X", version: "1.0.0", window: { width: 400, height: 300 }, allowedSkills: [] };
    drafts.save({ id: "draft_1", app, html: "<html></html>", runId: "r", sessionId: "s" });
    expect(drafts.get("draft_1")).toMatchObject({ app, html: "<html></html>" });
    expect(drafts.get("nope")).toBeUndefined();
    expect(drafts.list()).toHaveLength(1);

    const sch = new ScheduleStore(d);
    const s = sch.put({ id: "s1", cron: "0 9 * * 1", task: { input: "x", provider: "local", model: "m" }, enabled: true, nextRunAt: "2026-01-05T09:00:00.000Z" });
    expect(s.nextRunAt).toBe("2026-01-05T09:00:00.000Z");
    expect(s.lastRunAt).toBeUndefined();
    sch.put({ ...s, enabled: false, lastRunAt: "2026-01-01T00:00:00.000Z" });
    expect(sch.get("s1")).toMatchObject({ enabled: false, lastRunAt: "2026-01-01T00:00:00.000Z" });
    expect(sch.list()).toHaveLength(1);
    expect(sch.remove("s1")).toBe(true);
    expect(sch.remove("s1")).toBe(false);
    expect(sch.get("s1")).toBeUndefined();
  });
});
