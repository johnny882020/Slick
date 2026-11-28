// Read skill folders from disk with the contract parser (buildManifest). Never another parser.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { buildManifest, SKILL_FILE, SKILL_PERMISSIONS_FILE, type SkillIssue, type SkillManifest } from "@oneseat/contracts";

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

/** All files under dir, relative with POSIX separators, sorted. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() || e.isSymbolicLink()) out.push(relative(dir, full).split(sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A single skill folder (has SKILL.md), or every direct sub-folder that has one. Sorted. */
export async function findSkillDirs(root: string): Promise<string[]> {
  if (await exists(join(root, SKILL_FILE))) return [root];
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
    if (e.isDirectory() && !IGNORED.has(e.name) && (await exists(join(root, e.name, SKILL_FILE)))) dirs.push(join(root, e.name));
  return dirs;
}

export interface SkillFolder {
  dir: string;
  manifest?: SkillManifest;
  issues: SkillIssue[];
  files: string[];
  /** File contents as bytes, keyed by relative path. */
  contents: Map<string, Buffer>;
}

/** Read a skill folder into memory and build its manifest. */
export async function readSkillFolder(dir: string): Promise<SkillFolder> {
  const files = await listFilesRecursive(dir);
  const contents = new Map<string, Buffer>();
  for (const f of files) contents.set(f, await readFile(join(dir, ...f.split("/"))));
  const skillMd = contents.get(SKILL_FILE);
  if (!skillMd) return { dir, files, contents, issues: [{ severity: "error", rule: "skill-md", message: `${SKILL_FILE} is missing`, file: SKILL_FILE }] };
  const perms = contents.get(SKILL_PERMISSIONS_FILE);
  const { manifest, issues } = buildManifest({
    dir,
    dirName: basename(dir),
    skillMd: skillMd.toString("utf8"),
    ...(perms ? { permissionsJson: perms.toString("utf8") } : {}),
    files,
  });
  return { dir, files, contents, issues, ...(manifest ? { manifest } : {}) };
}

/** sha256 over the sorted file list and each file's content. */
export function hashSkillContents(contents: ReadonlyMap<string, Buffer | string>): string {
  const h = createHash("sha256");
  for (const f of [...contents.keys()].sort()) {
    const c = contents.get(f)!;
    h.update(f, "utf8");
    h.update("\0");
    h.update(createHash("sha256").update(c).digest("hex"));
    h.update("\n");
  }
  return h.digest("hex");
}
