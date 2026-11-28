import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { FetchLike, LoadedSkill, SkillEntry } from "../../src/index.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const fixture = (name: string) => join(FIXTURES, name);

const made: string[] = [];
afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

/** A temp folder removed after the test. */
export async function tempDir(prefix = "oneseat-reg-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Write files (path -> content) under `root`. */
export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<string> {
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, ...p.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

/** Copy a fixture into a temp folder (so tests can modify it). */
export async function copyFixture(name: string, as = name): Promise<string> {
  const root = await tempDir();
  const dest = join(root, as);
  await cp(fixture(name), dest, { recursive: true });
  return dest;
}

export const DESC = "Summarise a document into five bullet points for a busy reader. Use when the user asks for a summary.";

export function skillMd(name = "test-skill", body = "# Test\n\nDo the task.\n", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${DESC}\n${extra}---\n${body}`;
}

/** Build a LoadedSkill in memory (no disk). SKILL.md is added unless given. */
export function mem(files: Record<string, string | Uint8Array>, dirName = "test-skill"): LoadedSkill {
  const all: Record<string, string | Uint8Array> = { "SKILL.md": skillMd(dirName), ...files };
  const entries: SkillEntry[] = Object.keys(all)
    .sort()
    .map((path) => {
      const v = all[path]!;
      return { kind: "file" as const, path, bytes: typeof v === "string" ? new TextEncoder().encode(v) : v };
    });
  return { dir: `/mem/${dirName}`, dirName, entries };
}

export interface FakeRoute {
  status?: number;
  body?: Uint8Array;
  headers?: Record<string, string>;
  /** Respond without a body stream (exercises the arrayBuffer path). */
  noStream?: boolean;
  error?: Error;
}

/** A fetch that serves fixed responses by URL and records every request. */
export function fakeFetch(routes: Record<string, FakeRoute | Uint8Array>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    const route: FakeRoute = r instanceof Uint8Array ? { body: r } : r;
    if (route.error) throw route.error;
    const status = route.status ?? 200;
    if (route.noStream) {
      const bytes = route.body ?? new Uint8Array();
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(route.headers ?? {}),
        body: null,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }
    return new Response((route.body ?? new Uint8Array()) as unknown as BodyInit, { status, headers: route.headers ?? {} });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const codeload = (owner: string, repo: string, ref = "HEAD") => `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
