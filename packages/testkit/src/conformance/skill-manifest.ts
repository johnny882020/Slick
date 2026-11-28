// SkillManifest conformance (contract 2) for skill folders, e.g. skills/*.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, extractLinks, isValidToolName, SKILL_FILE, SKILL_MAX_LINES, SKILL_PERMISSIONS_FILE } from "@oneseat/contracts";
import { safeSkillPath } from "../memory-store.js";
import { validateEvalSuite } from "../evals/validate.js";

export interface SkillFolderCheckOptions {
  /** Require evals/cases.json with at least minEvalCases cases (gate 5). Default true. */
  requireEvals?: boolean;
  /** Default 10. */
  minEvalCases?: number;
}

export const SKILL_FOLDER_CHECKS = [
  "SKILL.md parses and the frontmatter is valid",
  "name matches the folder",
  `SKILL.md is under ${SKILL_MAX_LINES} lines`,
  "description says what the skill does and when to use it",
  "linked files exist inside the folder",
  "linked files are linked directly from SKILL.md (no chains)",
  "oneseat.json is valid and every network host has a reason",
  "declared scripts exist inside the folder",
  "allowed-tools are valid tool names",
  "eval cases are valid",
] as const;

export type SkillFolderCheck = (typeof SKILL_FOLDER_CHECKS)[number];

export interface SkillFolderReport {
  dir: string;
  name: string;
  /** Problems per check. An empty list means the check passed. */
  checks: Record<SkillFolderCheck, string[]>;
}

const MARKDOWN = /\.(md|markdown)$/i;
const IGNORED = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

function listFilesSync(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORED.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Skill folders under root (or root itself if it has SKILL.md). Synchronous, because describe() collects synchronously. */
export function findSkillDirsSync(root: string): string[] {
  if (isFile(join(root, SKILL_FILE))) return [root];
  if (!isDir(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED.has(e.name))
    .map((e) => join(root, e.name))
    .filter((d) => isFile(join(d, SKILL_FILE)))
    .sort();
}

/** Run every manifest check on one skill folder. Never throws. */
export function checkSkillFolder(dir: string, opts: SkillFolderCheckOptions = {}): SkillFolderReport {
  const requireEvals = opts.requireEvals ?? true;
  const minEvalCases = opts.minEvalCases ?? 10;
  const checks = Object.fromEntries(SKILL_FOLDER_CHECKS.map((c) => [c, [] as string[]])) as Record<SkillFolderCheck, string[]>;
  const add = (c: SkillFolderCheck, msg: string) => checks[c].push(msg);
  const dirName = basename(dir);
  let files: string[];
  let skillMd: string;
  try {
    files = listFilesSync(dir);
    skillMd = readFileSync(join(dir, SKILL_FILE), "utf8");
  } catch (e) {
    add("SKILL.md parses and the frontmatter is valid", `cannot read the folder: ${(e as Error).message}`);
    return { dir, name: dirName, checks };
  }
  const permissionsJson = files.includes(SKILL_PERMISSIONS_FILE) ? readFileSync(join(dir, SKILL_PERMISSIONS_FILE), "utf8") : undefined;
  const built = buildManifest({ dir, skillMd, files, ...(permissionsJson !== undefined ? { permissionsJson } : {}) });
  for (const i of built.issues) {
    if (i.severity !== "error") continue;
    add(i.file === SKILL_PERMISSIONS_FILE ? "oneseat.json is valid and every network host has a reason" : "SKILL.md parses and the frontmatter is valid", `[${i.rule}] ${i.message}`);
  }
  const m = built.manifest;
  if (!m) return { dir, name: dirName, checks };
  if (m.frontmatter.name !== dirName) add("name matches the folder", `name "${m.frontmatter.name}" must match folder "${dirName}"`);

  const lines = skillMd.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
  if (lines > SKILL_MAX_LINES) add(`SKILL.md is under ${SKILL_MAX_LINES} lines`, `SKILL.md has ${lines} lines (max ${SKILL_MAX_LINES}); move detail into linked files`);

  const desc = m.frontmatter.description;
  if (desc.length < 20) add("description says what the skill does and when to use it", "description is too short to route on");
  if (!/\b(use|used|when|whenever)\b/i.test(desc)) add("description says what the skill does and when to use it", 'description must say when to use the skill (e.g. "Use when ...")');

  const fileSet = new Set(files);
  const linked = new Set<string>();
  for (const link of m.linkedFiles) {
    const p = safeSkillPath(link);
    if (p === undefined) add("linked files exist inside the folder", `link "${link}" points outside the skill folder`);
    else {
      linked.add(p);
      const isFolder = files.some((f) => f.startsWith(`${p.replace(/\/$/, "")}/`));
      if (!fileSet.has(p) && !isFolder) add("linked files exist inside the folder", `linked file "${link}" does not exist`);
    }
  }
  for (const f of linked) {
    if (!MARKDOWN.test(f) || !fileSet.has(f)) continue;
    const text = readFileSync(join(dir, ...f.split("/")), "utf8");
    const base = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    for (const l of extractLinks(text)) {
      const target = safeSkillPath(base + l);
      if (target && fileSet.has(target) && target !== SKILL_FILE && !linked.has(target))
        add("linked files are linked directly from SKILL.md (no chains)", `"${f}" links to "${target}", which SKILL.md does not link; link it from SKILL.md directly`);
    }
  }

  for (const [key, s] of Object.entries(m.scripts)) {
    const p = safeSkillPath(s.file);
    if (p === undefined) add("declared scripts exist inside the folder", `script "${key}" (${s.file}) is outside the folder`);
    else if (!fileSet.has(p)) add("declared scripts exist inside the folder", `script "${key}" file ${s.file} does not exist`);
  }
  for (const t of m.frontmatter.allowedTools ?? []) {
    // MCP names like "github.create-issue" are converted with toToolName(); allow "." and ":" in source names.
    if (!isValidToolName(t.replace(/[.:]/g, "_"))) add("allowed-tools are valid tool names", `allowed tool "${t}" is not a valid tool name`);
  }

  if (fileSet.has("evals/cases.json")) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "evals", "cases.json"), "utf8")) as unknown;
      for (const i of validateEvalSuite(raw, { skill: m.frontmatter.name, minCases: requireEvals ? minEvalCases : 0 }))
        if (i.severity === "error") add("eval cases are valid", `${i.path}: ${i.message}`);
    } catch (e) {
      add("eval cases are valid", `evals/cases.json is not valid JSON: ${(e as Error).message}`);
    }
  } else if (requireEvals) add("eval cases are valid", `evals/cases.json is missing (gate 5 needs at least ${minEvalCases} cases)`);
  return { dir, name: m.frontmatter.name, checks };
}

/**
 * Register manifest conformance for one skill folder, or every skill folder under dir (vitest).
 * Call it at the top level of a test file.
 */
export function describeSkillManifestConformance(dir: string, opts: SkillFolderCheckOptions = {}): void {
  const dirs = findSkillDirsSync(dir);
  describe(`conformance: SkillManifest ${basename(dir)}`, () => {
    it("has at least one skill folder", () => expect(dirs.length).toBeGreaterThan(0));
    for (const d of dirs) {
      describe(basename(d), () => {
        let report: SkillFolderReport | undefined;
        const get = () => (report ??= checkSkillFolder(d, opts));
        for (const check of SKILL_FOLDER_CHECKS) it(check, () => expect(get().checks[check]).toEqual([]));
      });
    }
  });
}
