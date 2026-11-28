import type { HarnessEvent } from "@oneseat/contracts";
import { describe, expect, it } from "vitest";
import { bundleFromToolContent, bundlesFromText, makeDraft } from "../src/artifacts";
import { initialRun, isFinished, pendingApprovals, reduceRun, runText, type ToolItem } from "../src/run-state";

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

function play(events: HarnessEvent[], runId = "r1") {
  return events.reduce(reduceRun, initialRun(runId, "task"));
}

const bundle = {
  html: "<!doctype html><html><body><button onclick=\"oneseat.run('invoice-chaser','x')\">Go</button></body></html>",
  app: { id: "invoice-tracker", name: "Invoice tracker", version: "1.0.0", window: { width: 640, height: 480 }, allowedSkills: ["invoice-chaser"] },
};

describe("reduceRun", () => {
  it("builds a streamed run with skills, tools, text and usage", () => {
    const s = play([
      { type: "session_start", sessionId: "s1", runId: "r1" },
      { type: "skill_loaded", name: "weekly-report", reason: "router" },
      { type: "skill_loaded", name: "weekly-report", reason: "router" },
      { type: "skill_file_read", skill: "weekly-report", file: "SKILL.md" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", " },
      { type: "text_delta", text: "" },
      { type: "tool_start", call: { id: "c1", name: "db_query", input: { sql: "select 1" } }, effects: ["read"] },
      { type: "tool_end", result: { callId: "c1", name: "db_query", content: "[]", isError: false }, durationMs: 9 },
      { type: "text_delta", text: "world" },
      { type: "turn_end", turn: 1, usage: usage(10, 5) },
      { type: "turn_end", turn: 2, usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7 } },
    ]);
    expect(s.sessionId).toBe("s1");
    expect(s.skills).toEqual([{ name: "weekly-report", reason: "router" }]);
    expect(s.filesRead).toEqual([{ skill: "weekly-report", file: "SKILL.md" }]);
    expect(s.items.map((i) => i.kind)).toEqual(["text", "tool", "text"]);
    expect(runText(s)).toBe("Hello, world");
    const tool = s.items[1] as ToolItem;
    expect(tool).toMatchObject({ status: "ok", result: "[]", durationMs: 9, effects: ["read"] });
    expect(s.usage).toEqual({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 7 });
    expect(s.turns).toBe(2);
    expect(s.status).toBe("running");
    expect(new Set(s.items.map((i) => i.key)).size).toBe(3);

    const done = reduceRun(s, { type: "done", stopReason: "end_turn", text: "Hello, world", usage: usage(20, 9) });
    expect(done.status).toBe("done");
    expect(done.usage).toEqual(usage(20, 9));
    expect(isFinished(done)).toBe(true);
    // done with zero usage keeps the summed usage
    expect(reduceRun(s, { type: "done", stopReason: "end_turn", text: "", usage: usage(0, 0) }).usage.inputTokens).toBe(13);
  });

  it("tracks approvals: waiting, approved, denied", () => {
    const call = { id: "c9", name: "email_send", input: { to: "a@b.c" } };
    let s = play([
      { type: "approval_request", approvalId: "a1", call, effects: ["send"], summary: "Send it" },
      { type: "approval_request", approvalId: "a1", call, effects: ["send"], summary: "Send it" },
    ]);
    expect(s.status).toBe("waiting");
    expect(pendingApprovals(s)).toHaveLength(1);
    s = reduceRun(s, { type: "approval_result", approvalId: "a1", approved: true });
    expect(s.status).toBe("running");
    expect(s.items[0]).toMatchObject({ kind: "approval", status: "approved" });
    s = reduceRun(s, { type: "approval_request", approvalId: "a2", call, effects: ["send"], summary: "Again" });
    s = reduceRun(s, { type: "approval_result", approvalId: "a2", approved: false });
    expect(s.items[1]).toMatchObject({ status: "denied" });
    expect(pendingApprovals(s)).toHaveLength(0);
  });

  it("closes open approvals when the run ends, and handles cancel and errors", () => {
    const call = { id: "c9", name: "pay", input: {} };
    const s = play([
      { type: "approval_request", approvalId: "a1", call, effects: ["pay"], summary: "Pay" },
      { type: "done", stopReason: "cancelled", text: "", usage: usage(0, 0) },
    ]);
    expect(s.status).toBe("cancelled");
    expect(pendingApprovals(s)).toHaveLength(0);
    // A late approval request after the end does not reopen the run.
    expect(reduceRun(s, { type: "approval_request", approvalId: "a3", call, effects: ["pay"], summary: "x" }).status).toBe("cancelled");

    const e = play([{ type: "error", message: "overloaded", retryable: true }]);
    expect(e.status).toBe("error");
    expect(e.error).toBe("overloaded");
    expect(e.items[0]).toMatchObject({ kind: "error", retryable: true });
  });

  it("marks failed tools and shows an end without a start", () => {
    const s = play([
      { type: "tool_start", call: { id: "c1", name: "fetch", input: {} }, effects: ["network"] },
      { type: "tool_end", result: { callId: "c1", name: "fetch", content: "boom", isError: true }, durationMs: 3 },
      { type: "tool_end", result: { callId: "zz", name: "orphan", content: "ok", isError: false }, durationMs: 1 },
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ status: "error", result: "boom" });
    expect(s.items[1]).toMatchObject({ name: "orphan", status: "ok" });
  });

  it("collects artifact drafts from tool results and fenced blocks, once each", () => {
    const content = JSON.stringify(bundle);
    let s = play([
      { type: "tool_start", call: { id: "a", name: "artifact_create", input: {} }, effects: ["write"] },
      { type: "tool_end", result: { callId: "a", name: "artifact_create", content, isError: false }, durationMs: 1 },
      { type: "tool_end", result: { callId: "a", name: "artifact_create", content, isError: false }, durationMs: 1 },
    ]);
    expect(s.artifacts).toHaveLength(1);
    expect(s.artifacts[0]).toMatchObject({ key: "r1:invoice-tracker", pinnable: true });
    const other = { ...bundle, app: { ...bundle.app, id: "second-app" } };
    s = reduceRun(s, { type: "done", stopReason: "end_turn", text: "Here:\n```oneseat-artifact\n" + JSON.stringify(other) + "\n```", usage: usage(1, 1) });
    expect(s.artifacts.map((a) => a.bundle.app.id)).toEqual(["invoice-tracker", "second-app"]);
    // Failed tool results never produce drafts.
    const f = play([{ type: "tool_end", result: { callId: "a", name: "artifact_create", content, isError: true }, durationMs: 1 }]);
    expect(f.artifacts).toHaveLength(0);
  });

  it("ignores unknown events", () => {
    const s = initialRun("x");
    expect(reduceRun(s, { type: "mystery" } as unknown as HarnessEvent)).toBe(s);
  });
});

describe("artifacts", () => {
  it("recognises bundles, wrapped bundles and rejects others", () => {
    expect(bundleFromToolContent(JSON.stringify(bundle))?.app.id).toBe("invoice-tracker");
    expect(bundleFromToolContent(JSON.stringify({ artifact: bundle }))?.app.id).toBe("invoice-tracker");
    expect(bundleFromToolContent(JSON.stringify({ bundle }))?.app.id).toBe("invoice-tracker");
    expect(bundleFromToolContent('{"html": 1}')).toBeNull();
    expect(bundleFromToolContent('{"html":"x","app":{}}')).toBeNull();
    expect(bundleFromToolContent("plain text")).toBeNull();
    expect(bundleFromToolContent('{"html": broken')).toBeNull();
    expect(bundlesFromText("```oneseat-artifact\nnot json\n```")).toEqual([]);
  });

  it("flags bundles that cannot be pinned", () => {
    const bad = makeDraft("r", { html: '<html><script src="https://evil.example/x.js"></script></html>', app: { ...bundle.app, id: "Bad Id" } });
    expect(bad.pinnable).toBe(false);
    expect(bad.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["app-id", "remote-resource"]));
  });
});
