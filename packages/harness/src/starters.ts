// Starter skills: the skills folder shipped with the app.
//
// Every start installs the starter skills that are not installed, except the ones the
// person removed: those are recorded in <dataDir>/removed-starters.json so they do not
// come back on their own. skills.restorable lists the starter skills that are not
// installed, and skills.restore puts one back from the bundle (still through scan + lint)
// and clears its "removed" mark.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSkillMd, SKILL_FILE, type InstallResult, type SkillStore } from "@oneseat/contracts";

export const REMOVED_STARTERS_FILE = "removed-starters.json";

export interface BundledSkill {
  /** Frontmatter name (the folder name when SKILL.md has none). */
  name: string;
  description: string;
  /** Absolute folder of the skill inside the bundle. */
  dir: string;
}

/** The starter skills in `dir`: folders with a SKILL.md (not hidden, not "_"-prefixed). */
export function listBundledSkills(dir: string | undefined): BundledSkill[] {
  if (!dir || !existsSync(dir)) return [];
  const out: BundledSkill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const skillDir = join(dir, entry.name);
    const md = join(skillDir, SKILL_FILE);
    if (!existsSync(md)) continue;
    let name = entry.name;
    let description = "";
    try {
      const fm = parseSkillMd(readFileSync(md, "utf8")).frontmatter;
      if (typeof fm["name"] === "string" && fm["name"]) name = fm["name"];
      if (typeof fm["description"] === "string") description = fm["description"];
    } catch {
      /* scan + lint report the problem at install time */
    }
    out.push({ name, description, dir: skillDir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The set of starter skills the person removed, kept in <dataDir>/removed-starters.json. */
export class RemovedStarters {
  readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, REMOVED_STARTERS_FILE);
  }

  list(): string[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return []; // missing or unreadable: nothing is marked removed
    }
    const removed = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["removed"] : undefined;
    if (!Array.isArray(removed)) return [];
    return [...new Set(removed.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 64))].sort();
  }

  has(name: string): boolean {
    return this.list().includes(name);
  }

  add(name: string): void {
    const set = new Set(this.list());
    if (set.has(name)) return;
    set.add(name);
    this.write([...set]);
  }

  delete(name: string): void {
    const set = new Set(this.list());
    if (!set.delete(name)) return;
    this.write([...set]);
  }

  private write(names: string[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, removed: names.sort() }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

/**
 * Install every starter skill that is neither installed nor removed by the person.
 * A starter skill still goes through scan + lint; a failure is logged, not fatal.
 * Returns the names installed.
 */
export async function seedStarterSkills(store: SkillStore, dir: string | undefined, dataDir: string, log: (line: string) => void): Promise<string[]> {
  const bundled = listBundledSkills(dir);
  if (!bundled.length) return [];
  const installed = new Set((await store.list()).map((s) => s.manifest.frontmatter.name));
  const removed = new Set(new RemovedStarters(dataDir).list());
  const seeded: string[] = [];
  for (const b of bundled) {
    if (installed.has(b.name) || removed.has(b.name)) continue;
    const res = await store.install({ kind: "local", path: b.dir });
    if (res.installed) seeded.push(b.name);
    else log(`bundled skill ${b.name} not installed: ${res.reason ?? res.scan.verdict}`);
  }
  return seeded;
}

/** Only the contract fields of an install result (the registry adds per-skill details). */
export function installResult(r: InstallResult): InstallResult {
  return {
    installed: r.installed,
    ...(r.skill ? { skill: r.skill } : {}),
    scan: r.scan,
    lint: r.lint,
    ...(r.reason ? { reason: r.reason } : {}),
  };
}
