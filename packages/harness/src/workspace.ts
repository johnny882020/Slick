// Workspace file access, confined to one folder (symlinks included).

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export class PathError extends Error {
  override name = "PathError";
}

/**
 * Check a relative path from a model or skill: no absolute paths, drive letters,
 * home shortcuts, NUL bytes or ".." segments. Returns it with "/" separators.
 */
export function normaliseRelativePath(raw: string, what = "path"): string {
  if (typeof raw !== "string") throw new PathError(`${what} must be a string`);
  const p = raw.trim();
  if (p.includes("\0")) throw new PathError(`${what} contains a NUL byte`);
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\") || p.startsWith("~"))
    throw new PathError(`${what} "${raw}" must be relative`);
  const segs = p.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new PathError(`${what} "${raw}" must not contain ".."`);
  return segs.join("/");
}

/** Resolve a path inside root, following symlinks of existing parts to make sure it stays inside. */
export function resolveInside(root: string, raw: string, what = "path"): string {
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  const rel = normaliseRelativePath(raw, what);
  const target = rel ? join(realRoot, ...rel.split("/")) : realRoot;
  // Walk up to the deepest existing ancestor and check its real location.
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep))
    throw new PathError(`${what} "${raw}" is outside the workspace`);
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep))
      throw new PathError(`${what} "${raw}" is outside the workspace`);
  }
  return target;
}

export function displayPath(root: string, abs: string): string {
  return relative(realpathSync(root), abs).split(sep).join("/") || ".";
}
