import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createScriptedProvider,
  RPC_ERRORS,
  type HarnessEvent,
  type ProviderConfig,
  type ProviderFactory,
  type ScriptEntry,
} from "@oneseat/contracts";
import { createDaemon, serveStdio, type Daemon, type DaemonOptions } from "../src/daemon.js";
import { checked, MemorySkillStore, onCleanup, tmpDir } from "./helpers.js";

const MCP_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghij";

interface Msg {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcClient(daemon: Daemon) {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = daemon.connect(input, output);
  const pending = new Map<number | string, (m: Msg) => void>();
  const notes: Msg[] = [];
  const raw: string[] = [];
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  createInterface({ input: output }).on("line", (line) => {
    raw.push(line);
    const m = JSON.parse(line) as Msg;
    if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
      return;
    }
    notes.push(m);
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  });
  let id = 0;
  const send = (method: string, params?: unknown): Promise<Msg> => {
    const myId = ++id;
    return new Promise((resolve) => {
      pending.set(myId, resolve);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  };
  const call = async (method: string, params: unknown = {}) => {
    const m = await send(method, params);
    if (m.error) throw Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data });
    return m.result as Record<string, unknown>;
  };
  const writeLine = (line: string) => input.write(line + "\n");
  const nextNote = (pred: (m: Msg) => boolean): Promise<Msg> => {
    const found = notes.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  const event = (runId: string, type: HarnessEvent["type"]) =>
    nextNote((m) => m.method === "harness.event" && m.params?.["runId"] === runId && (m.params["event"] as HarnessEvent).type === type).then(
      (m) => m.params!["event"] as HarnessEvent,
    );
  const events = (runId: string) =>
    notes.filter((m) => m.method === "harness.event" && m.params?.["runId"] === runId).map((m) => m.params!["event"] as HarnessEvent);
  return { send, call, writeLine, notes, raw, nextNote, event, events, input, output, conn };
}

function make(script: ScriptEntry[], extra: Partial<DaemonOptions> = {}) {
  const dataDir = tmpDir();
  const store = new MemorySkillStore();
  store.add({ name: "weekly-report", description: "Write the weekly report. Use for weekly reports.", body: "WEEKLY-BODY" });
  store.add({ name: "invoice-chase", description: "Chase invoices.", body: "INVOICE-BODY" });
  const provider = createScriptedProvider(checked(script), {
    models: [{ id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", supportsTools: true, tier: "frontier" }],
  });
  const configs: ProviderConfig[] = [];
  const factory: ProviderFactory = (config) => {
    configs.push(config);
    return provider;
  };
  const logs: string[] = [];
  const daemon = createDaemon({
    store,
    providers: { anthropic: factory, local: factory },
    dataDir,
    startScheduler: false,
    log: (l) => logs.push(l),
    harness: { sleep: async () => undefined },
    ...extra,
  });
  onCleanup(() => void daemon.close());
  return { daemon, provider, configs, logs, dataDir, store, rpc: rpcClient(daemon) };
}

const run = (input: string, more: Record<string, unknown> = {}) => ({ input, provider: "anthropic", model: "claude-opus-5-5", ...more });

describe("daemon JSON-RPC", () => {
  it("answers hello, auth and models, and rejects bad requests", async () => {
    const { rpc, configs } = make([]);
    expect(await rpc.call("daemon.hello", { client: "test" })).toEqual({ version: "0.1.0", protocol: 1 });
    expect(await rpc.call("auth.status")).toEqual({ anthropic: false, openai: false, google: false, local: false });
    await expect(rpc.call("models.list", { provider: "anthropic" })).rejects.toMatchObject({ code: RPC_ERRORS.notAuthorised });
    expect(await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY, baseUrl: "https://proxy.example.com" })).toEqual({ ok: true });
    expect((await rpc.call("auth.status"))["anthropic"]).toBe(true);
    expect(await rpc.call("models.list", { provider: "anthropic" })).toEqual({
      models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "frontier" }],
    });
    expect(configs.at(-1)).toEqual({ apiKey: KEY, baseUrl: "https://proxy.example.com" });
    // No adapter for openai in this daemon.
    await expect(rpc.call("models.list", { provider: "openai" })).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
    expect(await rpc.call("auth.clear", { provider: "anthropic" })).toEqual({ ok: true });
    expect((await rpc.call("auth.status"))["anthropic"]).toBe(false);

    await expect(rpc.call("auth.set", { provider: "nope", apiKey: "x" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("auth.set", { provider: "anthropic", apiKey: "" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("auth.set", { provider: "anthropic", apiKey: "k", baseUrl: "ftp://x" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("no.such.method")).rejects.toMatchObject({ code: RPC_ERRORS.methodNotFound });
    await expect(rpc.call("toString")).rejects.toMatchObject({ code: RPC_ERRORS.methodNotFound });
    await expect(rpc.call("daemon.hello", [1])).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });

    rpc.writeLine("{not json");
    rpc.writeLine(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "daemon.hello" }));
    rpc.writeLine(JSON.stringify({ jsonrpc: "2.0", id: { bad: true }, method: "daemon.hello" }));
    rpc.writeLine(JSON.stringify([1, 2]));
    rpc.writeLine("   ");
    rpc.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "daemon.hello", params: {} })); // notification: no reply
    rpc.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "no.such" })); // notification error: no reply
    const hello = await rpc.call("daemon.hello", { client: "x" });
    expect(hello).toMatchObject({ protocol: 1 });
    const errors = rpc.notes.filter((m) => m.error).map((m) => [m.id, m.error!.code]);
    expect(errors).toEqual([
      [null, RPC_ERRORS.parse],
      [9, RPC_ERRORS.invalidRequest],
      [null, RPC_ERRORS.invalidRequest],
      [null, RPC_ERRORS.invalidRequest],
    ]);
  });

  it("harness.run returns a runId and streams events as notifications", async () => {
    const { rpc } = make([{ steps: [{ text: "Hello from the model" }] }]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("hi"))) as { runId: string };
    expect(runId).toMatch(/^run_/);
    const doneEv = await rpc.event(runId, "done");
    expect(doneEv).toMatchObject({ type: "done", stopReason: "end_turn", text: "Hello from the model" });
    expect(rpc.events(runId).map((e) => e.type)).toEqual(["session_start", "text_delta", "text_delta", "text_delta", "turn_end", "done"]);

    await expect(rpc.call("harness.run", { input: "x" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { provider: "google" }))).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
    await expect(rpc.call("harness.run", run("x", { maxTurns: 0 }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { effort: "max" }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { skill: 5 }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { disableSkills: "yes" }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { origin: { kind: "web" } }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { origin: { kind: "app" } }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { origin: { kind: "schedule" } }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", run("x", { origin: { kind: "app", appId: "ghost" } }))).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
    await expect(rpc.call("harness.run", run("x", { model: "" }))).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.run", "nope")).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
  });

  it("runs the local provider without a key", async () => {
    const { rpc } = make([{ steps: [{ text: "local ok" }] }]);
    const { runId } = (await rpc.call("harness.run", { input: "x", provider: "local", model: "m" })) as { runId: string };
    expect(await rpc.event(runId, "done")).toMatchObject({ text: "local ok" });
  });

  it("round-trips approvals through harness.approve", async () => {
    const { rpc, daemon } = make([
      { steps: [{ tool: "db_execute", input: { sql: "INSERT INTO customers (id, name) VALUES ('c1', 'Ada')" } }] },
      { steps: [{ tool: "db_execute", input: { sql: "DELETE FROM customers WHERE id = 'c1'" } }] },
      { steps: [{ tool: "db_execute", input: { sql: "DROP TABLE IF EXISTS posts" } }] },
      { steps: [{ text: "cleaned" }] },
    ]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("clean up"))) as { runId: string };
    const req = (await rpc.event(runId, "approval_request")) as Extract<HarnessEvent, { type: "approval_request" }>;
    expect(req.summary).toBe("Delete data: DELETE FROM customers WHERE id = 'c1'");
    expect(await rpc.call("harness.approve", { approvalId: "apr_unknown", approved: true })).toEqual({ ok: false });
    await expect(rpc.call("harness.approve", { approvalId: req.approvalId, approved: "yes" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    expect(await rpc.call("harness.approve", { approvalId: req.approvalId, approved: true })).toEqual({ ok: true });
    expect(await rpc.call("harness.approve", { approvalId: req.approvalId, approved: true })).toEqual({ ok: false });
    // Second approval: deny with a note.
    const second = await rpc.nextNote(
      (m) => m.method === "harness.event" && (m.params!["event"] as HarnessEvent).type === "approval_request" && (m.params!["event"] as { approvalId: string }).approvalId !== req.approvalId,
    );
    const id2 = (second.params!["event"] as { approvalId: string }).approvalId;
    await rpc.call("harness.approve", { approvalId: id2, approved: false, note: "keep posts" });
    const d = await rpc.event(runId, "done");
    expect(d).toMatchObject({ stopReason: "end_turn", text: "cleaned" });
    const results = rpc.events(runId).filter((e) => e.type === "approval_result");
    expect(results.map((r) => (r as { approved: boolean }).approved)).toEqual([true, false]);
    expect(daemon.db.db.prepare("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 0 });
    const log = (await rpc.call("actions.log", { limit: 2 })) as { entries: { tool: string; approved: boolean | null }[] };
    expect(log.entries.map((e) => e.approved)).toEqual([false, true]);
    expect(((await rpc.call("actions.log")) as { entries: unknown[] }).entries).toHaveLength(3);
    await expect(rpc.call("actions.log", { limit: 0 })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
  });

  it("cancels a run and releases its pending approval", async () => {
    const { rpc } = make([{ steps: [{ tool: "db_execute", input: { sql: "DELETE FROM customers" } }] }]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("x"))) as { runId: string };
    const req = (await rpc.event(runId, "approval_request")) as { approvalId: string };
    expect(await rpc.call("harness.cancel", { runId })).toEqual({ ok: true });
    expect(await rpc.event(runId, "done")).toMatchObject({ stopReason: "cancelled" });
    expect(await rpc.call("harness.cancel", { runId })).toEqual({ ok: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(await rpc.call("harness.approve", { approvalId: req.approvalId, approved: true })).toEqual({ ok: false });
  });

  it("round-trips questions through harness.answer, and only runs a person started can ask", async () => {
    const clock = { t: new Date(2026, 2, 13, 8, 0) };
    const { rpc, provider, daemon } = make([
      { steps: [{ tool: "ask_user", input: { question: "Which month?", options: ["March", "April"] } }] },
      (req) => {
        const r = req.messages.at(-1)!.content.find((p) => p.type === "tool_result") as { content: string };
        expect(r.content).toBe("April");
        return { steps: [{ tool: "ask_user", input: { question: "Anything else?" } }] };
      },
      (req) => {
        const r = req.messages.at(-1)!.content.find((p) => p.type === "tool_result") as { content: string };
        expect(r.content).toBe("The person skipped this question.");
        return { steps: [{ text: "April report." }] };
      },
      { steps: [{ text: "scheduled" }] },
    ], { now: () => clock.t });
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("monthly report"))) as { runId: string };
    const q = (await rpc.event(runId, "question")) as Extract<HarnessEvent, { type: "question" }>;
    expect(q).toMatchObject({ question: "Which month?", options: ["March", "April"] });
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain("ask_user");
    expect(await rpc.call("harness.answer", { questionId: "q_unknown", answer: "x" })).toEqual({ ok: false });
    await expect(rpc.call("harness.answer", { questionId: q.questionId })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("harness.answer", { questionId: "", answer: "x" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    expect(await rpc.call("harness.answer", { questionId: q.questionId, answer: "April" })).toEqual({ ok: true });
    expect(await rpc.call("harness.answer", { questionId: q.questionId, answer: "April" })).toEqual({ ok: false });
    const second = await rpc.nextNote(
      (m) => m.method === "harness.event" && (m.params!["event"] as HarnessEvent).type === "question" && (m.params!["event"] as { questionId: string }).questionId !== q.questionId,
    );
    const id2 = (second.params!["event"] as { questionId: string }).questionId;
    // An empty answer is a skip.
    expect(await rpc.call("harness.answer", { questionId: id2, answer: "" })).toEqual({ ok: true });
    expect(await rpc.event(runId, "done")).toMatchObject({ stopReason: "end_turn", text: "April report." });
    expect(rpc.events(runId).filter((e) => e.type === "question_answered").map((e) => (e as { answer: string }).answer)).toEqual(["April", ""]);

    // A scheduled run has nobody to ask: no ask_user.
    daemon.scheduler.upsert({ id: "s1", cron: "30 8 * * *", task: run("scheduled") as never, enabled: true });
    clock.t = new Date(2026, 2, 13, 8, 30);
    const fired = await daemon.scheduler.tick();
    expect(fired).toHaveLength(1);
    await rpc.event(fired[0]!.runId, "done");
    expect(provider.requests.at(-1)!.tools.map((t) => t.name)).not.toContain("ask_user");
  });

  it("a restricted schedule fires with only its allowed skills (security scan F2)", async () => {
    const clock = { t: new Date(2026, 2, 12, 9) };
    const { rpc, daemon, provider } = make([{ steps: [{ text: "done" }] }], { now: () => clock.t });
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    daemon.scheduler.upsert({ id: "s2", cron: "30 8 * * *", task: run("weekly") as never, enabled: true, allowedSkills: ["weekly-report"] });
    clock.t = new Date(2026, 2, 13, 8, 30);
    const fired = await daemon.scheduler.tick();
    await rpc.event(fired[0]!.runId, "done");
    const system = provider.requests.at(-1)!.system ?? "";
    expect(system).toContain("weekly-report");
    expect(system).not.toContain("invoice-chase");
  });

  it("cancelling a run releases its pending question", async () => {
    const { rpc } = make([{ steps: [{ tool: "ask_user", input: { question: "Which one?" } }] }]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("x"))) as { runId: string };
    const q = (await rpc.event(runId, "question")) as { questionId: string };
    expect(await rpc.call("harness.cancel", { runId })).toEqual({ ok: true });
    expect(await rpc.event(runId, "done")).toMatchObject({ stopReason: "cancelled" });
    expect(rpc.events(runId).filter((e) => e.type === "question_answered")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(await rpc.call("harness.answer", { questionId: q.questionId, answer: "late" })).toEqual({ ok: false });
  });

  it("delegates skills.* to the SkillStore", async () => {
    const { rpc } = make([]);
    const list = (await rpc.call("skills.list")) as { skills: { manifest: { frontmatter: { name: string } } }[] };
    expect(list.skills.map((s) => s.manifest.frontmatter.name)).toEqual(["weekly-report", "invoice-chase"]);
    expect(await rpc.call("skills.inspect", { source: "acme/skills@weekly-report" })).toMatchObject({ scan: { skill: "skills", verdict: "pass" } });
    expect(await rpc.call("skills.install", { source: "./local/thing", allowWarnings: true })).toMatchObject({ installed: false });
    await expect(rpc.call("skills.install", { source: "x", allowWarnings: 1 })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    expect(await rpc.call("skills.remove", { name: "invoice-chase" })).toEqual({ ok: true });
    expect(await rpc.call("skills.remove", { name: "invoice-chase" })).toEqual({ ok: false });
    await expect(rpc.call("skills.remove", {})).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
  });
});

describe("pinned apps over RPC", () => {
  const app = { id: "report-board", name: "Report board", version: "1.0.0", window: { width: 800, height: 600 }, allowedSkills: ["weekly-report"] };
  const html = "<!doctype html><html><body><script>oneseat.run('weekly-report', {})</script></body></html>";

  it("pins, lists, runs only allowed skills and unpins", async () => {
    const { rpc, dataDir, provider } = make([
      { steps: [{ text: "warm up" }] },
      (req) => {
        expect(req.system).toContain("WEEKLY-BODY");
        expect(req.system).not.toContain("invoice-chase");
        expect(req.messages[0]!.content[0]).toEqual({ type: "text", text: '{"week":12}' });
        return { steps: [{ text: '{"total": 42}' }] };
      },
      { steps: [{ text: "plain text result" }] },
    ]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const warm = (await rpc.call("harness.run", run("hi"))) as { runId: string };
    await rpc.event(warm.runId, "done");

    const pinned = (await rpc.call("apps.pin", { html, app })) as { app: { app: typeof app; htmlPath: string } };
    expect(pinned.app.htmlPath).toBe(join(dataDir, "apps", "report-board", "index.html"));
    expect(readFileSync(pinned.app.htmlPath, "utf8")).toContain("Content-Security-Policy");
    expect(JSON.parse(readFileSync(join(dataDir, "apps", "report-board", "app.json"), "utf8"))).toEqual(app);
    expect(((await rpc.call("apps.list")) as { apps: unknown[] }).apps).toHaveLength(1);

    const denied = await rpc.call("apps.run", { appId: "report-board", skill: "invoice-chase", input: "x" });
    expect(denied).toEqual({ ok: false, text: "", error: 'skill "invoice-chase" is not allowed for app "report-board"' });
    expect(await rpc.call("apps.run", { appId: "ghost", skill: "weekly-report", input: "x" })).toMatchObject({ ok: false, error: 'no pinned app "ghost"' });
    await expect(rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: 5 })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });

    const ok = await rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: { week: 12 } });
    expect(ok).toEqual({ ok: true, text: '{"total": 42}', data: { total: 42 } });
    expect(provider.requests[1]!.model).toBe("claude-opus-5-5");
    const plain = await rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: "again" });
    expect(plain).toEqual({ ok: true, text: "plain text result" });
    // App runs stream events like any other run (for approvals in the shell).
    expect(rpc.notes.filter((m) => m.method === "harness.event" && (m.params!["event"] as HarnessEvent).type === "skill_loaded").length).toBe(2);

    await expect(rpc.call("apps.pin", { html: '<script src="https://cdn.example.com/x.js"></script>', app })).rejects.toMatchObject({
      code: RPC_ERRORS.invalidParams,
      data: { issues: expect.arrayContaining([expect.objectContaining({ rule: "remote-resource" })]) },
    });
    expect(await rpc.call("apps.unpin", { id: "report-board" })).toEqual({ ok: true });
    expect(await rpc.call("apps.unpin", { id: "report-board" })).toEqual({ ok: false });
  });

  it("an app run reports a failed run and finds a default model from the providers", async () => {
    const { rpc, provider } = make([{ steps: [{ error: { kind: "auth", message: `bad key ${KEY}` } }] }], {
      providers: { anthropic: (() => undefined) as never, local: () => provider },
    });
    await rpc.call("apps.pin", { html, app });
    // anthropic has no key, so the first provider that can list models (local) is used.
    const r = await rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: "x" });
    expect(r).toEqual({ ok: false, text: "", error: "bad key [REDACTED]" });
    expect(provider.requests[0]!.model).toBe("claude-opus-5-5");
  });

  it("uses the configured default model and fails clearly without one", async () => {
    const a = make([{ steps: [{ text: "ok" }] }], { defaultModel: { provider: "local", model: "llama" }, providers: {} });
    await a.rpc.call("apps.pin", { html, app });
    // No local adapter: the run fails with a clear message.
    expect(await a.rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: "x" })).toEqual({
      ok: false,
      text: "",
      error: "no adapter for provider local",
    });
    const b = make([], { providers: {} });
    await b.rpc.call("apps.pin", { html, app });
    await expect(b.rpc.call("apps.run", { appId: "report-board", skill: "weekly-report", input: "x" })).rejects.toMatchObject({
      code: RPC_ERRORS.notAuthorised,
    });
  });

  it("serves drafts made by make_artifact", async () => {
    const { rpc } = make([
      { steps: [{ tool: "make_artifact", input: { name: "Report board", html, allowedSkills: ["weekly-report"] } }] },
      { steps: [{ text: "made" }] },
    ]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const { runId } = (await rpc.call("harness.run", run("make me an app"))) as { runId: string };
    const end = (await rpc.event(runId, "tool_end")) as Extract<HarnessEvent, { type: "tool_end" }>;
    const { draftId } = JSON.parse(end.result.content) as { draftId: string };
    const drafts = (await rpc.call("apps.drafts")) as { drafts: { id: string; appId: string }[] };
    expect(drafts.drafts).toEqual([expect.objectContaining({ id: draftId, appId: "report-board", name: "Report board" })]);
    const bundle = (await rpc.call("apps.draft", { draftId })) as { html: string; app: { id: string } };
    expect(bundle.html).toBe(html);
    const pinned = (await rpc.call("apps.pin", bundle)) as { app: { app: { id: string } } };
    expect(pinned.app.app.id).toBe("report-board");
    await expect(rpc.call("apps.draft", { draftId: "nope" })).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
  });
});

describe("schedules over RPC", () => {
  it("upserts, fires on the clock and removes", async () => {
    const clock = { t: new Date(2026, 2, 13, 8, 0) };
    const { rpc, daemon } = make([{ steps: [{ text: "Morning brief." }] }], { now: () => clock.t });
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const task = { input: "Morning brief", provider: "anthropic", model: "claude-opus-5-5", origin: { kind: "main" } };
    const r = (await rpc.call("schedules.upsert", { id: "brief", cron: "30 8 * * *", task, enabled: true })) as { schedule: Record<string, unknown> };
    expect(r.schedule).toEqual({
      id: "brief",
      cron: "30 8 * * *",
      task: { input: "Morning brief", provider: "anthropic", model: "claude-opus-5-5" },
      enabled: true,
      nextRunAt: new Date(2026, 2, 13, 8, 30).toISOString(),
    });
    await expect(rpc.call("schedules.upsert", { id: "x", cron: "bad", task, enabled: true })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("schedules.upsert", { id: "x", cron: "* * * * *", task, enabled: "yes" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(rpc.call("schedules.upsert", { id: "x", cron: "* * * * *", task: { input: 1 }, enabled: true })).rejects.toMatchObject({
      code: RPC_ERRORS.invalidParams,
    });
    clock.t = new Date(2026, 2, 13, 8, 30);
    const fired = await daemon.scheduler.tick();
    expect(fired).toHaveLength(1);
    const note = await rpc.nextNote((m) => m.method === "schedule.fired");
    expect(note.params).toEqual({ scheduleId: "brief", runId: fired[0]!.runId });
    expect(await rpc.event(fired[0]!.runId, "done")).toMatchObject({ text: "Morning brief." });
    const sessionStart = rpc.events(fired[0]!.runId)[0] as { sessionId: string };
    expect(daemon.harness.sessions.get(sessionStart.sessionId)!.origin).toEqual({ kind: "schedule", scheduleId: "brief" });
    const list = (await rpc.call("schedules.list")) as { schedules: { lastRunAt?: string }[] };
    expect(list.schedules[0]!.lastRunAt).toBe(clock.t.toISOString());
    expect(await rpc.call("schedules.remove", { id: "brief" })).toEqual({ ok: true });
    expect(await rpc.call("schedules.remove", { id: "brief" })).toEqual({ ok: false });
  });
});

describe("secrets", () => {
  it("never writes the API key to logs, events, errors, the database or app files", async () => {
    const { rpc, logs, dataDir, daemon } = make([
      { steps: [{ tool: "memory_save", input: { content: `the key is ${KEY}` } }] },
      { steps: [{ tool: "workspace_write", input: { path: "k.txt", content: `x-api-key: ${KEY}` } }] },
      { steps: [{ text: `Here it is: ${KEY}` }] },
      { steps: [{ error: { kind: "auth", message: `401 invalid x-api-key ${KEY}` } }] },
    ]);
    await rpc.call("auth.set", { provider: "anthropic", apiKey: KEY });
    const a = (await rpc.call("harness.run", run(`my key is ${KEY}`))) as { runId: string };
    await rpc.event(a.runId, "done");
    const b = (await rpc.call("harness.run", run("again"))) as { runId: string };
    const err = (await rpc.event(b.runId, "error")) as { message: string };
    expect(err.message).toBe("401 invalid x-api-key [REDACTED]");
    await expect(rpc.call("apps.pin", { html: KEY, app: { id: "Bad" } })).rejects.toBeDefined();
    daemon.logger.error(`something failed with ${KEY}`);
    await daemon.close();

    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toContain(KEY);
    // Every notification and response the client saw, streamed text included
    // (the key is split across 8-character chunks by the scripted provider).
    expect(rpc.raw.length).toBeGreaterThan(10);
    for (const l of rpc.raw) expect(l).not.toContain(KEY);
    const streamed = rpc.events(a.runId).filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(streamed).toBe("Here it is: [REDACTED]");
    // Tool results given to the model and shown in events are redacted.
    const toolEnds = rpc.events(a.runId).filter((e) => e.type === "tool_end");
    expect(toolEnds.length).toBe(2);
    // The data directory: database, WAL, workspace and apps. The person's own
    // message and memory are stored as typed; the key must not be among them.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dataDir);
    expect(files.some((f) => f.endsWith("oneseat.db"))).toBe(true);
    for (const f of files) expect(readFileSync(f).includes(Buffer.from(KEY)), f).toBe(false);
  });
});

describe("lifecycle", () => {
  it("loads MCP servers, reports their status and serves stdio", async () => {
    const dir = tmpDir();
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [MCP_SERVER] } } }));
    const { daemon } = make([{ steps: [{ tool: "mcp__fake__echo", input: { text: "via mcp" } }] }, { steps: [{ text: "ok" }] }], {
      mcpConfigPath: cfg,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const conn = serveStdio(daemon, { input, output });
    const lines: string[] = [];
    createInterface({ input: output }).on("line", (l) => lines.push(l));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mcp.status", params: {} }) + "\n");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lines.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(JSON.parse(lines[0]!).result).toEqual({ servers: [{ id: "fake", connected: true, tools: 12 }] });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "harness.run", params: { input: "x", provider: "local", model: "m" } }) + "\n");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lines.some((l) => l.includes('"type":"done"'))) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(lines.some((l) => l.includes('"content":"via mcp"'))).toBe(true);
    input.end();
    await conn.closed;
    await new Promise((r) => setTimeout(r, 20));
    await expect(daemon.request("daemon.hello", {})).rejects.toThrow("shutting down");
    await daemon.close();
  });

  it("starts the scheduler loop and survives a bad MCP config", async () => {
    const dir = tmpDir();
    const { daemon, logs } = make([], { startScheduler: true, mcpConfigPath: dir, schedulerIntervalMs: 60_000 });
    await daemon.ready;
    expect(daemon.scheduler.running).toBe(true);
    expect(logs.some((l) => l.includes("could not load MCP servers"))).toBe(true);
    await daemon.close();
    expect(daemon.scheduler.running).toBe(false);
    await daemon.close();
  });

  it("closing before init finishes shuts MCP servers down", async () => {
    const dir = tmpDir();
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [MCP_SERVER] } } }));
    const { daemon } = make([], { mcpConfigPath: cfg });
    await daemon.close();
    await daemon.ready;
  });
});
