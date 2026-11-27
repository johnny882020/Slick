// Stage a source, then scan and lint every skill in it. Shared by the store
// (install / inspect) and the CLI (scan).

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPermissions, type LintReport, type ScanReport, type SkillPermissions, type SkillSource } from "@oneseat/contracts";
import { UnsafeSourceError } from "./errors.js";
import { loadSkillDir, type LoadedSkill } from "./files.js";
import { DEFAULT_LIMITS, type SourceLimits } from "./limits.js";
import { lintSkill } from "./lint.js";
import { scanSkill } from "./scan.js";
import { describeSource, stageSource, type FetchLike } from "./sources.js";

export interface SkillCheck {
  /** The skill as staged: the exact bytes that were scanned. */
  loaded: LoadedSkill;
  scan: ScanReport;
  lint: LintReport;
}

export interface InspectOutcome {
  label: string;
  /** One per skill found. Empty when the source itself was refused. */
  checks: SkillCheck[];
  /** Combined reports (one skill: its own reports). */
  scan: ScanReport;
  lint: LintReport;
  /** Set when the source was refused before any skill could be scanned. */
  unsafe?: UnsafeSourceError;
}

export interface InspectOptions {
  fetch?: FetchLike;
  limits?: SourceLimits;
  /** Parent folder for the temporary staging folder (default: the OS temp dir). */
  stagingRoot?: string;
}

/** Scan and lint one folder in place (no staging). */
export async function checkDir(dir: string, limits: SourceLimits = DEFAULT_LIMITS): Promise<SkillCheck> {
  const loaded = await loadSkillDir(dir, limits);
  return { loaded, scan: scanSkill(loaded), lint: lintSkill(loaded) };
}

function unionPerms(list: SkillPermissions[]): SkillPermissions {
  const out = emptyPermissions();
  for (const p of list) for (const k of Object.keys(out) as (keyof SkillPermissions)[]) for (const v of p[k]) if (!out[k].includes(v)) out[k].push(v);
  for (const k of Object.keys(out) as (keyof SkillPermissions)[]) out[k].sort();
  return out;
}

/** Merge per-skill reports into one (for sources holding many skills). */
export function combineScans(scans: ScanReport[]): ScanReport {
  if (scans.length === 1) return scans[0]!;
  const verdict = scans.some((s) => s.verdict === "block") ? "block" : scans.some((s) => s.verdict === "warn") ? "warn" : "pass";
  return {
    skill: scans.map((s) => s.skill).join(", "),
    verdict,
    summary: [`${scans.length} skills.`, ...scans.map((s) => s.summary)].join("\n\n"),
    findings: scans.flatMap((s) => s.findings.map((f) => ({ ...f, file: `${s.skill}/${f.file}` }))),
    declared: unionPerms(scans.map((s) => s.declared)),
    observed: unionPerms(scans.map((s) => s.observed)),
    filesRead: scans.reduce((n, s) => n + s.filesRead, 0),
    bytesRead: scans.reduce((n, s) => n + s.bytesRead, 0),
  };
}

export function combineLints(lints: LintReport[]): LintReport {
  if (lints.length === 1) return lints[0]!;
  return {
    skill: lints.map((l) => l.skill).join(", "),
    ok: lints.every((l) => l.ok),
    issues: lints.flatMap((l) => l.issues.map((i) => ({ ...i, file: `${l.skill}/${i.file ?? ""}`.replace(/\/$/, "") }))),
  };
}

/** Reports for a source that was refused before scanning (unsafe archive entries etc.). */
export function unsafeReports(label: string, err: UnsafeSourceError): { scan: ScanReport; lint: LintReport } {
  const n = err.entries.length;
  return {
    scan: {
      skill: label,
      verdict: "block",
      summary: `The source ${label} was refused before scanning: ${n} unsafe entr${n === 1 ? "y" : "ies"} (${[...new Set(err.entries.map((e) => e.rule))].join(", ")}). Nothing from it was installed.`,
      findings: err.entries.map((e) => ({ severity: "block" as const, rule: e.rule, file: e.path, message: e.message })),
      declared: emptyPermissions(),
      observed: emptyPermissions(),
      filesRead: 0,
      bytesRead: 0,
    },
    lint: { skill: label, ok: false, issues: [{ severity: "error", rule: "unsafe-source", message: err.message }] },
  };
}

/**
 * Fetch `source` into a fresh staging folder, scan and lint each skill, then
 * delete the folder. The returned checks hold the scanned bytes in memory, so
 * an install writes exactly what was scanned.
 */
export async function inspectSource(source: SkillSource, opts: InspectOptions = {}): Promise<InspectOutcome> {
  const root = opts.stagingRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, "oneseat-stage-"));
  const label = describeSource(source);
  try {
    let outcome: InspectOutcome;
    try {
      const staged = await stageSource(source, join(staging, "src"), { fetch: opts.fetch ?? globalThis.fetch, limits: opts.limits ?? DEFAULT_LIMITS });
      const checks: SkillCheck[] = [];
      for (const dir of staged.skillDirs) checks.push(await checkDir(dir, opts.limits));
      outcome = {
        label,
        checks,
        scan: combineScans(checks.map((c) => c.scan)),
        lint: combineLints(checks.map((c) => c.lint)),
      };
    } catch (e) {
      if (!(e instanceof UnsafeSourceError)) throw e;
      outcome = { label, checks: [], ...unsafeReports(label, e), unsafe: e };
    }
    return outcome;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
