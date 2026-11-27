import { describe, expect, it } from "vitest";
import type { HarnessApi, HarnessEvent } from "@oneseat/contracts";
import { CONFORMANCE_SKILLS, describeHarnessConformance, HARNESS_CHECKS, runHarnessConformance, validateHarnessEvents, type MakeHarness } from "../src/index.js";
import { createReferenceHarness, type HarnessBug } from "./fakes/harness.js";

const make =
  (bugs: HarnessBug[] = []): MakeHarness =>
  (provider, store, ctx) =>
    createReferenceHarness({ provider, store, tools: ctx.tools, bugs });

// As packages/harness will use it.
describeHarnessConformance(make());

async function failing(bugs: HarnessBug[]) {
  const r = await runHarnessConformance(make(bugs), { timeoutMs: 5000 });
  return Object.fromEntries(r.filter((x) => x.problems.length > 0).map((x) => [x.name, x.problems.join("\n")]));
}

describe("harness conformance catches broken harnesses", () => {
  it("passes the reference harness", async () => {
    expect(await failing([])).toEqual({});
    expect(HARNESS_CHECKS.length).toBe(11);
    expect(CONFORMANCE_SKILLS.map((s) => s.name)).toEqual(["alpha-notes", "beta-invoices"]);
  });

  const cases: [HarnessBug, RegExp, RegExp][] = [
    ["run-before-approval", /before a "send" tool/, /ran before the person approved/],
    ["bodies-in-index", /skill index/, /contains skill content/],
    ["index-when-disabled", /disableSkills/, /baseline mentions skill/],
    ["double-done", /plain reply/, /terminal events, expected exactly one/],
    ["denial-not-error", /denied approval/, /isError: true/],
    ["throws", /provider error/, /harness threw/],
    ["no-skill-loaded-event", /forced skill/, /no skill_loaded event/],
  ];
  for (const [bug, check, problem] of cases)
    it(`catches "${bug}"`, async () => {
      const found = await failing([bug]);
      const name = Object.keys(found).find((n) => check.test(n));
      expect(name, `failing checks: ${Object.keys(found).join(" | ")}`).toBeDefined();
      expect(found[name!]).toMatch(problem);
    });

  it("reports a harness that never finishes or cannot be built", async () => {
    const hang: MakeHarness = () => ({ async *run() { yield { type: "session_start", sessionId: "s", runId: "r" } as HarnessEvent; await new Promise(() => {}); } });
    const r = await runHarnessConformance(hang, { timeoutMs: 50 });
    expect(r[0]!.problems.join()).toMatch(/did not finish within 50 ms/);
    const boom: MakeHarness = () => {
      throw new Error("no harness");
    };
    expect((await runHarnessConformance(boom, { timeoutMs: 100 }))[0]!.problems.join()).toMatch(/no harness/);
  });

  it("supports a custom load-skill tool", async () => {
    const custom: MakeHarness = (provider, store, ctx) => {
      const inner = createReferenceHarness({ provider, store, tools: ctx.tools });
      return inner as HarnessApi;
    };
    const r = await runHarnessConformance(custom, { loadSkillTool: { name: "use_skill", input: (skill) => ({ skill }) } });
    expect(r.find((x) => x.name.startsWith("starts with"))!.problems.join()).toMatch(/does not offer the use_skill tool/);
  });
});

describe("validateHarnessEvents", () => {
  const done: HarnessEvent = { type: "done", stopReason: "end_turn", text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
  const rules = (e: HarnessEvent[]) => validateHarnessEvents(e).map((i) => i.rule);
  it("accepts a normal run", () => {
    expect(rules([{ type: "session_start", sessionId: "s", runId: "r" }, { type: "text_delta", text: "x" }, { type: "turn_end", turn: 1, usage: { inputTokens: 1, outputTokens: 2 } }, done])).toEqual([]);
  });
  it("flags ordering and pairing problems", () => {
    const call = { id: "c1", name: "t", input: {} };
    expect(rules([])).toEqual(["empty"]);
    expect(rules([{ type: "text_delta", text: "x" }])).toContain("terminal");
    expect(rules([done, done])).toEqual(expect.arrayContaining(["after-terminal", "terminal"]));
    expect(rules([{ type: "text_delta", text: "x" }, { type: "session_start", sessionId: "s", runId: "r" }, done])).toContain("session-start");
    expect(rules([{ type: "tool_end", result: { callId: "zz", name: "t", content: "", isError: false }, durationMs: -1 }, done])).toEqual(expect.arrayContaining(["tool-pair", "tool-duration"]));
    expect(rules([{ type: "approval_result", approvalId: "nope", approved: true }, done])).toContain("approval-pair");
    expect(rules([{ type: "approval_request", approvalId: "a", call, effects: ["send"], summary: "s" }, { type: "approval_request", approvalId: "a", call, effects: ["send"], summary: "s" }, done])).toContain("approval-id");
    expect(rules([{ type: "turn_end", turn: 1, usage: { inputTokens: -1, outputTokens: 0 } }, { type: "done", stopReason: "weird" as never, text: 1 as never, usage: null as never }])).toEqual(
      expect.arrayContaining(["usage", "stop-reason", "done-text"]),
    );
    expect(rules([{ type: "error", message: "", retryable: false }])).toContain("error-message");
  });
});
