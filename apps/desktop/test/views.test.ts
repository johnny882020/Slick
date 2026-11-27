import { describe, expect, it } from "vitest";
import { featureRows, planSummary } from "../src/views/plan";
describe("plan view helpers", () => {
  it("summarises each plan in plain words", () => {
    expect(planSummary({ tier: "free", status: "none", features: [], computers: 1 })).toBe("Free: one computer and the seven starter skills.");
    expect(planSummary({ tier: "free", status: "none", features: [], computers: 1, reason: "the subscription was canceled" })).toBe("Free. The subscription was canceled.");
    const pro = planSummary({ tier: "pro", status: "active", features: ["pinned_apps"], computers: 3, email: "a@b.c", expiresAt: "2026-12-11T00:00:00.000Z" });
    expect(pro).toMatch(/^Pro, up to 3 computers, for a@b.c\. Works offline until /);
    expect(planSummary({ tier: "team", status: "past_due", features: [], computers: 15 })).toContain("Payment is past due");
  });
  it("lists every feature with whether the plan has it", () => {
    const rows = featureRows({ tier: "pro", status: "active", features: ["pinned_apps", "schedules"], computers: 3 });
    expect(rows.find((r) => r.feature === "pinned_apps")?.included).toBe(true);
    expect(rows.find((r) => r.feature === "priority_support")?.included).toBe(false);
    expect(rows).toHaveLength(5);
  });
});
