// Contract 2 — SkillManifest.
// The Agent Skills open standard (agentskills.io): a folder with SKILL.md
// (YAML frontmatter + Markdown body) and optional linked files.
// OneSeat adds one optional file, oneseat.json, for declared permissions.
// FROZEN at end of week 2.

import { parse as parseYaml } from "yaml";

export const SKILL_FILE = "SKILL.md";
export const SKILL_PERMISSIONS_FILE = "oneseat.json";
export const SKILL_MAX_LINES = 500;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;

/** Frontmatter fields defined by the Agent Skills standard. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Space-delimited in the file; parsed to a list. */
  allowedTools?: string[];
}

/**
 * What a skill's scripts may touch. Deny by default: an empty list means none.
 * The sandbox grants exactly these, and the scanner blocks anything else.
 */
export interface SkillPermissions {
  /** Hostnames (optionally host:port) scripts may reach. */
  net: string[];
  /** Paths, relative to the skill folder or a named root ("$WORKSPACE/..."), scripts may read. */
  read: string[];
  /** Paths scripts may write. */
  write: string[];
  /** Environment variable names scripts may read. Never secrets. */
  env: string[];
  /** Executables scripts may start. */
  run: string[];
}

export type SkillEffect = "send" | "pay" | "delete";

/** oneseat.json */
export interface SkillPermissionsFile {
  permissions?: Partial<SkillPermissions>;
  /** Outward effects the skill can cause. Each needs a person's approval at run time. */
  effects?: SkillEffect[];
  /** Why each network host is needed. The scanner requires a reason per host. */
  reasons?: Record<string, string>;
  /** Entry scripts the harness may run, relative to the skill folder. */
  scripts?: Record<string, { file: string; description: string }>;
}

export interface SkillManifest {
  frontmatter: SkillFrontmatter;
  /** Markdown body of SKILL.md, without frontmatter. */
  body: string;
  /** Absolute path of the skill folder (empty for in-memory skills). */
  dir: string;
  /** All files in the folder, relative, POSIX separators, sorted. */
  files: string[];
  /** Files linked from SKILL.md, relative, in order of first link. */
  linkedFiles: string[];
  permissions: SkillPermissions;
  effects: SkillEffect[];
  reasons: Record<string, string>;
  scripts: Record<string, { file: string; description: string }>;
}

/** What the router sends to the model at session start: ~100 tokens per skill. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

/** Where an installed skill came from. */
export type SkillSource =
  | { kind: "local"; path: string }
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { kind: "skills.sh"; owner: string; repo: string; skill?: string };

export interface InstalledSkill {
  manifest: SkillManifest;
  source: SkillSource;
  /** Semver from metadata.version, or "0.0.0+<hash8>". */
  version: string;
  /** sha256 over the sorted file list and contents. */
  contentHash: string;
  /** Base64 ed25519 signature over contentHash, by the local install key. */
  signature: string;
  installedAt: string;
}

export function emptyPermissions(): SkillPermissions {
  return { net: [], read: [], write: [], env: [], run: [] };
}

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
  /** 1-based line where the body starts in the file. */
  bodyStartLine: number;
}

export class SkillParseError extends Error {
  override name = "SkillParseError";
}

/** Split SKILL.md into YAML frontmatter and Markdown body. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) throw new SkillParseError("SKILL.md must start with YAML frontmatter (---)");
  const end = src.indexOf("\n---", 4);
  if (end === -1) throw new SkillParseError("SKILL.md frontmatter is not closed (---)");
  const yamlText = src.slice(4, end);
  let after = end + 4;
  if (src[after] === "\n") after += 1;
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (e) {
    throw new SkillParseError(`invalid YAML frontmatter: ${(e as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new SkillParseError("frontmatter must be a YAML mapping");
  const bodyStartLine = src.slice(0, after).split("\n").length;
  return { frontmatter: data as Record<string, unknown>, body: src.slice(after), bodyStartLine };
}

export interface SkillIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validate and normalise frontmatter per the Agent Skills standard. */
export function validateFrontmatter(
  raw: Record<string, unknown>,
  dirName?: string,
): { frontmatter?: SkillFrontmatter; issues: SkillIssue[] } {
  const issues: SkillIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: "error", rule, message, file: SKILL_FILE });
  const name = raw["name"];
  const description = raw["description"];
  if (typeof name !== "string" || name.length === 0) err("name-required", "name is required");
  else {
    if (name.length > SKILL_NAME_MAX) err("name-length", `name is over ${SKILL_NAME_MAX} characters`);
    if (!NAME_RE.test(name))
      err("name-format", "name must be lowercase letters, digits and single hyphens, not at the start or end");
    if (dirName !== undefined && dirName !== name) err("name-dir", `name "${name}" must match folder "${dirName}"`);
  }
  if (typeof description !== "string" || description.trim().length === 0)
    err("description-required", "description is required");
  else if (description.length > SKILL_DESCRIPTION_MAX)
    err("description-length", `description is over ${SKILL_DESCRIPTION_MAX} characters`);
  const compatibility = raw["compatibility"];
  if (compatibility !== undefined) {
    if (typeof compatibility !== "string") err("compatibility-type", "compatibility must be a string");
    else if (compatibility.length > SKILL_COMPATIBILITY_MAX)
      err("compatibility-length", `compatibility is over ${SKILL_COMPATIBILITY_MAX} characters`);
  }
  const license = raw["license"];
  if (license !== undefined && typeof license !== "string") err("license-type", "license must be a string");
  let metadata: Record<string, string> | undefined;
  const md = raw["metadata"];
  if (md !== undefined) {
    if (md === null || typeof md !== "object" || Array.isArray(md)) err("metadata-type", "metadata must be a mapping");
    else {
      metadata = {};
      for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") metadata[k] = String(v);
        else err("metadata-value", `metadata.${k} must be a string`);
      }
    }
  }
  let allowedTools: string[] | undefined;
  const at = raw["allowed-tools"];
  if (at !== undefined) {
    if (typeof at === "string") allowedTools = at.split(/\s+/).filter(Boolean);
    else if (Array.isArray(at) && at.every((x) => typeof x === "string")) allowedTools = at as string[];
    else err("allowed-tools-type", "allowed-tools must be a space-delimited string");
  }
  const known = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  for (const k of Object.keys(raw))
    if (!known.has(k))
      issues.push({ severity: "warning", rule: "unknown-field", message: `unknown frontmatter field "${k}"`, file: SKILL_FILE });
  if (issues.some((i) => i.severity === "error")) return { issues };
  const frontmatter: SkillFrontmatter = { name: name as string, description: (description as string).trim() };
  if (typeof license === "string") frontmatter.license = license;
  if (typeof compatibility === "string") frontmatter.compatibility = compatibility;
  if (metadata) frontmatter.metadata = metadata;
  if (allowedTools) frontmatter.allowedTools = allowedTools;
  return { frontmatter, issues };
}

/** Parse and validate oneseat.json. Unknown keys are ignored. */
export function parsePermissionsFile(text: string | undefined): {
  value: Required<Omit<SkillPermissionsFile, "permissions">> & { permissions: SkillPermissions };
  issues: SkillIssue[];
} {
  const issues: SkillIssue[] = [];
  const value = { permissions: emptyPermissions(), effects: [] as SkillEffect[], reasons: {}, scripts: {} } as {
    permissions: SkillPermissions;
    effects: SkillEffect[];
    reasons: Record<string, string>;
    scripts: Record<string, { file: string; description: string }>;
  };
  if (text === undefined) return { value, issues };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    issues.push({ severity: "error", rule: "permissions-json", message: `oneseat.json is not valid JSON: ${(e as Error).message}`, file: SKILL_PERMISSIONS_FILE });
    return { value, issues };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ severity: "error", rule: "permissions-json", message: "oneseat.json must be an object", file: SKILL_PERMISSIONS_FILE });
    return { value, issues };
  }
  const r = raw as SkillPermissionsFile;
  const keys: (keyof SkillPermissions)[] = ["net", "read", "write", "env", "run"];
  for (const k of keys) {
    const list = r.permissions?.[k];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string"))
      issues.push({ severity: "error", rule: "permissions-type", message: `permissions.${k} must be a list of strings`, file: SKILL_PERMISSIONS_FILE });
    else value.permissions[k] = [...list];
  }
  if (r.effects !== undefined) {
    const ok: SkillEffect[] = ["send", "pay", "delete"];
    if (!Array.isArray(r.effects) || !r.effects.every((e) => ok.includes(e)))
      issues.push({ severity: "error", rule: "effects-type", message: 'effects must be a list of "send", "pay", "delete"', file: SKILL_PERMISSIONS_FILE });
    else value.effects = [...r.effects];
  }
  if (r.reasons !== undefined && typeof r.reasons === "object" && !Array.isArray(r.reasons)) {
    for (const [k, v] of Object.entries(r.reasons)) if (typeof v === "string") value.reasons[k] = v;
  }
  if (r.scripts !== undefined && typeof r.scripts === "object" && !Array.isArray(r.scripts)) {
    for (const [k, v] of Object.entries(r.scripts)) {
      if (v && typeof v === "object" && typeof v.file === "string" && typeof v.description === "string")
        value.scripts[k] = { file: v.file, description: v.description };
      else
        issues.push({ severity: "error", rule: "scripts-type", message: `scripts.${k} needs "file" and "description"`, file: SKILL_PERMISSIONS_FILE });
    }
  }
  for (const host of value.permissions.net)
    if (!value.reasons[host])
      issues.push({ severity: "error", rule: "net-reason", message: `network host "${host}" has no declared reason`, file: SKILL_PERMISSIONS_FILE });
  return { value, issues };
}

/**
 * Relative files linked from Markdown: [text](path) and <path> autolinks,
 * excluding URLs and in-page anchors. Order of first appearance.
 */
export function extractLinks(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    let p = raw.trim().replace(/^<|>$/g, "");
    p = p.split("#")[0]!.split("?")[0]!;
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/")) return;
    p = p.replace(/^\.\//, "");
    try {
      p = decodeURI(p);
    } catch {
      /* keep raw */
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  // Ignore fenced code blocks.
  const text = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(m[1]!);
  for (const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) add(m[1]!);
  return out;
}

/** Build a manifest from file contents (used by registry and harness). */
export function buildManifest(input: {
  dir: string;
  dirName?: string;
  skillMd: string;
  permissionsJson?: string;
  files: string[];
}): { manifest?: SkillManifest; issues: SkillIssue[] } {
  const issues: SkillIssue[] = [];
  let parsed: ParsedSkillMd;
  try {
    parsed = parseSkillMd(input.skillMd);
  } catch (e) {
    return { issues: [{ severity: "error", rule: "parse", message: (e as Error).message, file: SKILL_FILE }] };
  }
  const fm = validateFrontmatter(parsed.frontmatter, input.dirName);
  issues.push(...fm.issues);
  const perms = parsePermissionsFile(input.permissionsJson);
  issues.push(...perms.issues);
  if (!fm.frontmatter) return { issues };
  const files = [...input.files].map((f) => f.replace(/\\/g, "/")).sort();
  const manifest: SkillManifest = {
    frontmatter: fm.frontmatter,
    body: parsed.body,
    dir: input.dir,
    files,
    linkedFiles: extractLinks(parsed.body),
    permissions: perms.value.permissions,
    effects: perms.value.effects,
    reasons: perms.value.reasons,
    scripts: perms.value.scripts,
  };
  return { manifest, issues };
}

export function toIndexEntry(m: SkillManifest): SkillIndexEntry {
  return { name: m.frontmatter.name, description: m.frontmatter.description };
}

/** Parse "owner/repo", "owner/repo@skill", a GitHub URL, or a local path. */
export function parseSkillSource(input: string): SkillSource {
  const s = input.trim();
  const gh = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+))?)?\/?$/);
  if (gh) {
    const src: SkillSource = { kind: "github", owner: gh[1]!, repo: gh[2]! };
    if (gh[3]) src.ref = gh[3];
    if (gh[4]) src.path = gh[4];
    return src;
  }
  const short = s.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:@([a-z0-9-]+))?$/);
  if (short && !s.startsWith(".") && !s.startsWith("/")) {
    const src: SkillSource = { kind: "skills.sh", owner: short[1]!, repo: short[2]! };
    if (short[3]) src.skill = short[3];
    return src;
  }
  return { kind: "local", path: s };
}
