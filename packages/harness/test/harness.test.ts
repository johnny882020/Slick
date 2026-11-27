import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, HarnessEvent, ToolResultPart } from "@oneseat/contracts";
import { createScriptedProvider } from "@oneseat/contracts";
import type { RegisteredTool } from "../src/tools/registry.js";
import { sleep } from "../src/util.js";
import { approveAll, collect, denyAll, done, MemorySkillStore, ofType, setup, task } from "./helpers.js";

const WEEKLY_BODY = "# Weekly report\n\nWEEKLY-BODY-MARKER. Use the [template](templates/brief.md).\n";

function skillsStore(): MemorySkillStore {
  const store = new MemorySkillStore();
  store.add({
    name: "weekly-report",
    description: "Collect the week's numbers and write a one-page brief. Use when the user asks for a weekly report.",
    body: WEEKLY_BODY,
    files: { "templates/brief.md": "BRIEF TEMPLATE", "notes/hidden.md": "not linked" },
  });
  store.add({
    name: "invoice-chase",
    description: "Find overdue invoices and draft polite reminders. Use when asked to chase unpaid invoices.",
    body: "# Invoice chase\n\nINVOICE-BODY-MARKER\n",
  });
  return store;
}

function lastResults(req: ChatRequest): ToolResultPart[] {
  const m = req.messages[req.messages.length - 1]!;
  return m.content.filter((p): p is ToolResultPart => p.type === "tool_result");
}

describe("skill routing", () => {
  it("sends only the skill index at session start", async () => {
    const { harness, provider } = setup([{ steps: [{ text: "Hello there" }] }], { store: skillsStore() });
    const events = await collect(harness.run(task("hi"), approveAll));
    const sys = provider.requests[0]!.system;
    expect(sys).toContain("- weekly-report: Collect the week's numbers");
    expect(sys).toContain("- invoice-chase: Find overdue invoices");
    expect(sys).toContain("call load_skill");
    expect(sys).not.toContain("WEEKLY-BODY-MARKER");
    expect(sys).not.toContain("INVOICE-BODY-MARKER");
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain("load_skill");
    expect(ofType(events, "skill_loaded")).toEqual([]);
    expect(events[0]).toMatchObject({ type: "session_start" });
    expect(done(events)).toMatchObject({ stopReason: "end_turn", text: "Hello there" });
  });

  it("loads a skill only when the model asks for it, with linked files and scripts listed", async () => {
    const store = skillsStore();
    const { harness, provider } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "weekly-report" } }] },
        (req) => {
          const r = lastResults(req)[0]!;
          expect(r.name).toBe("load_skill");
          expect(r.content).toContain("WEEKLY-BODY-MARKER");
          expect(r.content).toContain("- templates/brief.md");
          return { steps: [{ tool: "read_skill_file", input: { skill: "weekly-report", path: "templates/brief.md" } }] };
        },
        (req) => {
          expect(lastResults(req)[0]!.content).toBe("BRIEF TEMPLATE");
          return { steps: [{ text: "Report written." }] };
        },
      ],
      { store },
    );
    const events = await collect(harness.run(task("Write my weekly report"), approveAll));
    expect(ofType(events, "skill_loaded")).toEqual([{ type: "skill_loaded", name: "weekly-report", reason: "router" }]);
    expect(ofType(events, "skill_file_read")).toEqual([{ type: "skill_file_read", skill: "weekly-report", file: "templates/brief.md" }]);
    expect(done(events).text).toBe("Report written.");
    // The body arrives through the tool result, never the system prompt.
    for (const r of provider.requests) expect(r.system).not.toContain("WEEKLY-BODY-MARKER");
    expect(store.reads).toEqual([{ name: "weekly-report", file: "templates/brief.md" }]);
  });

  it("does not load skills for tasks that do not match", async () => {
    const { harness } = setup([{ steps: [{ text: "The capital of France is Paris." }] }], { store: skillsStore() });
    const events = await collect(harness.run(task("What is the capital of France?"), approveAll));
    expect(ofType(events, "skill_loaded")).toHaveLength(0);
  });

  it("returns a helpful error for an unknown skill and a repeated load", async () => {
    const { harness } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "nope" } }] },
        (req) => {
          expect(lastResults(req)[0]).toMatchObject({ isError: true });
          expect(lastResults(req)[0]!.content).toContain("Available skills: invoice-chase, weekly-report");
          return { steps: [{ tool: "load_skill", input: { name: "invoice-chase" } }, { tool: "load_skill", input: { name: "invoice-chase" } }] };
        },
        (req) => {
          const [a, b] = lastResults(req);
          expect(a!.content).not.toContain("(already loaded)");
          expect(b!.content).toContain("(already loaded)");
          return { steps: [{ text: "ok" }] };
        },
      ],
      { store: skillsStore() },
    );
    const events = await collect(harness.run(task("chase"), approveAll));
    expect(ofType(events, "skill_loaded")).toHaveLength(1);
    expect(done(events).stopReason).toBe("end_turn");
  });

  it("force-loads TaskRequest.skill into the system prompt", async () => {
    const { harness, provider } = setup([{ steps: [{ text: "done" }] }], { store: skillsStore() });
    const events = await collect(harness.run(task("go", { skill: "weekly-report" }), approveAll));
    expect(events[1]).toEqual({ type: "skill_loaded", name: "weekly-report", reason: "forced" });
    expect(provider.requests[0]!.system).toContain("WEEKLY-BODY-MARKER");
    expect(provider.requests[0]!.system).toContain("Active skill");
    expect(provider.requests[0]!.system).not.toContain("INVOICE-BODY-MARKER");
  });

  it("fails a forced skill that is not installed", async () => {
    const { harness, provider } = setup([{ steps: [{ text: "x" }] }], { store: skillsStore() });
    const events = await collect(harness.run(task("go", { skill: "missing" }), approveAll));
    expect(ofType(events, "error")[0]!.message).toContain('skill "missing" is not installed');
    expect(done(events).stopReason).toBe("error");
    expect(provider.requests).toHaveLength(0);
  });

  it("disableSkills gives no index and no skill tools", async () => {
    const { harness, provider } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "weekly-report" } }] },
        (req) => {
          expect(lastResults(req)[0]!.isError).toBe(true);
          expect(lastResults(req)[0]!.content).toContain("skills are off");
          return { steps: [{ text: "baseline answer" }] };
        },
      ],
      { store: skillsStore() },
    );
    const events = await collect(harness.run(task("Write my weekly report", { disableSkills: true }), approveAll));
    const req = provider.requests[0]!;
    expect(req.system).not.toContain("<skills>");
    expect(req.system).not.toContain("weekly-report");
    const names = req.tools.map((t) => t.name);
    for (const n of ["load_skill", "read_skill_file", "run_skill_script"]) expect(names).not.toContain(n);
    expect(names).toContain("db_query");
    expect(ofType(events, "skill_loaded")).toHaveLength(0);
    expect(done(events).text).toBe("baseline answer");
  });

  it("rejects skill together with disableSkills", async () => {
    const { harness } = setup([], { store: skillsStore() });
    const events = await collect(harness.run(task("x", { skill: "weekly-report", disableSkills: true }), approveAll));
    expect(ofType(events, "error")[0]!.message).toContain("cannot be used together");
  });

  it("read_skill_file needs a loaded skill and a path inside the folder", async () => {
    const { harness } = setup(
      [
        { steps: [{ tool: "read_skill_file", input: { skill: "weekly-report", path: "templates/brief.md" } }] },
        (req) => {
          expect(lastResults(req)[0]!.content).toContain("Load the skill first");
          return { steps: [{ tool: "load_skill", input: { name: "weekly-report" } }] };
        },
        {
          steps: [
            { tool: "read_skill_file", input: { skill: "weekly-report", path: "../invoice-chase/SKILL.md" } },
            { tool: "read_skill_file", input: { skill: "weekly-report", path: "/etc/passwd" } },
            { tool: "read_skill_file", input: { skill: "weekly-report", path: "templates/nope.md" } },
            { tool: "read_skill_file", input: { skill: "weekly-report", path: "C:\\Windows\\win.ini" } },
            { tool: "read_skill_file", input: { skill: "weekly-report", path: "./notes//hidden.md" } },
          ],
        },
        (req) => {
          const r = lastResults(req);
          expect(r[0]!.content).toContain('must not contain ".."');
          expect(r[1]!.content).toContain("must be relative");
          expect(r[2]!.content).toContain("Linked files: templates/brief.md");
          expect(r[3]!.content).toContain("must be relative");
          expect(r[4]).toMatchObject({ content: "not linked" });
          return { steps: [{ text: "ok" }] };
        },
      ],
      { store: skillsStore() },
    );
    const events = await collect(harness.run(task("report"), approveAll));
    expect(ofType(events, "skill_file_read").map((e) => e.file)).toEqual(["notes/hidden.md"]);
  });
});

describe("allowed-tools", () => {
  it("restricts extra tools while the skill is active but keeps the skill tools", async () => {
    const store = skillsStore();
    store.add({ name: "limited", description: "A limited skill. Use for limited things.", allowedTools: "db_query memory_*" });
    const { harness, provider } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "limited" } }] },
        { steps: [{ tool: "workspace_write", input: { path: "a.txt", content: "x" } }, { tool: "memory_search", input: { query: "x" } }] },
        (req) => {
          const [w, m] = lastResults(req);
          expect(w!.isError).toBe(true);
          expect(w!.content).toContain("not allowed while skill limited is active");
          expect(m!.isError).toBeFalsy();
          return { steps: [{ text: "ok" }] };
        },
      ],
      { store },
    );
    await collect(harness.run(task("limited things"), approveAll));
    const before = provider.requests[0]!.tools.map((t) => t.name);
    expect(before).toContain("workspace_write");
    const after = provider.requests[1]!.tools.map((t) => t.name).sort();
    expect(after).toEqual(["db_query", "load_skill", "memory_save", "memory_search", "read_skill_file", "run_skill_script"]);
  });
});

describe("tool loop", () => {
  it("runs a multi-turn loop with tool results, usage and ordered events", async () => {
    const { harness, provider, db } = setup([
      {
        steps: [
          { text: "Adding the customer." },
          { tool: "db_execute", input: { sql: "INSERT INTO customers (id, name, email) VALUES (?, ?, ?)", params: ["c1", "Ada", "ada@example.com"] } },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      (req) => {
        const r = lastResults(req)[0]!;
        expect(r).toMatchObject({ name: "db_execute" });
        expect(JSON.parse(r.content)).toEqual({ changes: 1, lastInsertRowid: 1 });
        return { steps: [{ tool: "db_query", input: { sql: "SELECT name FROM customers WHERE id = ?", params: ["c1"] } }], usage: { inputTokens: 150, outputTokens: 10 } };
      },
      (req) => {
        expect(JSON.parse(lastResults(req)[0]!.content)).toEqual({ rowCount: 1, rows: [{ name: "Ada" }] });
        return { steps: [{ text: "Ada is saved." }], usage: { inputTokens: 200, outputTokens: 5 } };
      },
    ]);
    const events = await collect(harness.run(task("Add Ada"), approveAll));
    expect(events.map((e) => e.type)).toEqual([
      "session_start",
      ...Array(3).fill("text_delta"),
      "turn_end",
      "tool_start",
      "tool_end",
      "turn_end",
      "tool_start",
      "tool_end",
      ...Array(2).fill("text_delta"),
      "turn_end",
      "done",
    ]);
    expect(ofType(events, "turn_end").map((e) => e.turn)).toEqual([1, 2, 3]);
    expect(done(events)).toEqual({
      type: "done",
      stopReason: "end_turn",
      text: "Ada is saved.",
      usage: { inputTokens: 450, outputTokens: 35 },
    });
    expect(ofType(events, "tool_start")[0]!.effects).toEqual(["write"]);
    // The assistant message keeps text before the tool call, then the tool_use part.
    const assistant = provider.requests[1]!.messages[1]!;
    expect(assistant.content.map((p) => p.type)).toEqual(["text", "tool_use"]);
    expect((db.db.prepare("SELECT count(*) AS n FROM customers").get() as { n: number }).n).toBe(1);
  });

  it("runs read-only calls in parallel and others in order", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (name: string, effects: ("read" | "write")[]): RegisteredTool => ({
      definition: { name, description: `slow ${name}`, inputSchema: { type: "object" }, effects, source: "builtin" },
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(100);
        active--;
        return { content: name };
      },
    });
    const { harness } = setup(
      [
        { steps: [{ tool: "slow_read", input: {} }, { tool: "slow_read", input: {} }, { tool: "slow_read", input: {} }] },
        { steps: [{ text: "a" }] },
      ],
      { extraTools: [slow("slow_read", ["read"]), slow("slow_write", ["write"])] },
    );
    const t0 = Date.now();
    await collect(harness.run(task("parallel"), approveAll));
    expect(maxActive).toBe(3);
    expect(Date.now() - t0).toBeLessThan(270); // sequential would take 300+ ms

    maxActive = 0;
    const second = setup(
      [{ steps: [{ tool: "slow_read", input: {} }, { tool: "slow_write", input: {} }] }, { steps: [{ text: "b" }] }],
      { extraTools: [slow("slow_read", ["read"]), slow("slow_write", ["write"])] },
    );
    const events = await collect(second.harness.run(task("sequential"), approveAll));
    expect(maxActive).toBe(1);
    // Sequential: start, end, start, end.
    expect(events.filter((e) => e.type === "tool_start" || e.type === "tool_end").map((e) => e.type)).toEqual([
      "tool_start",
      "tool_end",
      "tool_start",
      "tool_end",
    ]);
  });

  it("turns unknown tools, invalid input and thrown errors into tool errors", async () => {
    const boom: RegisteredTool = {
      definition: { name: "boom", description: "throws", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      async run() {
        throw new Error("kaboom");
      },
    };
    const { harness } = setup(
      [
        {
          steps: [
            { tool: "no_such_tool", input: {} },
            { tool: "db_query", input: {} },
            { tool: "db_query", input: { sql: "SELECT 1", extra: true } },
            { tool: "memory_search", input: { query: 5 } },
            { tool: "boom", input: {} },
          ],
        },
        (req) => {
          const r = lastResults(req);
          expect(r.every((x) => x.isError)).toBe(true);
          expect(r[0]!.content).toBe('Unknown tool "no_such_tool".');
          expect(r[1]!.content).toBe("Invalid input for db_query: input.sql is required");
          expect(r[2]!.content).toContain("input.extra is not allowed");
          expect(r[3]!.content).toContain("input.query must be string, got integer");
          expect(r[4]!.content).toBe("Tool boom failed: kaboom");
          return { steps: [{ text: "handled" }] };
        },
      ],
      { extraTools: [boom] },
    );
    const events = await collect(harness.run(task("errors"), approveAll));
    expect(ofType(events, "tool_end")).toHaveLength(5);
    expect(done(events).text).toBe("handled");
  });

  it("caps tool output and redacts known secrets from it", async () => {
    const big: RegisteredTool = {
      definition: { name: "big", description: "big output", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      async run() {
        return { content: "sk-test-SECRETVALUE-123 " + "x".repeat(5000) };
      },
    };
    const { harness, provider } = setup([{ steps: [{ tool: "big", input: {} }] }, { steps: [{ text: "ok" }] }], {
      extraTools: [big],
      toolOutputCap: 1000,
    });
    harness.redactor.add("sk-test-SECRETVALUE-123");
    const events = await collect(harness.run(task("big"), approveAll));
    const content = lastResults(provider.requests[1]!)[0]!.content;
    expect(content).toContain("[tool output truncated: showing 1000 of");
    expect(content).not.toContain("SECRETVALUE");
    expect(ofType(events, "tool_end")[0]!.result.content).toBe(content);
  });

  it("db_query refuses writes and private tables; db_execute refuses private tables", async () => {
    const { harness } = setup([
      {
        steps: [
          { tool: "db_query", input: { sql: "DELETE FROM customers" } },
          { tool: "db_query", input: { sql: "SELECT * FROM _os_sessions" } },
          { tool: "db_query", input: { sql: "WITH x AS (SELECT 1) DELETE FROM customers" } },
          { tool: "db_query", input: { sql: "SELECT 1; DROP TABLE customers" } },
          { tool: "db_query", input: { sql: "PRAGMA writable_schema = 1" } },
          { tool: "db_query", input: { sql: "PRAGMA table_info(customers)" } },
        ],
      },
      (req) => {
        const r = lastResults(req);
        expect(r[0]!.content).toContain("db_query refused: db_query is read-only: DELETE");
        expect(r[1]!.content).toContain("private to OneSeat");
        expect(r[2]!.content).toContain("write keyword");
        expect(r[3]!.content).toContain("one statement");
        expect(r[4]!.content).toContain("only PRAGMA table_info");
        expect(r[5]!.isError).toBeFalsy();
        expect(r[5]!.content).toContain('"name": "email"');
        return { steps: [{ tool: "db_execute", input: { sql: "UPDATE _os_action_log SET summary = 'x'" } }] };
      },
      (req) => {
        expect(lastResults(req)[0]!.content).toContain("private to OneSeat");
        return { steps: [{ text: "done" }] };
      },
    ]);
    expect(done(await collect(harness.run(task("db"), approveAll))).stopReason).toBe("end_turn");
  });
});

describe("approvals and the action log", () => {
  const sendEmail: RegisteredTool = {
    definition: {
      name: "send_email",
      description: "Send an email",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["to", "subject"],
      },
      effects: ["send"],
      source: "builtin",
    },
    async run(input) {
      return { content: `sent to ${String(input["to"])}` };
    },
  };

  it("asks before send and runs on approval", async () => {
    const onApproval = vi.fn(approveAll);
    const { harness } = setup(
      [
        { steps: [{ tool: "send_email", input: { to: "ada@example.com", subject: "Your invoice", body: "Hi" } }] },
        (req) => {
          expect(lastResults(req)[0]).toMatchObject({ content: "sent to ada@example.com" });
          return { steps: [{ text: "Sent." }] };
        },
      ],
      { extraTools: [sendEmail] },
    );
    const events = await collect(harness.run(task("email ada"), onApproval));
    const req = ofType(events, "approval_request")[0]!;
    expect(req.summary).toBe("Send email to ada@example.com: 'Your invoice'");
    expect(req.effects).toEqual(["send"]);
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: req.approvalId, summary: req.summary }));
    expect(ofType(events, "approval_result")).toEqual([{ type: "approval_result", approvalId: req.approvalId, approved: true }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("approval_request"));
    expect(types.indexOf("approval_result")).toBeLessThan(types.indexOf("tool_end"));
    const log = harness.actions.list();
    expect(log[0]).toMatchObject({ tool: "send_email", effects: ["send"], approved: true, isError: false, summary: req.summary });
  });

  it("a denial returns a tool error with the person's note and logs it", async () => {
    const run = vi.fn(sendEmail.run);
    const { harness } = setup(
      [
        { steps: [{ tool: "send_email", input: { to: "ada@example.com", subject: "Hi" } }] },
        (req) => {
          const r = lastResults(req)[0]!;
          expect(r.isError).toBe(true);
          expect(r.content).toContain("The person declined this action");
          expect(r.content).toContain('Their note: "not today"');
          return { steps: [{ text: "Understood." }] };
        },
      ],
      { extraTools: [{ ...sendEmail, run }] },
    );
    const events = await collect(harness.run(task("email"), denyAll("not today")));
    expect(run).not.toHaveBeenCalled();
    expect(ofType(events, "approval_result")[0]!.approved).toBe(false);
    expect(harness.actions.list()[0]).toMatchObject({ approved: false, isError: true });
  });

  it("db_execute DELETE needs approval; INSERT does not", async () => {
    const onApproval = vi.fn(denyAll());
    const { harness, db } = setup([
      {
        steps: [
          { tool: "db_execute", input: { sql: "INSERT INTO customers (id, name) VALUES ('c1', 'Ada')" } },
          { tool: "db_execute", input: { sql: "DELETE FROM customers WHERE id = 'c1'" } },
        ],
      },
      { steps: [{ text: "ok" }] },
    ]);
    const events = await collect(harness.run(task("cleanup"), onApproval));
    expect(onApproval).toHaveBeenCalledTimes(1);
    const req = ofType(events, "approval_request")[0]!;
    expect(req.effects).toEqual(["write", "delete"]);
    expect(req.summary).toBe("Delete data: DELETE FROM customers WHERE id = 'c1'");
    expect((db.db.prepare("SELECT count(*) AS n FROM customers").get() as { n: number }).n).toBe(1);
    const log = harness.actions.list();
    expect(log.map((l) => [l.tool, l.approved, l.isError])).toEqual([
      ["db_execute", false, true],
      ["db_execute", null, false],
    ]);
  });

  it("an approval handler that throws counts as a denial", async () => {
    const { harness } = setup([{ steps: [{ tool: "send_email", input: { to: "a@b.co", subject: "s" } }] }, { steps: [{ text: "ok" }] }], {
      extraTools: [sendEmail],
    });
    const events = await collect(
      harness.run(task("x"), async () => {
        throw new Error("ui gone");
      }),
    );
    expect(ofType(events, "approval_result")[0]!.approved).toBe(false);
    expect(ofType(events, "tool_end")[0]!.result.content).toContain("approval failed: ui gone");
  });

  it("logs every tool action with secrets redacted", async () => {
    const { harness } = setup([
      { steps: [{ tool: "memory_save", input: { content: "Stripe key is sk_live_abcdefghijklmnop1234 and api_key=hunter22" } }] },
      { steps: [{ tool: "db_query", input: { sql: "SELECT 1 AS one" } }] },
      { steps: [{ text: "ok" }] },
    ]);
    const events = await collect(harness.run(task("remember"), approveAll));
    const runId = ofType(events, "session_start")[0]!.runId;
    const log = harness.actions.list(10, runId);
    expect(log).toHaveLength(2);
    expect(log[1]!.tool).toBe("memory_save");
    expect(log[1]!.summary).not.toContain("hunter22");
    expect(log[1]!.summary).toContain("api_key=[REDACTED]");
    expect(log[0]).toMatchObject({ tool: "db_query", effects: ["read"], approved: null, runId });
  });
});

describe("stopping", () => {
  it("cancels a run during a tool call", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const waiter: RegisteredTool = {
      definition: { name: "wait", description: "waits for cancel", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      run: (_input, ctx) =>
        new Promise((resolve) => {
          started();
          ctx.signal.addEventListener("abort", () => resolve({ content: "stopped", isError: true }));
        }),
    };
    const { harness, provider } = setup([{ steps: [{ tool: "wait", input: {} }] }, { steps: [{ text: "never" }] }], { extraTools: [waiter] });
    const stream = harness.run(task("wait"), approveAll, { runId: "run_cancel_1" });
    const collected = collect(stream);
    await startedP;
    expect(harness.isRunning("run_cancel_1")).toBe(true);
    expect(harness.cancel("run_cancel_1")).toBe(true);
    const events = await collected;
    expect(done(events).stopReason).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
    expect(harness.cancel("run_cancel_1")).toBe(false);
    // The stored conversation still ends with an assistant message.
    const sid = ofType(events, "session_start")[0]!.sessionId;
    const msgs = harness.sessions.messages(sid);
    expect(msgs[msgs.length - 1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "[Stopped: cancelled by the person.]" }] });
  });

  it("cancels while waiting for an approval", async () => {
    const { harness } = setup([{ steps: [{ tool: "db_execute", input: { sql: "DROP TABLE IF EXISTS brand" } }] }]);
    let approvalSeen!: () => void;
    const seen = new Promise<void>((r) => (approvalSeen = r));
    const stream = harness.run(task("drop"), () => {
      approvalSeen();
      return new Promise(() => undefined);
    }, { runId: "run_cancel_2" });
    const collected = collect(stream);
    await seen;
    harness.cancel("run_cancel_2");
    const events = await collected;
    expect(ofType(events, "approval_result")[0]!.approved).toBe(false);
    expect(done(events).stopReason).toBe("cancelled");
  });

  it("an external AbortSignal or breaking out of the loop cancels", async () => {
    const ac = new AbortController();
    ac.abort();
    const { harness } = setup([{ steps: [{ text: "hi" }] }]);
    const events = await collect(harness.run(task("x"), approveAll, { signal: ac.signal }));
    expect(done(events).stopReason).toBe("cancelled");

    const waiter: RegisteredTool = {
      definition: { name: "wait", description: "w", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      run: (_i, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ content: "x" }))),
    };
    const second = setup([{ steps: [{ tool: "wait", input: {} }] }], { extraTools: [waiter] });
    for await (const e of second.harness.run(task("y"), approveAll, { runId: "run_break" })) if (e.type === "tool_start") break;
    await vi.waitFor(() => expect(second.harness.isRunning("run_break")).toBe(false));
  });

  it("stops at max turns", async () => {
    const loop = () => ({ steps: [{ tool: "db_query", input: { sql: "SELECT 1" } }] });
    const { harness, provider } = setup([loop, loop, loop, loop, loop]);
    const events = await collect(harness.run(task("loop", { maxTurns: 3 }), approveAll));
    expect(done(events).stopReason).toBe("max_turns");
    expect(provider.requests).toHaveLength(3);
    expect(ofType(events, "turn_end")).toHaveLength(3);
  });

  it("uses the default of 25 turns", async () => {
    const loop = () => ({ steps: [{ tool: "db_query", input: { sql: "SELECT 1" } }] });
    const { harness, provider } = setup(Array.from({ length: 30 }, () => loop));
    const events = await collect(harness.run(task("loop"), approveAll));
    expect(done(events).stopReason).toBe("max_turns");
    expect(provider.requests).toHaveLength(25);
  });
});

describe("provider errors", () => {
  it("retries a rate limit with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { harness, provider } = setup(
      [{ steps: [{ error: { kind: "rate_limit" } }] }, { steps: [{ error: { kind: "server" } }] }, { steps: [{ text: "finally" }] }],
      { sleep: async (ms) => void sleeps.push(ms), retry: { baseDelayMs: 100, maxRetries: 3 } },
    );
    const events = await collect(harness.run(task("x"), approveAll));
    expect(done(events)).toMatchObject({ stopReason: "end_turn", text: "finally" });
    expect(provider.requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(80);
    expect(sleeps[0]).toBeLessThanOrEqual(120);
    expect(sleeps[1]).toBeGreaterThanOrEqual(160);
    expect(ofType(events, "error")).toHaveLength(0);
  });

  it("gives up after the retry budget and reports a retryable error", async () => {
    const rl = { steps: [{ error: { kind: "rate_limit" as const, message: "slow down" } }] };
    const { harness, provider } = setup([rl, rl, rl], { retry: { maxRetries: 2 } });
    const events = await collect(harness.run(task("x"), approveAll));
    expect(provider.requests).toHaveLength(3);
    expect(ofType(events, "error")).toEqual([{ type: "error", message: "slow down", retryable: true }]);
    expect(done(events).stopReason).toBe("error");
  });

  it("does not retry auth errors or after output was streamed", async () => {
    const a = setup([{ steps: [{ error: { kind: "auth", message: "bad key sk-ant-api03-ABCDEFGHIJKLMNOPQRST" } }] }, { steps: [{ text: "x" }] }]);
    const ev = await collect(a.harness.run(task("x"), approveAll));
    expect(a.provider.requests).toHaveLength(1);
    expect(ofType(ev, "error")[0]).toEqual({ type: "error", message: "bad key [REDACTED]", retryable: false });

    const b = setup([{ steps: [{ text: "partial" }, { error: { kind: "server" } }] }, { steps: [{ text: "x" }] }]);
    const ev2 = await collect(b.harness.run(task("x"), approveAll));
    expect(b.provider.requests).toHaveLength(1);
    expect(ofType(ev2, "error")[0]!.retryable).toBe(true);
  });

  it("honours retryAfter and treats a thrown stream or a missing message_end as retryable", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const provider = {
      id: "local" as const,
      models: async () => [],
      countTokens: async () => 0,
      async *send(): AsyncIterable<import("@oneseat/contracts").ChatEvent> {
        call++;
        yield { type: "message_start", model: "m" };
        if (call === 1) {
          yield { type: "error", error: { kind: "rate_limit", message: "wait", retryable: true, retryAfter: 2 } };
          return;
        }
        if (call === 2) throw new Error("socket hang up");
        if (call === 3) return; // no message_end
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3 } };
      },
    };
    const { harness } = setup([], { provider: () => provider, sleep: async (ms) => void sleeps.push(ms), retry: { maxRetries: 5 } });
    const events = await collect(harness.run(task("x"), approveAll));
    expect(done(events).text).toBe("ok");
    expect(done(events).usage).toEqual({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3 });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(3);
  });

  it("reports a provider factory failure", async () => {
    const { harness } = setup([], {
      provider: () => {
        throw new Error("no API key for openai");
      },
    });
    const events = await collect(harness.run(task("x"), approveAll));
    expect(ofType(events, "error")[0]!.message).toBe("no API key for openai");
    expect(done(events).stopReason).toBe("error");
  });
});

describe("sessions", () => {
  it("continues a session with its history and loaded skills", async () => {
    const store = skillsStore();
    store.add({ name: "limited", description: "Limited skill for limited things.", allowedTools: "db_query" });
    const { harness, provider } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "limited" } }] },
        { steps: [{ text: "First answer." }] },
        (req) => {
          const texts = req.messages.flatMap((m) => m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text));
          expect(texts).toEqual(["first question", "First answer.", "second question"]);
          return { steps: [{ text: "Second answer." }] };
        },
      ],
      { store },
    );
    const first = await collect(harness.run(task("first question", { sessionId: "ses_fixed" }), approveAll));
    expect(ofType(first, "session_start")[0]!.sessionId).toBe("ses_fixed");
    const second = await collect(harness.run(task("second question", { sessionId: "ses_fixed" }), approveAll));
    expect(done(second).text).toBe("Second answer.");
    expect(ofType(second, "skill_loaded")).toHaveLength(0);
    // allowed-tools of the skill loaded in the first run still applies.
    expect(provider.requests[2]!.tools.map((t) => t.name).sort()).toEqual(["db_query", "load_skill", "read_skill_file", "run_skill_script"]);
    expect(harness.sessions.get("ses_fixed")!.loadedSkills).toEqual([{ name: "limited", reason: "router" }]);
  });

  it("keeps forced skills in the prompt on continuation", async () => {
    const { harness, provider } = setup([{ steps: [{ text: "a" }] }, { steps: [{ text: "b" }] }], { store: skillsStore() });
    const first = await collect(harness.run(task("q1", { skill: "invoice-chase" }), approveAll));
    const sessionId = ofType(first, "session_start")[0]!.sessionId;
    const second = await collect(harness.run(task("q2", { sessionId }), approveAll));
    expect(provider.requests[1]!.system).toContain("INVOICE-BODY-MARKER");
    expect(ofType(second, "skill_loaded")).toHaveLength(0);
  });

  it("refuses a second concurrent run on the same session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hold: RegisteredTool = {
      definition: { name: "hold", description: "h", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      run: async () => {
        await gate;
        return { content: "ok" };
      },
    };
    const { harness } = setup([{ steps: [{ tool: "hold", input: {} }] }, { steps: [{ text: "done" }] }], { extraTools: [hold] });
    const a = collect(harness.run(task("a", { sessionId: "ses_busy" }), approveAll));
    await vi.waitFor(() => expect(harness.activeRuns()).toHaveLength(1));
    await sleep(10);
    const b = await collect(harness.run(task("b", { sessionId: "ses_busy" }), approveAll));
    expect(ofType(b, "error")[0]!.message).toContain("already has a run in progress");
    release();
    expect(done(await a).text).toBe("done");
  });

  it("validates the task", async () => {
    const { harness } = setup([]);
    const e1 = await collect(harness.run({ ...task("x"), input: 5 as unknown as string }, approveAll));
    expect(ofType(e1, "error")[0]!.message).toContain("input must be a string");
    const e2 = await collect(harness.run({ ...task("x"), model: "" }, approveAll));
    expect(ofType(e2, "error")[0]!.message).toContain("model is required");
  });
});

describe("pinned apps", () => {
  it("restricts an app run to its allowed skills", async () => {
    const { harness, provider } = setup(
      [
        { steps: [{ tool: "load_skill", input: { name: "invoice-chase" } }] },
        (req) => {
          expect(lastResults(req)[0]!.content).toContain('No skill named "invoice-chase" is available. Available skills: weekly-report.');
          return { steps: [{ text: "ok" }] };
        },
      ],
      { store: skillsStore(), appAllowedSkills: (id) => (id === "report-app" ? ["weekly-report"] : undefined) },
    );
    await collect(harness.run(task("x", { origin: { kind: "app", appId: "report-app" } }), approveAll));
    const sys = provider.requests[0]!.system;
    expect(sys).toContain("weekly-report");
    expect(sys).not.toContain("invoice-chase");
  });

  it("refuses a forced skill outside the app list and gives unknown apps no skills", async () => {
    const { harness } = setup([{ steps: [{ text: "x" }] }], { store: skillsStore(), appAllowedSkills: () => ["weekly-report"] });
    const events = await collect(harness.run(task("x", { skill: "invoice-chase", origin: { kind: "app", appId: "a" } }), approveAll));
    expect(ofType(events, "error")[0]!.message).toBe('skill "invoice-chase" is not allowed here');

    const other = setup([{ steps: [{ text: "x" }] }], { store: skillsStore() });
    await collect(other.harness.run(task("x", { origin: { kind: "app", appId: "ghost" } }), approveAll));
    expect(other.provider.requests[0]!.system).not.toContain("<skills>");
  });

  it("intersects RunOptions.allowedSkills with the app list", async () => {
    const { harness, provider } = setup([{ steps: [{ text: "x" }] }], {
      store: skillsStore(),
      appAllowedSkills: () => ["weekly-report", "invoice-chase"],
    });
    await collect(harness.run(task("x", { origin: { kind: "app", appId: "a" } }), approveAll, { allowedSkills: ["invoice-chase"] }));
    expect(provider.requests[0]!.system).toContain("invoice-chase");
    expect(provider.requests[0]!.system).not.toContain("weekly-report");
  });
});

describe("context management", () => {
  it("truncates old tool results before dropping turns", async () => {
    const big: RegisteredTool = {
      definition: { name: "big", description: "big", inputSchema: { type: "object" }, effects: ["read"], source: "builtin" },
      async run() {
        return { content: "HEAD" + "y".repeat(20_000) };
      },
    };
    const { harness, provider } = setup(
      [{ steps: [{ tool: "big", input: {} }] }, { steps: [{ tool: "db_query", input: { sql: "SELECT 1" } }] }, { steps: [{ text: "ok" }] }],
      { extraTools: [big], contextBudgetTokens: 4000, toolOutputCap: 50_000 },
    );
    await collect(harness.run(task("x"), approveAll));
    // Turn 2 sees the big result in full (it is the latest); turn 3 sees it truncated.
    const t2 = provider.requests[1]!.messages[2]!.content[0] as ToolResultPart;
    expect(t2.content.length).toBeGreaterThan(20_000);
    const t3 = provider.requests[2]!.messages[2]!.content[0] as ToolResultPart;
    expect(t3.content.startsWith("HEAD")).toBe(true);
    expect(t3.content).toContain("[tool result truncated to fit the context");
    expect(provider.requests[2]!.messages).toHaveLength(5);
  });
});

describe("misc", () => {
  it("passes effort and model through and streams text deltas", async () => {
    const provider = createScriptedProvider([{ steps: [{ text: "abcdefghijklmnopqrstuvwxyz" }] }], { chunk: 5 });
    const { harness } = setup([], { provider: () => provider });
    const events: HarnessEvent[] = await collect(harness.run(task("x", { effort: "high", model: "m-1" }), approveAll));
    expect(provider.requests[0]).toMatchObject({ effort: "high", model: "m-1" });
    expect(ofType(events, "text_delta").map((e) => e.text)).toEqual(["abcde", "fghij", "klmno", "pqrst", "uvwxy", "z"]);
  });

  it("keeps reasoning parts with provider metadata in the history", async () => {
    const { harness, provider } = setup([
      { steps: [{ reasoning: "think" }, { tool: "db_query", input: { sql: "SELECT 1" } }] },
      { steps: [{ text: "ok" }] },
    ]);
    await collect(harness.run(task("x"), approveAll));
    expect(provider.requests[1]!.messages[1]!.content.map((p) => p.type)).toEqual(["reasoning", "tool_use"]);
  });
});
