// End to end: JSON-RPC client -> daemon -> harness -> real Anthropic adapter -> a local
// fake Messages API (SSE) -> tools against the real starter skills and SQLite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { startDaemon, parseModelRef, defaultDataDir, type StartedDaemon } from "../src/index.js";

const SKILLS = resolve(__dirname, "../../../skills");
const KEY = "sk-ant-test-SECRET-key-0123456789abcdef";

type Turn = (body: any) => { blocks: ({ text: string } | { tool: string; input: unknown })[] };

function sse(blocks: ReturnType<Turn>["blocks"]): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  let out = ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 50, output_tokens: 0 } } });
  let tool = false;
  blocks.forEach((b, i) => {
    if ("text" in b) {
      out += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      tool = true;
      out += ev("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${i}_${b.tool}`, name: b.tool, input: {} } });
      out += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index: i });
  });
  out += ev("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
  out += ev("message_stop", {});
  return out;
}

class FakeAnthropic {
  server!: Server;
  url = "";
  turns: Turn[] = [];
  bodies: any[] = [];
  headers: Record<string, string | string[] | undefined>[] = [];
  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        const body = JSON.parse(raw);
        this.bodies.push(body);
        this.headers.push(req.headers);
        const turn = this.turns.shift();
        if (!turn) {
          res.writeHead(500).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(turn(body).blocks));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }
}

class Client {
  input = new PassThrough();
  output = new PassThrough();
  lines: string[] = [];
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  notifications: any[] = [];
  private waiters: { pred: (n: any) => boolean; resolve: (n: any) => void }[] = [];
  constructor() {
    let buf = "";
    this.output.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        this.lines.push(line);
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        } else if (msg.method) {
          this.notifications.push(msg);
          this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
        }
      }
    });
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(Object.assign(new Error(m.error.message), { code: m.error.code })) : res(m.result)));
      this.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  waitFor(pred: (n: any) => boolean, ms = 15_000): Promise<any> {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for notification")), ms);
      this.waiters.push({ pred, resolve: (n) => (clearTimeout(t), resolve(n)) });
    });
  }
  events(runId: string) {
    return this.notifications.filter((n) => n.method === "harness.event" && n.params.runId === runId).map((n) => n.params.event);
  }
}

let dir: string;
let started: StartedDaemon;
let api: FakeAnthropic;
let client: Client;
const logs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oneseat-e2e-"));
  api = new FakeAnthropic();
  await api.start();
  started = await startDaemon({
    dataDir: dir,
    bundledSkillsDir: SKILLS,
    log: (l) => logs.push(l),
    startScheduler: false,
    harness: { retry: { maxRetries: 0 } } as never,
  });
  client = new Client();
  started.daemon.connect(client.input, client.output);
  const db = new DatabaseSync(join(dir, "oneseat.db"));
  db.exec(`INSERT INTO customers (id, name, email) VALUES ('c1','Ada Lovelace','ada@example.com'), ('c2','Bo Chen','bo@example.com');
           INSERT INTO purchases (id, customer_id, product, amount_cents, purchased_at) VALUES
           ('p1','c1','Annual plan',120000,'2026-10-01'), ('p2','c2','Monthly plan',9900,'2026-11-01');`);
  db.close();
});

afterAll(async () => {
  await started?.daemon.close();
  api?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon wiring", () => {
  it("seeds every starter skill through scan and lint on first run", async () => {
    expect(started.seeded.sort()).toEqual(readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory()).sort());
    const { skills } = await client.call("skills.list");
    expect(skills).toHaveLength(7);
    for (const s of skills) expect((await started.store.verify(s.manifest.frontmatter.name)).ok).toBe(true);
  });

  it("does not reseed on the next start", async () => {
    const again = await startDaemon({ dataDir: dir, bundledSkillsDir: SKILLS, log: () => {}, startScheduler: false });
    expect(again.seeded).toEqual([]);
    await again.daemon.close();
  });

  it("parses model refs and data dirs", () => {
    expect(parseModelRef("openai:gpt-x")).toEqual({ provider: "openai", model: "gpt-x" });
    expect(parseModelRef("nope:x")).toBeUndefined();
    expect(parseModelRef("anthropic")).toBeUndefined();
    expect(defaultDataDir({ ONESEAT_HOME: "/tmp/x" })).toBe(resolve("/tmp/x"));
    expect(defaultDataDir({}, "darwin")).toMatch(/Application Support[\\/]app\.oneseat$/);
    expect(defaultDataDir({ APPDATA: "C:\\U\\AppData\\Roaming" }, "win32")).toMatch(/app\.oneseat$/);
  });

  it("runs a routed skill end to end on the real Anthropic adapter", async () => {
    await client.call("auth.set", { provider: "anthropic", apiKey: KEY, baseUrl: api.url });
    expect((await client.call("auth.status")).anthropic).toBe(true);

    api.turns.push(
      (body) => {
        // Router: index only — every skill name + description, no bodies.
        expect(body.system).toContain("customers");
        expect(body.system).toContain("weekly-report");
        expect(body.system).not.toContain("Always pass values as params");
        return { blocks: [{ text: "Let me check. " }, { tool: "load_skill", input: { name: "customers" } }] };
      },
      (body) => {
        const last = body.messages.at(-1);
        const result = last.content.find((c: any) => c.type === "tool_result");
        expect(JSON.stringify(result.content)).toContain("customer_ltv");
        return { blocks: [{ tool: "db_query", input: { sql: "SELECT name, ltv_cents FROM customer_ltv ORDER BY ltv_cents DESC LIMIT 1", params: [] } }] };
      },
      (body) => {
        const result = body.messages.at(-1).content.find((c: any) => c.type === "tool_result");
        expect(JSON.stringify(result.content)).toContain("Ada Lovelace");
        return { blocks: [{ text: "Your top customer is Ada Lovelace ($1,200.00 lifetime)." }] };
      },
    );

    const { runId } = await client.call("harness.run", { input: "Who is my best customer?", provider: "anthropic", model: "claude-sonnet-5-5" });
    const done = await client.waitFor((n) => n.method === "harness.event" && n.params.runId === runId && n.params.event.type === "done");
    expect(done.params.event.stopReason).toBe("end_turn");
    expect(done.params.event.text).toContain("Ada Lovelace");
    const evs = client.events(runId);
    expect(evs.some((e) => e.type === "skill_loaded" && e.name === "customers")).toBe(true);
    expect(evs.filter((e) => e.type === "tool_end").every((e) => !e.result.isError)).toBe(true);
    expect(api.headers[0]!["x-api-key"]).toBe(KEY);
  });

  it("asks a person before a delete and passes a denial back to the model", async () => {
    api.turns.push(
      () => ({ blocks: [{ tool: "db_execute", input: { sql: "DELETE FROM customers WHERE id = ?", params: ["c2"] } }] }),
      (body) => {
        const result = body.messages.at(-1).content.find((c: any) => c.type === "tool_result");
        expect(result.is_error).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/keep bo/i);
        return { blocks: [{ text: "Understood, I kept Bo Chen." }] };
      },
    );
    const { runId } = await client.call("harness.run", { input: "Delete Bo", provider: "anthropic", model: "claude-sonnet-5-5" });
    const req = await client.waitFor((n) => n.method === "harness.event" && n.params.runId === runId && n.params.event.type === "approval_request");
    expect(req.params.event.effects).toContain("delete");
    await client.call("harness.approve", { approvalId: req.params.event.approvalId, approved: false, note: "Keep Bo, he is renewing" });
    await client.waitFor((n) => n.method === "harness.event" && n.params.runId === runId && n.params.event.type === "done");
    const db = new DatabaseSync(join(dir, "oneseat.db"), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS n FROM customers WHERE id = 'c2'").get()).toEqual({ n: 1 });
    db.close();
    const { entries } = await client.call("actions.log", { limit: 50 });
    const del = entries.find((e: any) => e.tool === "db_execute");
    expect(del.approved).toBe(false);
  });

  it("never writes the key to the wire, the logs or the data folder", () => {
    for (const line of client.lines) expect(line).not.toContain(KEY);
    for (const l of logs) expect(l).not.toContain(KEY);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(dir)) expect(readFileSync(f).includes(Buffer.from(KEY))).toBe(false);
  });
});
