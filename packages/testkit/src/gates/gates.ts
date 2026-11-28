// The release gates (CLAUDE.md "Gates"). Each gate reports PASS, FAIL, SKIPPED or MANUAL with a reason.
// Nothing passes by default: a missing package, tool or report is a FAIL that says what is missing.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { findSkillDirs } from "../skills.js";
import { findWorkspacePackage, listWorkspacePackages, type WorkspacePackage } from "../workspace.js";
import { evalMain, EXIT } from "../evals/cli.js";
import { dryRunEvals } from "../evals/dryrun.js";
import { parseProviderList, resolveProviderKeys } from "../evals/live.js";
import { renderEvalMarkdown } from "../evals/report.js";
import { rescoreReport, type EvalReport } from "../evals/runner.js";
import { checkCoverage, readCoverageSummary, type CoverageVerdict } from "./coverage.js";
import { defaultExec, type Exec } from "./exec.js";

export type GateStatus = "PASS" | "FAIL" | "SKIPPED" | "MANUAL";

export interface GateResult {
  id: number;
  name: string;
  status: GateStatus;
  reason: string;
  details: string[];
  durationMs: number;
}

export interface GateOptions {
  root: string;
  /** Default <root>/skills. */
  skillsDir?: string;
  /** Default 90. */
  coverageThreshold?: number;
  /** Folder names under packages/ held to the threshold. Default contracts, gateway, harness, registry. */
  corePackages?: readonly string[];
  /** Only parse existing coverage summaries; do not run tests. */
  coverageFromExisting?: boolean;
  /** Run gate 5 against real models when keys are present. Default false (dry run). */
  liveEvals?: boolean;
  /** provider:model list for gate 5. */
  evalProviders?: string;
  /** A recorded eval report to re-score when gate 5 cannot run live. */
  recordedEvals?: string;
  /** Where gate 5 writes its report. */
  evalOut?: string;
  env?: Record<string, string | undefined>;
  exec?: Exec;
  log?: (line: string) => void;
}

export const GATE_NAMES: Record<number, string> = {
  1: "Unit tests + coverage",
  2: "Provider contract parity",
  3: "Skill lint",
  4: "Security scan",
  5: "Skill evals vs no-skill",
  6: "Desktop end to end",
  7: "Pilot",
};

export const DEFAULT_CORE_PACKAGES = ["contracts", "gateway", "harness", "registry"] as const;
export const PILOT_TEMPLATE = "packages/testkit/templates/pilot.md";

type GateFn = (o: Required<Pick<GateOptions, "root" | "skillsDir" | "coverageThreshold" | "corePackages" | "env" | "exec" | "log">> & GateOptions) => Promise<Omit<GateResult, "id" | "name" | "durationMs">>;

const pass = (reason: string, details: string[] = []) => ({ status: "PASS" as const, reason, details });
const fail = (reason: string, details: string[] = []) => ({ status: "FAIL" as const, reason, details });
const skipped = (reason: string, details: string[] = []) => ({ status: "SKIPPED" as const, reason, details });

function tail(s: string, lines = 15): string[] {
  return s.trimEnd().split("\n").slice(-lines);
}

// ---- gate 1 ----

/**
 * Vitest flags that select the v8 coverage provider for a package. If the package cannot
 * resolve @vitest/coverage-v8 itself, point vitest at testkit's copy as a custom provider,
 * so core packages need no extra devDependency.
 */
export function coverageProviderArgs(pkgDir: string, fallback: () => string | undefined = testkitCoverageProvider): string[] {
  if (hasNodeModule(pkgDir, "@vitest/coverage-v8")) return ["--coverage.provider=v8"];
  const own = fallback();
  return own ? ["--coverage.provider=custom", `--coverage.customProviderModule=${own.split("\\").join("/")}`] : ["--coverage.provider=v8"];
}

/** Whether node_modules/<name> exists in dir or a parent (vite's lookup; NODE_PATH is ignored, as vite ignores it). */
export function hasNodeModule(dir: string, name: string): boolean {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", ...name.split("/"), "package.json"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

function testkitCoverageProvider(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("@vitest/coverage-v8");
  } catch {
    return undefined;
  }
}

const gate1: GateFn = async (o) => {
  const all = listWorkspacePackages(o.root);
  const core = o.corePackages.map((dir) => ({ dir, pkg: all.find((p) => relative(o.root, p.dir).split(/[\\/]/).join("/") === `packages/${dir}`) }));
  const details: string[] = [];
  const problems: string[] = [];
  for (const c of core) if (!c.pkg) problems.push(`core package packages/${c.dir} is missing`);
  const present = core.filter((c): c is { dir: string; pkg: WorkspacePackage } => !!c.pkg);
  const errors = new Map<string, string>();
  if (!o.coverageFromExisting) {
    const coreNames = new Set(present.map((c) => c.pkg.name));
    const others = all.filter((p) => !coreNames.has(p.name) && p.manifest.scripts?.["test"]);
    if (others.length > 0) {
      o.log(`gate 1: turbo test for ${others.map((p) => p.name).join(", ")}`);
      const r = await o.exec("pnpm", ["exec", "turbo", "run", "test", "--continue", ...others.map((p) => `--filter=${p.name}`)], { cwd: o.root });
      if (r.code !== 0) problems.push(`tests failed in ${others.map((p) => p.name).join(", ")} (turbo exit ${r.code})`);
    }
    for (const c of present) {
      o.log(`gate 1: tests with coverage for ${c.pkg.name}`);
      const r = await o.exec(
        "pnpm",
        [
          "--filter",
          c.pkg.name,
          "exec",
          "vitest",
          "run",
          "--coverage.enabled=true",
          ...coverageProviderArgs(c.pkg.dir),
          "--coverage.reporter=json-summary",
          "--coverage.reporter=text-summary",
          "--coverage.reportsDirectory=coverage",
          "--coverage.include=src/**",
        ],
        { cwd: o.root },
      );
      if (r.code !== 0) {
        const missingProvider = /Failed to load url @vitest\/coverage-v8|Cannot find (dependency|package|module) ['"]?@vitest\/coverage-v8/i.test(r.stdout + r.stderr);
        const msg = missingProvider ? `@vitest/coverage-v8 is not installed for ${c.pkg.name}; add it as a devDependency` : `tests failed (exit ${r.code})`;
        errors.set(c.pkg.name, msg);
        problems.push(`${c.pkg.name}: ${msg}`);
      }
    }
  }
  const verdicts: CoverageVerdict[] = [];
  for (const c of present) {
    const file = join(c.pkg.dir, "coverage", "coverage-summary.json");
    try {
      verdicts.push(checkCoverage(c.pkg.name, await readCoverageSummary(file), o.coverageThreshold));
    } catch (e) {
      verdicts.push(checkCoverage(c.pkg.name, undefined, o.coverageThreshold, errors.get(c.pkg.name) ?? (e as Error).message.split("\n")[0]));
    }
  }
  for (const v of verdicts) {
    details.push(v.message);
    if (!v.ok && !errors.has(v.pkg)) problems.push(v.message);
  }
  for (const p of all.filter((x) => !present.some((c) => c.pkg.name === x.name))) {
    const file = join(p.dir, "coverage", "coverage-summary.json");
    if (!existsSync(file)) continue;
    try {
      const v = checkCoverage(p.name, await readCoverageSummary(file), 0);
      details.push(`${v.message} (not a core package; informational)`);
    } catch {
      /* ignore */
    }
  }
  if (problems.length > 0) return fail(problems.join("; "), details);
  return pass(`core packages at or above ${o.coverageThreshold}% lines: ${verdicts.map((v) => `${v.pkg.replace("@oneseat/", "")} ${v.pct?.toFixed(1)}%`).join(", ")}`, details);
};

// ---- gate 2 ----

export interface ConformanceSummary {
  providerSuites: string[];
  parityProviders: string[];
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

/** Read a vitest JSON report and pick out the conformance suites. */
export function summariseConformanceJson(raw: unknown): ConformanceSummary {
  const out: ConformanceSummary = { providerSuites: [], parityProviders: [], passed: 0, failed: 0, skipped: 0, failures: [] };
  const files = (raw as { testResults?: { assertionResults?: { ancestorTitles?: string[]; fullName?: string; title?: string; status?: string }[] }[] })?.testResults ?? [];
  const suites = new Set<string>();
  const parity = new Set<string>();
  for (const f of files)
    for (const a of f.assertionResults ?? []) {
      const top = a.ancestorTitles?.[0] ?? a.fullName ?? "";
      if (!top.startsWith("conformance:")) continue;
      const ms = top.match(/^conformance: ModelProvider (.+)$/);
      if (ms) suites.add(ms[1]!);
      const mp = top.match(/^conformance: cross-provider tool-call parity \(([^)]*)\)/);
      if (mp) for (const n of mp[1]!.split(",").map((s) => s.trim()).filter(Boolean)) parity.add(n);
      if (a.status === "passed") out.passed++;
      else if (a.status === "failed") {
        out.failed++;
        out.failures.push(a.fullName ?? `${top} ${a.title ?? ""}`);
      } else out.skipped++;
    }
  out.providerSuites = [...suites].sort();
  out.parityProviders = [...parity].sort();
  return out;
}

const gate2: GateFn = async (o) => {
  const gw = findWorkspacePackage(o.root, "@oneseat/gateway");
  if (!gw) return fail("packages/gateway (@oneseat/gateway) is missing");
  const dir = await mkdtemp(join(tmpdir(), "oneseat-gate2-"));
  const out = join(dir, "conformance.json");
  try {
    const r = await o.exec("pnpm", ["--filter", "@oneseat/gateway", "exec", "vitest", "run", "-t", "conformance:", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`], { cwd: o.root });
    let summary: ConformanceSummary;
    try {
      summary = summariseConformanceJson(JSON.parse(await readFile(out, "utf8")) as unknown);
    } catch {
      return fail(`no vitest JSON report from the gateway conformance run (exit ${r.code})`, tail(r.stdout + r.stderr));
    }
    const details = [
      `ModelProvider conformance suites: ${summary.providerSuites.join(", ") || "none"}`,
      `parity providers: ${summary.parityProviders.join(", ") || "none"}`,
      `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
      ...summary.failures.slice(0, 20).map((f) => `failed: ${f}`),
    ];
    if (summary.failed > 0 || r.code !== 0) return fail(`${summary.failed} conformance test(s) failed (exit ${r.code})`, details);
    if (summary.passed === 0) return fail("no conformance tests ran; call describeModelProviderConformance and describeCrossProviderToolCallParity in packages/gateway tests", details);
    if (summary.parityProviders.length < 3) return fail(`tool-call parity covers ${summary.parityProviders.length} provider(s); gate 2 needs all 3`, details);
    if (summary.providerSuites.length < 3) return fail(`ModelProvider conformance covers ${summary.providerSuites.length} adapter(s); gate 2 needs at least 3`, details);
    return pass(`same tool-call result on ${summary.parityProviders.join(", ")}; ${summary.passed} conformance tests passed`, details);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

// ---- gates 3 and 4 ----

/** Find the registry CLI: ONESEAT_SKILLS_CLI, else @oneseat/registry's "oneseat-skills" bin. */
export function resolveSkillsCli(root: string, env: Record<string, string | undefined>): { path?: string; error?: string } {
  const override = env["ONESEAT_SKILLS_CLI"];
  if (override) return existsSync(override) ? { path: override } : { error: `ONESEAT_SKILLS_CLI points to a missing file: ${override}` };
  const reg = findWorkspacePackage(root, "@oneseat/registry");
  if (!reg) return { error: "packages/registry (@oneseat/registry) is missing" };
  const bin = reg.manifest.bin;
  const rel = typeof bin === "string" ? bin : bin?.["oneseat-skills"];
  if (!rel) return { error: '@oneseat/registry has no "oneseat-skills" bin in package.json' };
  const path = join(reg.dir, rel);
  return existsSync(path) ? { path } : { error: `the registry CLI is not built (${relative(root, path)} is missing); run pnpm build` };
}

/** Pull scan verdicts out of `oneseat-skills scan --json` output. */
export function parseScanOutput(stdout: string): { verdicts: string[]; findings: string[] } | undefined {
  const candidates = [stdout.trim(), ...stdout.trim().split("\n").reverse()];
  for (const c of candidates) {
    if (!c.startsWith("{") && !c.startsWith("[")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(c);
    } catch {
      continue;
    }
    // Accept a bare report, a list, or an envelope ({ reports } or the registry CLI's { ok, results }).
    const env = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { reports?: unknown; results?: unknown }) : undefined;
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray(env?.reports)
        ? env.reports
        : Array.isArray(env?.results)
          ? env.results
          : [raw];
    const verdicts: string[] = [];
    const findings: string[] = [];
    for (const item of list) {
      const scan = (item as { scan?: unknown })?.scan ?? item;
      const v = (scan as { verdict?: unknown })?.verdict;
      if (typeof v !== "string") continue;
      verdicts.push(v);
      for (const f of ((scan as { findings?: { severity?: string; rule?: string; file?: string; line?: number; message?: string }[] }).findings ?? []))
        if (f.severity === "block") findings.push(`${f.rule ?? "rule"} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.message ?? ""}`.trim());
    }
    if (verdicts.length > 0) return { verdicts, findings };
  }
  return undefined;
}

async function skillGate(o: Parameters<GateFn>[0], kind: "lint" | "scan") {
  const cli = resolveSkillsCli(o.root, o.env);
  if (!cli.path) return fail(cli.error!);
  const dirs = await findSkillDirs(o.skillsDir);
  if (dirs.length === 0) return fail(`no skill folders under ${relative(o.root, o.skillsDir) || o.skillsDir}`);
  const details: string[] = [];
  const bad: string[] = [];
  const warned: string[] = [];
  for (const d of dirs) {
    const name = relative(o.skillsDir, d) || d;
    const args = kind === "lint" ? [cli.path, "lint", d] : [cli.path, "scan", d, "--json"];
    const r = await o.exec(process.execPath, args, { cwd: o.root, echo: kind === "lint" });
    if (kind === "lint") {
      if (r.code === 0) details.push(`${name}: ok`);
      else {
        bad.push(name);
        details.push(`${name}: lint failed (exit ${r.code})`, ...tail(r.stdout + r.stderr, 8).map((l) => `  ${l}`));
      }
      continue;
    }
    const parsed = parseScanOutput(r.stdout);
    if (parsed?.verdicts.includes("block")) {
      bad.push(name);
      details.push(`${name}: BLOCK`, ...parsed.findings.map((f) => `  ${f}`));
    } else if (!parsed && r.code !== 0) {
      bad.push(name);
      details.push(`${name}: scan failed (exit ${r.code}) with no JSON report`, ...tail(r.stderr || r.stdout, 6).map((l) => `  ${l}`));
    } else if (!parsed) {
      bad.push(name);
      details.push(`${name}: scan printed no JSON report; run "oneseat-skills scan <dir> --json"`);
    } else {
      if (parsed.verdicts.includes("warn")) warned.push(name);
      details.push(`${name}: ${parsed.verdicts.join(", ")}`);
    }
  }
  if (bad.length > 0) return fail(`${kind === "lint" ? "lint failed" : "scan blocked"}: ${bad.join(", ")}`, details);
  return pass(`${dirs.length} skill(s) ${kind === "lint" ? "lint clean" : "scanned, none blocked"}${warned.length ? ` (warnings: ${warned.join(", ")})` : ""}`, details);
}

const gate3: GateFn = (o) => skillGate(o, "lint");
const gate4: GateFn = (o) => skillGate(o, "scan");

// ---- gate 5 ----

const gate5: GateFn = async (o) => {
  const dry = await dryRunEvals(o.skillsDir);
  const details = dry.issues.map((i) => `${i.severity}: ${i.skill ? `${i.skill}: ` : ""}${i.path}: ${i.message}`);
  if (!dry.ok) return fail(`eval suites are invalid (${dry.issues.filter((i) => i.severity === "error").length} error(s))`, details);
  details.unshift(`dry run OK: ${dry.suites.length} suite(s), ${dry.cases} case(s)`);
  const providersText = o.evalProviders ?? "anthropic:claude-sonnet-5-5";
  let keys;
  try {
    keys = resolveProviderKeys(parseProviderList(providersText), o.env);
  } catch (e) {
    return fail(`bad eval providers: ${(e as Error).message}`, details);
  }
  let recordedNote = "";
  if (o.recordedEvals) {
    try {
      const rec = JSON.parse(await readFile(o.recordedEvals, "utf8")) as EvalReport;
      const re = await rescoreReport(rec, dry.suites);
      const passing = re.verdicts.filter((v) => v.pass).length;
      recordedNote = `; recorded report re-scored: ${passing}/${re.verdicts.length} verdict(s) pass`;
      details.push(...renderEvalMarkdown(re).split("\n").filter((l) => l.startsWith("|")));
    } catch (e) {
      recordedNote = `; recorded report unreadable: ${(e as Error).message}`;
    }
  }
  if (!o.liveEvals) return skipped(`skipped: live evals not requested (run with --live-evals and keys); suites validated${recordedNote}`, details);
  if (keys.available.length === 0) return skipped(`skipped: no keys (${keys.skipped.map((s) => s.env).join(", ")} unset); suites validated${recordedNote}`, details);
  const lines: string[] = [];
  const argv = ["--live", "--skills-dir", o.skillsDir, "--providers", providersText, "--root", o.root, ...(o.evalOut ? ["--out", o.evalOut] : [])];
  const code = await evalMain(argv, { stdout: (s) => lines.push(s), stderr: (s) => o.log(s.trimEnd()), env: o.env, cwd: o.root });
  details.push(...lines.join("").split("\n").filter((l) => l.startsWith("|") || l.startsWith("- ")));
  if (code === EXIT.pass) return pass(`every skill wins or ties its no-skill baseline on ${keys.available.map((k) => k.provider).join(", ")}`, details);
  if (code === EXIT.skipped) return skipped("skipped: no keys", details);
  return fail(`gate 5 failed (exit ${code}); see the eval report${o.evalOut ? ` in ${o.evalOut}` : ""}`, details);
};

// ---- gate 6 ----

const gate6: GateFn = async (o) => {
  const desk = findWorkspacePackage(o.root, "@oneseat/desktop");
  if (!desk) return fail("apps/desktop (@oneseat/desktop) is missing");
  if (!desk.manifest.scripts?.["e2e"]) return fail('@oneseat/desktop has no "e2e" script');
  const r = await o.exec("pnpm", ["--filter", "@oneseat/desktop", "e2e"], { cwd: o.root });
  return r.code === 0 ? pass(`desktop e2e passed on ${process.platform}`) : fail(`desktop e2e failed (exit ${r.code})`, tail(r.stdout + r.stderr));
};

// ---- gate 7 ----

const gate7: GateFn = async () => ({
  status: "MANUAL",
  reason: `pilot: 10 teams, 2 weeks. Copy ${PILOT_TEMPLATE} to docs/pilot.md and track it there.`,
  details: [],
});

const GATES: Record<number, GateFn> = { 1: gate1, 2: gate2, 3: gate3, 4: gate4, 5: gate5, 6: gate6, 7: gate7 };

/** Run the selected gates in order. Never throws: a crash is a FAIL. */
export async function runGates(ids: readonly number[], opts: GateOptions): Promise<GateResult[]> {
  const full = {
    ...opts,
    skillsDir: opts.skillsDir ?? join(opts.root, "skills"),
    coverageThreshold: opts.coverageThreshold ?? 90,
    corePackages: opts.corePackages ?? DEFAULT_CORE_PACKAGES,
    env: opts.env ?? process.env,
    exec: opts.exec ?? defaultExec,
    log: opts.log ?? ((l: string) => process.stderr.write(`${l}\n`)),
  };
  const results: GateResult[] = [];
  for (const id of ids) {
    const fn = GATES[id];
    const name = GATE_NAMES[id] ?? `Gate ${id}`;
    const started = Date.now();
    if (!fn) {
      results.push({ id, name, status: "FAIL", reason: `unknown gate ${id}`, details: [], durationMs: 0 });
      continue;
    }
    full.log(`\n== gate ${id}: ${name} ==`);
    try {
      const r = await fn(full);
      results.push({ id, name, ...r, durationMs: Date.now() - started });
    } catch (e) {
      results.push({ id, name, status: "FAIL", reason: `gate crashed: ${(e as Error).message}`, details: [], durationMs: Date.now() - started });
    }
  }
  return results;
}

export function gatesExitCode(results: readonly GateResult[]): number {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}
