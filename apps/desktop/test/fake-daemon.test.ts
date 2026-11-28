// @vitest-environment node
// The fake daemon is what dev mode and the e2e tests run against, so check it speaks
// the DaemonMethods protocol the way the shell expects.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DaemonMethod, DaemonMethods, HarnessEvent } from "@oneseat/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../dev/fake-daemon.mjs", import.meta.url));

class Client {
  private next = 1;
  private pending = new Map<number, (m: { result?: unknown; error?: { code: number; message: string } }) => void>();
  readonly events: { runId: string; event: HarnessEvent }[] = [];
  readonly stderr: string[] = [];
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.id === undefined) {
        if (m.method === "harness.event") this.events.push(m.params);
      } else this.pending.get(m.id)?.(m);
    });
    createInterface({ input: child.stderr }).on("line", (l) => this.stderr.push(l));
  }
  raw(method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"]): Promise<DaemonMethods[M]["result"]> {
    const r = await this.raw(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result as DaemonMethods[M]["result"];
  }
  async waitFor(pred: (e: { runId: string; event: HarnessEvent }) => boolean): Promise<{ runId: string; event: HarnessEvent }> {
    for (let i = 0; i < 400; i++) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for event");
  }
}

let home: string;
let c: Client;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "oneseat-fake-test-"));
  const child = spawn(process.execPath, [script], { env: { ...process.env, ONESEAT_HOME: home, FAKE_DAEMON_STEP_MS: "1" } });
  c = new Client(child);
});

afterAll(() => {
  c.child.kill();
  rmSync(home, { recursive: true, force: true });
});

describe("fake daemon", () => {
  it("handshakes, gates runs on keys and never logs keys", async () => {
    expect(await c.call("daemon.hello", { client: "test" })).toEqual({ version: "0.0.0-fake", protocol: 1 });
    expect(await c.call("auth.status", {})).toEqual({ anthropic: false, openai: false, google: false, local: false });
    await expect(c.call("harness.run", { input: "hi", provider: "anthropic", model: "claude-opus-5-5" })).rejects.toMatchObject({ code: -32001 });
    await c.call("auth.set", { provider: "anthropic", apiKey: "sk-ant-fake-key-123456" });
    expect((await c.call("auth.status", {})).anthropic).toBe(true);
    expect(c.stderr.join("\n")).not.toContain("sk-ant-fake");
    expect((await c.raw("nope.nope", {})).error?.code).toBe(-32601);
    expect((await c.raw("auth.set", { provider: "zzz", apiKey: "x" })).error?.code).toBe(-32602);
  });

  it("streams a default run", async () => {
    const { runId } = await c.call("harness.run", { input: "weekly recap", provider: "anthropic", model: "claude-opus-5-5" });
    const done = await c.waitFor((e) => e.runId === runId && e.event.type === "done");
    const types = c.events.filter((e) => e.runId === runId).map((e) => e.event.type);
    expect(types[0]).toBe("session_start");
    expect(types).toEqual(expect.arrayContaining(["skill_loaded", "tool_start", "tool_end", "text_delta", "turn_end"]));
    expect(done.event).toMatchObject({ stopReason: "end_turn" });
  });

  it("waits for approval and reports the decision", async () => {
    const { runId } = await c.call("harness.run", { input: "send the reminder email", provider: "anthropic", model: "m" });
    const req = await c.waitFor((e) => e.runId === runId && e.event.type === "approval_request");
    const approvalId = (req.event as Extract<HarnessEvent, { type: "approval_request" }>).approvalId;
    expect(await c.call("harness.approve", { approvalId: "unknown", approved: true })).toEqual({ ok: false });
    expect(await c.call("harness.approve", { approvalId, approved: false, note: "not yet" })).toEqual({ ok: true });
    const done = await c.waitFor((e) => e.runId === runId && e.event.type === "done");
    expect((done.event as Extract<HarnessEvent, { type: "done" }>).text).toContain("not yet");
    const log = await c.call("actions.log", { limit: 5 });
    expect(log.entries[0]).toMatchObject({ tool: "email_send", approved: false });
  });

  it("cancels a run", async () => {
    const { runId } = await c.call("harness.run", { input: "slow recap", provider: "anthropic", model: "m" });
    await c.waitFor((e) => e.runId === runId && e.event.type === "text_delta");
    expect(await c.call("harness.cancel", { runId })).toEqual({ ok: true });
    const done = await c.waitFor((e) => e.runId === runId && e.event.type === "done");
    expect(done.event).toMatchObject({ stopReason: "cancelled" });
  });

  it("inspects and installs skills by verdict", async () => {
    const pass = await c.call("skills.inspect", { source: "acme/support-replies" });
    expect(pass.scan.verdict).toBe("pass");
    expect(pass.scan.skill).toBe("support-replies");
    const block = await c.call("skills.inspect", { source: "https://github.com/bad/evil-skill" });
    expect(block.scan.verdict).toBe("block");
    expect((await c.call("skills.install", { source: "https://github.com/bad/evil-skill" })).installed).toBe(false);
    expect((await c.call("skills.install", { source: "./warn-notes" })).installed).toBe(false);
    expect((await c.call("skills.install", { source: "./warn-notes", allowWarnings: true })).installed).toBe(true);
    expect((await c.call("skills.install", { source: "acme/support-replies" })).installed).toBe(true);
    const names = (await c.call("skills.list", {})).skills.map((s) => s.manifest.frontmatter.name);
    expect(names).toEqual(expect.arrayContaining(["support-replies", "warn-notes", "invoice-chaser"]));
    expect(await c.call("skills.remove", { name: "support-replies" })).toEqual({ ok: true });
    await expect(c.call("skills.inspect", { source: "missing/thing" })).rejects.toMatchObject({ code: -32004 });
  });

  it("searches a canned skills.sh and restores removed starter skills", async () => {
    const { results } = await c.call("skills.search", { query: "invoice" });
    expect(results.map((r) => r.skill)).toEqual(["invoice-chase", "invoice-organizer"]);
    expect(results.every((r) => r.installed === false && r.repo && r.installs > 0)).toBe(true);
    expect((await c.call("skills.search", { query: "weekly" })).results[0]).toMatchObject({ skill: "weekly-report", installed: true });
    expect(await c.call("skills.search", { query: "  " })).toEqual({ results: [] });
    expect(await c.call("skills.search", { query: "zzz" })).toEqual({ results: [] });
    await expect(c.call("skills.search", { query: "offline" })).rejects.toMatchObject({ code: -32603 });
    expect((await c.call("skills.inspect", { source: "skills.sh:acme/support-replies/support-replies" })).scan.skill).toBe("support-replies");

    expect(await c.call("skills.restorable", {})).toEqual({ skills: [] });
    expect(await c.call("skills.remove", { name: "social-posts" })).toEqual({ ok: true });
    const { skills } = await c.call("skills.restorable", {});
    expect(skills.map((s) => s.name)).toEqual(["social-posts"]);
    expect(skills[0]!.description).toMatch(/social media/);
    await expect(c.call("skills.restore", { name: "nope" })).rejects.toMatchObject({ code: -32004 });
    expect(await c.call("skills.restore", { name: "social-posts" })).toMatchObject({ installed: true, skill: { manifest: { frontmatter: { name: "social-posts" } } } });
    await expect(c.call("skills.restore", { name: "social-posts" })).rejects.toMatchObject({ code: -32602 });
    expect(await c.call("skills.restorable", {})).toEqual({ skills: [] });
  });

  it("pins apps to ONESEAT_HOME and enforces allowedSkills in apps.run", async () => {
    const { runId } = await c.call("harness.run", { input: "make an invoice tracker app", provider: "anthropic", model: "m" });
    const end = await c.waitFor((e) => e.runId === runId && e.event.type === "tool_end");
    const { draftId } = JSON.parse((end.event as Extract<HarnessEvent, { type: "tool_end" }>).result.content);
    const bundle = await c.call("apps.draft", { draftId });
    expect((await c.call("apps.drafts", {})).drafts.map((d) => d.id)).toContain(draftId);
    const { app } = await c.call("apps.pin", bundle);
    expect(existsSync(join(home, "apps", "invoice-tracker", "index.html"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "apps", "invoice-tracker", "app.json"), "utf8")).id).toBe("invoice-tracker");
    expect(app.htmlPath).toBe(join(home, "apps", "invoice-tracker", "index.html"));
    expect((await c.call("apps.list", {})).apps).toHaveLength(1);
    expect(await c.call("apps.run", { appId: "invoice-tracker", skill: "invoice-chaser", input: { a: 1 } })).toMatchObject({ ok: true });
    expect(await c.call("apps.run", { appId: "invoice-tracker", skill: "weekly-report", input: "x" })).toMatchObject({ ok: false });
    await expect(c.call("apps.run", { appId: "nope", skill: "x", input: "" })).rejects.toMatchObject({ code: -32004 });
    expect(await c.call("apps.unpin", { id: "invoice-tracker" })).toEqual({ ok: true });
    expect(existsSync(join(home, "apps", "invoice-tracker"))).toBe(false);
  });

  it("manages schedules", async () => {
    const task = { input: "weekly report", provider: "anthropic" as const, model: "claude-opus-5-5" };
    const { schedule } = await c.call("schedules.upsert", { id: "s1", cron: "0 9 * * mon", task, enabled: true });
    expect(schedule.nextRunAt).toBeTruthy();
    await expect(c.call("schedules.upsert", { id: "s2", cron: "bad", task, enabled: true })).rejects.toMatchObject({ code: -32602 });
    expect((await c.call("schedules.list", {})).schedules.map((s) => s.id)).toEqual(["s1"]);
    expect(await c.call("schedules.remove", { id: "s1" })).toEqual({ ok: true });
    expect((await c.call("schedules.list", {})).schedules).toEqual([]);
  });
});

describe("fake daemon approval timing", () => {
  it("accepts an answer that arrives the moment the request is seen", async () => {
    // A slow step widens the gap between emitting approval_request and the next step,
    // so a waiter registered after the emit would miss this instant answer.
    const dir = mkdtempSync(join(tmpdir(), "oneseat-fake-slow-"));
    const slow = new Client(spawn(process.execPath, [script], { env: { ...process.env, ONESEAT_HOME: dir, FAKE_DAEMON_STEP_MS: "150" } }));
    try {
      await slow.call("auth.set", { provider: "anthropic", apiKey: "sk-ant-fake-key-123456" });
      const { runId } = await slow.call("harness.run", { input: "send the reminder email", provider: "anthropic", model: "m" });
      const req = await slow.waitFor((e) => e.runId === runId && e.event.type === "approval_request");
      const approvalId = (req.event as Extract<HarnessEvent, { type: "approval_request" }>).approvalId;
      expect(await slow.call("harness.approve", { approvalId, approved: false })).toEqual({ ok: true });
    } finally {
      slow.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
