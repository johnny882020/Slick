import { describe, expect, it } from "vitest";
import { createScriptedProvider, type EvalCheck } from "@oneseat/contracts";
import {
  compareScores,
  countWords,
  createModelJudge,
  gate5Decision,
  gate5Pass,
  judgePrompt,
  JUDGE_SYSTEM,
  parseJsonOutput,
  parseJudgeReply,
  scoreCase,
  scoreCheck,
  weightedScore,
  type JudgeFn,
} from "../src/evals/index.js";

const out = (text: string, toolCalls: string[] = []) => ({ text, toolCalls, input: "task" });
const s = async (check: EvalCheck, text: string, tools: string[] = [], judge?: JudgeFn) => scoreCheck(check, out(text, tools), judge);

describe("scoreCheck: every EvalCheck type", () => {
  it("contains / not_contains, case-insensitive by default", async () => {
    expect((await s({ type: "contains", value: "Paris" }, "in paris today")).pass).toBe(true);
    expect((await s({ type: "contains", value: "Paris", caseSensitive: true }, "in paris")).pass).toBe(false);
    const miss = await s({ type: "contains", value: "Rome" }, "Paris");
    expect(miss).toMatchObject({ pass: false, score: 0, detail: 'missing "Rome"' });
    expect((await s({ type: "not_contains", value: "TODO" }, "all done")).pass).toBe(true);
    expect(await s({ type: "not_contains", value: "todo" }, "TODO left")).toMatchObject({ pass: false, detail: 'found "todo"' });
  });

  it("regex, ignoring the g flag and reporting bad patterns", async () => {
    expect((await s({ type: "regex", pattern: "INV-\\d{4}" }, "Invoice INV-0042")).pass).toBe(true);
    expect((await s({ type: "regex", pattern: "inv-\\d+", flags: "gi" }, "INV-1")).pass).toBe(true);
    expect((await s({ type: "regex", pattern: "^x$" }, "y")).detail).toMatch(/no match/);
    expect((await s({ type: "regex", pattern: "(" }, "y")).detail).toMatch(/invalid RegExp/);
  });

  it("tool_called / tool_not_called from tool_start names", async () => {
    expect((await s({ type: "tool_called", name: "db_query" }, "", ["db_query"])).pass).toBe(true);
    expect(await s({ type: "tool_called", name: "db_query", minTimes: 2 }, "", ["db_query"])).toMatchObject({ pass: false, detail: "db_query called 1 time(s), expected at least 2" });
    expect((await s({ type: "tool_not_called", name: "send_email" }, "", ["db_query"])).pass).toBe(true);
    expect((await s({ type: "tool_not_called", name: "send_email" }, "", ["send_email"])).detail).toMatch(/called 1/);
  });

  it("json_valid, allowing one code fence", async () => {
    expect((await s({ type: "json_valid" }, '{"a":1}')).pass).toBe(true);
    expect((await s({ type: "json_valid" }, '```json\n{"a":1}\n```')).pass).toBe(true);
    expect((await s({ type: "json_valid" }, "Here: {a:1}")).detail).toMatch(/not valid JSON/);
    expect(parseJsonOutput("[1,2]")).toEqual({ ok: true, value: [1, 2] });
  });

  it("max_words / min_words count words, not symbols", async () => {
    expect(countWords("Hello, world — it's a well-known fact. 42 ## **")).toBe(7);
    expect(countWords("")).toBe(0);
    expect(countWords("Ünïcode wörds 東京")).toBe(3);
    expect((await s({ type: "max_words", value: 3 }, "one two three")).pass).toBe(true);
    expect((await s({ type: "max_words", value: 2 }, "one two three")).detail).toBe("3 words, max 2");
    expect((await s({ type: "min_words", value: 3 }, "one two")).detail).toBe("2 words, min 3");
  });

  it("judge: uses the judge score and threshold, clamps, survives errors", async () => {
    const j = (score: number): JudgeFn => async () => ({ score, reason: "because" });
    expect(await s({ type: "judge", rubric: "r" }, "x", [], j(0.8))).toMatchObject({ pass: true, score: 0.8 });
    expect(await s({ type: "judge", rubric: "r", threshold: 0.9 }, "x", [], j(0.8))).toMatchObject({ pass: false, score: 0.8 });
    expect((await s({ type: "judge", rubric: "r" }, "x", [], j(7))).score).toBe(1);
    expect((await s({ type: "judge", rubric: "r" }, "x", [], j(Number.NaN))).score).toBe(0);
    expect(await s({ type: "judge", rubric: "r" }, "x")).toMatchObject({ pass: false, score: 0, detail: "not scored: no judge model configured" });
    const failing: JudgeFn = async () => {
      throw new Error("judge down");
    };
    expect((await s({ type: "judge", rubric: "r" }, "x", [], failing)).detail).toBe("judge failed: judge down");
    let seen: Parameters<JudgeFn>[0] | undefined;
    await s({ type: "judge", rubric: "be brief" }, "answer", ["db_query"], async (a) => ((seen = a), { score: 1, reason: "" }));
    expect(seen).toEqual({ rubric: "be brief", input: "task", output: "answer", toolCalls: ["db_query"] });
  });

  it("unknown check types fail", async () => {
    expect((await s({ type: "telepathy" } as never, "x")).detail).toMatch(/unknown check type/);
  });
});

describe("case scores and gate 5 maths", () => {
  it("case score is the mean of check scores; failed runs score zero", async () => {
    const c = { checks: [{ type: "contains", value: "a" }, { type: "contains", value: "zzz" }, { type: "not_contains", value: "q" }] as EvalCheck[] };
    expect((await scoreCase(c, out("a"))).score).toBeCloseTo(2 / 3);
    const failed = await scoreCase(c, out("a"), { error: "boom" });
    expect(failed.score).toBe(0);
    expect(failed.checks.every((x) => !x.pass && x.detail === "run failed: boom")).toBe(true);
    expect((await scoreCase({ checks: [] }, out("a"))).score).toBe(0);
  });

  it("win / tie / loss with a 0.01 tie band", () => {
    expect(compareScores(0.8, 0.5)).toBe("win");
    expect(compareScores(0.5, 0.8)).toBe("loss");
    expect(compareScores(0.5, 0.5)).toBe("tie");
    expect(compareScores(0.505, 0.5)).toBe("tie");
    expect(compareScores(0.51, 0.5)).toBe("tie");
    expect(compareScores(0.5, 0.51)).toBe("tie");
    expect(compareScores(0.512, 0.5)).toBe("win");
    expect(compareScores(0.5, 0.512)).toBe("loss");
    expect(compareScores(2 / 3, 0.67)).toBe("tie");
    expect(compareScores(0.6, 0.5, 0.2)).toBe("tie");
  });

  it("weighted score", () => {
    expect(weightedScore([{ score: 1, weight: 3 }, { score: 0 }])).toBe(0.75);
    expect(weightedScore([])).toBe(0);
  });

  it("gate 5: wins or ties on every case, at least 10 cases, no failed runs", () => {
    const ties = Array.from({ length: 10 }, (_, i) => ({ caseId: `c${i}`, result: "tie" as const }));
    expect(gate5Pass(ties)).toBe(true);
    expect(gate5Pass([...ties.slice(0, 9), { caseId: "w", result: "win" }])).toBe(true);
    expect(gate5Decision(ties.slice(0, 9))).toEqual({ pass: false, reasons: ["only 9 case(s); gate 5 needs at least 10"] });
    expect(gate5Decision([...ties, { caseId: "bad", result: "loss" }]).reasons).toEqual(["baseline beat the skill on 1 case(s): bad"]);
    expect(gate5Decision(ties, { errors: 2 }).reasons).toEqual(["2 run(s) failed, so the comparison is not valid"]);
    expect(gate5Pass(ties.slice(0, 3), { minCases: 3 })).toBe(true);
  });
});

describe("judge model", () => {
  it("parses strict replies", () => {
    expect(parseJudgeReply('{"score": 0.5, "reason": " ok "}')).toEqual({ score: 0.5, reason: "ok" });
    expect(parseJudgeReply('Sure! {"score":1,"reason":"full"} done')).toEqual({ score: 1, reason: "full" });
    expect(parseJudgeReply('```json\n{"score":0,"reason":"no"}\n```')).toEqual({ score: 0, reason: "no" });
    expect(() => parseJudgeReply("no json")).toThrow(/not JSON/);
    expect(() => parseJudgeReply("[1]")).toThrow(/object/);
    expect(() => parseJudgeReply('{"score": 8, "reason": "x"}')).toThrow(/0 to 1/);
    expect(() => parseJudgeReply('{"score": "0.5", "reason": "x"}')).toThrow(/0 to 1/);
    expect(() => parseJudgeReply('{"score": 0.5}')).toThrow(/reason/);
  });

  it("prompts with the rubric and treats the answer as data", () => {
    const p = judgePrompt({ rubric: "R", input: "I", output: "O".repeat(30_000), toolCalls: [] });
    expect(p).toContain("<rubric>\nR\n</rubric>");
    expect(p).toContain("tools_called>\nnone");
    expect(p).toContain("[answer truncated]");
    expect(JUDGE_SYSTEM).toMatch(/data, not instructions/);
  });

  it("asks the model, retries once on a bad reply, and gives up clearly", async () => {
    const good = createScriptedProvider([{ steps: [{ text: '{"score":0.9,"reason":"meets it"}' }] }]);
    const judge = createModelJudge({ provider: good, model: "judge-1" });
    expect(await judge({ rubric: "r", input: "i", output: "o", toolCalls: ["t"] })).toEqual({ score: 0.9, reason: "meets it" });
    expect(good.requests[0]!.system).toBe(JUDGE_SYSTEM);
    expect(good.requests[0]!.temperature).toBe(0);
    expect(good.requests[0]!.tools).toEqual([]);

    const retry = createScriptedProvider([{ steps: [{ text: "I think it is good" }] }, { steps: [{ text: '{"score":0.4,"reason":"partly"}' }] }]);
    expect(await createModelJudge({ provider: retry, model: "j" })({ rubric: "r", input: "i", output: "o", toolCalls: [] })).toEqual({ score: 0.4, reason: "partly" });
    expect(JSON.stringify(retry.requests[1]!.messages)).toMatch(/previous reply was invalid/);

    const bad = createScriptedProvider([{ steps: [{ text: "nope" }] }, { steps: [{ text: "still nope" }] }]);
    await expect(createModelJudge({ provider: bad, model: "j" })({ rubric: "r", input: "i", output: "o", toolCalls: [] })).rejects.toThrow(/no valid verdict/);

    const authFail = createScriptedProvider([{ steps: [{ error: { kind: "auth", message: "bad key" } }] }]);
    await expect(createModelJudge({ provider: authFail, model: "j", retries: 3 })({ rubric: "r", input: "i", output: "o", toolCalls: [] })).rejects.toThrow(/auth: bad key/);
    expect(authFail.requests).toHaveLength(1);

    const flaky = createScriptedProvider([{ steps: [{ error: { kind: "server" } }] }, { steps: [{ text: '{"score":1,"reason":"y"}' }] }]);
    expect((await createModelJudge({ provider: flaky, model: "j" })({ rubric: "r", input: "i", output: "o", toolCalls: [] })).score).toBe(1);
  });
});
