// Search the skills.sh directory (GET https://skills.sh/api/search?q=...).
//
// Everything in the reply is untrusted: each entry is checked field by field, names are
// capped and stripped of control characters, entries that do not describe an installable
// "owner/repo@skill" source are dropped, and at most `limit` results come back.
// No API key is sent. Installing a result is a separate step (stageSource with a
// skills.sh source) and still goes through scan + lint.

import type { SkillSearchResult } from "@oneseat/contracts";
import { RegistryError } from "./errors.js";
import type { FetchLike } from "./sources.js";

/** Hosts the registry talks to, and why (CLAUDE.md: every network host has a reason). */
export const REGISTRY_HOSTS: Readonly<Record<string, string>> = {
  "codeload.github.com": "Download the GitHub repository of a skill the person chose to inspect or install.",
  "skills.sh": "Search the skills.sh directory when the person types a search in the Skill library.",
};

export const SKILLS_SH_URL = "https://skills.sh";
export const SEARCH_LIMIT = 25;
export const SEARCH_TIMEOUT_MS = 10_000;
/** Longest query sent to skills.sh. */
export const SEARCH_QUERY_MAX = 200;
/** Biggest reply read from skills.sh. */
export const SEARCH_MAX_BYTES = 1024 * 1024;
const NAME_MAX = 100;

/** A skills.sh result before the daemon marks which ones are installed. */
export type SkillsShResult = Omit<SkillSearchResult, "installed">;

export interface SearchOptions {
  fetch?: FetchLike;
  /** Default https://skills.sh. */
  baseUrl?: string;
  /** Default 25 (and never more). */
  limit?: number;
  /** Default 10 s. */
  timeoutMs?: number;
}

// Same shapes parseSkillSource accepts for "owner/repo@skill", so every result installs.
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The source text that skills.inspect / skills.install take for a result: "owner/repo@skill". */
export function skillsShSource(r: Pick<SkillSearchResult, "repo" | "skill">): string {
  return `${r.repo}@${r.skill}`;
}

/** Trim, drop control characters and cap the length of untrusted text. */
function cleanText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);
}

/** One entry of the reply, or undefined when it is malformed. */
export function parseSearchEntry(raw: unknown): SkillsShResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const source = e["source"];
  const skill = e["skillId"];
  if (typeof source !== "string" || typeof skill !== "string") return undefined;
  const parts = source.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo.endsWith(".git") || !SKILL_RE.test(skill) || skill.length > 64) return undefined;
  const id = `${owner}/${repo}/${skill}`;
  if (e["id"] !== undefined && e["id"] !== id) return undefined;
  const rawName = typeof e["name"] === "string" ? cleanText(e["name"], NAME_MAX) : "";
  const n = e["installs"];
  const installs = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return { id, repo: `${owner}/${repo}`, skill, name: rawName || skill, installs };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new RegistryError("too-large", "skills.sh sent a reply that is too large");
  if (!res.body) {
    const text = await res.text();
    if (text.length > maxBytes) throw new RegistryError("too-large", "skills.sh sent a reply that is too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("too-large", "skills.sh sent a reply that is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Search skills.sh for `query`. An empty query returns [] without a request.
 * Throws RegistryError("fetch-failed") when skills.sh cannot be reached, is slow, or
 * answers with something that is not a search reply.
 */
export async function searchSkillsSh(query: string, opts: SearchOptions = {}): Promise<SkillsShResult[]> {
  const q = cleanText(String(query ?? ""), SEARCH_QUERY_MAX);
  if (!q) return [];
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const limit = Math.max(1, Math.min(SEARCH_LIMIT, Math.floor(opts.limit ?? SEARCH_LIMIT)));
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const url = `${(opts.baseUrl ?? SKILLS_SH_URL).replace(/\/+$/, "")}/api/search?q=${encodeURIComponent(q)}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let text: string;
  try {
    const res = await fetchFn(url, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new RegistryError("fetch-failed", `skills.sh search failed (HTTP ${res.status})`);
    text = await readCapped(res, SEARCH_MAX_BYTES);
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    if (signal.aborted) {
      const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
      throw new RegistryError("fetch-failed", `skills.sh did not answer within ${secs} second${secs === 1 ? "" : "s"}`);
    }
    throw new RegistryError("fetch-failed", `could not reach skills.sh: ${(e as Error).message}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RegistryError("fetch-failed", "skills.sh sent a reply OneSeat could not read");
  }
  const list = body && typeof body === "object" ? (body as Record<string, unknown>)["skills"] : undefined;
  if (!Array.isArray(list)) throw new RegistryError("fetch-failed", "skills.sh sent a reply OneSeat could not read");
  const out: SkillsShResult[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const r = parseSearchEntry(raw);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
