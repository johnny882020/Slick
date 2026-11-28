// oneseat-gates: run release gates 1-7 and print a PASS / FAIL / SKIPPED / MANUAL table.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findRepoRoot } from "../workspace.js";
import { GATE_NAMES, gatesExitCode, runGates, type GateOptions, type GateResult } from "./gates.js";
import type { Exec } from "./exec.js";

export const GATES_USAGE = `Usage: oneseat-gates [options]

Runs the release gates and prints a summary. Exit 1 if any gate FAILs.
  1 unit tests + 90% line coverage on core packages   2 provider contract parity
  3 skill lint   4 security scan   5 skill evals vs no-skill baseline
  6 desktop end to end   7 pilot (manual)

Options:
  --only <ids>              Gates to run, e.g. 1,2,3 (default: all)
  --skip <ids>              Gates to leave out (reported as SKIPPED)
  --root <dir>              Repo root (default: found from cwd)
  --skills-dir <dir>        Default <root>/skills
  --threshold <pct>         Line coverage for core packages (default 90)
  --core <names>            Core package folders (default contracts,gateway,harness,registry)
  --coverage-from-existing  Gate 1 reads existing coverage summaries without running tests
  --live-evals              Gate 5 calls real models when keys are set (default: dry run)
  --eval-providers <list>   provider:model,... for gate 5
  --recorded-evals <file>   Re-score this recorded eval report when gate 5 cannot run live
  --eval-out <dir>          Where gate 5 writes its report
  --report <file>           Write the results as JSON
  -h, --help`;

export interface GatesCliOptions {
  ids: number[];
  skippedIds: number[];
  report?: string;
  gate: GateOptions;
}

function ids(text: string | undefined, flag: string): number[] | undefined {
  if (text === undefined) return undefined;
  const out = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  for (const n of out) if (!Number.isInteger(n) || !(n in GATE_NAMES)) throw new Error(`${flag}: unknown gate "${n}" (use 1-7)`);
  return [...new Set(out)].sort((a, b) => a - b);
}

export function parseGatesArgs(argv: readonly string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): GatesCliOptions | "help" {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      only: { type: "string" },
      skip: { type: "string" },
      root: { type: "string" },
      "skills-dir": { type: "string" },
      threshold: { type: "string" },
      core: { type: "string" },
      "coverage-from-existing": { type: "boolean" },
      "live-evals": { type: "boolean" },
      "eval-providers": { type: "string" },
      "recorded-evals": { type: "string" },
      "eval-out": { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const all = Object.keys(GATE_NAMES).map(Number);
  const only = ids(values.only, "--only") ?? all;
  const skip = ids(values.skip, "--skip") ?? [];
  const root = resolve(cwd, values.root ?? findRepoRoot(cwd));
  let threshold: number | undefined;
  if (values.threshold !== undefined) {
    threshold = Number(values.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("--threshold must be 0 to 100");
  }
  const gate: GateOptions = { root, env };
  if (values["skills-dir"]) gate.skillsDir = resolve(cwd, values["skills-dir"]);
  if (threshold !== undefined) gate.coverageThreshold = threshold;
  if (values.core) gate.corePackages = values.core.split(",").map((s) => s.trim()).filter(Boolean);
  if (values["coverage-from-existing"]) gate.coverageFromExisting = true;
  if (values["live-evals"]) gate.liveEvals = true;
  if (values["eval-providers"]) gate.evalProviders = values["eval-providers"];
  if (values["recorded-evals"]) gate.recordedEvals = resolve(cwd, values["recorded-evals"]);
  if (values["eval-out"]) gate.evalOut = resolve(cwd, values["eval-out"]);
  const out: GatesCliOptions = { ids: only.filter((i) => !skip.includes(i)), skippedIds: only.filter((i) => skip.includes(i)), gate };
  if (values.report) out.report = resolve(cwd, values.report);
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Plain-text summary table. */
export function renderGatesTable(results: readonly GateResult[]): string {
  const rows = results.map((r) => [String(r.id), r.name, r.status, r.reason]);
  const head = ["Gate", "Name", "Status", "Reason"];
  const w = [0, 1, 2].map((i) => Math.max(head[i]!.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => `${pad(r[0]!, w[0]!)}  ${pad(r[1]!, w[1]!)}  ${pad(r[2]!, w[2]!)}  ${r[3]}`;
  const counts = (["PASS", "FAIL", "SKIPPED", "MANUAL"] as const).map((s) => `${results.filter((r) => r.status === s).length} ${s}`).join(", ");
  return [line(head), line(w.map((n) => "-".repeat(n)).concat("------")), ...rows.map(line), "", `${counts}. ${gatesExitCode(results) === 0 ? "No gate failed." : "A gate FAILED."}`].join("\n");
}

/** Markdown summary (for $GITHUB_STEP_SUMMARY). */
export function renderGatesMarkdown(results: readonly GateResult[]): string {
  const icon: Record<string, string> = { PASS: "PASS", FAIL: "**FAIL**", SKIPPED: "SKIPPED", MANUAL: "MANUAL" };
  const lines = ["## OneSeat gates", "", "| Gate | Name | Status | Reason |", "|---:|---|---|---|"];
  for (const r of results) lines.push(`| ${r.id} | ${r.name} | ${icon[r.status]} | ${r.reason.replace(/\|/g, "\\|")} |`);
  const withDetails = results.filter((r) => r.details.length > 0);
  for (const r of withDetails) {
    lines.push("", `<details><summary>Gate ${r.id} details</summary>`, "", "```", ...r.details.slice(0, 80), "```", "</details>");
  }
  return `${lines.join("\n")}\n`;
}

export interface GatesIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  exec?: Exec;
}

export async function gatesMain(argv: readonly string[], io: GatesIO): Promise<number> {
  let opts: GatesCliOptions | "help";
  try {
    opts = parseGatesArgs(argv, io.cwd, io.env);
  } catch (e) {
    io.stderr(`oneseat-gates: ${(e as Error).message}\n\n${GATES_USAGE}\n`);
    return 2;
  }
  if (opts === "help") {
    io.stdout(`${GATES_USAGE}\n`);
    return 0;
  }
  const results = await runGates(opts.ids, { ...opts.gate, ...(io.exec ? { exec: io.exec } : {}), log: (l) => io.stderr(`${l}\n`) });
  for (const id of opts.skippedIds) results.push({ id, name: GATE_NAMES[id]!, status: "SKIPPED", reason: "skipped by --skip", details: [], durationMs: 0 });
  results.sort((a, b) => a.id - b.id);
  for (const r of results)
    if (r.details.length > 0 && r.status !== "PASS") io.stderr(`\ngate ${r.id} details:\n${r.details.map((d) => `  ${d}`).join("\n")}\n`);
  io.stdout(`\n${renderGatesTable(results)}\n`);
  if (opts.report) {
    await mkdir(dirname(opts.report), { recursive: true });
    await writeFile(opts.report, `${JSON.stringify({ results, exitCode: gatesExitCode(results) }, null, 2)}\n`);
  }
  const summary = io.env["GITHUB_STEP_SUMMARY"];
  if (summary) await appendFile(summary, renderGatesMarkdown(results)).catch(() => {});
  return gatesExitCode(results);
}
