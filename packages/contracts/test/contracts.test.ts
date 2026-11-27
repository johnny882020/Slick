import { describe, expect, it } from "vitest";
import {
  buildManifest,
  collect,
  createScriptedProvider,
  extractLinks,
  findBridgeCalls,
  parseSkillMd,
  parseSkillSource,
  requiresApproval,
  slugify,
  toToolName,
  validateAppJson,
  validateArtifactHtml,
  validateFrontmatter,
  validateToolSpec,
} from "../src/index.js";

const SKILL = `---
name: weekly-report
description: Collect the week's numbers and write a one-page brief. Use when the user asks for a weekly report or summary.
metadata:
  version: 1.2.0
allowed-tools: db_query read_skill_file
---
# Weekly report

See [the template](templates/brief.md) and [examples](./examples/one.md#top).
Do not follow [web](https://example.com) or \`[code](not/a/link.md)\`.

\`\`\`
[fenced](ignored.md)
\`\`\`
`;

describe("SkillManifest", () => {
  it("parses frontmatter and body", () => {
    const p = parseSkillMd(SKILL);
    expect(p.frontmatter["name"]).toBe("weekly-report");
    expect(p.body.startsWith("# Weekly report")).toBe(true);
    expect(p.bodyStartLine).toBe(8);
  });

  it("builds a manifest with linked files", () => {
    const { manifest, issues } = buildManifest({
      dir: "/x/weekly-report",
      dirName: "weekly-report",
      skillMd: SKILL,
      files: ["SKILL.md", "templates/brief.md", "examples/one.md"],
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(manifest!.linkedFiles).toEqual(["templates/brief.md", "examples/one.md"]);
    expect(manifest!.frontmatter.allowedTools).toEqual(["db_query", "read_skill_file"]);
    expect(manifest!.frontmatter.metadata).toEqual({ version: "1.2.0" });
    expect(manifest!.permissions.net).toEqual([]);
  });

  it("rejects bad names and folder mismatch", () => {
    expect(validateFrontmatter({ name: "Bad_Name", description: "x" }).issues.map((i) => i.rule)).toContain("name-format");
    expect(validateFrontmatter({ name: "a--b", description: "x" }).issues.map((i) => i.rule)).toContain("name-format");
    expect(validateFrontmatter({ name: "-a", description: "x" }).issues.map((i) => i.rule)).toContain("name-format");
    expect(validateFrontmatter({ name: "ok", description: "x" }, "other").issues.map((i) => i.rule)).toContain("name-dir");
    expect(validateFrontmatter({ name: "ok" }).issues.map((i) => i.rule)).toContain("description-required");
    expect(validateFrontmatter({ name: "ok", description: "d".repeat(1025) }).issues.map((i) => i.rule)).toContain(
      "description-length",
    );
  });

  it("requires a reason for each network host", () => {
    const { issues, manifest } = buildManifest({
      dir: "",
      skillMd: "---\nname: a\ndescription: b\n---\n",
      permissionsJson: JSON.stringify({ permissions: { net: ["api.example.com"] } }),
      files: ["SKILL.md", "oneseat.json"],
    });
    expect(issues.map((i) => i.rule)).toContain("net-reason");
    expect(manifest!.permissions.net).toEqual(["api.example.com"]);
  });

  it("fails without frontmatter", () => {
    expect(buildManifest({ dir: "", skillMd: "# hi", files: [] }).issues[0]!.rule).toBe("parse");
  });

  it("extracts reference-style links", () => {
    expect(extractLinks("[a]: refs/a.md\n[b](b.md)")).toEqual(["b.md", "refs/a.md"]);
  });

  it("parses skill sources", () => {
    expect(parseSkillSource("anthropics/skills")).toEqual({ kind: "skills.sh", owner: "anthropics", repo: "skills" });
    expect(parseSkillSource("anthropics/skills@pdf")).toEqual({ kind: "skills.sh", owner: "anthropics", repo: "skills", skill: "pdf" });
    expect(parseSkillSource("https://github.com/o/r/tree/main/skills/x")).toEqual({
      kind: "github", owner: "o", repo: "r", ref: "main", path: "skills/x",
    });
    expect(parseSkillSource("./skills/customers")).toEqual({ kind: "local", path: "./skills/customers" });
    expect(parseSkillSource("/abs/path")).toEqual({ kind: "local", path: "/abs/path" });
  });
});

describe("ToolCall", () => {
  it("validates names across providers", () => {
    expect(validateToolSpec({ name: "db_query", description: "d", inputSchema: { type: "object" } })).toEqual([]);
    expect(validateToolSpec({ name: "1bad", description: "d", inputSchema: { type: "object" } })).toHaveLength(1);
    expect(toToolName("github.create-issue")).toBe("github_create-issue");
    expect(toToolName("9x")).toBe("_9x");
  });
  it("flags approval effects", () => {
    expect(requiresApproval(["read"])).toBe(false);
    expect(requiresApproval(["read", "send"])).toBe(true);
  });
});

describe("ArtifactBundle", () => {
  it("accepts a self-contained page", () => {
    const html = `<!doctype html><html><body><img src="data:image/png;base64,AA=="><script>oneseat.run("invoices", {})</script></body></html>`;
    expect(validateArtifactHtml(html).filter((i) => i.severity === "error")).toEqual([]);
    expect(findBridgeCalls(html)).toEqual(["invoices"]);
  });
  it("rejects remote resources", () => {
    const rules = validateArtifactHtml(`<html><script src="https://cdn.x/y.js"></script><style>@import url(//f.x/a.css)</style><iframe></iframe></html>`).map((i) => i.rule);
    expect(rules).toContain("remote-resource");
    expect(rules).toContain("remote-css");
    expect(rules).toContain("iframe");
  });
  it("allows remote <a> links with a warning", () => {
    const issues = validateArtifactHtml(`<html><a href="https://x.com">x</a></html>`);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });
  it("validates app.json", () => {
    expect(validateAppJson({ id: "invoice-app", name: "Invoices", version: "1.0.0", window: { width: 900, height: 700 }, allowedSkills: ["invoices"], icon: "🧾" })).toEqual([]);
    expect(validateAppJson({ id: "Bad Id", name: "", version: "x", window: { width: 1, height: 1 }, allowedSkills: [1] }).length).toBeGreaterThan(3);
    expect(slugify("Invoice App — Ünïcode!")).toBe("invoice-app-unicode");
  });
});

describe("Scripted provider", () => {
  it("plays turns and records requests", async () => {
    const p = createScriptedProvider([{ steps: [{ text: "hello world" }, { tool: "x", input: { a: 1 } }] }, { steps: [{ text: "done" }] }]);
    const req = { model: "m", system: "s", messages: [], tools: [], maxTokens: 100 };
    const r1 = await collect(p.send(req));
    expect(r1.stopReason).toBe("tool_use");
    expect(r1.message.content).toEqual([{ type: "text", text: "hello world" }, { type: "tool_use", id: "call_0_0", name: "x", input: { a: 1 } }]);
    const r2 = await collect(p.send(req));
    expect(r2.stopReason).toBe("end_turn");
    expect(p.requests).toHaveLength(2);
    const r3 = await collect(p.send(req));
    expect(r3.error?.message).toBe("script exhausted");
  });
});

import { BUSINESS_SCHEMA_SQL, touchesPrivateTable } from "../src/index.js";
import { DatabaseSync } from "node:sqlite";

describe("Business schema", () => {
  it("creates in SQLite and computes lifetime value", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(BUSINESS_SCHEMA_SQL);
    db.exec(BUSINESS_SCHEMA_SQL); // idempotent
    db.prepare("INSERT INTO customers (id, name) VALUES (?, ?)").run("c1", "Ada");
    db.prepare("INSERT INTO purchases (id, customer_id, product, amount_cents, purchased_at) VALUES (?,?,?,?,?)").run("p1", "c1", "Plan", 1200, "2026-01-01");
    db.prepare("INSERT INTO purchases (id, customer_id, product, amount_cents, purchased_at) VALUES (?,?,?,?,?)").run("p2", "c1", "Plan", 800, "2026-02-01");
    const row = db.prepare("SELECT ltv_cents, purchase_count FROM customer_ltv WHERE customer_id = 'c1'").get();
    expect(row).toEqual({ ltv_cents: 2000, purchase_count: 2 });
  });
  it("detects private tables", () => {
    expect(touchesPrivateTable("select * from _os_action_log")).toBe(true);
    expect(touchesPrivateTable("select * from customers")).toBe(false);
  });
});
