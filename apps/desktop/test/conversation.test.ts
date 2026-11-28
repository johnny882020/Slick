// Questions mid-run, replies in the same session, and "Turn into app".
import type { HarnessEvent } from "@oneseat/contracts";
import { describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import { makeDraft } from "../src/artifacts";
import type { KeyStatus } from "../src/protocol";
import { createConversation, createRunOutput } from "../src/render-run";
import { canMakeApp, canReply, initialRun, pendingQuestions, reduceRun, resultText, type QuestionItem, type RunState } from "../src/run-state";
import { Store } from "../src/store";
import type { Transport } from "../src/transport";
import { followUpRequest, TURN_INTO_APP_INPUT } from "../src/views/run";

const usage = { inputTokens: 1, outputTokens: 1 };
const play = (events: HarnessEvent[], run: RunState = initialRun("r1", "task")) => events.reduce(reduceRun, run);
const question = (id = "q1", options?: string[]): HarnessEvent => ({ type: "question", questionId: id, question: "Which month?", ...(options ? { options } : {}) });
const tick = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => setTimeout(r, 30));
const buttonNamed = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

describe("run state: questions", () => {
  it("shows a question as a card item, not an ask_user tool row, and tracks the answer", () => {
    let s = play([
      { type: "session_start", sessionId: "s1", runId: "r1" },
      { type: "tool_start", call: { id: "c1", name: "ask_user", input: { question: "Which month?" } }, effects: [] },
      question("q1", ["March", "April"]),
      question("q1", ["March", "April"]),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["question"]);
    expect(s.status).toBe("asking");
    expect(pendingQuestions(s)).toHaveLength(1);
    s = play(
      [
        { type: "question_answered", questionId: "q1", answer: " April " },
        { type: "tool_end", result: { callId: "c1", name: "ask_user", content: "April", isError: false }, durationMs: 3 },
      ],
      s,
    );
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "question", status: "answered", answer: "April", options: ["March", "April"] });
    expect(s.status).toBe("running");
    s = play([question("q2"), { type: "question_answered", questionId: "q2", answer: "" }], s);
    expect((s.items[1] as QuestionItem).status).toBe("skipped");
    expect((s.items[1] as QuestionItem).options).toEqual([]);
  });

  it("an approval wins over a question for the status, and done closes what is still pending", () => {
    const call = { id: "c", name: "email_send", input: {} };
    let s = play([question("q1"), { type: "approval_request", approvalId: "a1", call, effects: ["send"], summary: "Send" }]);
    expect(s.status).toBe("waiting");
    s = reduceRun(s, { type: "approval_result", approvalId: "a1", approved: true });
    expect(s.status).toBe("asking");
    s = reduceRun(s, { type: "done", stopReason: "cancelled", text: "", usage });
    expect((s.items[0] as QuestionItem).status).toBe("closed");
    expect(reduceRun(s, question("q9")).status).toBe("cancelled");
  });

  it("says when a run can be replied to or turned into an app", () => {
    const started = play([{ type: "session_start", sessionId: "s1", runId: "r1" }, { type: "text_delta", text: "Partial" }]);
    expect(canReply(started)).toBe(false);
    const done = reduceRun(started, { type: "done", stopReason: "end_turn", text: "The result.", usage });
    expect(canReply(done)).toBe(true);
    expect(canMakeApp(done)).toBe(true);
    expect(resultText(done)).toBe("The result.");
    expect(resultText({ ...done, finalText: "" })).toBe("Partial");
    // Cancelled with output: can continue; with nothing: cannot.
    expect(canReply(reduceRun(started, { type: "done", stopReason: "cancelled", text: "", usage }))).toBe(true);
    const empty = play([{ type: "session_start", sessionId: "s2", runId: "r2" }, { type: "error", message: "bad", retryable: false }], initialRun("r2"));
    expect(canReply(empty)).toBe(false);
    expect(canReply(reduceRun(initialRun("r3"), { type: "done", stopReason: "end_turn", text: "x", usage }))).toBe(false); // no session
    // A run that already made an app does not offer it again; nor does an empty result.
    const bundle = { html: "<html></html>", app: { id: "a", name: "A", version: "1.0.0", window: { width: 300, height: 300 }, allowedSkills: [] } };
    expect(canMakeApp({ ...done, artifacts: [makeDraft("r1", bundle)] })).toBe(false);
    expect(canMakeApp(reduceRun(play([{ type: "session_start", sessionId: "s", runId: "r1" }]), { type: "done", stopReason: "end_turn", text: " ", usage }))).toBe(false);
  });
});

describe("store: conversations", () => {
  it("chains replies into a conversation and lists one row per conversation", () => {
    const s = new Store();
    s.applyEvent("r2", { type: "text_delta", text: "early" });
    s.startRun("r1", "first", { provider: "anthropic", model: "m" });
    s.startRun("r2", "second", { provider: "anthropic", model: "m", followsRunId: "r1" });
    s.startRun("r3", "third", { followsRunId: "r2" });
    s.startRun("x1", "other");
    expect(s.runs.get("r2")).toMatchObject({ input: "second", provider: "anthropic", followsRunId: "r1" });
    expect(s.runs.get("r2")!.items).toHaveLength(1);
    expect(s.conversation("r3").map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    expect(s.conversation("r1").map((r) => r.runId)).toEqual(["r1"]);
    expect(s.conversation("missing")).toEqual([]);
    expect(s.conversationTips().map((r) => r.runId)).toEqual(["r3", "x1"]);
    // A cycle never loops.
    s.runs.set("r1", { ...s.runs.get("r1")!, followsRunId: "r3" });
    expect(s.conversation("r3")).toHaveLength(3);
  });
});

describe("question card", () => {
  function card(options?: string[], onAnswer = vi.fn(async () => true)) {
    const out = createRunOutput({ onReview: () => {}, onPin: () => {}, isPinned: () => false, onAnswer });
    document.body.replaceChildren(out.el);
    let s = play([question("q1", options)]);
    out.update(s);
    const el = out.el.querySelector('[data-question="q1"]') as HTMLElement;
    return { out, el, onAnswer, set: (ev: HarnessEvent) => out.update((s = reduceRun(s, ev))) };
  }

  it("answers with an option button, then shows the answer as sent", async () => {
    const { el, onAnswer, set } = card(["March", "April"]);
    expect(el.textContent).toContain("OneSeat asks");
    expect(el.querySelector(".question-text")?.textContent).toBe("Which month?");
    expect(el.getAttribute("role")).toBe("group");
    expect(el.querySelector(".question-text")?.getAttribute("dir")).toBe("auto");
    await tick();
    expect(document.activeElement).toBe(el);
    expect(el.closest(".run-output")?.querySelector(".run-status")?.textContent).toBe("Waiting for your answer");
    buttonNamed(el, "April")!.click();
    await tick();
    expect(onAnswer).toHaveBeenCalledWith("q1", "April");
    expect(el.dataset["status"]).toBe("answered");
    expect(el.querySelector(".question-state")?.textContent).toBe("You answered: April");
    expect((el.querySelector("form") as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(el);
    set({ type: "question_answered", questionId: "q1", answer: "April" });
    expect(el.querySelector(".question-state")?.textContent).toBe("You answered: April");
  });

  it("sends a typed answer, refuses an empty one, and can skip", async () => {
    const { el, onAnswer } = card();
    expect((el.querySelector(".question-options") as HTMLElement).hidden).toBe(true);
    const area = el.querySelector('textarea[name="answer"]') as HTMLTextAreaElement;
    expect(area.getAttribute("dir")).toBe("auto");
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("Type an answer");
    expect(onAnswer).not.toHaveBeenCalled();
    area.value = "  The whole quarter ";
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await tick();
    expect(onAnswer).toHaveBeenCalledWith("q1", "The whole quarter");

    const second = card();
    buttonNamed(second.el, "Skip")!.click();
    await tick();
    expect(second.onAnswer).toHaveBeenCalledWith("q1", "");
    expect(second.el.dataset["status"]).toBe("skipped");
    expect(second.el.textContent).toContain("You skipped this question.");
  });

  it("explains when the answer did not go through, and when the run ended first", async () => {
    const stale = card(["A"], vi.fn(async () => false));
    buttonNamed(stale.el, "A")!.click();
    await tick();
    expect(stale.el.querySelector('[role="alert"]')?.textContent).toBe("This question is no longer waiting for an answer.");
    expect(stale.el.dataset["status"]).toBe("pending");

    const failing = card(["A"], vi.fn(async () => Promise.reject(new Error("engine is restarting"))));
    buttonNamed(failing.el, "A")!.click();
    await tick();
    expect(failing.el.querySelector('[role="alert"]')?.textContent).toBe("Could not send your answer: engine is restarting");
    failing.set({ type: "done", stopReason: "cancelled", text: "", usage });
    expect(failing.el.dataset["status"]).toBe("closed");
    expect(failing.el.textContent).toContain("The run ended before this was answered.");

    const noHandler = createRunOutput({ onReview: () => {}, onPin: () => {}, isPinned: () => false });
    noHandler.update(play([question("q1", ["A"])]));
    buttonNamed(noHandler.el, "A")!.click();
    await tick();
    expect(noHandler.el.querySelector('[role="alert"]')?.textContent).toContain("no longer waiting");
  });
});

describe("conversation view", () => {
  it("renders each turn with the person's message, and starts over for another conversation", () => {
    const footer = document.createElement("form");
    const conv = createConversation({ onReview: () => {}, onPin: () => {}, isPinned: () => false }, footer);
    const a = reduceRun(initialRun("a", "First task"), { type: "text_delta", text: "Answer A" });
    const b = reduceRun({ ...initialRun("b", "A reply"), followsRunId: "a" }, { type: "text_delta", text: "Answer B" });
    conv.update([a]);
    const firstOutput = conv.el.querySelector(".run-output");
    conv.update([a, b]);
    expect(conv.el.querySelectorAll(".run-output")).toHaveLength(2);
    expect(conv.el.querySelector(".run-output")).toBe(firstOutput);
    expect([...conv.el.querySelectorAll(".turn-text")].map((t) => t.textContent)).toEqual(["First task", "A reply"]);
    expect(conv.el.dataset["turns"]).toBe("2");
    expect(conv.el.lastElementChild).toBe(footer);
    conv.update([reduceRun(initialRun("c"), { type: "text_delta", text: "C" })]);
    expect(conv.el.querySelectorAll(".run-output")).toHaveLength(1);
    expect((conv.el.querySelector(".turn-you") as HTMLElement).hidden).toBe(true);
    expect(conv.el.textContent).not.toContain("Answer A");
    conv.update([]);
    expect(conv.el.hidden).toBe(true);
  });

  it("builds follow-up requests in the same session with the same model", () => {
    const tip = { ...initialRun("r1", "x"), sessionId: "ses_1", provider: "openai", model: "gpt-5" };
    expect(followUpRequest(tip, "more", { provider: "anthropic", model: "claude-opus-5-5" })).toEqual({
      input: "more",
      provider: "openai",
      model: "gpt-5",
      sessionId: "ses_1",
      origin: { kind: "main" },
    });
    const bg = { ...initialRun("r2"), sessionId: "ses_2" };
    expect(followUpRequest(bg, "go", { provider: "anthropic", model: "m" }, "brand-kit")).toMatchObject({ provider: "anthropic", model: "m", skill: "brand-kit" });
    expect(followUpRequest(initialRun("r3"), "go", { provider: "anthropic", model: "m" })).toBeNull();
    expect(followUpRequest(bg, "go", { provider: "", model: "" })).toBeNull();
  });
});

/** In-memory shell for the run view: harness.run returns run-1, run-2, ...; events are pushed by the test. */
function memoryShell(skills: string[] = ["weekly-report", "brand-kit"]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  let runs = 0;
  const status: KeyStatus = {
    keychain: { available: true, message: null },
    providers: [{ provider: "anthropic", stored: true, active: true, baseUrl: null }],
    daemon: { state: "running", restarts: 0, pid: 1, version: "t", lastError: null, description: "memory" },
  };
  const daemon: Record<string, (p: Record<string, unknown>) => unknown> = {
    "models.list": () => ({ models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "frontier" }] }),
    "skills.list": () => ({ skills: skills.map((name) => ({ manifest: { frontmatter: { name } } })) }),
    "harness.run": () => ({ runId: `run-${++runs}` }),
    "harness.answer": () => ({ ok: true }),
  };
  const transport: Transport = {
    kind: "memory",
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      if (cmd === "key_status") return status as T;
      if (cmd === "daemon_call") {
        const method = args!["method"] as string;
        const params = (args!["params"] ?? {}) as Record<string, unknown>;
        calls.push({ method, params });
        const fn = daemon[method];
        if (!fn) throw { code: -32601, message: "not found" };
        return fn(params) as T;
      }
      return null as T;
    },
    async listen<T>(event: string, handler: (p: T) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler as (p: unknown) => void]);
      return () => {};
    },
    close() {},
  };
  const event = (runId: string, ev: HarnessEvent) =>
    (listeners.get("daemon://notification") ?? []).forEach((h) => h({ method: "harness.event", params: { runId, event: ev } }));
  return { transport, calls, event };
}

describe("run view: answer, reply, turn into app", () => {
  async function open(skills?: string[]) {
    location.hash = "#/run";
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const shell = memoryShell(skills);
    const { store } = await startApp(root, shell.transport);
    await frame();
    const task = root.querySelector('textarea[name="task"]') as HTMLTextAreaElement;
    task.value = "Write the monthly report";
    (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await frame();
    return { root, shell, store };
  }

  it("answers a question with harness.answer and replies in the same session", async () => {
    const { root, shell, store } = await open();
    expect(shell.calls.find((c) => c.method === "harness.run")!.params).toMatchObject({ input: "Write the monthly report", provider: "anthropic", model: "claude-opus-5-5" });
    shell.event("run-1", { type: "session_start", sessionId: "ses_a", runId: "run-1" });
    shell.event("run-1", question("q1", ["October", "November"]));
    await frame();
    const card = root.querySelector('[data-question="q1"]') as HTMLElement;
    expect(card).toBeTruthy();
    const followUps = root.querySelector("form.followups") as HTMLFormElement;
    expect(followUps.hidden).toBe(true);
    buttonNamed(card, "November")!.click();
    await tick();
    expect(shell.calls.find((c) => c.method === "harness.answer")!.params).toEqual({ questionId: "q1", answer: "November" });
    shell.event("run-1", { type: "question_answered", questionId: "q1", answer: "November" });
    shell.event("run-1", { type: "text_delta", text: "November report. Send it to the team?" });
    shell.event("run-1", { type: "done", stopReason: "end_turn", text: "November report. Send it to the team?", usage });
    await frame();
    expect(followUps.hidden).toBe(false);
    expect(buttonNamed(followUps, "Turn into app")!.hidden).toBe(false);

    // Empty reply is refused.
    followUps.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(followUps.textContent).toContain("Type a reply first.");
    const reply = root.querySelector('textarea[name="reply"]') as HTMLTextAreaElement;
    expect(reply.getAttribute("dir")).toBe("auto");
    reply.value = "Yes, send it";
    buttonNamed(followUps, "Reply")!.click();
    await frame();
    const runs = shell.calls.filter((c) => c.method === "harness.run");
    expect(runs[1]!.params).toEqual({ input: "Yes, send it", provider: "anthropic", model: "claude-opus-5-5", sessionId: "ses_a", origin: { kind: "main" } });
    expect(store.currentRunId).toBe("run-2");
    expect(reply.value).toBe("");
    expect(followUps.hidden).toBe(true);
    shell.event("run-2", { type: "session_start", sessionId: "ses_a", runId: "run-2" });
    shell.event("run-2", { type: "text_delta", text: "Sent." });
    shell.event("run-2", { type: "done", stopReason: "end_turn", text: "Sent.", usage });
    await frame();
    expect([...root.querySelectorAll(".turn-text")].map((t) => t.textContent)).toEqual(["Write the monthly report", "Yes, send it"]);
    expect(root.querySelectorAll(".conversation .run-output")).toHaveLength(2);

    // New task clears the conversation and focuses the task box.
    buttonNamed(followUps, "New task")!.click();
    await frame();
    expect((root.querySelector(".conversation") as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('textarea[name="task"]'));
  });

  it("Turn into app continues the session forcing brand-kit, or lets OneSeat choose without it", async () => {
    for (const [skills, forced] of [
      [["weekly-report", "brand-kit"], "brand-kit"],
      [["weekly-report"], undefined],
    ] as const) {
      const { root, shell } = await open([...skills]);
      shell.event("run-1", { type: "session_start", sessionId: "ses_b", runId: "run-1" });
      shell.event("run-1", { type: "done", stopReason: "end_turn", text: "Revenue was $12,450.", usage });
      await frame();
      buttonNamed(root, "Turn into app")!.click();
      await frame();
      const req = shell.calls.filter((c) => c.method === "harness.run")[1]!.params;
      expect(req).toMatchObject({ input: TURN_INTO_APP_INPUT, sessionId: "ses_b" });
      expect(req["skill"]).toBe(forced);
    }
  });
});
