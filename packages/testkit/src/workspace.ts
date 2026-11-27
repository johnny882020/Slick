// Find the monorepo root and import sibling workspace packages at run time
// (testkit never imports gateway / harness / registry statically).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/** Walk up from start to the folder holding pnpm-workspace.yaml. Falls back to start. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: { name?: string; scripts?: Record<string, string>; bin?: string | Record<string, string>; exports?: unknown; main?: string; [k: string]: unknown };
}

/** Workspace packages from pnpm-workspace.yaml ("dir/*" and plain "dir" patterns). */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  let patterns = ["packages/*", "apps/*"];
  try {
    const ws = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as { packages?: string[] } | null;
    if (ws?.packages?.length) patterns = ws.packages;
  } catch {
    /* defaults */
  }
  const out: WorkspacePackage[] = [];
  const add = (dir: string) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    try {
      const manifest = JSON.parse(readFileSync(pj, "utf8")) as WorkspacePackage["manifest"];
      if (manifest.name) out.push({ name: manifest.name, dir, manifest });
    } catch {
      /* skip broken package.json */
    }
  };
  for (const p of patterns) {
    if (p.startsWith("!")) continue;
    const clean = p.replace(/\/\*\*?$/, "");
    const base = join(root, clean);
    if (p.endsWith("/*") || p.endsWith("/**")) {
      if (!existsSync(base)) continue;
      for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) add(join(base, e.name));
    } else add(base);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findWorkspacePackage(root: string, name: string): WorkspacePackage | undefined {
  return listWorkspacePackages(root).find((p) => p.name === name);
}

/** The built entry file of a package (exports "." default/import, or main). */
export function packageEntry(pkg: WorkspacePackage, subpath = "."): string | undefined {
  const ex = pkg.manifest.exports;
  let target: unknown;
  if (typeof ex === "string" && subpath === ".") target = ex;
  else if (ex && typeof ex === "object") {
    const obj = ex as Record<string, unknown>;
    const entry = subpath in obj ? obj[subpath] : subpath === "." && !Object.keys(obj).some((k) => k.startsWith(".")) ? obj : undefined;
    if (typeof entry === "string") target = entry;
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      target = e["import"] ?? e["default"] ?? e["node"];
      if (target && typeof target === "object") target = (target as Record<string, unknown>)["default"];
    }
  }
  if (!target && subpath === ".") target = pkg.manifest.main ?? "index.js";
  return typeof target === "string" ? join(pkg.dir, target) : undefined;
}

export class WorkspaceImportError extends Error {
  override name = "WorkspaceImportError";
}

/**
 * Import a workspace package by name: first as a normal dependency, then by finding it in
 * the workspace and importing its built entry. Throws a WorkspaceImportError that says what to do.
 */
export async function importWorkspacePackage<T = Record<string, unknown>>(name: string, root: string, importer: (specifier: string) => Promise<unknown> = (s) => import(s)): Promise<T> {
  try {
    return (await importer(name)) as T;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && !/Cannot find (module|package)/.test(String((e as Error).message))) throw e;
  }
  const pkg = findWorkspacePackage(root, name);
  if (!pkg) throw new WorkspaceImportError(`${name} is not installed and is not in this workspace (${root}). It is needed for live runs; add the package or run without --live.`);
  const entry = packageEntry(pkg);
  if (!entry || !existsSync(entry)) throw new WorkspaceImportError(`${name} is in the workspace at ${pkg.dir} but its build output is missing (${entry ?? "no entry"}). Run "pnpm build" first.`);
  return (await importer(pathToFileURL(entry).href)) as T;
}
