// HarnessApi conformance: progressive skill loading, the no-skill baseline, approvals, event order.
// packages/harness calls describeHarnessConformance() from its own tests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createScriptedProvider,
  type ApprovalDecision,
  type ApprovalHandler,
  type ChatRequest,
  type HarnessApi,
  type HarnessEvent,
  type ModelProvider,
  type ScriptEntry,
  type SkillStore,
  type TaskRequest,
  type ToolDefinition,
  type ToolEffect,
} from "@oneseat/contracts";
import { createMemorySkillStore, type MemorySkillInput } from "../memory-store.js";
import { STOP_REASONS } from "../stream.js";

/** A tool the suite asks the harness to expose. The harness must call run() to execute it. */
export interface ConformanceTool {
  definition: ToolDefinition;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface HarnessConformanceContext {
  /** A fresh, empty data folder for this run. */
  dataDir: string;
  /** Tools the harness must offer the model, with their effects, alongside its own. */
  tools: ConformanceTool[];
}

export type MakeHarness = (provider: ModelProvider, store: SkillStore, ctx: HarnessConformanceContext) => HarnessApi | Promise<HarnessApi>;

export interface HarnessConformanceOptions {
  /** How the model asks to load a skill. Default: tool "load_skill" with input {name}. */
  loadSkillTool?: { name: string; input: (skill: string) => Record<string, unknown> };
  /** Per-run timeout in ms. Default 15 000. */
  timeoutMs?: number;
}

export interface HarnessIssue {
  index: number;
  rule: string;
  message: string;
}



function nonNegativeUsage(u: unknown): boolean {
  if (!u || typeof u !== "object") return false;
  const x = u as Record<string, unknown>;
  return ["inputTokens", "outputTokens"].every((k) => typeof x[k] === "number" && Number.isInteger(x[k]) && (x[k] as number) >= 0);
}

/**
 * Check a HarnessEvent sequence: exactly one done, last; an error (if any) is followed by
 * done with stopReason "error"; ids pair up; usage is sane. (Contract: harness.ts HarnessEvent.)
 */
export function validateHarnessEvents(events: readonly HarnessEvent[]): HarnessIssue[] {
  const issues: HarnessIssue[] = [];
  if (events.length === 0) return [{ index: -1, rule: "empty", message: "run produced no events" }];
  const toolStarts = new Set<string>();
  const approvals = new Set<string>();
  const approvalCalls = new Set<string>();
  let terminals = 0;
  let sawError = false;
  events.forEach((ev, i) => {
    if (terminals > 0) issues.push({ index: i, rule: "after-terminal", message: `${ev.type} after the terminal event` });
    switch (ev.type) {
      case "session_start":
        if (i !== 0) issues.push({ index: i, rule: "session-start", message: "session_start must be the first event" });
        break;
      case "tool_start":
        toolStarts.add(ev.call.id);
        break;
      case "approval_request":
        if (approvals.has(ev.approvalId)) issues.push({ index: i, rule: "approval-id", message: `duplicate approvalId ${ev.approvalId}` });
        approvals.add(ev.approvalId);
        approvalCalls.add(ev.call.id);
        break;
      case "approval_result":
        if (!approvals.has(ev.approvalId)) issues.push({ index: i, rule: "approval-pair", message: `approval_result for unknown approvalId ${ev.approvalId}` });
        break;
      case "tool_end":
        if (!toolStarts.has(ev.result.callId) && !approvalCalls.has(ev.result.callId))
          issues.push({ index: i, rule: "tool-pair", message: `tool_end for call ${ev.result.callId} without tool_start` });
        if (typeof ev.durationMs !== "number" || ev.durationMs < 0) issues.push({ index: i, rule: "tool-duration", message: "tool_end.durationMs must be >= 0" });
        break;
      case "turn_end":
        if (!nonNegativeUsage(ev.usage)) issues.push({ index: i, rule: "usage", message: "turn_end.usage must have non-negative integer token counts" });
        break;
      case "done":
        terminals++;
        if (![...STOP_REASONS, "max_turns", "cancelled"].includes(ev.stopReason)) issues.push({ index: i, rule: "stop-reason", message: `unknown stopReason ${String(ev.stopReason)}` });
        if (typeof ev.text !== "string") issues.push({ index: i, rule: "done-text", message: "done.text must be a string" });
        if (!nonNegativeUsage(ev.usage)) issues.push({ index: i, rule: "usage", message: "done.usage must have non-negative integer token counts" });
        break;
      case "error":
        sawError = true;
        if (typeof ev.message !== "string" || !ev.message) issues.push({ index: i, rule: "error-message", message: "error.message must be a non-empty string" });
        break;
      default:
        break;
    }
  });
  const dones = events.filter((e) => e.type === "done");
  const last = events[events.length - 1]!;
  if (dones.length === 0) issues.push({ index: -1, rule: "terminal", message: "run ended without done" });
  else if (dones.length > 1) issues.push({ index: -1, rule: "terminal", message: `run has ${dones.length} done events, expected exactly one` });
  else if (last.type !== "done") issues.push({ index: -1, rule: "terminal", message: "done is not the last event" });
  if (sawError && last.type === "done" && last.stopReason !== "error")
    issues.push({ index: events.length - 1, rule: "error-done", message: `an error must end with done/error, got done/${last.stopReason}` });
  return issues;
}

// ---- fixtures ----

export const CONFORMANCE_SKILLS: readonly MemorySkillInput[] = [
  {
    name: "alpha-notes",
    description: "Turn rough meeting jottings into tidy notes. Use when the user asks for meeting notes.",
    body: "# Alpha notes\n\nALPHA-BODY-SENTINEL-7f3a. Follow [the reference](reference.md).\n",
    files: { "reference.md": "ALPHA-FILE-SENTINEL-c41d\n" },
  },
  {
    name: "beta-invoices",
    description: "Draft an invoice from a list of hours. Use when the user asks to bill a customer.",
    body: "# Beta invoices\n\nBETA-BODY-SENTINEL-91c2.\n",
  },
];

const SENTINELS = ["ALPHA-BODY-SENTINEL-7f3a", "ALPHA-FILE-SENTINEL-c41d", "BETA-BODY-SENTINEL-91c2"];

interface ToolLog {
  log: string[];
  tools: ConformanceTool[];
}

function conformanceTools(log: string[]): ConformanceTool[] {
  const mk = (name: string, description: string, effects: ToolEffect[]): ConformanceTool => ({
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      effects,
      source: "builtin",
      owner: "conformance",
    },
    async run(input) {
      log.push(`run:${name}`);
      return JSON.stringify({ ok: true, tool: name, id: input["id"] ?? null, marker: `RESULT-${name}` });
    },
  });
  return [
    mk("cx_send_message", "Send a message to a customer.", ["send"]),
    mk("cx_pay_invoice", "Pay a supplier invoice.", ["pay"]),
    mk("cx_delete_record", "Delete a customer record.", ["delete"]),
    mk("cx_read_note", "Read a note.", ["read"]),
  ];
}

interface RunOutcome {
  events: HarnessEvent[];
  requests: ChatRequest[];
  approvals: Parameters<ApprovalHandler>[0][];
  log: string[];
  problems: string[];
}

function reqText(r: ChatRequest | undefined): string {
  return r ? `${r.system}\n${JSON.stringify(r.messages)}\n${JSON.stringify(r.tools)}` : "";
}

interface Ctx {
  makeHarness: MakeHarness;
  opts: Required<Pick<HarnessConformanceOptions, "timeoutMs">> & { loadSkillTool: NonNullable<HarnessConformanceOptions["loadSkillTool"]> };
}

async function runOnce(ctx: Ctx, script: ScriptEntry[], task: Partial<TaskRequest>, decide: (call: string) => ApprovalDecision = () => ({ approved: true })): Promise<RunOutcome> {
  const provider = createScriptedProvider(script, { id: "local" });
  const store = createMemorySkillStore(CONFORMANCE_SKILLS);
  const dataDir = await mkdtemp(join(tmpdir(), "oneseat-harness-conformance-"));
  const tl: ToolLog = { log: [], tools: [] };
  tl.tools = conformanceTools(tl.log);
  const events: HarnessEvent[] = [];
  const approvals: Parameters<ApprovalHandler>[0][] = [];
  const problems: string[] = [];
  const onApproval: ApprovalHandler = async (req) => {
    approvals.push(req);
    tl.log.push(`approval:${req.call.name}`);
    return decide(req.call.name);
  };
  const full: TaskRequest = { input: "Hello", provider: "local", model: "scripted-1", origin: { kind: "eval" }, maxTurns: 6, ...task };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const harness = await ctx.makeHarness(provider, store, { dataDir, tools: tl.tools });
    const drain = (async () => {
      for await (const ev of harness.run(full, onApproval)) events.push(ev);
    })();
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ctx.opts.timeoutMs)));
    if ((await Promise.race([drain.then(() => "ok" as const), timeout])) === "timeout") problems.push(`run did not finish within ${ctx.opts.timeoutMs} ms`);
  } catch (e) {
    problems.push(`harness threw instead of emitting an error event: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  for (const i of validateHarnessEvents(events)) problems.push(`[${i.rule}]${i.index >= 0 ? ` event #${i.index}` : ""}: ${i.message}`);
  return { events, requests: provider.requests, approvals, log: tl.log, problems };
}

type Check = { name: string; run: (ctx: Ctx) => Promise<string[]> };

function approvalCheck(tool: string, effect: ToolEffect): Check {
  return {
    name: `asks a person before a "${effect}" tool runs (${tool}), then runs it once approved`,
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ tool, input: { id: "r1" }, id: "call_cx_1" }] }, { steps: [{ text: "Done." }] }], { input: `Please ${effect} it.` });
      const p = [...r.problems];
      if (r.approvals.length !== 1) p.push(`approval handler called ${r.approvals.length} times, expected 1`);
      const a = r.approvals[0];
      if (a) {
        if (a.call.name !== tool) p.push(`approval asked for ${a.call.name}, expected ${tool}`);
        if (!a.effects.includes(effect)) p.push(`approval effects ${JSON.stringify(a.effects)} miss "${effect}"`);
        if (!a.summary || typeof a.summary !== "string") p.push("approval summary must be a non-empty string");
      }
      const ai = r.log.indexOf(`approval:${tool}`);
      const ri = r.log.indexOf(`run:${tool}`);
      if (ri === -1) p.push(`${tool} did not run after approval`);
      else if (ai === -1 || ai > ri) p.push(`${tool} ran before the person approved it`);
      if (r.log.filter((x) => x === `run:${tool}`).length > 1) p.push(`${tool} ran more than once`);
      const reqEv = r.events.findIndex((e) => e.type === "approval_request" && e.call.name === tool);
      const resEv = r.events.findIndex((e) => e.type === "approval_result");
      if (reqEv === -1) p.push("no approval_request event");
      else {
        const ev = r.events[reqEv] as Extract<HarnessEvent, { type: "approval_request" }>;
        if (a && ev.approvalId !== a.approvalId) p.push("approval_request.approvalId differs from the id given to the handler");
        if (resEv === -1 || resEv < reqEv) p.push("no approval_result after approval_request");
        else if ((r.events[resEv] as Extract<HarnessEvent, { type: "approval_result" }>).approved !== true) p.push("approval_result.approved should be true");
      }
      const end = r.events.find((e) => e.type === "tool_end" && e.result.callId === "call_cx_1") as Extract<HarnessEvent, { type: "tool_end" }> | undefined;
      if (!end) p.push("no tool_end for the approved call");
      else if (end.result.isError) p.push("approved tool_end should not be an error");
      const next = reqText(r.requests[1]);
      if (!next.includes(`RESULT-${tool}`)) p.push("the tool result was not sent back to the model");
      return p;
    },
  };
}

function findToolResult(req: ChatRequest | undefined, callId: string) {
  for (const m of req?.messages ?? []) for (const part of m.content) if (part.type === "tool_result" && part.toolUseId === callId) return part;
  return undefined;
}

const CHECKS: Check[] = [
  {
    name: "starts with a skill index of name + description only (no bodies, no files)",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ text: "Hi." }] }], { input: "Hello there" });
      const p = [...r.problems];
      const first = r.requests[0];
      if (!first) return [...p, "the model was never called"];
      for (const s of CONFORMANCE_SKILLS) {
        if (!first.system.includes(s.name)) p.push(`system prompt lacks skill name "${s.name}"`);
        if (!first.system.includes(s.description)) p.push(`system prompt lacks the description of "${s.name}"`);
      }
      for (const sentinel of SENTINELS) if (reqText(first).includes(sentinel)) p.push(`first request contains skill content (${sentinel}) before any load`);
      if (!first.tools.some((t) => t.name === ctx.opts.loadSkillTool.name)) p.push(`first request does not offer the ${ctx.opts.loadSkillTool.name} tool`);
      if (r.events.some((e) => e.type === "skill_loaded")) p.push("a skill_loaded event fired although no skill was requested");
      return p;
    },
  },
  {
    name: "loads a skill body only after load_skill is called",
    run: async (ctx) => {
      const lt = ctx.opts.loadSkillTool;
      const r = await runOnce(ctx, [{ steps: [{ tool: lt.name, input: lt.input("alpha-notes"), id: "call_load_1" }] }, { steps: [{ text: "Notes ready." }] }], { input: "Write up my meeting notes" });
      const p = [...r.problems];
      const [first, second] = r.requests;
      if (!second) return [...p, `the model was not called again after ${lt.name}`];
      if (SENTINELS.some((s) => reqText(first).includes(s))) p.push("skill content was sent before the load");
      if (!reqText(second).includes("ALPHA-BODY-SENTINEL-7f3a")) p.push("alpha-notes body was not sent after the load");
      if (reqText(second).includes("BETA-BODY-SENTINEL-91c2")) p.push("beta-invoices body was sent although only alpha-notes was loaded");
      if (reqText(second).includes("ALPHA-FILE-SENTINEL-c41d")) p.push("a linked file was sent without being read (load files on demand)");
      const loaded = r.events.filter((e) => e.type === "skill_loaded") as Extract<HarnessEvent, { type: "skill_loaded" }>[];
      if (loaded.length !== 1 || loaded[0]!.name !== "alpha-notes") p.push(`expected one skill_loaded for alpha-notes, got ${JSON.stringify(loaded)}`);
      else if (loaded[0]!.reason !== "router") p.push(`skill_loaded.reason is "${loaded[0]!.reason}", expected "router"`);
      return p;
    },
  },
  {
    name: "a forced skill (TaskRequest.skill) is loaded at the start with reason forced",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ text: "Notes." }] }], { input: "Tidy these notes", skill: "alpha-notes" });
      const p = [...r.problems];
      const first = r.requests[0];
      if (!first) return [...p, "the model was never called"];
      if (!reqText(first).includes("ALPHA-BODY-SENTINEL-7f3a")) p.push("the forced skill's body is not in the first request");
      if (reqText(first).includes("BETA-BODY-SENTINEL-91c2")) p.push("another skill's body is in the first request");
      const loaded = r.events.find((e) => e.type === "skill_loaded") as Extract<HarnessEvent, { type: "skill_loaded" }> | undefined;
      if (!loaded) p.push("no skill_loaded event");
      else if (loaded.name !== "alpha-notes" || loaded.reason !== "forced") p.push(`skill_loaded is ${JSON.stringify(loaded)}, expected alpha-notes / forced`);
      return p;
    },
  },
  {
    name: "disableSkills: sends no skill index and offers no skill loading",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ text: "Hi." }] }], { input: "Write up my meeting notes", disableSkills: true });
      const p = [...r.problems];
      const first = r.requests[0];
      if (!first) return [...p, "the model was never called"];
      const text = reqText(first);
      for (const s of CONFORMANCE_SKILLS) {
        if (text.includes(s.name)) p.push(`no-skill baseline mentions skill "${s.name}"`);
        if (text.includes(s.description)) p.push(`no-skill baseline includes the description of "${s.name}"`);
      }
      for (const sentinel of SENTINELS) if (text.includes(sentinel)) p.push(`no-skill baseline includes skill content (${sentinel})`);
      if (first.tools.some((t) => t.name === ctx.opts.loadSkillTool.name)) p.push(`no-skill baseline offers ${ctx.opts.loadSkillTool.name}`);
      if (r.events.some((e) => e.type === "skill_loaded")) p.push("skill_loaded fired in a no-skill run");
      return p;
    },
  },
  approvalCheck("cx_send_message", "send"),
  approvalCheck("cx_pay_invoice", "pay"),
  approvalCheck("cx_delete_record", "delete"),
  {
    name: "a denied approval does not run the tool and returns a tool error to the model",
    run: async (ctx) => {
      const r = await runOnce(
        ctx,
        [{ steps: [{ tool: "cx_send_message", input: { id: "r2" }, id: "call_cx_deny" }] }, { steps: [{ text: "Okay, I will not send it." }] }],
        { input: "Send it" },
        () => ({ approved: false, note: "Not today" }),
      );
      const p = [...r.problems];
      if (r.approvals.length !== 1) p.push(`approval handler called ${r.approvals.length} times, expected 1`);
      if (r.log.includes("run:cx_send_message")) p.push("the tool ran although the person said no");
      const res = r.events.find((e) => e.type === "approval_result") as Extract<HarnessEvent, { type: "approval_result" }> | undefined;
      if (!res || res.approved !== false) p.push("no approval_result with approved: false");
      const tr = findToolResult(r.requests[1], "call_cx_deny");
      if (!tr) p.push("the model did not get a tool_result for the denied call");
      else if (tr.isError !== true) p.push("the denied call's tool_result must have isError: true");
      const done = r.events[r.events.length - 1];
      if (done?.type !== "done") p.push(`expected the run to finish with done, got ${done?.type ?? "nothing"}`);
      return p;
    },
  },
  {
    name: "read-only tools run without asking",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ tool: "cx_read_note", input: { id: "n1" }, id: "call_cx_read" }] }, { steps: [{ text: "Read it." }] }], { input: "Read note n1" });
      const p = [...r.problems];
      if (r.approvals.length > 0) p.push("approval was requested for a read-only tool");
      if (!r.log.includes("run:cx_read_note")) p.push("the read tool did not run");
      if (!r.events.some((e) => e.type === "tool_start" && e.call.name === "cx_read_note")) p.push("no tool_start for cx_read_note");
      return p;
    },
  },
  {
    name: "a provider error emits error, then exactly one done/error",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ error: { kind: "auth", message: "bad key" } }] }], { input: "Hello" });
      const p = [...r.problems];
      const last = r.events[r.events.length - 1];
      if (!r.events.some((e) => e.type === "error")) p.push("a provider error produced no error event");
      if (last?.type !== "done" || last.stopReason !== "error") p.push(`a provider error must end with done/error; got ${last?.type}/${last?.type === "done" ? last.stopReason : "-"}`);
      return p;
    },
  },
  {
    name: "a plain reply ends with one done carrying the final text",
    run: async (ctx) => {
      const r = await runOnce(ctx, [{ steps: [{ text: "All set." }] }], { input: "Hello" });
      const p = [...r.problems];
      const last = r.events[r.events.length - 1];
      if (last?.type !== "done") p.push(`expected done, got ${last?.type ?? "nothing"}`);
      else {
        if (last.text !== "All set.") p.push(`done.text is ${JSON.stringify(last.text)}, expected "All set."`);
        if (last.stopReason !== "end_turn") p.push(`done.stopReason is "${last.stopReason}", expected "end_turn"`);
      }
      return p;
    },
  },
];

export const HARNESS_CHECKS: readonly string[] = CHECKS.map((c) => c.name);

function ctxOf(makeHarness: MakeHarness, opts: HarnessConformanceOptions): Ctx {
  return {
    makeHarness,
    opts: { timeoutMs: opts.timeoutMs ?? 15_000, loadSkillTool: opts.loadSkillTool ?? { name: "load_skill", input: (name) => ({ name }) } },
  };
}

async function safeRun(c: Check, ctx: Ctx): Promise<string[]> {
  try {
    return await c.run(ctx);
  } catch (e) {
    return [`check crashed: ${(e as Error)?.message ?? String(e)}`];
  }
}

/** Run every harness check and return problems. Never throws. */
export async function runHarnessConformance(makeHarness: MakeHarness, opts: HarnessConformanceOptions = {}): Promise<{ name: string; problems: string[] }[]> {
  const ctx = ctxOf(makeHarness, opts);
  const out: { name: string; problems: string[] }[] = [];
  for (const c of CHECKS) out.push({ name: c.name, problems: await safeRun(c, ctx) });
  return out;
}

/** Register the HarnessApi conformance suite (vitest). */
export function describeHarnessConformance(makeHarness: MakeHarness, opts: HarnessConformanceOptions = {}): void {
  describe("conformance: HarnessApi", () => {
    const ctx = ctxOf(makeHarness, opts);
    for (const c of CHECKS) it(c.name, async () => expect(await safeRun(c, ctx)).toEqual([]), ctx.opts.timeoutMs + 5_000);
  });
}
