import { describe, expect, it } from "vitest";
import { featureRows, planSummary, trialActiveTitle, trialErrorText } from "../src/views/plan";
import { ShellError } from "../src/transport";
describe("plan view helpers", () => {
  it("explains why a trial could not start, in plain words", () => {
    const err = (code: string, message = "x") => new ShellError(message, -32002, { code });
    expect(trialErrorText(err("trial_used"))).toMatch(/already had its free Team trial.*choose a plan at oneseat-cloud\.onrender\.com.*license key from someone on your team/);
    expect(trialErrorText(err("bad_email"))).toBe("Enter your email address, like name@company.com.");
    expect(trialErrorText(err("rate_limited"))).toMatch(/Wait a minute/);
    expect(trialErrorText(err("network"))).toMatch(/Check the internet connection/);
    expect(trialErrorText(err("has_license", "this computer already has OneSeat Pro"))).toBe("Could not start the trial: this computer already has OneSeat Pro");
    expect(trialErrorText(new Error("boom"))).toBe("Could not start the trial: boom");
  });
  it("titles an active trial with its end date", () => {
    expect(trialActiveTitle("2026-12-12T10:00:00.000Z")).toMatch(/^Team trial active until .*2026/);
    expect(trialActiveTitle(undefined)).toBe("Team trial active");
    expect(trialActiveTitle("nope")).toBe("Team trial active");
  });
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
