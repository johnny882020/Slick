// Scoring for every EvalCheck type, case outcomes and the gate 5 pass rule.

import type { CheckResult, EvalCase, EvalCheck } from "@oneseat/contracts";

/** What a run produced, as the checks see it. */
export interface RunOutput {
  /** Final answer text (HarnessEvent done.text). */
  text: string;
  /** Tool names from tool_start events, in order. */
  toolCalls: string[];
  /** Task input, shown to the judge. */
  input?: string;
}

export interface JudgeVerdict {
  score: number;
  reason: string;
}

/** Scores one judge check. Must return a score in 0..1. */
export type JudgeFn = (args: { rubric: string; input: string; output: string; toolCalls: string[] }) => Promise<JudgeVerdict>;

export const TIE_EPSILON = 0.01;
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/** Words: runs of letters or digits (with inner apostrophes, hyphens). Markdown symbols do not count. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** Parse text as JSON, allowing one surrounding ``` or ```json fence. */
export function parseJsonOutput(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let t = text.trim();
  const fence = t.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1]!.trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function result(check: EvalCheck, pass: boolean, detail?: string, score?: number): CheckResult {
  return { check, pass, score: score ?? (pass ? 1 : 0), ...(detail !== undefined ? { detail } : {}) };
}

/** Score one check against a run's output. Never throws. */
export async function scoreCheck(check: EvalCheck, out: RunOutput, judge?: JudgeFn): Promise<CheckResult> {
  const text = out.text ?? "";
  switch (check.type) {
    case "contains":
    case "not_contains": {
      const cs = check.caseSensitive ?? false;
      const has = cs ? text.includes(check.value) : text.toLowerCase().includes(check.value.toLowerCase());
      const pass = check.type === "contains" ? has : !has;
      return result(check, pass, pass ? undefined : `${has ? "found" : "missing"} ${JSON.stringify(check.value)}`);
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(check.pattern, (check.flags ?? "").replace("g", ""));
      } catch (e) {
        return result(check, false, `invalid RegExp: ${(e as Error).message}`);
      }
      const pass = re.test(text);
      return result(check, pass, pass ? undefined : `no match for /${check.pattern}/${check.flags ?? ""}`);
    }
    case "tool_called": {
      const n = out.toolCalls.filter((t) => t === check.name).length;
      const min = check.minTimes ?? 1;
      const pass = n >= min;
      return result(check, pass, pass ? undefined : `${check.name} called ${n} time(s), expected at least ${min}`);
    }
    case "tool_not_called": {
      const n = out.toolCalls.filter((t) => t === check.name).length;
      return result(check, n === 0, n === 0 ? undefined : `${check.name} was called ${n} time(s)`);
    }
    case "json_valid": {
      const r = parseJsonOutput(text);
      return result(check, r.ok, r.ok ? undefined : `not valid JSON: ${r.error}`);
    }
    case "max_words":
    case "min_words": {
      const n = countWords(text);
      const pass = check.type === "max_words" ? n <= check.value : n >= check.value;
      return result(check, pass, pass ? undefined : `${n} words, ${check.type === "max_words" ? "max" : "min"} ${check.value}`);
    }
    case "judge": {
      const threshold = check.threshold ?? DEFAULT_JUDGE_THRESHOLD;
      if (!judge) return result(check, false, "not scored: no judge model configured", 0);
      try {
        const v = await judge({ rubric: check.rubric, input: out.input ?? "", output: text, toolCalls: out.toolCalls });
        const score = Math.min(1, Math.max(0, Number.isFinite(v.score) ? v.score : 0));
        return result(check, score >= threshold, `judge ${score.toFixed(2)} (threshold ${threshold}): ${v.reason}`, score);
      } catch (e) {
        return result(check, false, `judge failed: ${(e as Error).message}`, 0);
      }
    }
    default: {
      const unknown = check as { type?: unknown };
      return result(check as EvalCheck, false, `unknown check type ${JSON.stringify(unknown.type)}`);
    }
  }
}

/** Score a case: the mean of its check scores. A failed run scores 0 on every check. */
export async function scoreCase(c: Pick<EvalCase, "checks">, out: RunOutput, opts: { judge?: JudgeFn; error?: string } = {}): Promise<{ score: number; checks: CheckResult[] }> {
  if (opts.error !== undefined) return { score: 0, checks: c.checks.map((check) => result(check, false, `run failed: ${opts.error}`, 0)) };
  const checks: CheckResult[] = [];
  for (const check of c.checks) checks.push(await scoreCheck(check, out, opts.judge));
  const score = checks.length === 0 ? 0 : checks.reduce((s, r) => s + r.score, 0) / checks.length;
  return { score, checks };
}

export type CaseOutcome = "win" | "tie" | "loss";

/** Skill vs baseline on one case. Tie when the scores are within epsilon (default 0.01). */
export function compareScores(withSkill: number, baseline: number, epsilon = TIE_EPSILON): CaseOutcome {
  if (Math.abs(withSkill - baseline) <= epsilon + 1e-9) return "tie";
  return withSkill > baseline ? "win" : "loss";
}

/** Weighted mean of case scores (weight defaults to 1). */
export function weightedScore(items: readonly { score: number; weight?: number }[]): number {
  let total = 0;
  let weights = 0;
  for (const i of items) {
    const w = i.weight ?? 1;
    total += i.score * w;
    weights += w;
  }
  return weights === 0 ? 0 : total / weights;
}

export interface Gate5Decision {
  pass: boolean;
  reasons: string[];
}

/** Gate 5: the skill wins or ties on every case, over at least minCases cases, with no failed runs. */
export function gate5Decision(outcomes: readonly { caseId: string; result: CaseOutcome }[], opts: { minCases?: number; errors?: number } = {}): Gate5Decision {
  const minCases = opts.minCases ?? 10;
  const reasons: string[] = [];
  if (outcomes.length < minCases) reasons.push(`only ${outcomes.length} case(s); gate 5 needs at least ${minCases}`);
  const losses = outcomes.filter((o) => o.result === "loss");
  if (losses.length > 0) reasons.push(`baseline beat the skill on ${losses.length} case(s): ${losses.map((l) => l.caseId).join(", ")}`);
  if ((opts.errors ?? 0) > 0) reasons.push(`${opts.errors} run(s) failed, so the comparison is not valid`);
  return { pass: reasons.length === 0, reasons };
}

/** Gate 5 pass rule as a boolean. */
export function gate5Pass(outcomes: readonly { caseId: string; result: CaseOutcome }[], opts: { minCases?: number; errors?: number } = {}): boolean {
  return gate5Decision(outcomes, opts).pass;
}
