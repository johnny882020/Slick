import { describe, expect, it } from "vitest";
import { parseSkillSource } from "@oneseat/contracts";
import { parseSearchEntry, REGISTRY_HOSTS, RegistryError, SEARCH_LIMIT, searchSkillsSh, skillsShSource, type FetchLike } from "../src/index.js";

const entry = (skill: string, source = "anthropics/knowledge-work-plugins", installs = 10, extra: Record<string, unknown> = {}) => ({
  id: `${source}/${skill}`,
  source,
  skillId: skill,
  name: skill,
  installs,
  ...extra,
});

function stub(body: unknown, init: ResponseInit = { status: 200 }) {
  const urls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  const fetch: FetchLike = async (url, i) => {
    urls.push(url);
    headers.push(i?.headers);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
  };
  return { fetch, urls, headers };
}

describe("searchSkillsSh", () => {
  it("calls /api/search with the query and maps entries", async () => {
    const s = stub({ query: "invoice", searchType: "fuzzy", skills: [entry("invoice-chase", undefined, 2258)] });
    const out = await searchSkillsSh("  invoice chase ", { fetch: s.fetch });
    expect(s.urls).toEqual(["https://skills.sh/api/search?q=invoice%20chase"]);
    expect(s.headers[0]).toEqual({ accept: "application/json" });
    expect(out).toEqual([
      { id: "anthropics/knowledge-work-plugins/invoice-chase", repo: "anthropics/knowledge-work-plugins", skill: "invoice-chase", name: "invoice-chase", installs: 2258 },
    ]);
    // The install source is one parseSkillSource reads as skills.sh owner/repo@skill.
    expect(parseSkillSource(skillsShSource(out[0]!))).toEqual({ kind: "skills.sh", owner: "anthropics", repo: "knowledge-work-plugins", skill: "invoice-chase" });
  });

  it("returns [] for an empty query without a request", async () => {
    const s = stub({ skills: [] });
    expect(await searchSkillsSh("   ", { fetch: s.fetch })).toEqual([]);
    expect(await searchSkillsSh("\u0000​", { fetch: s.fetch })).toEqual([]);
    expect(s.urls).toEqual([]);
  });

  it("caps the query, the count, and drops duplicates and malformed entries", async () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`skill-${i}`));
    const s = stub({ skills: [entry("skill-0"), "junk", null, ...many] });
    const out = await searchSkillsSh("x".repeat(500), { fetch: s.fetch, baseUrl: "https://mirror.example/" });
    expect(out).toHaveLength(SEARCH_LIMIT);
    expect(new Set(out.map((r) => r.id)).size).toBe(SEARCH_LIMIT);
    expect(s.urls[0]).toBe(`https://mirror.example/api/search?q=${"x".repeat(200)}`);
    expect(await searchSkillsSh("x", { fetch: stub({ skills: many }).fetch, limit: 3 })).toHaveLength(3);
    expect(await searchSkillsSh("x", { fetch: stub({ skills: many }).fetch, limit: 999 })).toHaveLength(SEARCH_LIMIT);
  });

  it("reports HTTP errors, timeouts, unreachable hosts and bad replies in plain words", async () => {
    const fail = (p: Promise<unknown>, msg: RegExp) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof RegistryError && e.code !== undefined && msg.test(e.message));
    await fail(searchSkillsSh("x", { fetch: stub("down", { status: 503 }).fetch }), /HTTP 503/);
    await fail(searchSkillsSh("x", { fetch: stub("<html>").fetch }), /could not read/);
    await fail(searchSkillsSh("x", { fetch: stub({ results: [] }).fetch }), /could not read/);
    await fail(searchSkillsSh("x", { fetch: stub("null").fetch }), /could not read/);
    await fail(
      searchSkillsSh("x", {
        fetch: async () => {
          throw new TypeError("getaddrinfo ENOTFOUND skills.sh");
        },
      }),
      /could not reach skills.sh: getaddrinfo/,
    );
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await fail(searchSkillsSh("x", { fetch: hang, timeoutMs: 20 }), /did not answer within 1 second$/);
  });

  it("refuses replies that are too large", async () => {
    const big = JSON.stringify({ skills: [], pad: "x".repeat(1024 * 1024 + 10) });
    await expect(searchSkillsSh("x", { fetch: stub(big).fetch })).rejects.toMatchObject({ code: "too-large" });
    const declared: FetchLike = async () => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } });
    await expect(searchSkillsSh("x", { fetch: declared })).rejects.toMatchObject({ code: "too-large" });
    const noBody = (text: string): FetchLike =>
      async () => ({ ok: true, status: 200, headers: new Headers(), body: null, text: async () => text }) as unknown as Response;
    await expect(searchSkillsSh("x", { fetch: noBody(big) })).rejects.toMatchObject({ code: "too-large" });
    expect(await searchSkillsSh("x", { fetch: noBody(JSON.stringify({ skills: [entry("a-b")] })) })).toHaveLength(1);
  });

  it("uses globalThis.fetch by default", async () => {
    const orig = globalThis.fetch;
    const s = stub({ skills: [entry("a")] });
    globalThis.fetch = ((url: string, init?: RequestInit) => s.fetch(url, init as never)) as typeof fetch;
    try {
      expect(await searchSkillsSh("a")).toHaveLength(1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("parseSearchEntry", () => {
  it("accepts a well-formed entry and cleans the name", () => {
    expect(parseSearchEntry(entry("x", "o/r", 3.7, { name: "  Invoice\u0007 Automation‮ " }))).toEqual({
      id: "o/r/x",
      repo: "o/r",
      skill: "x",
      name: "Invoice Automation",
      installs: 3,
    });
    expect(parseSearchEntry({ source: "o/r", skillId: "x" })).toEqual({ id: "o/r/x", repo: "o/r", skill: "x", name: "x", installs: 0 });
    expect(parseSearchEntry(entry("x", "o/r", 1, { name: "n".repeat(300) }))!.name).toHaveLength(100);
  });

  it.each([
    ["not an object", 42],
    ["an array", []],
    ["no source", { skillId: "x" }],
    ["no skillId", { source: "o/r" }],
    ["source with three parts", entry("x", "o/r/extra")],
    ["source with one part", entry("x", "o")],
    ["owner with a dot", entry("x", "../r")],
    ["repo starting with a dot", entry("x", "o/.git")],
    ["repo ending .git", entry("x", "o/r.git")],
    ["upper-case skill", entry("X", "o/r")],
    ["skill with a slash", entry("a/b", "o/r")],
    ["long skill", entry("a".repeat(65), "o/r")],
    ["id that disagrees", entry("x", "o/r", 1, { id: "evil/other/x" })],
  ])("drops %s", (_label, raw) => {
    expect(parseSearchEntry(raw)).toBeUndefined();
  });

  it.each([[-5], [Number.NaN], [Infinity], ["12"]])("treats installs %s as 0", (n) => {
    expect(parseSearchEntry({ source: "o/r", skillId: "x", installs: n })!.installs).toBe(0);
  });
});

it("lists every registry host with a reason", () => {
  expect(Object.keys(REGISTRY_HOSTS).sort()).toEqual(["codeload.github.com", "skills.sh"]);
  for (const reason of Object.values(REGISTRY_HOSTS)) expect(reason.length).toBeGreaterThan(20);
});
