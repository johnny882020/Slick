import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BUSINESS_SCHEMA_SQL } from "@oneseat/contracts";
// @ts-expect-error plain .mjs script, no types
import { providersFromEnv, renderMarkdown, SCENARIOS, SEED_SQL } from "../scripts/live-qa.mjs";

describe("live QA script", () => {
  it("seeds data that fits the business schema, with the numbers the checks expect", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BUSINESS_SCHEMA_SQL);
    db.exec(SEED_SQL);
    const top = db.prepare("SELECT name, ltv_cents FROM customer_ltv ORDER BY ltv_cents DESC LIMIT 2").all();
    expect(top).toEqual([{ name: "Ada Lovelace", ltv_cents: 300000 }, { name: "Cara Diaz", ltv_cents: 240000 }]);
    const lastWeek = db.prepare("SELECT SUM(amount_cents) AS c FROM purchases WHERE purchased_at BETWEEN '2026-11-16' AND '2026-11-22'").get();
    expect(lastWeek).toEqual({ c: 249900 });
    // Invoice: 3 x $150 = $450.00, 8.25% tax = $37.125 -> $37.13 (half up), total $487.13.
    expect(Math.round(45000 * 0.0825) + 45000).toBe(48713);
  });

  it("covers every starter skill and the safety paths", () => {
    const skills = new Set(SCENARIOS.map((s: { skill: string }) => s.skill));
    for (const s of ["brand-kit", "customers", "outreach", "proposals-invoices", "social-posts", "support-inbox", "weekly-report"]) expect(skills.has(s)).toBe(true);
    const ids = SCENARIOS.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("delete-needs-approval");
  });

  it("picks providers that have keys and renders a report", () => {
    expect(providersFromEnv({ ONESEAT_QA_PROVIDERS: "anthropic:m1,openai:m2,google:,bogus:x", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "" })).toEqual([{ provider: "anthropic", model: "m1", key: "k" }]);
    const md = renderMarkdown([
      { provider: "anthropic", scenario: "a", pass: true, problems: [], seconds: 3, usage: { inputTokens: 1, outputTokens: 2 } },
      { provider: "anthropic", scenario: "b", pass: false, problems: ["x | y"], seconds: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(md).toContain("Live QA: 1/2 passed");
    expect(md).toContain("x / y");
  });
});
