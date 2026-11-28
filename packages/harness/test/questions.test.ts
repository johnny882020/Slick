// ask_user: the model asks the person a question mid-run (HarnessEvent question / question_answered).
import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, QuestionHandler, ToolResultPart } from "@oneseat/contracts";
import { ASKING_SECTION } from "../src/router.js";
import { ASK_USER_TOOL, SKIPPED_ANSWER } from "../src/tools/ask.js";
import { approveAll, collect, done, MemorySkillStore, ofType, setup, task } from "./helpers.js";

function lastResults(req: ChatRequest): ToolResultPart[] {
  const m = req.messages[req.messages.length - 1]!;
  return m.content.filter((p): p is ToolResultPart => p.type === "tool_result");
}

const ask = (question: string, options?: string[]) => ({ tool: ASK_USER_TOOL, input: { question, ...(options ? { options } : {}) } });

describe("ask_user", () => {
  it("is not offered, and not callable, when the run has nobody to ask", async () => {
    const { harness, provider } = setup([
      { steps: [ask("Which customer?")] },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ isError: true, content: 'Unknown tool "ask_user".' });
        return { steps: [{ text: "ok" }] };
      },
    ]);
    const events = await collect(harness.run(task("x"), approveAll));
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain(ASK_USER_TOOL);
    expect(provider.requests[0]!.system).not.toContain(ASKING_SECTION);
    expect(ofType(events, "question")).toHaveLength(0);
    expect(done(events).text).toBe("ok");
  });

  it("asks, waits for the answer and gives it to the model as the tool result", async () => {
    const onQuestion = vi.fn<QuestionHandler>(async () => "Acme Ltd");
    const { harness, provider } = setup([
      (req) => {
        const spec = req.tools.find((t) => t.name === ASK_USER_TOOL)!;
        expect(spec.description).toContain("only when you truly cannot go on");
        expect(spec.inputSchema).toMatchObject({ required: ["question"], properties: { options: { maxItems: 6 } } });
        expect(req.system).toContain(ASKING_SECTION);
        return { steps: [{ text: "One thing first." }, ask("  Which customer should I chase? ", ["Acme Ltd", " Acme Ltd ", "Globex", ""])] };
      },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ name: ASK_USER_TOOL, content: "Acme Ltd" });
        expect(lastResults(req)[0]!.isError).toBeUndefined();
        return { steps: [{ text: "Chasing Acme Ltd." }] };
      },
    ]);
    const events = await collect(harness.run(task("chase an invoice"), approveAll, { onQuestion }));
    const q = ofType(events, "question")[0]!;
    expect(q).toEqual({ type: "question", questionId: expect.stringMatching(/^q_/), question: "Which customer should I chase?", options: ["Acme Ltd", "Globex"] });
    expect(onQuestion).toHaveBeenCalledWith({ questionId: q.questionId, question: q.question, options: q.options });
    expect(ofType(events, "question_answered")).toEqual([{ type: "question_answered", questionId: q.questionId, answer: "Acme Ltd" }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("question"));
    expect(types.indexOf("question")).toBeLessThan(types.indexOf("question_answered"));
    expect(types.indexOf("question_answered")).toBeLessThan(types.indexOf("tool_end"));
    expect(ofType(events, "tool_start")[0]!.effects).toEqual([]);
    expect(ofType(events, "approval_request")).toHaveLength(0);
    expect(done(events).text).toBe("Chasing Acme Ltd.");
    expect(provider.requests).toHaveLength(2);
    // Asking is logged like every tool action.
    expect(harness.actions.list()[0]).toMatchObject({ tool: ASK_USER_TOOL, approved: null, summary: "Ask the person: Which customer should I chase?" });
  });

  it("an empty answer tells the model the person skipped, and a question without options has none", async () => {
    const { harness } = setup([
      { steps: [ask("Anything to add?")] },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ content: SKIPPED_ANSWER });
        return { steps: [{ text: "Going ahead." }] };
      },
    ]);
    const events = await collect(harness.run(task("x"), approveAll, { onQuestion: async () => "   " }));
    expect(ofType(events, "question")[0]).not.toHaveProperty("options");
    expect(ofType(events, "question_answered")[0]!.answer).toBe("");
    expect(done(events).stopReason).toBe("end_turn");
  });

  it("asks one question at a time when the model asks two at once", async () => {
    const order: string[] = [];
    const onQuestion: QuestionHandler = async (req) => {
      order.push(`ask:${req.question}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`answer:${req.question}`);
      return req.question === "First?" ? "1" : "2";
    };
    const { harness } = setup([
      { steps: [ask("First?"), ask("Second?")] },
      (req) => {
        expect(lastResults(req).map((r) => r.content)).toEqual(["1", "2"]);
        return { steps: [{ text: "done" }] };
      },
    ]);
    await collect(harness.run(task("x"), approveAll, { onQuestion }));
    expect(order).toEqual(["ask:First?", "answer:First?", "ask:Second?", "answer:Second?"]);
  });

  it("rejects more than six options and an empty question as invalid input", async () => {
    const onQuestion = vi.fn<QuestionHandler>(async () => "x");
    const { harness } = setup([
      { steps: [ask("Pick one", ["a", "b", "c", "d", "e", "f", "g"]), ask("")] },
      (req) => {
        const [a, b] = lastResults(req);
        expect(a).toMatchObject({ isError: true, content: expect.stringContaining("at most 6 items") });
        expect(b).toMatchObject({ isError: true, content: expect.stringContaining("at least 1 characters") });
        return { steps: [{ text: "ok" }] };
      },
    ]);
    await collect(harness.run(task("x"), approveAll, { onQuestion }));
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it("cancelling the run releases a pending question", async () => {
    const { harness, provider } = setup([{ steps: [ask("Which month?", ["March", "April"])] }, { steps: [{ text: "never" }] }]);
    let asked!: () => void;
    const seen = new Promise<void>((r) => (asked = r));
    const stream = harness.run(task("report"), approveAll, {
      runId: "run_q_cancel",
      onQuestion: () => {
        asked();
        return new Promise<string>(() => undefined);
      },
    });
    const collected = collect(stream);
    await seen;
    expect(harness.cancel("run_q_cancel")).toBe(true);
    const events = await collected;
    expect(ofType(events, "question")).toHaveLength(1);
    // Nobody answered: no question_answered; done closes the question.
    expect(ofType(events, "question_answered")).toHaveLength(0);
    expect(ofType(events, "tool_end")[0]!.result).toMatchObject({ isError: true, content: "The run was cancelled before the person answered." });
    expect(done(events).stopReason).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
  });

  it("a handler that fails is a tool error, and the question still closes", async () => {
    const { harness } = setup([
      { steps: [ask("Which one?")] },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ isError: true, content: "Could not ask the person: window closed" });
        return { steps: [{ text: "ok" }] };
      },
    ]);
    const events = await collect(harness.run(task("x"), approveAll, { onQuestion: async () => Promise.reject(new Error("window closed")) }));
    expect(ofType(events, "question_answered")).toHaveLength(1);
    expect(done(events).text).toBe("ok");
  });

  it("redacts secrets in questions, options and answers", async () => {
    const KEY = "sk-ant-api03-SECRET-0123456789abcdefghij";
    const { harness, provider } = setup([
      { steps: [ask(`Is ${KEY} the right key?`, [`yes ${KEY}`, "no"])] },
      (req) => {
        const r = lastResults(req)[0]!;
        expect(r.content).not.toContain(KEY);
        expect(r.content).not.toContain("sk-proj-");
        expect(r.content).toContain("[REDACTED]");
        return { steps: [{ text: "ok" }] };
      },
    ]);
    harness.redactor.add(KEY);
    const onQuestion = vi.fn<QuestionHandler>(async () => `use ${KEY} or sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX0123456789`);
    const events = await collect(harness.run(task("check"), approveAll, { onQuestion }));
    const q = ofType(events, "question")[0]!;
    expect(JSON.stringify(q)).not.toContain(KEY);
    expect(JSON.stringify(onQuestion.mock.calls[0]![0])).not.toContain(KEY);
    expect(q.question).toBe("Is [REDACTED] the right key?");
    expect(q.options).toEqual(["yes [REDACTED]", "no"]);
    const a = ofType(events, "question_answered")[0]!;
    expect(a.answer).not.toContain(KEY);
    expect(a.answer).not.toContain("sk-proj-ABCDEFGH");
    expect(JSON.stringify(provider.requests)).not.toContain(KEY);
    expect(JSON.stringify(harness.actions.list())).not.toContain(KEY);
  });

  it("stays available while a skill with allowed-tools is active", async () => {
    const store = new MemorySkillStore();
    store.add({ name: "narrow", description: "A narrow skill for narrow tasks.", allowedTools: "db_query" });
    const { harness, provider } = setup(
      [
        { steps: [ask("Which table?", ["customers", "invoices"])] },
        (req) => {
          expect(lastResults(req)[0]!.content).toBe("invoices");
          return { steps: [{ text: "ok" }] };
        },
      ],
      { store },
    );
    await collect(harness.run(task("x", { skill: "narrow" }), approveAll, { onQuestion: async () => "invoices" }));
    expect(provider.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["ask_user", "db_query", "load_skill", "read_skill_file", "run_skill_script"]);
  });

  it("a continued session can answer in a new turn, and ask_user is offered per run", async () => {
    const { harness, provider } = setup([
      { steps: [{ text: "Which month should the report cover?" }] },
      (req) => {
        const texts = req.messages.flatMap((m) => m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text));
        expect(texts).toEqual(["weekly report", "Which month should the report cover?", "March"]);
        return { steps: [{ text: "March report." }] };
      },
    ]);
    const first = await collect(harness.run(task("weekly report"), approveAll));
    const sessionId = ofType(first, "session_start")[0]!.sessionId;
    const second = await collect(harness.run(task("March", { sessionId }), approveAll, { onQuestion: async () => "" }));
    expect(done(second).text).toBe("March report.");
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain(ASK_USER_TOOL);
    expect(provider.requests[1]!.tools.map((t) => t.name)).toContain(ASK_USER_TOOL);
  });
});
