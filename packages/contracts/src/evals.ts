// Eval case format. Skill packs (stream E) write cases; the eval runner (stream F) runs them.
// File: skills/<name>/evals/cases.json  ->  EvalSuite

export type EvalCheck =
  | { type: "contains"; value: string; caseSensitive?: boolean }
  | { type: "not_contains"; value: string; caseSensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "tool_called"; name: string; minTimes?: number }
  | { type: "tool_not_called"; name: string }
  | { type: "json_valid" }
  | { type: "max_words"; value: number }
  | { type: "min_words"; value: number }
  /** Scored by a judge model, 0..1. Pass when score >= threshold (default 0.7). */
  | { type: "judge"; rubric: string; threshold?: number };

export interface EvalCase {
  id: string;
  /** What the user types. */
  input: string;
  /** Optional files placed in the workspace before the run, path -> content. */
  workspace?: Record<string, string>;
  /** Seed rows for the local database, table -> rows. */
  db?: Record<string, Record<string, unknown>[]>;
  checks: EvalCheck[];
  /** Weight in the skill score. Default 1. */
  weight?: number;
}

export interface EvalSuite {
  skill: string;
  cases: EvalCase[];
}

export interface CheckResult {
  check: EvalCheck;
  pass: boolean;
  score: number;
  detail?: string;
}

export interface CaseRun {
  caseId: string;
  provider: string;
  model: string;
  withSkill: boolean;
  score: number;
  checks: CheckResult[];
  outputText: string;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

/** Gate 5 verdict for one skill on one provider. */
export interface SkillEvalVerdict {
  skill: string;
  provider: string;
  model: string;
  withSkillScore: number;
  baselineScore: number;
  /** Per case: did the skill win, tie or lose against the baseline? */
  outcomes: { caseId: string; result: "win" | "tie" | "loss" }[];
  /** Gate 5 pass rule: skill wins or ties on every case (default 10 cases). */
  pass: boolean;
}
