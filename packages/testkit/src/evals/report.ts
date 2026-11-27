// Eval report rendering and the no-skill check
// ("every release, run each starter task once without its skill; remove rules that hold the model back").

import type { EvalCheck } from "@oneseat/contracts";
import { compareScores, type CaseOutcome } from "./score.js";
import type { EvalReport } from "./runner.js";

export interface NoSkillCheckDiff {
  check: EvalCheck;
  skillScore: number;
  baselineScore: number;
  skillDetail?: string;
  baselineDetail?: string;
}

export interface NoSkillFinding {
  skill: string;
  provider: string;
  model: string;
  caseId: string;
  /** Case outcome for the skill: "loss" means the baseline beat it overall. */
  outcome: CaseOutcome;
  skillScore: number;
  baselineScore: number;
  /** Checks where the baseline scored higher than the skill. */
  checks: NoSkillCheckDiff[];
}

/** Every case, per provider, where the baseline beat the skill overall or on any single check. */
export function noSkillCheck(report: Pick<EvalReport, "runs" | "tieEpsilon">): NoSkillFinding[] {
  const out: NoSkillFinding[] = [];
  for (const s of report.runs.filter((r) => r.withSkill)) {
    const b = report.runs.find((r) => !r.withSkill && r.skill === s.skill && r.caseId === s.caseId && r.provider === s.provider && r.model === s.model);
    if (!b || s.error || b.error) continue;
    const checks: NoSkillCheckDiff[] = [];
    s.checks.forEach((sc, i) => {
      const bc = b.checks[i];
      if (!bc || JSON.stringify(bc.check) !== JSON.stringify(sc.check)) return;
      if (bc.score > sc.score + 1e-9)
        checks.push({
          check: sc.check,
          skillScore: sc.score,
          baselineScore: bc.score,
          ...(sc.detail !== undefined ? { skillDetail: sc.detail } : {}),
          ...(bc.detail !== undefined ? { baselineDetail: bc.detail } : {}),
        });
    });
    const outcome = compareScores(s.score, b.score, report.tieEpsilon);
    if (outcome === "loss" || checks.length > 0)
      out.push({ skill: s.skill, provider: s.provider, model: s.model, caseId: s.caseId, outcome, skillScore: s.score, baselineScore: b.score, checks });
  }
  return out.sort((a, b) => a.skill.localeCompare(b.skill) || a.caseId.localeCompare(b.caseId) || a.provider.localeCompare(b.provider));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Describe a check in a few words for tables. */
export function describeCheck(c: EvalCheck): string {
  switch (c.type) {
    case "contains":
    case "not_contains":
      return `${c.type} ${JSON.stringify(c.value)}`;
    case "regex":
      return `regex /${c.pattern}/${c.flags ?? ""}`;
    case "tool_called":
      return `tool_called ${c.name}${c.minTimes ? ` x${c.minTimes}` : ""}`;
    case "tool_not_called":
      return `tool_not_called ${c.name}`;
    case "json_valid":
      return "json_valid";
    case "max_words":
    case "min_words":
      return `${c.type} ${c.value}`;
    case "judge":
      return `judge: ${c.rubric.length > 60 ? `${c.rubric.slice(0, 57)}...` : c.rubric}`;
  }
}

/** Markdown summary: one row per skill and provider, then failures and no-skill findings. */
export function renderEvalMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Skill evals (gate 5) — ${report.pass ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push(`Mode: ${report.mode}. Providers: ${report.providers.map((p) => `${p.name} (${p.model})`).join(", ") || "none"}.${report.judge ? ` Judge: ${report.judge.provider} (${report.judge.model}).` : ""}`);
  lines.push(`Pass rule: the skill wins or ties (within ${report.tieEpsilon}) the no-skill baseline on every case, with at least ${report.minCases} cases and no failed runs.`);
  lines.push("");
  lines.push("| Skill | Provider | Model | Cases | Wins | Ties | Losses | Errors | Skill score | Baseline | Verdict |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const v of report.verdicts) {
    const n = (r: CaseOutcome) => v.outcomes.filter((o) => o.result === r).length;
    lines.push(`| ${cell(v.skill)} | ${cell(v.provider)} | ${cell(v.model)} | ${v.cases} | ${n("win")} | ${n("tie")} | ${n("loss")} | ${v.errors} | ${pct(v.withSkillScore)} | ${pct(v.baselineScore)} | ${v.pass ? "PASS" : "FAIL"} |`);
  }
  if (report.verdicts.length === 0) lines.push("| — | — | — | 0 | 0 | 0 | 0 | 0 | — | — | FAIL |");
  const failed = report.verdicts.filter((v) => !v.pass || v.notes.length > 0);
  if (failed.length > 0) {
    lines.push("", "## Why", "");
    for (const v of failed) for (const r of [...v.reasons, ...v.notes]) lines.push(`- **${v.skill}** on ${v.provider}: ${r}`);
  }
  const errs = report.runs.filter((r) => r.error);
  if (errs.length > 0) {
    lines.push("", "## Failed runs", "");
    for (const r of errs.slice(0, 50)) lines.push(`- ${r.skill}/${r.caseId} (${r.provider}, ${r.withSkill ? "with skill" : "baseline"}): ${cell(r.error ?? "")}`);
    if (errs.length > 50) lines.push(`- ...and ${errs.length - 50} more`);
  }
  if (report.noSkill.length > 0) lines.push("", renderNoSkillMarkdown(report.noSkill, { heading: "## No-skill check" }));
  return `${lines.join("\n")}\n`;
}

/** The no-skill check as Markdown: cases and checks where the baseline did better, so maintainers can cut rules. */
export function renderNoSkillMarkdown(findings: readonly NoSkillFinding[], opts: { heading?: string } = {}): string {
  const lines: string[] = [opts.heading ?? "# No-skill check", ""];
  if (findings.length === 0) {
    lines.push("The baseline never beat a skill. No rules to cut.");
    return lines.join("\n");
  }
  lines.push("Cases where the model did better without the skill. Each listed check is a rule to review: it may be holding the model back.", "");
  lines.push("| Skill | Case | Provider | Outcome | Skill | Baseline | Checks where baseline did better |");
  lines.push("|---|---|---|---|---:|---:|---|");
  for (const f of findings)
    lines.push(
      `| ${cell(f.skill)} | ${cell(f.caseId)} | ${cell(f.provider)} | ${f.outcome} | ${pct(f.skillScore)} | ${pct(f.baselineScore)} | ${cell(f.checks.map((c) => `${describeCheck(c.check)} (${pct(c.skillScore)} vs ${pct(c.baselineScore)}${c.skillDetail ? `; skill: ${c.skillDetail}` : ""})`).join("; ") || "—")} |`,
    );
  return lines.join("\n");
}
