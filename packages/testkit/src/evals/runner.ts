// Gate 5 eval runner: each case runs WITH its skill (TaskRequest.skill forced) and WITHOUT
// (disableSkills: true), on every provider, each in a fresh seeded data folder.

import type {
  ApprovalHandler,
  CaseRun,
  CheckResult,
  EvalCase,
  EvalSuite,
  HarnessApi,
  HarnessEvent,
  ModelProvider,
  SkillEvalVerdict,
  TaskRequest,
} from "@oneseat/contracts";
import { createModelJudge } from "./judge.js";
import { compareScores, gate5Decision, scoreCase, scoreCheck, TIE_EPSILON, weightedScore, type JudgeFn } from "./score.js";
import { prepareRunDirs } from "./seed.js";
import { noSkillCheck, type NoSkillFinding } from "./report.js";

export interface EvalProviderSpec {
  provider: ModelProvider;
  model: string;
  /** Label in reports. Default provider.id. */
  name?: string;
}

export interface EvalHarnessContext {
  /** Fresh data folder; the seeded business database is at dbPath inside it. */
  dataDir: string;
  dbPath: string;
  /** Folder holding EvalCase.workspace files. */
  workspaceDir: string;
  provider: ModelProvider;
  providerName: string;
  model: string;
  skill: string;
  caseId: string;
  withSkill: boolean;
}

export type EvalHarnessFactory = (ctx: EvalHarnessContext) => HarnessApi | Promise<HarnessApi>;

export interface RunEvalsOptions {
  harness: EvalHarnessFactory;
  providers: readonly EvalProviderSpec[];
  suites: readonly EvalSuite[];
  /** Judge for "judge" checks: a model, or a JudgeFn. */
  judge?: { provider: ModelProvider; model: string } | JudgeFn;
  /** Parallel runs. Default 4. */
  concurrency?: number;
  /** Cases a skill needs for gate 5. Default 10. */
  minCases?: number;
  /** Default 0.01. */
  tieEpsilon?: number;
  /** Per-run timeout in ms. Default 300 000. */
  timeoutMs?: number;
  /** Default 12. */
  maxTurns?: number;
  /** Approval handler. Default: deny every send/pay/delete (evals never act on the world). */
  approvals?: ApprovalHandler;
  /** Where run folders go. Default os.tmpdir(). */
  tmpRoot?: string;
  /** Keep run folders for debugging. */
  keepRunDirs?: boolean;
  onRun?: (run: EvalCaseRun, done: number, total: number) => void;
}

/** CaseRun plus the fields the report needs (contracts' CaseRun has no skill field). */
export interface EvalCaseRun extends CaseRun {
  skill: string;
  durationMs: number;
  /** With-skill runs: did the harness emit skill_loaded for this skill? */
  skillLoaded: boolean;
  weight: number;
}

export interface SkillVerdictReport extends SkillEvalVerdict {
  cases: number;
  errors: number;
  /** Why the verdict failed, empty when it passed. */
  reasons: string[];
  /** Non-blocking notes (for example a skill that never loaded). */
  notes: string[];
}

export interface EvalReport {
  version: 1;
  mode: "live" | "recorded";
  startedAt: string;
  finishedAt: string;
  providers: { name: string; provider: string; model: string }[];
  judge?: { provider: string; model: string };
  minCases: number;
  tieEpsilon: number;
  runs: EvalCaseRun[];
  verdicts: SkillVerdictReport[];
  /** Every verdict passed (and there was at least one). */
  pass: boolean;
  /** Cases and checks where the no-skill baseline beat the skill. */
  noSkill: NoSkillFinding[];
}

export const DENY_ALL_APPROVALS: ApprovalHandler = async () => ({ approved: false, note: "Eval run: outward actions are never performed. Describe what you would do instead." });

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

interface Collected {
  text: string;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
  skillLoaded: boolean;
}

/** Drive one harness run to its terminal event (or timeout). Never throws. */
export async function collectHarnessRun(harness: HarnessApi, task: TaskRequest, approvals: ApprovalHandler, timeoutMs: number): Promise<Collected> {
  const out: Collected = { text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, skillLoaded: false };
  let deltas = "";
  let turnUsage = { inputTokens: 0, outputTokens: 0 };
  let terminal = false;
  let iterator: AsyncIterator<HarnessEvent> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  try {
    iterator = harness.run(task, approvals)[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), timeout]);
      if (step === "timeout") {
        out.error = `timed out after ${timeoutMs} ms`;
        void iterator.return?.();
        break;
      }
      if (step.done) break;
      const ev = step.value;
      switch (ev.type) {
        case "text_delta":
          deltas += ev.text;
          break;
        case "tool_start":
          out.toolCalls.push(ev.call.name);
          break;
        case "skill_loaded":
          if (ev.name === task.skill) out.skillLoaded = true;
          break;
        case "turn_end":
          turnUsage = { inputTokens: turnUsage.inputTokens + ev.usage.inputTokens, outputTokens: turnUsage.outputTokens + ev.usage.outputTokens };
          break;
        case "done":
          terminal = true;
          out.text = ev.text || deltas;
          out.usage = { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens };
          if (ev.stopReason === "error" || ev.stopReason === "cancelled") out.error = `run ended with ${ev.stopReason}`;
          break;
        case "error":
          terminal = true;
          out.error = ev.message;
          break;
        default:
          break;
      }
      if (terminal) break;
    }
    if (!terminal && !out.error) out.error = "run ended without done or error";
  } catch (e) {
    out.error = `harness threw: ${(e as Error)?.message ?? String(e)}`;
  } finally {
    clearTimeout(timer);
  }
  if (!out.text) out.text = deltas;
  if (out.usage.inputTokens + out.usage.outputTokens === 0) out.usage = turnUsage;
  return out;
}

function toJudgeFn(j: RunEvalsOptions["judge"]): JudgeFn | undefined {
  if (!j) return undefined;
  return typeof j === "function" ? j : createModelJudge({ provider: j.provider, model: j.model });
}

/** Run every case with and without its skill on every provider, then score and decide gate 5. */
export async function runEvals(opts: RunEvalsOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const judge = toJudgeFn(opts.judge);
  const approvals = opts.approvals ?? DENY_ALL_APPROVALS;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  type Job = { suite: EvalSuite; c: EvalCase; spec: EvalProviderSpec; withSkill: boolean };
  const jobs: Job[] = [];
  for (const suite of opts.suites)
    for (const c of suite.cases)
      for (const spec of opts.providers)
        for (const withSkill of [true, false]) jobs.push({ suite, c, spec, withSkill });
  const runs: (EvalCaseRun | undefined)[] = new Array(jobs.length);
  const index = new Map(jobs.map((j, i) => [j, i]));
  let done = 0;
  await pool(jobs, opts.concurrency ?? 4, async (job) => {
    const name = job.spec.name ?? job.spec.provider.id;
    const started = Date.now();
    let collected: Collected;
    let dirs: Awaited<ReturnType<typeof prepareRunDirs>> | undefined;
    try {
      dirs = await prepareRunDirs(job.c, { label: `${job.suite.skill}-${job.c.id}-${job.withSkill ? "skill" : "base"}`, ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}), ...(opts.keepRunDirs ? { keep: true } : {}) });
      const harness = await opts.harness({
        dataDir: dirs.dataDir,
        dbPath: dirs.dbPath,
        workspaceDir: dirs.workspaceDir,
        provider: job.spec.provider,
        providerName: name,
        model: job.spec.model,
        skill: job.suite.skill,
        caseId: job.c.id,
        withSkill: job.withSkill,
      });
      const task: TaskRequest = {
        input: job.c.input,
        provider: job.spec.provider.id,
        model: job.spec.model,
        origin: { kind: "eval" },
        maxTurns: opts.maxTurns ?? 12,
        ...(job.withSkill ? { skill: job.suite.skill } : { disableSkills: true }),
      };
      collected = await collectHarnessRun(harness, task, approvals, timeoutMs);
    } catch (e) {
      collected = { text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, skillLoaded: false, error: `setup failed: ${(e as Error).message}` };
    } finally {
      await dirs?.cleanup();
    }
    const scored = await scoreCase(job.c, { text: collected.text, toolCalls: collected.toolCalls, input: job.c.input }, { ...(judge ? { judge } : {}), ...(collected.error !== undefined ? { error: collected.error } : {}) });
    const run: EvalCaseRun = {
      skill: job.suite.skill,
      caseId: job.c.id,
      provider: name,
      model: job.spec.model,
      withSkill: job.withSkill,
      score: scored.score,
      checks: scored.checks,
      outputText: collected.text,
      toolCalls: collected.toolCalls,
      usage: collected.usage,
      durationMs: Date.now() - started,
      skillLoaded: collected.skillLoaded,
      weight: job.c.weight ?? 1,
      ...(collected.error !== undefined ? { error: collected.error } : {}),
    };
    runs[index.get(job)!] = run;
    done++;
    opts.onRun?.(run, done, jobs.length);
  });
  const providers = opts.providers.map((p) => ({ name: p.name ?? p.provider.id, provider: p.provider.id, model: p.model }));
  const judgeInfo = opts.judge && typeof opts.judge !== "function" ? { provider: opts.judge.provider.id, model: opts.judge.model } : undefined;
  return buildReport({
    mode: "live",
    startedAt,
    runs: runs.filter((r): r is EvalCaseRun => !!r),
    suites: opts.suites,
    providers,
    minCases: opts.minCases ?? 10,
    tieEpsilon: opts.tieEpsilon ?? TIE_EPSILON,
    ...(judgeInfo ? { judge: judgeInfo } : {}),
  });
}

export interface BuildReportInput {
  mode: EvalReport["mode"];
  startedAt: string;
  runs: EvalCaseRun[];
  suites: readonly EvalSuite[];
  providers: EvalReport["providers"];
  minCases: number;
  tieEpsilon: number;
  judge?: EvalReport["judge"];
}

/** Pair with-skill and baseline runs, decide each verdict, and list no-skill findings. */
export function buildReport(input: BuildReportInput): EvalReport {
  const verdicts: SkillVerdictReport[] = [];
  for (const suite of input.suites) {
    for (const p of input.providers) {
      const outcomes: SkillEvalVerdict["outcomes"] = [];
      const skillScores: { score: number; weight: number }[] = [];
      const baseScores: { score: number; weight: number }[] = [];
      const reasons: string[] = [];
      const notes: string[] = [];
      let errors = 0;
      let unscoredJudge = 0;
      let notLoaded = 0;
      for (const c of suite.cases) {
        const find = (withSkill: boolean) => input.runs.find((r) => r.skill === suite.skill && r.caseId === c.id && r.provider === p.name && r.model === p.model && r.withSkill === withSkill);
        const s = find(true);
        const b = find(false);
        if (!s || !b) {
          reasons.push(`case ${c.id} is missing a ${!s ? "with-skill" : "baseline"} run`);
          continue;
        }
        if (s.error) errors++;
        if (b.error) errors++;
        if (!s.error && !s.skillLoaded) notLoaded++;
        for (const r of [s, b]) unscoredJudge += r.checks.filter((ch) => ch.check.type === "judge" && ch.detail?.startsWith("not scored")).length;
        outcomes.push({ caseId: c.id, result: compareScores(s.score, b.score, input.tieEpsilon) });
        skillScores.push({ score: s.score, weight: c.weight ?? 1 });
        baseScores.push({ score: b.score, weight: c.weight ?? 1 });
      }
      const decision = gate5Decision(outcomes, { minCases: input.minCases, errors });
      reasons.push(...decision.reasons);
      if (unscoredJudge > 0) reasons.push(`${unscoredJudge} judge check result(s) were not scored (no judge model)`);
      if (notLoaded > 0) notes.push(`the harness did not report skill_loaded for ${notLoaded} with-skill run(s)`);
      verdicts.push({
        skill: suite.skill,
        provider: p.name,
        model: p.model,
        withSkillScore: weightedScore(skillScores),
        baselineScore: weightedScore(baseScores),
        outcomes,
        pass: reasons.length === 0,
        cases: suite.cases.length,
        errors,
        reasons,
        notes,
      });
    }
  }
  const report: EvalReport = {
    version: 1,
    mode: input.mode,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    providers: input.providers,
    ...(input.judge ? { judge: input.judge } : {}),
    minCases: input.minCases,
    tieEpsilon: input.tieEpsilon,
    runs: input.runs,
    verdicts,
    pass: verdicts.length > 0 && verdicts.every((v) => v.pass),
    noSkill: [],
  };
  report.noSkill = noSkillCheck(report);
  return report;
}

/**
 * Re-score a recorded report against the current suites without calling a model.
 * Deterministic checks are re-run on the recorded output; judge results are reused
 * when the same rubric was judged before, otherwise left unscored.
 */
export async function rescoreReport(recorded: EvalReport, suites: readonly EvalSuite[], opts: { minCases?: number; tieEpsilon?: number; judge?: JudgeFn } = {}): Promise<EvalReport> {
  const runs: EvalCaseRun[] = [];
  const known = new Set(suites.map((s) => s.skill));
  for (const r of recorded.runs) {
    if (!known.has(r.skill)) continue;
    const c = suites.find((s) => s.skill === r.skill)!.cases.find((x) => x.id === r.caseId);
    if (!c) continue;
    let checks: CheckResult[];
    if (r.error !== undefined) checks = (await scoreCase(c, { text: "", toolCalls: [] }, { error: r.error })).checks;
    else {
      checks = [];
      for (const check of c.checks) {
        if (check.type === "judge" && !opts.judge) {
          const prev = r.checks.find((x) => JSON.stringify(x.check) === JSON.stringify(check) && !x.detail?.startsWith("not scored"));
          checks.push(prev ?? { check, pass: false, score: 0, detail: "not scored: no judge model configured" });
        } else checks.push(await scoreCheck(check, { text: r.outputText, toolCalls: r.toolCalls, input: c.input }, opts.judge));
      }
    }
    const score = checks.length ? checks.reduce((s, x) => s + x.score, 0) / checks.length : 0;
    runs.push({ ...r, checks, score, weight: c.weight ?? 1 });
  }
  return buildReport({
    mode: "recorded",
    startedAt: new Date().toISOString(),
    runs,
    suites,
    providers: recorded.providers,
    minCases: opts.minCases ?? recorded.minCases ?? 10,
    tieEpsilon: opts.tieEpsilon ?? recorded.tieEpsilon ?? TIE_EPSILON,
    ...(recorded.judge ? { judge: recorded.judge } : {}),
  });
}
