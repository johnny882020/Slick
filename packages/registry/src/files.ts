// Reading skill folders into memory, finding skills in a tree, and writing
// them back out. Symlinks are never followed while walking: each one is kept
// as an entry so the scanner can judge it (inside the folder: warn and copy
// as a plain file at install; outside: block).

import { constants as fsc } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { SKILL_FILE } from "@oneseat/contracts";
import { RegistryError, UnsafeSourceError, type UnsafeEntry } from "./errors.js";
import { DEFAULT_LIMITS, MAX_DISCOVERY_DEPTH, SKIPPED_DIRS, type SourceLimits } from "./limits.js";

export type SkillEntry =
  | { kind: "file"; path: string; bytes: Uint8Array }
  | {
      kind: "symlink";
      path: string;
      /** The raw link target. */
      target: string;
      /** Relative path the link points to inside the skill; undefined when it escapes. */
      resolved?: string;
      /** True when the link points inside the skill but at nothing. */
      dangling?: boolean;
    }
  | { kind: "special"; path: string; type: string };

/** A skill folder held in memory: exactly the bytes that were scanned are the bytes installed. */
export interface LoadedSkill {
  /** Absolute folder path the skill was read from. */
  dir: string;
  /** Folder name (the frontmatter name must match it). */
  dirName: string;
  /** Every entry, sorted by POSIX relative path. */
  entries: SkillEntry[];
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** True when `child` (absolute) is `root` or inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function specialType(st: { isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): string {
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character device";
  if (st.isBlockDevice()) return "block device";
  return "unknown";
}

/** Read a skill folder into memory. Enforces the source size and file-count caps. */
export async function loadSkillDir(dir: string, limits: SourceLimits = DEFAULT_LIMITS): Promise<LoadedSkill> {
  const root = resolve(dir);
  const st = await lstat(root).catch(() => undefined);
  if (!st || !st.isDirectory()) throw new RegistryError("bad-source", `not a folder: ${dir}`);
  const realRoot = await realpath(root);
  const entries: SkillEntry[] = [];
  let bytes = 0;
  let count = 0;
  const bump = () => {
    count += 1;
    if (count > limits.maxFiles) throw new RegistryError("too-many-files", `skill has more than ${limits.maxFiles} files`);
  };
  async function walk(abs: string): Promise<void> {
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      const childAbs = join(abs, name);
      const rel = toPosix(relative(root, childAbs));
      const cst = await lstat(childAbs);
      if (cst.isDirectory()) {
        if (name === ".git") continue;
        await walk(childAbs);
      } else if (cst.isFile()) {
        bump();
        bytes += cst.size;
        if (bytes > limits.maxBytes) throw new RegistryError("too-large", `skill is larger than ${limits.maxBytes} bytes`);
        entries.push({ kind: "file", path: rel, bytes: new Uint8Array(await readFile(childAbs)) });
      } else if (cst.isSymbolicLink()) {
        bump();
        entries.push(await describeLink(root, realRoot, childAbs, rel));
      } else {
        bump();
        entries.push({ kind: "special", path: rel, type: specialType(cst) });
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir: root, dirName: basename(root), entries };
}

async function describeLink(root: string, realRoot: string, abs: string, rel: string): Promise<SkillEntry> {
  const target = await readlink(abs);
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return { kind: "symlink", path: rel, target };
  const lexical = resolve(dirname(abs), target);
  if (!isInside(root, lexical)) return { kind: "symlink", path: rel, target };
  let real: string | undefined;
  try {
    real = await realpath(abs);
  } catch {
    return { kind: "symlink", path: rel, target, resolved: toPosix(relative(root, lexical)), dangling: true };
  }
  if (!isInside(realRoot, real)) return { kind: "symlink", path: rel, target };
  return { kind: "symlink", path: rel, target, resolved: toPosix(relative(realRoot, real)) };
}

/** All regular-file paths of a loaded skill. */
export function filePaths(skill: LoadedSkill): string[] {
  return skill.entries.filter((e) => e.kind === "file").map((e) => e.path);
}

export function fileEntry(skill: LoadedSkill, path: string): Extract<SkillEntry, { kind: "file" }> | undefined {
  const e = skill.entries.find((x) => x.path === path);
  if (!e) return undefined;
  if (e.kind === "file") return e;
  if (e.kind === "symlink" && e.resolved !== undefined && !e.dangling) {
    const t = skill.entries.find((x) => x.path === e.resolved);
    if (t && t.kind === "file") return { kind: "file", path, bytes: t.bytes };
  }
  return undefined;
}

/** True when `path` names a folder inside the skill (some entry lives under it). */
export function isDirPath(skill: LoadedSkill, path: string): boolean {
  const p = path.replace(/\/+$/, "");
  if (p === "" || p === ".") return true;
  return skill.entries.some((e) => e.path.startsWith(`${p}/`));
}

const decoder = new TextDecoder("utf-8", { fatal: false });
export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Find skill folders (folders holding SKILL.md) under `root`, at most
 * `maxDepth` levels down. A folder that is a skill is not searched further.
 * Skips .git and node_modules, and never follows symlinks.
 */
export async function discoverSkillDirs(root: string, maxDepth = MAX_DISCOVERY_DEPTH): Promise<string[]> {
  const out: string[] = [];
  async function visit(abs: string, depth: number): Promise<void> {
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => []);
    if (dirents.some((d) => d.isFile() && d.name === SKILL_FILE)) {
      out.push(abs);
      return;
    }
    if (depth >= maxDepth) return;
    const subdirs = dirents.filter((d) => d.isDirectory() && !SKIPPED_DIRS.has(d.name)).map((d) => d.name).sort();
    for (const name of subdirs) await visit(join(abs, name), depth + 1);
  }
  await visit(resolve(root), 0);
  return out.sort();
}

/**
 * Copy a folder tree (used to stage a local source). Symlinks are copied as
 * symlinks (the scanner judges them); devices, FIFOs and sockets are refused.
 */
export async function copyTree(src: string, dest: string, limits: SourceLimits = DEFAULT_LIMITS): Promise<void> {
  let bytes = 0;
  let count = 0;
  const unsafe: UnsafeEntry[] = [];
  async function walk(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const name of (await readdir(from)).sort()) {
      if (name === ".git") continue;
      const f = join(from, name);
      const t = join(to, name);
      const st = await lstat(f);
      if (st.isDirectory()) {
        await walk(f, t);
        continue;
      }
      count += 1;
      if (count > limits.maxFiles) throw new RegistryError("too-many-files", `source has more than ${limits.maxFiles} files`);
      if (st.isFile()) {
        bytes += st.size;
        if (bytes > limits.maxBytes) throw new RegistryError("too-large", `source is larger than ${limits.maxBytes} bytes`);
        await copyFile(f, t, fsc.COPYFILE_EXCL);
      } else if (st.isSymbolicLink()) {
        await symlink(await readlink(f), t);
      } else {
        unsafe.push({ path: toPosix(relative(src, f)), rule: "special-file", message: `${specialType(st)} is not allowed in a skill` });
      }
    }
  }
  await walk(src, dest);
  if (unsafe.length) throw new UnsafeSourceError(unsafe);
}

/**
 * Write a loaded skill to `dest` (which must not exist). Regular files are
 * written as-is; a symlink to a file inside the skill becomes a plain copy of
 * that file; other symlinks and special entries are left out.
 */
export async function writeSkill(skill: LoadedSkill, dest: string): Promise<string[]> {
  await mkdir(dest, { recursive: false });
  const written: string[] = [];
  for (const e of skill.entries) {
    const file = fileEntry(skill, e.path);
    if (!file) continue;
    const segments = e.path.split("/");
    if (segments.some((s) => s === ".." || s === "" || s === ".") || posix.isAbsolute(e.path))
      throw new RegistryError("bad-path", `refusing to write ${e.path}`);
    const out = join(dest, ...segments);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, file.bytes, { mode: 0o644, flag: "wx" });
    written.push(e.path);
  }
  return written.sort();
}
