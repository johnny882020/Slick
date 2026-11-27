import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessEvent, Schedule } from "@oneseat/contracts";
import { AppError, AppStore, bridgeResult, parseJsonText, prepareHtml } from "../src/apps.js";
import { OneSeatDb } from "../src/db.js";
import { SkillSession } from "../src/router.js";
import { Scheduler } from "../src/scheduler.js";
import { ArtifactDrafts, MemoryStore, ScheduleStore } from "../src/stores.js";
import { createBuiltinTools, type BuiltinServices } from "../src/tools/builtins.js";
import { ToolRegistry, type RegisteredTool, type ToolContext } from "../src/tools/registry.js";
import { createSkillTools, scriptEffects } from "../src/tools/skills.js";
import { MemorySkillStore, onCleanup, tmpDir } from "./helpers.js";

function services(extra: Partial<BuiltinServices> = {}) {
  const dir = tmpDir();
  const db = OneSeatDb.open(dir);
  onCleanup(() => db.close());
  const store = new MemorySkillStore();
  store.add({ name: "weekly-report", description: "Weekly report." });
  store.add({ name: "invoice-chase", description: "Chase invoices." });
  const scheduler = new Scheduler({ store: new ScheduleStore(db), fire: async () => "r", now: () => new Date(2026, 0, 1, 8) });
  const s: BuiltinServices = {
    db,
    memory: new MemoryStore(db),
    drafts: new ArtifactDrafts(db),
    store,
    workspaceDir: join(dir, "ws"),
    schedules: scheduler,
    now: () => new Date(2026, 0, 1, 8),
    ...extra,
  };
  const tools = new Map<string, RegisteredTool>();
  for (const t of [...createBuiltinTools(s), ...createSkillTools(store, undefined)]) tools.set(t.definition.name, t);
  const events: HarnessEvent[] = [];
  const ctx = (skills = new SkillSession({ store })): ToolContext => ({
    runId: "run_t",
    sessionId: "ses_t",
    task: { input: "x", provider: "anthropic", model: "claude-opus-5-5", effort: "low" },
    signal: new AbortController().signal,
    skills,
    emit: (e) => events.push(e),
  });
  const call = async (name: string, input: Record<string, unknown>, c = ctx()) => tools.get(name)!.run(input, c);
  return { s, db, store, scheduler, tools, ctx, call, events, dir };
}

describe("ToolRegistry", () => {
  it("validates specs, rejects duplicates and removes by owner", () => {
    const r = new ToolRegistry();
    const t: RegisteredTool = {
      definition: { name: "a", description: "A", inputSchema: { type: "object" }, effects: ["read"], source: "mcp", owner: "srv" },
      run: async () => ({ content: "" }),
    };
    r.register(t);
    expect(() => r.register(t)).toThrow("already registered");
    r.register(t, { replace: true });
    expect(() => r.register({ ...t, definition: { ...t.definition, name: "bad name" } })).toThrow("invalid tool");
    r.register({ ...t, definition: { ...t.definition, name: "b" } });
    expect(r.names()).toEqual(["a", "b"]);
    expect(r.has("a")).toBe(true);
    expect(r.unregisterOwner("srv")).toBe(2);
    expect(r.list()).toEqual([]);
    expect(r.unregister("a")).toBe(false);
    expect(r.get("a")).toBeUndefined();
  });
});

describe("database tools", () => {
  it("caps rows and maps blobs and booleans", async () => {
    const { call, db } = services({ queryRowLimit: 3 });
    db.db.exec("CREATE TABLE IF NOT EXISTS nums (n INTEGER, b BLOB)");
    for (let i = 0; i < 5; i++) db.db.prepare("INSERT INTO nums VALUES (?, ?)").run(i, new Uint8Array([1, 2]));
    const r = JSON.parse((await call("db_query", { sql: "SELECT n, b FROM nums WHERE n >= ?", params: [0] })).content);
    expect(r).toMatchObject({ rowCount: 3, truncated: true });
    expect(r.rows[0]).toEqual({ n: 0, b: "[blob 2 bytes]" });
    const bad = await call("db_query", { sql: "SELECT * FROM no_such_table" });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("SQL error: no such table");
    const ins = await call("db_execute", { sql: "INSERT INTO brand (key, value) VALUES (?, ?)", params: ["dark", true] });
    expect(JSON.parse(ins.content).changes).toBe(1);
    expect(db.db.prepare("SELECT value FROM brand WHERE key = 'dark'").get()).toEqual({ value: "1" });
    expect((await call("db_execute", { sql: "INSERT INTO brand (key) VALUES ('x')" })).content).toContain("NOT NULL");
    expect((await call("db_execute", { sql: "VACUUM" })).content).toContain("not allowed");
  });

  it("db_execute effects and summaries depend on the statement", async () => {
    const { tools, ctx } = services();
    const t = tools.get("db_execute")!;
    expect(await t.effectsFor!({ sql: "DELETE FROM posts" }, ctx())).toEqual(["write", "delete"]);
    expect(await t.effectsFor!({ sql: "UPDATE posts SET body = ''" }, ctx())).toEqual(["write"]);
    expect(await t.summarize!({ sql: "UPDATE posts\n SET body = ''" }, ctx())).toBe("Change database: UPDATE posts SET body = ''");
  });
});

describe("memory tools", () => {
  it("saves and searches", async () => {
    const { call } = services();
    expect((await call("memory_save", { content: "  " })).isError).toBe(true);
    expect(JSON.parse((await call("memory_save", { content: "Ada likes PDFs", tags: ["ada", "a,b"] })).content)).toMatchObject({ saved: true });
    const r = JSON.parse((await call("memory_search", { query: "pdfs", limit: 500 })).content);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].tags).toEqual(["ada", "a b"]);
  });
});

describe("workspace tools", () => {
  it("reads, writes, appends and lists inside the workspace only", async () => {
    const { call, s } = services({ maxReadBytes: 50 });
    expect(JSON.parse((await call("workspace_write", { path: "out/report.md", content: "# Hi" })).content)).toEqual({ path: "out/report.md", bytes: 4 });
    await call("workspace_write", { path: "out/report.md", content: "!", append: true });
    expect((await call("workspace_read", { path: "out/report.md" })).content).toBe("# Hi!");
    expect((await call("workspace_read", { path: "../escape.txt" })).content).toContain('must not contain ".."');
    expect((await call("workspace_write", { path: "/tmp/x", content: "x" })).content).toContain("must be relative");
    expect((await call("workspace_read", { path: "missing.txt" })).content).toContain("no such file");
    expect((await call("workspace_read", { path: "out" })).content).toContain("is a folder");
    expect((await call("workspace_write", { path: "out", content: "x" })).content).toContain("is a folder");
    expect((await call("workspace_write", { path: ".", content: "x" })).content).toContain("must name a file");
    writeFileSync(join(s.workspaceDir, "big.txt"), "x".repeat(100));
    expect((await call("workspace_read", { path: "big.txt" })).content).toContain("the limit is 50");
    const list = JSON.parse((await call("workspace_list", { recursive: true })).content);
    expect(list.entries).toEqual([
      { path: "big.txt", type: "file", size: 100 },
      { path: "out", type: "dir" },
      { path: "out/report.md", type: "file", size: 5 },
    ]);
    expect(JSON.parse((await call("workspace_list", {})).content).entries).toHaveLength(2);
    expect((await call("workspace_list", { path: "nope" })).content).toContain("no such folder");
    expect((await call("workspace_list", { path: "big.txt" })).content).toContain("is a file");
    expect((await call("workspace_list", { path: "../.." })).isError).toBe(true);
    mkdirSync(join(s.workspaceDir, "many"));
    for (let i = 0; i < 510; i++) writeFileSync(join(s.workspaceDir, "many", `f${String(i).padStart(3, "0")}`), "");
    expect(JSON.parse((await call("workspace_list", { path: "many" })).content).truncated).toBe(true);
  });
});

describe("make_artifact", () => {
  const html = '<!doctype html><html><body><button onclick="oneseat.run(\'weekly-report\', {})">Go</button></body></html>';

  it("validates and stores a draft", async () => {
    const { call, ctx, store, s } = services();
    const skills = new SkillSession({ store });
    skills.markLoaded("weekly-report", "router");
    const r = await call("make_artifact", { name: "Weekly Board", html, allowedSkills: ["weekly-report", "weekly-report"], icon: "📊" }, ctx(skills));
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content);
    expect(out).toMatchObject({ appId: "weekly-board", name: "Weekly Board", allowedSkills: ["weekly-report"] });
    const draft = s.drafts.get(out.draftId)!;
    expect(draft.app).toMatchObject({ id: "weekly-board", createdBy: "weekly-report", icon: "📊", window: { width: 900, height: 700 } });
    expect(draft.html).toBe(html);
  });

  it("rejects remote resources, undeclared bridge calls and unknown skills", async () => {
    const { call, store, ctx } = services();
    const bad = '<html><script src="https://cdn.example.com/x.js"></script><script>oneseat.run("invoice-chase", {})</script></html>';
    const r = await call("make_artifact", { name: "Bad", html: bad, allowedSkills: ["ghost"], window: { width: 100, height: 300 } });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("remote-resource");
    expect(r.content).toContain('oneseat.run("invoice-chase")');
    expect(r.content).toContain('"ghost", which is not installed');
    expect(r.content).toContain("window.width must be 200 to 4000");
    const limited = new SkillSession({ store, allowedSkills: ["weekly-report"] });
    const r2 = await call("make_artifact", { name: "X", html: "<html></html>", allowedSkills: ["invoice-chase"] }, ctx(limited));
    expect(r2.content).toContain("not available to this run");
  });
});

describe("schedule_task", () => {
  it("creates a schedule from the current task", async () => {
    const { call, scheduler, ctx, store } = services();
    const r = JSON.parse((await call("schedule_task", { cron: "0 9 * * 1", input: "Weekly brief", skill: "weekly-report" })).content);
    const sch = scheduler.get(r.scheduleId)!;
    expect(sch.task).toEqual({ input: "Weekly brief", provider: "anthropic", model: "claude-opus-5-5", skill: "weekly-report", effort: "low" });
    expect(sch.enabled).toBe(true);
    expect(r.nextRunAt).toBe(new Date(2026, 0, 5, 9).toISOString());
    expect((await call("schedule_task", { cron: "bad", input: "x" })).content).toContain('invalid cron "bad"');
    expect((await call("schedule_task", { cron: "0 0 30 2 *", input: "x" })).content).toContain("never runs");
    expect((await call("schedule_task", { cron: "0 9 * * *", input: "x", skill: "ghost" })).content).toContain('no skill named "ghost"');
    const limited = new SkillSession({ store, allowedSkills: [] });
    expect((await call("schedule_task", { cron: "0 9 * * *", input: "x", skill: "weekly-report" }, ctx(limited))).isError).toBe(true);
    const noSched = services({ schedules: undefined as unknown as { upsert(): Schedule } });
    delete noSched.s.schedules;
    const t = createBuiltinTools(noSched.s).find((x) => x.definition.name === "schedule_task")!;
    expect((await t.run({ cron: "0 9 * * *", input: "x" }, noSched.ctx())).content).toContain("not available");
  });
});

describe("skill tools", () => {
  it("run_skill_script refuses unloaded skills and a missing sandbox", async () => {
    const { call, store, ctx, tools } = services();
    store.add({
      name: "mailer",
      description: "Sends mail.",
      oneseat: { effects: ["send"], permissions: { net: ["api.mail.example"], write: ["$WORKSPACE/out"] }, reasons: { "api.mail.example": "send" }, scripts: { send: { file: "send.ts", description: "Send it" } } },
      files: { "send.ts": "console.log(1)" },
    });
    expect((await call("run_skill_script", { skill: "ghost", script: "x" })).content).toContain('No skill named "ghost"');
    expect((await call("run_skill_script", { skill: "mailer", script: "send" })).content).toContain("Load the skill first");
    const skills = new SkillSession({ store });
    skills.markLoaded("mailer", "router");
    expect((await call("run_skill_script", { skill: "mailer", script: "send" }, ctx(skills))).content).toContain("Deno sandbox is not installed");
    const t = tools.get("run_skill_script")!;
    expect(await t.effectsFor!({ skill: "mailer" }, ctx(skills))).toEqual(["write", "network", "send"]);
    expect(await t.effectsFor!({ skill: "ghost" }, ctx(skills))).toEqual(["read"]);
    expect(await t.summarize!({ skill: "mailer", script: "send", args: ["--to", "ada"] }, ctx(skills))).toBe(
      'Run script "send" of skill mailer - Send it with --to ada (can send)',
    );
    expect(await t.summarize!({ skill: "ghost", script: "s" }, ctx(skills))).toBe('Run script "s" of skill ghost');
  });

  it("scriptEffects is read-only only without writes, network, runs or effects", () => {
    const base = { frontmatter: { name: "x", description: "x" }, body: "", dir: "", files: [], linkedFiles: [], reasons: {}, scripts: {} };
    const perms = { net: [], read: [], write: [], env: [], run: [] };
    expect(scriptEffects({ ...base, permissions: perms, effects: [] })).toEqual(["read"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, net: ["a.b"] }, effects: [] })).toEqual(["read", "network"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, run: ["git"] }, effects: ["delete"] })).toEqual(["write", "delete"]);
  });

  it("applies a skill's outward effects to scripts only when the sandbox lets them happen", () => {
    const base = { frontmatter: { name: "x", description: "x" }, body: "", dir: "", files: [], linkedFiles: [], reasons: {}, scripts: {} };
    const perms = { net: [], read: [], write: [], env: [], run: [] };
    // proposals-invoices: sends invoices via a connected tool; its totals script has no access at all.
    expect(scriptEffects({ ...base, permissions: perms, effects: ["send", "delete"] })).toEqual(["read"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, net: ["api.mail.test"] }, effects: ["send"] })).toEqual(["network", "send"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, net: ["api.pay.test"] }, effects: ["pay"] })).toEqual(["network", "pay"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, write: ["$WORKSPACE/out"] }, effects: ["delete", "send"] })).toEqual(["write", "delete"]);
    expect(scriptEffects({ ...base, permissions: { ...perms, run: ["curl"] }, effects: ["send"] })).toEqual(["write", "send"]);
  });

  it("read_skill_file reports a store failure", async () => {
    const { call, store, ctx } = services();
    store.add({ name: "broken", description: "b", files: { "a.md": "x" } });
    store.skills.get("broken")!.files = {};
    const skills = new SkillSession({ store });
    skills.markLoaded("broken", "router");
    expect((await call("read_skill_file", { skill: "broken", path: "a.md" }, ctx(skills))).content).toContain("could not read a.md");
    expect((await call("read_skill_file", { skill: "broken", path: "." }, ctx(skills))).content).toContain("must name a file");
    expect((await call("read_skill_file", { skill: "ghost", path: "a.md" }, ctx(skills))).isError).toBe(true);
  });
});

describe("pinned app storage", () => {
  const app = { id: "board", name: "Board", version: "1.0.0", window: { width: 800, height: 600 }, allowedSkills: ["weekly-report"] };

  it("pins, lists, reads and unpins", () => {
    const dir = tmpDir();
    const apps = new AppStore(join(dir, "apps"));
    const pinned = apps.pin({ html: "<p>Hello</p>", app }, new Date("2026-01-02T03:04:05.000Z"));
    expect(pinned.pinnedAt).toBe("2026-01-02T03:04:05.000Z");
    const html = readFileSync(pinned.htmlPath, "utf8");
    expect(html).toContain("<body>\n<p>Hello</p>\n</body>");
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(JSON.parse(readFileSync(join(dir, "apps", "board", "app.json"), "utf8"))).toEqual(app);
    expect(apps.list().map((a) => a.app.id)).toEqual(["board"]);
    expect(apps.allowedSkills("board")).toEqual(["weekly-report"]);
    expect(apps.get("../etc")).toBeUndefined();
    apps.pin({ html: "<html><body>v2</body></html>", app: { ...app, name: "Board 2" } });
    expect(apps.get("board")!.app.name).toBe("Board 2");
    writeFileSync(join(dir, "apps", "board", "pin.json"), "garbage");
    expect(apps.get("board")!.pinnedAt).toBe("");
    mkdirSync(join(dir, "apps", "broken"));
    writeFileSync(join(dir, "apps", "broken", "app.json"), "{");
    expect(apps.get("broken")).toBeUndefined();
    expect(apps.unpin("board")).toBe(true);
    expect(apps.unpin("board")).toBe(false);
  });

  it("refuses invalid bundles", () => {
    const apps = new AppStore(join(tmpDir(), "apps"));
    expect(() => apps.pin({ html: '<img src="https://x.example/a.png">', app })).toThrow(AppError);
    try {
      apps.pin({ html: "<html></html>", app: { ...app, id: "Bad Id" } });
    } catch (e) {
      expect((e as AppError).issues.map((i) => i.rule)).toContain("app-id");
    }
    expect(() => apps.pin(null as never)).toThrow("needs {html, app}");
  });

  it("prepareHtml enforces the pinned CSP", () => {
    expect(prepareHtml("<html><head><title>x</title></head><body></body></html>")).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy"/);
    const replaced = prepareHtml('<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>');
    expect(replaced).not.toContain("default-src *");
    expect(replaced).toContain("default-src 'none'");
    expect(prepareHtml("<html><body>x</body></html>")).toMatch(/<html>\n<head><meta http-equiv/);
    expect(prepareHtml("<body>x</body>")).toContain("<!doctype html>");
  });

  it("parses JSON results for the bridge", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText("```json\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonText("```\n{bad\n```")).toBeUndefined();
    expect(parseJsonText("Hello")).toBeUndefined();
    expect(parseJsonText("{not json")).toBeUndefined();
    expect(parseJsonText("")).toBeUndefined();
    expect(parseJsonText("42")).toBe(42);
    expect(bridgeResult("end_turn", '{"ok":true}')).toEqual({ ok: true, text: '{"ok":true}', data: { ok: true } });
    expect(bridgeResult("max_turns", "x")).toEqual({ ok: false, text: "x", error: "the skill did not finish in time" });
    expect(bridgeResult("cancelled", "")).toMatchObject({ ok: false, error: "cancelled" });
    expect(bridgeResult("refusal", "")).toMatchObject({ ok: false, error: "stopped: refusal" });
    expect(bridgeResult("error", "", "boom")).toMatchObject({ ok: false, error: "boom" });
  });
});
