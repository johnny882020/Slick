import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createScriptedProvider, type ChatRequest, type EvalCase, type EvalSuite, type HarnessApi, type HarnessEvent, type ModelProvider, type ProviderId, type ScriptedTurn } from "@oneseat/contracts";
import { createMemorySkillStore } from "../src/index.js";
import {
  buildReport,
  collectHarnessRun,
  DENY_ALL_APPROVALS,
  noSkillCheck,
  renderEvalMarkdown,
  renderNoSkillMarkdown,
  describeCheck,
  rescoreReport,
  runEvals,
  type EvalHarnessContext,
  type EvalHarnessFactory,
  type JudgeFn,
} from "../src/evals/index.js";
import { createReferenceHarness } from "./fakes/harness.js";

const SKILL_BODY = "Always end the report with SIGNED-OFF.";
const store = createMemorySkillStore([{ name: "weekly-report", description: "Write the weekly report. Use when asked for a weekly report.", body: SKILL_BODY }]);

/** A provider that answers every request from the request itself. */
function smart(answer: (req: ChatRequest) => ScriptedTurn, opts: { id?: ProviderId; delayMs?: number; track?: { now: number; max: number } } = {}): ModelProvider {
  return {
    id: opts.id ?? "anthropic",
    models: async () => [{ id: "m1", provider: opts.id ?? "anthropic", label: "M1", supportsTools: true }],
    countTokens: async () => 1,
    async *send(req) {
      if (opts.track) {
        opts.track.now++;
        opts.track.max = Math.max(opts.track.max, opts.track.now);
      }
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield* createScriptedProvider([answer(req)]).send(req);
      } finally {
        if (opts.track) opts.track.now--;
      }
    },
  };
}

const answer = (req: ChatRequest): ScriptedTurn => {
  const customers = /CUSTOMERS=(\d+)/.exec(req.system)?.[1] ?? "?";
  const signed = req.system.includes("SIGNED-OFF") ? " SIGNED-OFF" : "";
  return { steps: [{ text: `Weekly report for ${customers} customers.${signed}` }] };
};

const contexts: EvalHarnessContext[] = [];
const harness: EvalHarnessFactory = (ctx) => {
  contexts.push(ctx);
  const db = new DatabaseSync(ctx.dbPath);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n;
  db.close();
  return createReferenceHarness({ provider: ctx.provider, store, systemExtra: `CUSTOMERS=${n}` });
};

function suite(n = 10, extra: Partial<EvalCase> = {}): EvalSuite {
  return {
    skill: "weekly-report",
    cases: Array.from({ length: n }, (_, i) => ({
      id: `case-${i + 1}`,
      input: `Weekly report ${i + 1}`,
      db: { customers: Array.from({ length: i + 1 }, (_, k) => ({ id: `c${k}`, name: `Customer ${k}` })) },
      checks: [{ type: "contains", value: "SIGNED-OFF" }, { type: "contains", value: `for ${i + 1} customers` }],
      ...extra,
    })),
  };
}

describe("runEvals", () => {
  it("runs every case with and without the skill, each in a fresh seeded data folder", async () => {
    contexts.length = 0;
    const report = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite()] });
    expect(report.runs).toHaveLength(20);
    expect(new Set(contexts.map((c) => c.dataDir)).size).toBe(20);
    expect(contexts.every((c) => !existsSync(c.dataDir))).toBe(true);
    expect(contexts.filter((c) => c.withSkill)).toHaveLength(10);
    const withSkill = report.runs.filter((r) => r.withSkill);
    expect(withSkill.every((r) => r.score === 1 && r.skillLoaded)).toBe(true);
    expect(report.runs.filter((r) => !r.withSkill).every((r) => r.score === 0.5)).toBe(true);
    const v = report.verdicts[0]!;
    expect(v).toMatchObject({ skill: "weekly-report", provider: "anthropic", model: "m1", pass: true, cases: 10, errors: 0, withSkillScore: 1, baselineScore: 0.5 });
    expect(v.outcomes.every((o) => o.result === "win")).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.noSkill).toEqual([]);
    const md = renderEvalMarkdown(report);
    expect(md).toContain("# Skill evals (gate 5) — PASS");
    expect(md).toContain("| weekly-report | anthropic | m1 | 10 | 10 | 0 | 0 | 0 | 100.0% | 50.0% | PASS |");
  });

  it("fails the verdict when the baseline wins a case, and the no-skill check names the check", async () => {
    const s = suite();
    s.cases[3]!.checks = [{ type: "not_contains", value: "SIGNED-OFF" }, { type: "contains", value: "for 4 customers" }];
    const report = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [s], concurrency: 8 });
    const v = report.verdicts[0]!;
    expect(v.pass).toBe(false);
    expect(v.outcomes.find((o) => o.caseId === "case-4")!.result).toBe("loss");
    expect(v.reasons).toEqual(["baseline beat the skill on 1 case(s): case-4"]);
    expect(report.noSkill).toHaveLength(1);
    expect(report.noSkill[0]).toMatchObject({ caseId: "case-4", outcome: "loss", skillScore: 0.5, baselineScore: 1 });
    expect(report.noSkill[0]!.checks[0]!.check).toEqual({ type: "not_contains", value: "SIGNED-OFF" });
    const md = renderNoSkillMarkdown(report.noSkill);
    expect(md).toContain('| weekly-report | case-4 | anthropic | loss | 50.0% | 100.0% | not_contains "SIGNED-OFF" (0.0% vs 100.0%; skill: found "SIGNED-OFF") |');
    expect(renderEvalMarkdown(report)).toContain("## No-skill check");
    expect(renderEvalMarkdown(report)).toContain("- **weekly-report** on anthropic: baseline beat the skill");
  });

  it("ties pass; fewer than 10 cases fail; minCases is configurable", async () => {
    const tie = suite(10, { checks: [{ type: "contains", value: "Weekly report" }] });
    const r = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [tie] });
    expect(r.verdicts[0]!.outcomes.every((o) => o.result === "tie")).toBe(true);
    expect(r.pass).toBe(true);
    const few = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(3)] });
    expect(few.verdicts[0]!.reasons).toEqual(["only 3 case(s); gate 5 needs at least 10"]);
    expect((await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(3)], minCases: 3 })).pass).toBe(true);
  });

  it("gives one verdict per provider and labels duplicate providers", async () => {
    const r = await runEvals({
      harness,
      providers: [
        { provider: smart(answer, { id: "anthropic" }), model: "a1" },
        { provider: smart(() => ({ steps: [{ text: "nothing useful" }] }), { id: "openai" }), model: "o1" },
      ],
      suites: [suite()],
    });
    expect(r.verdicts.map((v) => [v.provider, v.pass])).toEqual([["anthropic", true], ["openai", true]]);
    expect(r.verdicts[1]!.outcomes.every((o) => o.result === "tie")).toBe(true);
  });

  it("counts failed runs and fails the verdict; a failed run scores zero", async () => {
    const flaky = smart((req) => (/report 2\b/.test(JSON.stringify(req.messages)) ? { steps: [{ error: { kind: "server", message: "down" } }] } : answer(req)));
    const r = await runEvals({ harness, providers: [{ provider: flaky, model: "m1" }], suites: [suite()] });
    const v = r.verdicts[0]!;
    expect(v.errors).toBe(2);
    expect(v.pass).toBe(false);
    expect(v.reasons.join()).toMatch(/2 run\(s\) failed/);
    expect(r.runs.find((x) => x.caseId === "case-2" && x.withSkill)!).toMatchObject({ score: 0, error: "server: down" });
    expect(renderEvalMarkdown(r)).toContain("## Failed runs");
    expect(r.noSkill.find((f) => f.caseId === "case-2")).toBeUndefined();
  });

  it("reports setup failures and harness timeouts as run errors", async () => {
    const broken: EvalHarnessFactory = () => {
      throw new Error("no harness");
    };
    const r = await runEvals({ harness: broken, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(1)], minCases: 1 });
    expect(r.runs[0]!.error).toBe("setup failed: no harness");
    const hang: EvalHarnessFactory = () => ({ async *run() { await new Promise(() => {}); } }) as HarnessApi;
    const t = await runEvals({ harness: hang, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(1)], minCases: 1, timeoutMs: 30 });
    expect(t.runs[0]!.error).toBe("timed out after 30 ms");
  });

  it("scores judge checks with the judge, and fails verdicts when judge checks went unscored", async () => {
    const s = suite(10, { checks: [{ type: "judge", rubric: "Is it signed off?" }] });
    const judge: JudgeFn = async ({ output }) => ({ score: output.includes("SIGNED-OFF") ? 1 : 0.2, reason: "checked" });
    const r = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [s], judge });
    expect(r.pass).toBe(true);
    expect(r.runs.find((x) => !x.withSkill)!.score).toBeCloseTo(0.2);
    const modelJudge = smart(() => ({ steps: [{ text: '{"score":0.9,"reason":"fine"}' }] }), { id: "google" });
    const m = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(1, { checks: [{ type: "judge", rubric: "ok?" }] })], minCases: 1, judge: { provider: modelJudge, model: "j1" } });
    expect(m.judge).toEqual({ provider: "google", model: "j1" });
    expect(m.runs[0]!.checks[0]!.score).toBe(0.9);
    const none = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [s] });
    expect(none.pass).toBe(false);
    expect(none.verdicts[0]!.reasons).toContain("20 judge check result(s) were not scored (no judge model)");
  });

  it("respects the concurrency limit and reports progress", async () => {
    const track = { now: 0, max: 0 };
    const seen: number[] = [];
    await runEvals({ harness, providers: [{ provider: smart(answer, { delayMs: 10, track }), model: "m1" }], suites: [suite()], concurrency: 3, onRun: (_r, done) => seen.push(done) });
    expect(track.max).toBeLessThanOrEqual(3);
    expect(track.max).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("denies every approval by default and sends the forced skill / disableSkills flags", async () => {
    expect(await DENY_ALL_APPROVALS({ approvalId: "a", call: { id: "c", name: "send_email", input: {} }, effects: ["send"], summary: "" })).toMatchObject({ approved: false });
    const tasks: unknown[] = [];
    const spy: EvalHarnessFactory = () => ({
      async *run(task) {
        tasks.push(task);
        yield { type: "done", stopReason: "end_turn", text: "x", usage: { inputTokens: 1, outputTokens: 1 } } as HarnessEvent;
      },
    });
    await runEvals({ harness: spy, providers: [{ provider: smart(answer), model: "m1" }], suites: [suite(1)], minCases: 1, maxTurns: 3 });
    expect(tasks).toEqual(
      expect.arrayContaining([
        { input: "Weekly report 1", provider: "anthropic", model: "m1", origin: { kind: "eval" }, maxTurns: 3, skill: "weekly-report" },
        { input: "Weekly report 1", provider: "anthropic", model: "m1", origin: { kind: "eval" }, maxTurns: 3, disableSkills: true },
      ]),
    );
  });
});

describe("collectHarnessRun", () => {
  const h = (events: HarnessEvent[], throwAfter = false): HarnessApi => ({
    async *run() {
      for (const e of events) yield e;
      if (throwAfter) throw new Error("exploded");
    },
  });
  const task = { input: "x", provider: "local" as const, model: "m", skill: "s" };
  it("collects text, tool calls, usage and skill loading", async () => {
    const r = await collectHarnessRun(
      h([
        { type: "skill_loaded", name: "s", reason: "forced" },
        { type: "text_delta", text: "a" },
        { type: "tool_start", call: { id: "1", name: "db_query", input: {} }, effects: ["read"] },
        { type: "turn_end", turn: 1, usage: { inputTokens: 3, outputTokens: 4 } },
        { type: "text_delta", text: "b" },
        { type: "done", stopReason: "end_turn", text: "", usage: { inputTokens: 0, outputTokens: 0 } },
        { type: "text_delta", text: "ignored after done" },
      ]),
      task,
      DENY_ALL_APPROVALS,
      1000,
    );
    expect(r).toEqual({ text: "ab", toolCalls: ["db_query"], usage: { inputTokens: 3, outputTokens: 4 }, skillLoaded: true });
  });
  it("turns missing terminals, throws, errors and cancelled runs into errors", async () => {
    expect((await collectHarnessRun(h([{ type: "text_delta", text: "a" }]), task, DENY_ALL_APPROVALS, 1000)).error).toBe("run ended without done");
    expect((await collectHarnessRun(h([], true), task, DENY_ALL_APPROVALS, 1000)).error).toBe("harness threw: exploded");
    expect((await collectHarnessRun(h([{ type: "error", message: "bad", retryable: false }]), task, DENY_ALL_APPROVALS, 1000)).error).toBe("bad");
    // Contract: error then done/error; the error message wins.
    expect((await collectHarnessRun(h([{ type: "error", message: "bad", retryable: false }, { type: "done", stopReason: "error", text: "", usage: { inputTokens: 0, outputTokens: 0 } }]), task, DENY_ALL_APPROVALS, 1000)).error).toBe("bad");
    expect((await collectHarnessRun(h([{ type: "done", stopReason: "cancelled", text: "t", usage: { inputTokens: 1, outputTokens: 1 } }]), task, DENY_ALL_APPROVALS, 1000)).error).toBe("run ended with cancelled");
  });
});

describe("rescoring recorded reports", () => {
  it("re-runs deterministic checks on recorded output and reuses judge results", async () => {
    const judge: JudgeFn = async () => ({ score: 1, reason: "ok" });
    const s = suite(10);
    s.cases[0]!.checks.push({ type: "judge", rubric: "fine?" });
    const live = await runEvals({ harness, providers: [{ provider: smart(answer), model: "m1" }], suites: [s], judge });
    expect(live.pass).toBe(true);
    const same = await rescoreReport(live, [s]);
    expect(same.mode).toBe("recorded");
    expect(same.pass).toBe(true);
    expect(same.runs[0]!.checks.find((c) => c.check.type === "judge")!.score).toBe(1);
    const changed = structuredClone(s);
    changed.cases[1]!.checks = [{ type: "not_contains", value: "SIGNED-OFF" }];
    changed.cases[2]!.checks.push({ type: "judge", rubric: "new rubric" });
    const re = await rescoreReport(live, [changed]);
    expect(re.verdicts[0]!.outcomes.find((o) => o.caseId === "case-2")!.result).toBe("loss");
    expect(re.verdicts[0]!.reasons.join()).toMatch(/not scored/);
    const rejudged = await rescoreReport(live, [changed], { judge });
    expect(rejudged.verdicts[0]!.reasons.join()).not.toMatch(/not scored/);
    const fewer = { ...changed, cases: changed.cases.slice(0, 2) };
    expect((await rescoreReport(live, [fewer], { minCases: 2 })).runs).toHaveLength(4);
    expect((await rescoreReport(live, [{ skill: "other", cases: [] }])).runs).toEqual([]);
    const withErr = structuredClone(live);
    withErr.runs[0]!.error = "boom";
    expect((await rescoreReport(withErr, [s])).verdicts[0]!.errors).toBe(1);
  });

  it("buildReport notes missing runs and skills that never loaded", () => {
    const r = buildReport({ mode: "recorded", startedAt: "t", runs: [], suites: [suite(1)], providers: [{ name: "a", provider: "anthropic", model: "m" }], minCases: 1, tieEpsilon: 0.01 });
    expect(r.verdicts[0]!.reasons[0]).toBe("case case-1 is missing a with-skill run");
    expect(r.pass).toBe(false);
    const run = (withSkill: boolean) => ({ skill: "weekly-report", caseId: "case-1", provider: "a", model: "m", withSkill, score: 1, checks: [], outputText: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, skillLoaded: false, weight: 1 });
    const n = buildReport({ mode: "recorded", startedAt: "t", runs: [run(true), run(false)], suites: [suite(1)], providers: [{ name: "a", provider: "anthropic", model: "m" }], minCases: 1, tieEpsilon: 0.01 });
    expect(n.verdicts[0]!.notes[0]).toMatch(/did not report skill_loaded/);
    expect(renderEvalMarkdown(n)).toContain("did not report skill_loaded");
    expect(renderEvalMarkdown({ ...n, verdicts: [] })).toContain("| — | — | — | 0 |");
    expect(noSkillCheck({ runs: [run(true)], tieEpsilon: 0.01 })).toEqual([]);
    expect(renderNoSkillMarkdown([])).toMatch(/No rules to cut/);
  });

  it("describes every check type", () => {
    expect(
      [
        { type: "contains", value: "a" },
        { type: "regex", pattern: "x", flags: "i" },
        { type: "tool_called", name: "t", minTimes: 2 },
        { type: "tool_not_called", name: "t" },
        { type: "json_valid" },
        { type: "max_words", value: 5 },
        { type: "judge", rubric: "r".repeat(80) },
      ].map((c) => describeCheck(c as never)),
    ).toEqual(['contains "a"', "regex /x/i", "tool_called t x2", "tool_not_called t", "json_valid", "max_words 5", `judge: ${"r".repeat(57)}...`]);
  });
});
