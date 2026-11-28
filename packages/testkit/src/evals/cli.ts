// oneseat-evals: gate 5 skill evals and the no-skill check.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findRepoRoot } from "../workspace.js";
import { createSkillStoreFromDir } from "../memory-store.js";
import { dryRunEvals, renderDryRun } from "./dryrun.js";
import { loadHarnessFactory, loadLiveProviders, parseProviderList, resolveProviderKeys, type ProviderModel } from "./live.js";
import { renderEvalMarkdown, renderNoSkillMarkdown } from "./report.js";
import { rescoreReport, runEvals, type EvalReport } from "./runner.js";

export const EXIT = { pass: 0, fail: 1, usage: 2, skipped: 3 } as const;

export const DEFAULT_EVAL_PROVIDERS = "anthropic:claude-sonnet-5-5";

export interface EvalCliOptions {
  root: string;
  skillsDir: string;
  providers: ProviderModel[];
  out?: string;
  live: boolean;
  dryRun: boolean;
  judge?: ProviderModel;
  concurrency: number;
  skills: string[];
  recorded?: string;
  from?: string;
  noSkillCheck: boolean;
  minCases: number;
  harnessModule?: string;
  timeoutMs: number;
  json: boolean;
}

export const EVAL_USAGE = `Usage: oneseat-evals [options]

Runs each skill's eval cases with the skill and without it (no-skill baseline),
on every provider, and applies the gate 5 rule: the skill wins or ties on every case.

Modes (default: --dry-run):
  --dry-run                 Validate suites and seed every case; call no model.
  --live                    Call real models. Keys come from ANTHROPIC_API_KEY,
                            OPENAI_API_KEY, GEMINI_API_KEY; a provider without a key is skipped.
  --recorded <report.json>  Re-score a recorded report against the current cases.
  --from <report.json>      Print an existing report (with --no-skill-check: only that section).

Options:
  --skills-dir <dir>        Skill folders (default: <repo>/skills)
  --providers <list>        provider:model,... (default: ${DEFAULT_EVAL_PROVIDERS})
  --judge <provider:model>  Model for "judge" checks (default: the first live provider)
  --skill <name[,name]>     Only these skills
  --out <dir>               Write eval-report.json, eval-report.md, no-skill.md here
  --concurrency <n>         Parallel runs (default 4)
  --min-cases <n>           Cases a skill needs (default 10)
  --timeout <seconds>       Per run (default 300)
  --harness-module <path>   Module exporting createEvalHarness(ctx, store)
  --no-skill-check          Print the no-skill check: cases where the baseline beat the skill
  --json                    Print the JSON report instead of Markdown
  -h, --help
Exit codes: 0 pass, 1 fail, 2 usage error, 3 skipped (no keys).`;

export class UsageError extends Error {
  override name = "UsageError";
}

function int(v: string | undefined, name: string, def: number, min = 1): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
  return n;
}

/** Parse argv (without node and script). Returns "help" for -h/--help. */
export function parseEvalArgs(argv: readonly string[], cwd = process.cwd()): EvalCliOptions | "help" {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        "skills-dir": { type: "string" },
        providers: { type: "string" },
        out: { type: "string" },
        live: { type: "boolean" },
        "dry-run": { type: "boolean" },
        judge: { type: "string" },
        concurrency: { type: "string" },
        skill: { type: "string", multiple: false },
        recorded: { type: "string" },
        from: { type: "string" },
        "no-skill-check": { type: "boolean" },
        "min-cases": { type: "string" },
        "harness-module": { type: "string" },
        timeout: { type: "string" },
        root: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values["help"]) return "help";
  const root = resolve(cwd, (values["root"] as string | undefined) ?? findRepoRoot(cwd));
  const live = !!values["live"];
  const dryRunFlag = !!values["dry-run"];
  const recorded = values["recorded"] as string | undefined;
  const from = values["from"] as string | undefined;
  const modes = [live, dryRunFlag, recorded !== undefined, from !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError("choose one of --live, --dry-run, --recorded, --from");
  let providers: ProviderModel[];
  let judge: ProviderModel | undefined;
  try {
    providers = parseProviderList((values["providers"] as string | undefined) ?? DEFAULT_EVAL_PROVIDERS);
    if (values["judge"] !== undefined) {
      const j = parseProviderList(values["judge"] as string);
      if (j.length !== 1) throw new Error("--judge takes exactly one provider:model");
      judge = j[0];
    }
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (providers.length === 0) throw new UsageError("--providers is empty");
  const opts: EvalCliOptions = {
    root,
    skillsDir: resolve(cwd, (values["skills-dir"] as string | undefined) ?? join(root, "skills")),
    providers,
    live,
    dryRun: dryRunFlag || modes === 0,
    concurrency: int(values["concurrency"] as string | undefined, "concurrency", 4),
    skills: ((values["skill"] as string | undefined) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    noSkillCheck: !!values["no-skill-check"],
    minCases: int(values["min-cases"] as string | undefined, "min-cases", 10, 0),
    timeoutMs: int(values["timeout"] as string | undefined, "timeout", 300) * 1000,
    json: !!values["json"],
  };
  if (values["out"] !== undefined) opts.out = resolve(cwd, values["out"] as string);
  if (judge) opts.judge = judge;
  if (recorded !== undefined) opts.recorded = resolve(cwd, recorded);
  if (from !== undefined) opts.from = resolve(cwd, from);
  if (values["harness-module"] !== undefined) opts.harnessModule = values["harness-module"] as string;
  return opts;
}

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Override dynamic import (tests). */
  importer?: (specifier: string) => Promise<unknown>;
}

async function writeOutputs(report: EvalReport, out: string | undefined): Promise<string[]> {
  if (!out) return [];
  await mkdir(out, { recursive: true });
  const files = [join(out, "eval-report.json"), join(out, "eval-report.md"), join(out, "no-skill.md")];
  await writeFile(files[0]!, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(files[1]!, renderEvalMarkdown(report));
  await writeFile(files[2]!, `${renderNoSkillMarkdown(report.noSkill)}\n`);
  return files;
}

function print(report: EvalReport, opts: EvalCliOptions, io: CliIO): void {
  if (opts.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else if (opts.noSkillCheck) io.stdout(`${renderNoSkillMarkdown(report.noSkill)}\n`);
  else io.stdout(renderEvalMarkdown(report));
}

async function readReport(path: string): Promise<EvalReport> {
  const raw = JSON.parse(await readFile(path, "utf8")) as EvalReport;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.runs)) throw new UsageError(`${path} is not an eval report (version 1)`);
  return raw;
}

/** Run the CLI. Returns the exit code. */
export async function evalMain(argv: readonly string[], io: CliIO): Promise<number> {
  let opts: EvalCliOptions | "help";
  try {
    opts = parseEvalArgs(argv, io.cwd);
  } catch (e) {
    io.stderr(`oneseat-evals: ${(e as Error).message}\n\n${EVAL_USAGE}\n`);
    return EXIT.usage;
  }
  if (opts === "help") {
    io.stdout(`${EVAL_USAGE}\n`);
    return EXIT.pass;
  }
  try {
    if (opts.from) {
      const report = await readReport(opts.from);
      print(report, opts, io);
      return report.pass ? EXIT.pass : EXIT.fail;
    }
    const dry = await dryRunEvals(opts.skillsDir, { minCases: opts.minCases, ...(opts.skills.length ? { only: opts.skills } : {}) });
    if (opts.dryRun) {
      io.stdout(`${renderDryRun(dry)}\n`);
      return dry.ok ? EXIT.pass : EXIT.fail;
    }
    if (!dry.ok) {
      io.stderr(`${renderDryRun(dry)}\nFix the eval suites before running them.\n`);
      return EXIT.fail;
    }
    if (opts.recorded) {
      const report = await rescoreReport(await readReport(opts.recorded), dry.suites, { minCases: opts.minCases });
      await writeOutputs(report, opts.out);
      print(report, opts, io);
      return report.pass ? EXIT.pass : EXIT.fail;
    }
    // --live
    const keys = resolveProviderKeys(opts.providers, io.env);
    for (const s of keys.skipped) io.stderr(`skipping ${s.provider}:${s.model}: ${s.env} is not set\n`);
    if (keys.available.length === 0) {
      io.stdout(`skipped: no keys (${keys.skipped.map((s) => s.env).join(", ")} unset). Suites validated: ${dry.suites.length}, cases: ${dry.cases}.\n`);
      return EXIT.skipped;
    }
    const providers = await loadLiveProviders(keys.available, opts.root, io.importer);
    let judge: { provider: (typeof providers)[number]["provider"]; model: string } | undefined;
    if (dry.judgeChecks > 0) {
      if (opts.judge) {
        const jk = resolveProviderKeys([opts.judge], io.env);
        if (jk.available.length === 0) {
          io.stderr(`judge ${opts.judge.provider}:${opts.judge.model} has no key (${jk.skipped[0]!.env}); judge checks will not be scored\n`);
        } else {
          const [jp] = await loadLiveProviders(jk.available, opts.root, io.importer);
          judge = { provider: jp!.provider, model: jp!.model };
        }
      } else {
        judge = { provider: providers[0]!.provider, model: providers[0]!.model };
        io.stderr(`using ${providers[0]!.name}:${providers[0]!.model} as the judge (pass --judge to choose)\n`);
      }
    }
    const store = await createSkillStoreFromDir(opts.skillsDir);
    const harness = await loadHarnessFactory({ root: opts.root, store, ...(opts.harnessModule ? { harnessModule: opts.harnessModule } : {}), ...(io.importer ? { importer: io.importer } : {}) });
    const report = await runEvals({
      harness,
      providers,
      suites: dry.suites,
      concurrency: opts.concurrency,
      minCases: opts.minCases,
      timeoutMs: opts.timeoutMs,
      ...(judge ? { judge } : {}),
      onRun: (r, done, total) => io.stderr(`[${done}/${total}] ${r.skill}/${r.caseId} ${r.provider} ${r.withSkill ? "skill" : "base"} ${(r.score * 100).toFixed(0)}%${r.error ? ` error: ${r.error}` : ""}\n`),
    });
    const files = await writeOutputs(report, opts.out);
    print(report, opts, io);
    if (files.length) io.stderr(`wrote ${files.join(", ")}\n`);
    return report.pass ? EXIT.pass : EXIT.fail;
  } catch (e) {
    io.stderr(`oneseat-evals: ${(e as Error).message}\n`);
    return e instanceof UsageError ? EXIT.usage : EXIT.fail;
  }
}

