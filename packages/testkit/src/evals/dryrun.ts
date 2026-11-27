// --dry-run: validate every suite and seed every case into an in-memory database. No model calls.

import type { EvalSuite } from "@oneseat/contracts";
import { trySeedInMemory } from "./seed.js";
import { loadEvalSuites, type EvalIssue } from "./validate.js";

export interface DryRunResult {
  ok: boolean;
  suites: EvalSuite[];
  issues: EvalIssue[];
  /** Skill folders with no evals/cases.json. */
  missing: string[];
  cases: number;
  judgeChecks: number;
}

export async function dryRunEvals(skillsDir: string, opts: { minCases?: number; only?: readonly string[]; requireAll?: boolean } = {}): Promise<DryRunResult> {
  const loaded = await loadEvalSuites(skillsDir, opts);
  const issues = [...loaded.issues];
  let cases = 0;
  let judgeChecks = 0;
  for (const suite of loaded.suites) {
    for (const [i, c] of suite.cases.entries()) {
      cases++;
      judgeChecks += c.checks.filter((x) => x.type === "judge").length;
      const err = await trySeedInMemory(c);
      if (err) issues.push({ severity: "error", path: `cases[${i}].db`, message: `seed failed: ${err}`, skill: suite.skill });
    }
  }
  if (opts.requireAll ?? true) for (const m of loaded.missing) issues.push({ severity: "error", path: "evals/cases.json", message: "skill has no eval cases", skill: m });
  if (loaded.suites.length === 0 && loaded.missing.length === 0 && !issues.some((i) => i.severity === "error"))
    issues.push({ severity: "error", path: skillsDir, message: "no skills with eval cases found" });
  const suites = loaded.suites.filter((s) => !issues.some((i) => i.severity === "error" && i.skill === s.skill));
  return { ok: !issues.some((i) => i.severity === "error"), suites, issues, missing: loaded.missing, cases, judgeChecks };
}

export function renderDryRun(r: DryRunResult): string {
  const lines = [`Eval dry run: ${r.ok ? "OK" : "FAILED"} — ${r.suites.length} suite(s), ${r.cases} case(s), ${r.judgeChecks} judge check(s). No models were called.`];
  for (const i of r.issues) lines.push(`  ${i.severity === "error" ? "error" : "warn "} ${i.skill ? `${i.skill}: ` : ""}${i.path ? `${i.path}: ` : ""}${i.message}`);
  return lines.join("\n");
}
