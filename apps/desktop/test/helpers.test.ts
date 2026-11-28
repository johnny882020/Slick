import { describe, expect, it } from "vitest";
import { cronError, CRON_PRESETS, describeCron } from "../src/cron";
import {
  describeSource,
  effectLabel,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  formatUsage,
  previewJson,
  providerLabel,
  truncate,
} from "../src/format";
import { daemonBanner, parseRoute } from "../src/app";
import { approvalLabel } from "../src/views/activity";
import { describeInput, describePermissions, installPolicy, VERDICT_LABEL } from "../src/views/skills";
import { defaultModel } from "../src/views/run";
import { newScheduleId } from "../src/views/schedules";
import { keyStatusRows } from "../src/views/setup";
import type { ScanReport } from "@oneseat/contracts";

describe("cron", () => {
  it("validates", () => {
    for (const ok of ["* * * * *", "0 9 * * 1-5", "*/15 * * * *", "0 9 1 * *", "0 9 * jan mon", "0,30 8-18/2 * * 1,3,5", "0 0 * * 7"])
      expect(cronError(ok), ok).toBeNull();
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "* * * foo *"])
      expect(cronError(bad), bad).not.toBeNull();
    for (const p of CRON_PRESETS) expect(cronError(p.cron)).toBeNull();
  });

  it("describes common schedules", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("30 * * * *")).toBe("Every hour at minute 30");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(describeCron("0 10 * * 0,6")).toBe("Every weekend day at 10:00");
    expect(describeCron("5 8 * * 1")).toBe("Every Monday at 08:05");
    expect(describeCron("0 8 * * 1,3")).toBe("Every Monday, Wednesday at 08:00");
    expect(describeCron("0 8 * * 7")).toBe("Every Sunday at 08:00");
    expect(describeCron("0 9 1 * *")).toBe("On day 1 of every month at 09:00");
    expect(describeCron("0 9 1 6 *")).toBe("Cron: 0 9 1 6 *");
    expect(describeCron("0 9-17 * * *")).toBe("Cron: 0 9-17 * * *");
    expect(describeCron("nope")).toBe("nope");
  });
});

describe("format", () => {
  it("formats numbers, durations, sizes and usage", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatTokens(-4)).toBe("0");
    expect(formatUsage({ inputTokens: 1830, outputTokens: 240 })).toBe("1,830 in · 240 out tokens");
    expect(formatUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })).toBe("1 in · 2 out · 3 cached tokens");
    expect(formatDuration(14)).toBe("14 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(-1)).toBe("");
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("formats labels and text", () => {
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("google")).toBe("Gemini");
    expect(providerLabel("x")).toBe("x");
    expect(effectLabel("send")).toBe("sends a message");
    expect(effectLabel("pay")).toBe("makes a payment");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(previewJson({ a: "x".repeat(300) }, 20)).toHaveLength(20);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(previewJson(circular)).toBe("[object Object]");
    expect(describeSource({ kind: "local", path: "/s/x" })).toBe("Folder /s/x");
    expect(describeSource({ kind: "github", owner: "o", repo: "r", ref: "main", path: "skills/a" })).toBe("GitHub o/r/skills/a @ main");
    expect(describeSource({ kind: "skills.sh", owner: "o", repo: "r", skill: "s" })).toBe("skills.sh o/r@s");
  });

  it("formats times relative to today", () => {
    const now = new Date("2026-11-27T12:00:00");
    expect(formatTime(undefined)).toBe("");
    expect(formatTime("garbage")).toBe("garbage");
    expect(formatTime("2026-11-27T09:05:00", now)).toMatch(/09:05|9:05/);
    expect(formatTime("2026-10-01T09:05:00", now)).toMatch(/Oct/);
  });
});

describe("view helpers", () => {
  const scan = (verdict: ScanReport["verdict"]): ScanReport => ({
    skill: "x",
    verdict,
    summary: "s",
    findings: [],
    declared: { net: [], read: [], write: [], env: [], run: [] },
    observed: { net: [], read: [], write: [], env: [], run: [] },
    filesRead: 0,
    bytesRead: 0,
  });

  it("install policy follows the verdict", () => {
    expect(installPolicy(scan("pass"))).toEqual({ allowed: true, needsConfirm: false });
    expect(installPolicy(scan("warn"))).toEqual({ allowed: true, needsConfirm: true });
    expect(installPolicy(scan("block"))).toMatchObject({ allowed: false });
    expect(VERDICT_LABEL.block).toMatch(/Blocked/);
  });

  it("describes permissions and inputs", () => {
    expect(describePermissions({ net: ["api.x.com"], read: ["a"], write: ["b"], env: ["E"], run: ["git"] })).toEqual([
      "Internet: api.x.com",
      "Reads files: a",
      "Writes files: b",
      "Settings it reads: E",
      "Programs it starts: git",
    ]);
    expect(describeInput("")).toBe("");
    expect(describeInput("owner/repo")).toBe("From skills.sh owner/repo");
    expect(describeInput("https://github.com/o/r")).toBe("From GitHub o/r");
    expect(describeInput("/home/me/skills/x")).toBe("A folder on this computer: /home/me/skills/x");
  });

  it("misc", () => {
    expect(approvalLabel(null)).toBe("Not needed");
    expect(approvalLabel(true)).toBe("Approved");
    expect(approvalLabel(false)).toBe("Denied");
    expect(defaultModel([{ id: "a", tier: "fast" }, { id: "b", tier: "frontier" }])).toBe("b");
    expect(defaultModel([{ id: "a" }])).toBe("a");
    expect(defaultModel([])).toBeUndefined();
    expect(newScheduleId(() => 0.5)).toMatch(/^sch-[a-z0-9]+-[a-z0-9]+$/);
    expect(parseRoute("#/skills")).toBe("skills");
    expect(parseRoute("#/apps?x=1")).toBe("apps");
    expect(parseRoute("#/nope")).toBeNull();
    expect(parseRoute("")).toBeNull();
    expect(daemonBanner(null)).toBeNull();
    const st = { restarts: 1, pid: null, version: null, description: "d" };
    expect(daemonBanner({ ...st, state: "running", lastError: null })).toBeNull();
    expect(daemonBanner({ ...st, state: "restarting", lastError: "daemon exited (3)" })).toMatch(/restarting \(daemon exited/);
    expect(daemonBanner({ ...st, state: "failed", lastError: "x" })).toMatch(/could not start: x/);
    expect(daemonBanner({ ...st, state: "starting", lastError: null })).toMatch(/Starting/);
    expect(daemonBanner({ ...st, state: "stopped", lastError: null })).toMatch(/stopped/);
    expect(
      keyStatusRows({
        keychain: { available: true, message: null },
        daemon: null,
        providers: [
          { provider: "anthropic", stored: true, active: true, baseUrl: null },
          { provider: "openai", stored: true, active: null, baseUrl: null },
          { provider: "google", stored: false, active: false, baseUrl: null },
        ],
      }).map((r) => [r.label, r.engine]),
    ).toEqual([
      ["Claude", "Ready"],
      ["OpenAI", "Unknown"],
      ["Gemini", "Not loaded"],
    ]);
    expect(keyStatusRows(null)).toEqual([]);
  });
});
