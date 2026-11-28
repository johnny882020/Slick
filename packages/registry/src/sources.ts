// Fetch a SkillSource into a staging folder and find the skills in it.
//
// - local: a path to one skill folder, or a folder holding many. Only the
//   discovered skill folders are copied into staging.
// - github: the tarball from codeload.github.com (default ref HEAD), checked
//   and extracted by the safe tar reader. `path` narrows the search to a subfolder.
// - skills.sh: "owner/repo" or "owner/repo@skill" (as `npx skills add` takes).
//   Resolved to the GitHub repo; with @skill, only the skill whose frontmatter
//   name matches is kept. Without it, every skill in the repo is staged.
//
// Skills are found by SKILL.md at the root, in skills/*, .claude/skills/*, or
// anywhere up to MAX_DISCOVERY_DEPTH folders down.

import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SKILL_FILE, parseSkillMd, type SkillSource } from "@oneseat/contracts";
import { RegistryError } from "./errors.js";
import { copyTree, discoverSkillDirs } from "./files.js";
import { DEFAULT_LIMITS, type SourceLimits } from "./limits.js";
import { checkArchivePath, extractTarGz } from "./tar.js";

/** The subset of fetch the registry uses (inject a fake in tests). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface StagedSource {
  /** Human label, e.g. "github:owner/repo@HEAD". */
  label: string;
  /** Absolute skill folders inside the staging folder. */
  skillDirs: string[];
}

export interface StageOptions {
  fetch: FetchLike;
  limits?: SourceLimits;
}

const GH_NAME = /^[A-Za-z0-9_.-]+$/;

export function describeSource(source: SkillSource): string {
  switch (source.kind) {
    case "local":
      return `local:${source.path}`;
    case "github":
      return `github:${source.owner}/${source.repo}@${source.ref ?? "HEAD"}${source.path ? `/${source.path}` : ""}`;
    case "skills.sh":
      return `skills.sh:${source.owner}/${source.repo}${source.skill ? `@${source.skill}` : ""}`;
  }
}

export function tarballUrl(owner: string, repo: string, ref = "HEAD"): string {
  if (!GH_NAME.test(owner) || !GH_NAME.test(repo) || owner.startsWith(".") || repo.startsWith("."))
    throw new RegistryError("bad-source", `invalid GitHub repository "${owner}/${repo}"`);
  if (!ref || ref.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new RegistryError("bad-source", `invalid git ref "${ref}"`);
  const safeRef = ref.split("/").map(encodeURIComponent).join("/");
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${safeRef}`;
}

/** Download a URL into memory, refusing bodies over `maxBytes`. */
export async function download(fetchFn: FetchLike, url: string, maxBytes: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/x-gzip, application/octet-stream" } });
  } catch (e) {
    throw new RegistryError("fetch-failed", `could not download ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new RegistryError("fetch-failed", `download failed: ${url} returned HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new RegistryError("too-large", `download is larger than ${maxBytes} bytes`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new RegistryError("too-large", `download is larger than ${maxBytes} bytes`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("too-large", `download is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The frontmatter name of the skill in `dir`, or the folder name if SKILL.md cannot be parsed. */
export async function skillNameOf(dir: string): Promise<string> {
  try {
    const parsed = parseSkillMd(await readFile(join(dir, SKILL_FILE), "utf8"));
    const name = parsed.frontmatter["name"];
    if (typeof name === "string" && name) return name;
  } catch {
    /* fall through */
  }
  return basename(dir);
}

async function stageGithub(
  owner: string,
  repo: string,
  ref: string | undefined,
  subpath: string | undefined,
  staging: string,
  opts: StageOptions,
): Promise<string[]> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const url = tarballUrl(owner, repo, ref ?? "HEAD");
  const gz = await download(opts.fetch, url, limits.maxBytes);
  const root = join(staging, "repo");
  await extractTarGz(gz, root, { strip: 1, limits });
  let base = root;
  if (subpath) {
    const checked = checkArchivePath(subpath, 0);
    if (!checked.ok) throw new RegistryError("bad-source", `invalid path in source: ${subpath}`);
    if (checked.path) base = join(root, ...checked.path.split("/"));
    const st = await lstat(base).catch(() => undefined);
    if (!st?.isDirectory()) throw new RegistryError("no-skills", `${owner}/${repo} has no folder "${subpath}"`);
  }
  return discoverSkillDirs(base);
}

/** Fetch `source` into `staging` (an empty folder) and return the skill folders found. */
export async function stageSource(source: SkillSource, staging: string, opts: StageOptions): Promise<StagedSource> {
  const label = describeSource(source);
  const limits = opts.limits ?? DEFAULT_LIMITS;
  await mkdir(staging, { recursive: true });
  let dirs: string[];
  if (source.kind === "local") {
    const src = resolve(source.path);
    const st = await lstat(src).catch(() => undefined);
    if (!st?.isDirectory()) throw new RegistryError("bad-source", `not a folder: ${source.path}`);
    const found = await discoverSkillDirs(src);
    dirs = [];
    for (const [i, dir] of found.entries()) {
      const dest = join(staging, String(i), basename(dir));
      await copyTree(dir, dest, limits);
      dirs.push(dest);
    }
  } else if (source.kind === "github") {
    dirs = await stageGithub(source.owner, source.repo, source.ref, source.path, staging, opts);
  } else {
    dirs = await stageGithub(source.owner, source.repo, undefined, undefined, staging, opts);
    if (source.skill) {
      const named: string[] = [];
      const names: string[] = [];
      for (const d of dirs) {
        const n = await skillNameOf(d);
        names.push(n);
        if (n === source.skill) named.push(d);
      }
      if (named.length === 0)
        throw new RegistryError(
          "skill-not-found",
          `no skill named "${source.skill}" in ${source.owner}/${source.repo}` +
            (names.length ? ` (found: ${names.sort().join(", ")})` : ""),
        );
      dirs = named;
    }
  }
  if (dirs.length === 0) throw new RegistryError("no-skills", `no SKILL.md found in ${label}`);
  return { label, skillDirs: dirs };
}
