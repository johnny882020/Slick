import { describe, expect, it } from "vitest";
import { Store, type Change } from "../src/store";

const call = { id: "c", name: "email_send", input: {} };

describe("Store", () => {
  it("applies events before and after startRun, and tracks approvals across runs", () => {
    const s = new Store();
    const changes: Change["type"][] = [];
    s.subscribe((c) => changes.push(c.type));
    // An event can arrive before harness.run returns.
    s.handleNotification({ method: "harness.event", params: { runId: "r1", event: { type: "skill_loaded", name: "x", reason: "router" } } });
    s.startRun("r1", "do it");
    expect(s.runs.get("r1")?.input).toBe("do it");
    expect(s.runs.get("r1")?.skills).toHaveLength(1);
    expect(s.currentRunId).toBe("r1");
    // A background run (schedule / pinned app) asks for approval too.
    s.applyEvent("bg", { type: "approval_request", approvalId: "a-bg", call, effects: ["send"], summary: "bg" });
    s.applyEvent("r1", { type: "approval_request", approvalId: "a-1", call, effects: ["send"], summary: "fg" });
    expect(s.pendingApprovals().map((a) => [a.runId, a.approvalId])).toEqual([
      ["r1", "a-1"],
      ["bg", "a-bg"],
    ]);
    s.markDecided("a-1", true);
    expect(s.pendingApprovals().map((a) => a.approvalId)).toEqual(["a-bg"]);
    s.undoDecided("a-1");
    expect(s.pendingApprovals()).toHaveLength(2);
    s.applyEvent("r1", { type: "approval_result", approvalId: "a-1", approved: true });
    expect(s.decided.has("a-1")).toBe(false);
    expect(s.pendingApprovals().map((a) => a.approvalId)).toEqual(["a-bg"]);
    expect(changes).toContain("approvals");
  });

  it("lists drafts until pinned and forwards schedule.fired", () => {
    const s = new Store();
    const fired: Change[] = [];
    s.subscribe((c) => c.type === "schedule.fired" && fired.push(c));
    const bundle = {
      html: "<html></html>",
      app: { id: "t", name: "T", version: "1.0.0", window: { width: 300, height: 300 }, allowedSkills: [] },
    };
    s.applyEvent("r", { type: "tool_end", result: { callId: "x", name: "artifact_create", content: JSON.stringify(bundle), isError: false }, durationMs: 1 });
    expect(s.drafts().map((d) => d.key)).toEqual(["r:t"]);
    s.markPinned("r:t");
    expect(s.drafts()).toEqual([]);
    s.handleNotification({ method: "schedule.fired", params: { scheduleId: "s1", runId: "r9" } });
    expect(fired).toEqual([{ type: "schedule.fired", scheduleId: "s1", runId: "r9" }]);
  });

  it("knows which providers are ready and keeps a bounded run history", () => {
    const s = new Store();
    expect(s.hasAnyKey()).toBe(false);
    s.setKeyStatus({
      keychain: { available: true, message: null },
      providers: [
        { provider: "anthropic", stored: true, active: true, baseUrl: null },
        { provider: "openai", stored: false, active: false, baseUrl: null },
      ],
      daemon: { state: "running", restarts: 0, pid: 1, version: "v", lastError: null, description: "d" },
    });
    expect(s.readyProviders()).toEqual(["anthropic"]);
    expect(s.daemon?.state).toBe("running");
    s.setDaemon({ state: "restarting", restarts: 1, pid: null, version: null, lastError: "x", description: "d" });
    expect(s.daemon?.state).toBe("restarting");
    for (let i = 0; i < 60; i++) s.applyEvent(`r${i}`, { type: "text_delta", text: "x" });
    expect(s.runs.size).toBe(50);
    // A throwing subscriber does not break others.
    let ok = false;
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe(() => (ok = true));
    const err = console.error;
    console.error = () => {};
    s.emit({ type: "keys" });
    console.error = err;
    expect(ok).toBe(true);
  });
});
