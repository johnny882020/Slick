import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArtifactBundle, ToolDefinition } from "@oneseat/contracts";
import {
  checkArtifactBundle,
  checkSkillFolder,
  checkToolDefinition,
  checkToolDefinitions,
  describeArtifactBundleConformance,
  describeSkillManifestConformance,
  describeToolCallConformance,
  findSkillDirsSync,
  impliedEffects,
  loadArtifactBundle,
} from "../src/index.js";

// ---- a skills folder written synchronously, since describe() collects synchronously ----

const root = mkdtempSync(join(tmpdir(), "oneseat-manifest-"));
function write(rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
export function evalCases(skill: string, n = 10) {
  return JSON.stringify({ skill, cases: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, input: `Task ${i + 1}`, checks: [{ type: "min_words", value: 1 }] })) });
}

write("skills/good-skill/SKILL.md", "---\nname: good-skill\ndescription: Write a weekly brief from the numbers. Use when the user asks for a weekly report.\nallowed-tools: db_query github.create-issue\n---\n# Good\n\nSee [the template](templates/brief.md) and [refs](refs/).\n");
write("skills/good-skill/templates/brief.md", "# Brief\n\nBack to [SKILL](../SKILL.md). External [x](https://example.com).\n");
write("skills/good-skill/refs/a.md", "a");
write("skills/good-skill/scripts/run.ts", "console.log(1)\n");
write("skills/good-skill/oneseat.json", JSON.stringify({ permissions: { net: ["api.example.com"] }, reasons: { "api.example.com": "rates" }, scripts: { run: { file: "scripts/run.ts", description: "Run." } } }));
write("skills/good-skill/evals/cases.json", evalCases("good-skill"));
const skillsDir = join(root, "skills");

write("bad/long-skill/SKILL.md", `---\nname: long-skill\ndescription: Short\n---\n${"line\n".repeat(520)}`);
write("bad/wrong-name/SKILL.md", "---\nname: other-name\ndescription: Does things. Use when needed.\n---\n");
write("bad/links/SKILL.md", "---\nname: links\ndescription: Has bad links. Use when testing links.\nallowed-tools: ok bad!tool\n---\n[missing](nope.md) [escape](../outside.md) [chain](a.md)\n");
write("bad/links/a.md", "[next](b.md)\n");
write("bad/links/b.md", "end\n");
write("bad/links/oneseat.json", JSON.stringify({ permissions: { net: ["x.test"] }, scripts: { s: { file: "scripts/none.ts", description: "d" }, t: { file: "../t.ts", description: "d" } } }));
write("bad/links/evals/cases.json", JSON.stringify({ skill: "links", cases: [] }));
write("bad/badjson/SKILL.md", "---\nname: badjson\ndescription: Bad eval JSON. Use when testing.\n---\n");
write("bad/badjson/evals/cases.json", "{nope");
write("bad/broken/SKILL.md", "no frontmatter");
write("bad/not-a-skill/readme.md", "x");

describeSkillManifestConformance(skillsDir);
describeSkillManifestConformance(join(skillsDir, "good-skill"));

describe("checkSkillFolder catches bad skills", () => {
  const bad = (name: string, opts = {}) => checkSkillFolder(join(root, "bad", name), opts).checks;
  it("finds skill folders", () => {
    expect(findSkillDirsSync(skillsDir)).toEqual([join(skillsDir, "good-skill")]);
    expect(findSkillDirsSync(join(skillsDir, "good-skill"))).toEqual([join(skillsDir, "good-skill")]);
    expect(findSkillDirsSync(join(root, "missing"))).toEqual([]);
    expect(findSkillDirsSync(join(root, "bad")).length).toBe(5);
  });
  it("passes the good skill", () => {
    const r = checkSkillFolder(join(skillsDir, "good-skill"));
    expect(r.name).toBe("good-skill");
    expect(Object.values(r.checks).flat()).toEqual([]);
  });
  it("too long, vague description, missing evals", () => {
    const c = bad("long-skill");
    expect(c["SKILL.md is under 500 lines"].join()).toMatch(/has 524 lines/);
    expect(c["description says what the skill does and when to use it"].join()).toMatch(/too short.*|when to use/);
    expect(c["eval cases are valid"].join()).toMatch(/missing/);
    expect(bad("long-skill", { requireEvals: false })["eval cases are valid"]).toEqual([]);
  });
  it("name must match folder", () => {
    expect(bad("wrong-name")["name matches the folder"].join()).toMatch(/must match folder/);
  });
  it("links, chains, scripts, hosts, tools and eval cases", () => {
    const c = bad("links");
    expect(c["linked files exist inside the folder"].join("\n")).toMatch(/nope.md" does not exist/);
    expect(c["linked files exist inside the folder"].join("\n")).toMatch(/outside the skill folder/);
    expect(c["linked files are linked directly from SKILL.md (no chains)"].join()).toMatch(/"a.md" links to "b.md"/);
    expect(c["declared scripts exist inside the folder"].join("\n")).toMatch(/does not exist/);
    expect(c["declared scripts exist inside the folder"].join("\n")).toMatch(/outside the folder/);
    expect(c["oneseat.json is valid and every network host has a reason"].join()).toMatch(/net-reason/);
    expect(c["allowed-tools are valid tool names"].join()).toMatch(/bad!tool/);
    expect(c["eval cases are valid"].join()).toMatch(/at least 10 cases/);
  });
  it("bad eval JSON and unparsable SKILL.md", () => {
    expect(bad("badjson")["eval cases are valid"].join()).toMatch(/not valid JSON/);
    expect(bad("broken")["SKILL.md parses and the frontmatter is valid"].join()).toMatch(/frontmatter/);
    expect(checkSkillFolder(join(root, "bad", "missing-dir"))["checks"]["SKILL.md parses and the frontmatter is valid"].join()).toMatch(/cannot read/);
  });
});

// ---- tools ----

const tool = (name: string, effects: ToolDefinition["effects"], extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `Tool ${name}.`,
  inputSchema: { type: "object", properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["id"] },
  effects,
  source: "builtin",
  ...extra,
});

const GOOD_TOOLS = [tool("db_query", ["read"]), tool("send_email", ["send", "network"]), tool("pay_invoice", ["pay"]), tool("delete_customer", ["delete", "write"]), tool("list_messages", ["read"]), tool("draft_post", ["write"])];
describeToolCallConformance(GOOD_TOOLS, "builtin");

describe("tool checks", () => {
  it("implies effects from names", () => {
    expect(impliedEffects("send_email")).toEqual(["send"]);
    expect(impliedEffects("sendInvoiceEmail")).toEqual(["send"]);
    expect(impliedEffects("refund_and_remove")).toEqual(["pay", "delete"]);
    expect(impliedEffects("get_payment")).toEqual([]);
    expect(impliedEffects("db_query")).toEqual([]);
  });
  it("flags missing approval effects, bad names, schemas and sources", () => {
    expect(checkToolDefinition(tool("send_email", ["network"])).join()).toMatch(/declare the "send" effect/);
    expect(checkToolDefinition(tool("charge_card", ["write"])).join()).toMatch(/"pay"/);
    expect(checkToolDefinition(tool("purge_cache", ["write"])).join()).toMatch(/"delete"/);
    expect(checkToolDefinition(tool("1bad", ["read"])).join()).toMatch(/invalid tool name/);
    expect(checkToolDefinition(tool("x", [])).join()).toMatch(/must not be empty/);
    expect(checkToolDefinition(tool("x", ["fly" as never])).join()).toMatch(/unknown effect/);
    expect(checkToolDefinition(tool("x", "read" as never)).join()).toMatch(/must be a list/);
    expect(checkToolDefinition(tool("x", ["read"], { source: "cloud" as never })).join()).toMatch(/source/);
    expect(checkToolDefinition(tool("x", ["read"], { inputSchema: { type: "string" } })).join()).toMatch(/must be "object"/);
    const schema = checkToolDefinition(
      tool("x", ["read"], {
        inputSchema: {
          type: "object",
          properties: { a: { $ref: "#/x" }, b: { type: "array" }, c: { description: "no type" }, d: { type: "string", enum: [] }, e: { type: "array", items: [{ type: "string" }, "bad" as never] } },
          required: ["a", "zzz"],
          $defs: {},
        },
      }),
    ).join("\n");
    expect(schema).toMatch(/\$ref is not portable/);
    expect(schema).toMatch(/\$defs/);
    expect(schema).toMatch(/needs items/);
    expect(schema).toMatch(/has no type/);
    expect(schema).toMatch(/enum must be a non-empty list/);
    expect(schema).toMatch(/"zzz", which is not in properties/);
    expect(schema).toMatch(/items\[1\]: schema must be an object/);
    expect(checkToolDefinition(tool("x", ["read"], { inputSchema: { type: "object", properties: [] as never, required: "a" as never } })).join()).toMatch(/properties must be an object.*required must be a list/s);
  });
  it("flags duplicate names across a list", () => {
    const r = checkToolDefinitions([tool("a", ["read"]), tool("a", ["read"]), tool("9x", ["read"])]);
    expect(r["a"]!.join()).toMatch(/used 2 times/);
    expect(Object.keys(r)).toContain('#2 "9x"');
  });
  it("guards deep schemas", () => {
    let s: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) s = { type: "object", properties: { n: s } };
    expect(checkToolDefinition(tool("deep", ["read"], { inputSchema: s })).join()).toMatch(/nests too deeply/);
  });
});

// ---- artifacts ----

const GOOD_BUNDLE: ArtifactBundle = {
  html: '<!doctype html><html><body><button onclick="oneseat.run(\'invoices\', {})">Go</button><img src="data:image/png;base64,AA=="></body></html>',
  app: { id: "invoice-app", name: "Invoices", version: "1.0.0", window: { width: 900, height: 700 }, allowedSkills: ["invoices"], icon: "🧾" },
};
write("apps/invoice-app/index.html", GOOD_BUNDLE.html);
write("apps/invoice-app/app.json", JSON.stringify(GOOD_BUNDLE.app));
describeArtifactBundleConformance(GOOD_BUNDLE);
describeArtifactBundleConformance([join(root, "apps", "invoice-app"), GOOD_BUNDLE]);

describe("artifact checks", () => {
  it("loads bundles from folders", () => {
    expect(loadArtifactBundle(join(root, "apps", "invoice-app"))).toEqual(GOOD_BUNDLE);
  });
  it("flags remote resources, unlisted skills, dynamic names and Tauri internals", () => {
    const r = checkArtifactBundle({
      html: '<html><script src="https://cdn.x/y.js"></script><script>oneseat.run("payroll", {}); oneseat.run(name); window.__TAURI__.invoke("x")</script></html>',
      app: { ...GOOD_BUNDLE.app, id: "Bad Id" },
    }).checks;
    expect(r["app.json is valid"]!.join()).toMatch(/app-id/);
    expect(r["HTML is self-contained (no remote resources, frames or base)"]!.join()).toMatch(/remote-resource/);
    expect(r["oneseat.run() calls only allowed skills"]!.join("\n")).toMatch(/payroll/);
    expect(r["oneseat.run() calls only allowed skills"]!.join("\n")).toMatch(/string literal/);
    expect(r["no inline script reaches for globals outside the bridge"]!.join()).toMatch(/__TAURI__/);
    expect(checkArtifactBundle({ html: 3 as never, app: GOOD_BUNDLE.app }).checks["HTML is self-contained (no remote resources, frames or base)"]!.join()).toMatch(/must be a string/);
    expect(checkArtifactBundle({ html: "<html></html>", app: { ...GOOD_BUNDLE.app, allowedSkills: "x" as never } }).id).toBe("invoice-app");
  });
});
