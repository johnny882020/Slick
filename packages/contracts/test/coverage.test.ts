// Edge paths of the contracts helpers: stream collection, estimates, parse errors,
// oneseat.json validation and the scripted provider.
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  collect,
  createScriptedProvider,
  estimateTokens,
  extractLinks,
  parsePermissionsFile,
  parseSkillMd,
  SkillParseError,
  toIndexEntry,
  validateArtifactBundle,
  validateArtifactHtml,
  validateFrontmatter,
  validateToolSpec,
  type ChatEvent,
} from "../src/index.js";

async function* stream(events: ChatEvent[]) {
  for (const e of events) yield e;
}

const req = { model: "m", system: "s", messages: [], tools: [], maxTokens: 10 };

describe("collect", () => {
  it("keeps reasoning between text and tool calls, with providerMeta", async () => {
    const r = await collect(
      stream([
        { type: "message_start", model: "m" },
        { type: "text_delta", text: "a" },
        { type: "reasoning_done", part: { type: "reasoning", text: "think", providerMeta: { signature: "s" } } },
        { type: "tool_call", call: { id: "1", name: "t", input: {}, providerMeta: { thoughtSignature: "x" } } },
        { type: "reasoning_delta", text: "ignored" },
        { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
      ]),
    );
    expect(r.message.content).toEqual([
      { type: "text", text: "a" },
      { type: "reasoning", text: "think", providerMeta: { signature: "s" } },
      { type: "tool_use", id: "1", name: "t", input: {}, providerMeta: { thoughtSignature: "x" } },
    ]);
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
  it("reports errors", async () => {
    const r = await collect(stream([{ type: "error", error: { kind: "auth", message: "no", retryable: false } }]));
    expect(r.stopReason).toBe("error");
    expect(r.error?.kind).toBe("auth");
  });
});

describe("estimateTokens", () => {
  it("counts every part type and tools", () => {
    const n = estimateTokens({
      system: "x".repeat(40),
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "y".repeat(40) }, { type: "image", mediaType: "image/png", data: "AA" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "tool_use", id: "1", name: "t", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "1", name: "t", content: "ok" }] },
      ],
    });
    expect(n).toBeGreaterThan(1600);
  });
});

describe("SKILL.md parse errors", () => {
  it("rejects unclosed, invalid and non-mapping frontmatter", () => {
    expect(() => parseSkillMd("---\nname: a\n")).toThrow(SkillParseError);
    expect(() => parseSkillMd("---\nname: [a\n---\n")).toThrow(/invalid YAML/);
    expect(() => parseSkillMd("---\n- a\n---\n")).toThrow(/mapping/);
    expect(parseSkillMd("﻿---\r\nname: a\r\n---\r\nbody").body).toBe("body");
  });
  it("validates optional fields", () => {
    const rules = (raw: Record<string, unknown>) => validateFrontmatter({ name: "a", description: "d", ...raw }).issues.map((i) => i.rule);
    expect(rules({ compatibility: 5 })).toContain("compatibility-type");
    expect(rules({ compatibility: "c".repeat(501) })).toContain("compatibility-length");
    expect(rules({ license: 1 })).toContain("license-type");
    expect(rules({ metadata: [] })).toContain("metadata-type");
    expect(rules({ metadata: { a: { b: 1 } } })).toContain("metadata-value");
    expect(rules({ "allowed-tools": 3 })).toContain("allowed-tools-type");
    expect(rules({ extra: 1 })).toContain("unknown-field");
    expect(rules({ name: "a".repeat(65) })).toContain("name-length");
    const ok = validateFrontmatter({ name: "a", description: " d ", license: "MIT", compatibility: "x", metadata: { v: 1, b: true }, "allowed-tools": ["x"] });
    expect(ok.frontmatter).toEqual({ name: "a", description: "d", license: "MIT", compatibility: "x", metadata: { v: "1", b: "true" }, allowedTools: ["x"] });
  });
});

describe("oneseat.json", () => {
  const rules = (text: string) => parsePermissionsFile(text).issues.map((i) => i.rule);
  it("rejects bad JSON and bad shapes", () => {
    expect(rules("{")).toEqual(["permissions-json"]);
    expect(rules("[]")).toEqual(["permissions-json"]);
    expect(rules(JSON.stringify({ permissions: { net: "x" } }))).toContain("permissions-type");
    expect(rules(JSON.stringify({ effects: ["email"] }))).toContain("effects-type");
    expect(rules(JSON.stringify({ scripts: { a: { file: "a.ts" } } }))).toContain("scripts-type");
  });
  it("reads effects, reasons and scripts", () => {
    const { value, issues } = parsePermissionsFile(
      JSON.stringify({
        permissions: { net: ["api.x.com"], read: ["$SKILL/data"] },
        effects: ["send"],
        reasons: { "api.x.com": "Reads orders.", junk: 1 },
        scripts: { totals: { file: "scripts/totals.ts", description: "Totals" } },
      }),
    );
    expect(issues).toEqual([]);
    expect(value.effects).toEqual(["send"]);
    expect(value.reasons).toEqual({ "api.x.com": "Reads orders." });
    expect(value.scripts.totals!.file).toBe("scripts/totals.ts");
    expect(value.permissions.read).toEqual(["$SKILL/data"]);
  });
});

describe("links and manifests", () => {
  it("keeps undecodable links raw and skips absolute ones", () => {
    expect(extractLinks("[a](bad%E0.md) [b](/etc/passwd) [c](#top) [d](x.md?v=1)")).toEqual(["bad%E0.md", "x.md"]);
  });
  it("returns issues without a manifest for invalid frontmatter, and index entries", () => {
    expect(buildManifest({ dir: "", skillMd: "---\nname: Bad\ndescription: d\n---\n", files: [] }).manifest).toBeUndefined();
    const { manifest } = buildManifest({ dir: "/s/a", skillMd: "---\nname: a\ndescription: d\n---\n", files: ["b\\c.md", "SKILL.md"] });
    expect(manifest!.files).toEqual(["SKILL.md", "b/c.md"]);
    expect(toIndexEntry(manifest!)).toEqual({ name: "a", description: "d" });
  });
});

describe("artifact and tool edges", () => {
  it("checks a whole bundle and HTML edge rules", () => {
    const issues = validateArtifactBundle({
      html: '<p>no doc</p><base href="/"><meta http-equiv="refresh" content="0"><script>fetch("x")</script>' + "x".repeat(5 * 1024 * 1024),
      app: { id: "a", name: "A", version: "1.0.0", window: { width: 800, height: 600 }, allowedSkills: [], icon: "not an icon at all" },
    });
    const r = issues.map((i) => i.rule);
    for (const rule of ["size", "document", "base", "refresh", "network-api", "app-icon"]) expect(r).toContain(rule);
    expect(validateArtifactHtml("<html>new WebSocket('x')</html>").map((i) => i.rule)).toContain("network-api");
  });
  it("validates tool specs", () => {
    const r = validateToolSpec({ name: "t", description: "", inputSchema: { type: "string" } }).map((i) => i.path);
    expect(r).toEqual(["description", "inputSchema.type"]);
    expect(validateToolSpec({ name: "t", description: "d".repeat(1025), inputSchema: null as never }).map((i) => i.path)).toEqual(["description", "inputSchema"]);
  });
});

describe("scripted provider", () => {
  it("plays reasoning, computed turns and errors, and honours abort", async () => {
    const p = createScriptedProvider(
      [
        { steps: [{ reasoning: "hm" }, { text: "x" }], usage: { inputTokens: 3, outputTokens: 4 } },
        (r, i) => ({ steps: [{ text: `turn ${i} for ${r.model}` }] }),
        { steps: [{ error: { kind: "rate_limit" } }] },
        { steps: [{ error: { kind: "auth", message: "bad key" } }] },
        { steps: [{ text: "never" }] },
      ],
      { id: "anthropic" },
    );
    expect(p.id).toBe("anthropic");
    expect((await p.models())[0]!.provider).toBe("anthropic");
    expect(await p.countTokens({ ...req, system: "x".repeat(8) })).toBe(2);
    const a = await collect(p.send(req));
    expect(a.message.content[0]).toEqual({ type: "reasoning", text: "hm" });
    expect(a.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect((await collect(p.send(req))).message.content).toEqual([{ type: "text", text: "turn 1 for m" }]);
    expect((await collect(p.send(req))).error).toMatchObject({ kind: "rate_limit", retryable: true });
    expect((await collect(p.send(req))).error).toMatchObject({ kind: "auth", message: "bad key", retryable: false });
    const ac = new AbortController();
    ac.abort();
    expect((await collect(p.send({ ...req, signal: ac.signal }))).error?.kind).toBe("aborted");
    expect(p.remaining()).toBe(0);
  });
  it("uses custom models", async () => {
    const p = createScriptedProvider([], { models: [{ id: "x", provider: "local", label: "X", supportsTools: false }] });
    expect((await p.models())[0]!.id).toBe("x");
  });
});
