// Load rule packs from YAML text or a rules/ directory.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "yaml";
import type { RulePack } from "@oneseat/contracts";
import { lintPack, type LintIssue } from "./lint.js";

export interface LoadResult {
  packs: RulePack[];
  issues: LintIssue[];
}

/** Parse and lint one pack. The pack is returned only when it has no lint errors. */
export function loadPackText(text: string, name: string): { pack?: RulePack; issues: LintIssue[] } {
  let raw: unknown;
  try {
    // Keep dates as strings: YAML 1.2 core schema has no timestamp type.
    raw = parse(text, { schema: "core" });
  } catch (e) {
    return { issues: [{ pack: name, at: "", level: "error", message: `YAML does not parse: ${(e as Error).message}` }] };
  }
  const issues = lintPack(raw, name);
  if (issues.some((i) => i.level === "error")) return { issues };
  return { pack: raw as RulePack, issues };
}

/** Load every *.yaml / *.yml pack under a directory (recursively), sorted by path. */
export async function loadRulebook(dir: string): Promise<LoadResult> {
  const files = (await walk(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const packs: RulePack[] = [];
  const issues: LintIssue[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const name = relative(dir, file);
    const r = loadPackText(await readFile(file, "utf8"), name);
    issues.push(...r.issues);
    if (!r.pack) continue;
    const prev = seen.get(r.pack.id);
    if (prev) {
      issues.push({ pack: name, at: "id", level: "error", message: `pack id "${r.pack.id}" is also used by ${prev}` });
      continue;
    }
    seen.set(r.pack.id, name);
    packs.push(r.pack);
  }
  return { packs, issues };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** True when the pack is in force on the given ISO date and not retired. */
export function inEffect(pack: RulePack, today: string): boolean {
  if (pack.review.status === "retired") return false;
  if (pack.effectiveFrom > today) return false;
  return pack.effectiveTo === undefined || pack.effectiveTo === null || pack.effectiveTo >= today;
}
