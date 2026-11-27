import { describe, expect, it } from "vitest";
import { createScriptedProvider, type ChatEvent } from "@oneseat/contracts";
import {
  assertValidChatStream,
  canonicalJson,
  deepEqual,
  drainStream,
  isJsonRoundTrippable,
  normaliseToolCalls,
  StreamValidationError,
  streamText,
  terminalEvent,
  validateChatStream,
} from "../src/index.js";

const end = (stopReason: "end_turn" | "tool_use" = "end_turn"): ChatEvent => ({ type: "message_end", stopReason, usage: { inputTokens: 5, outputTokens: 2 } });
const start: ChatEvent = { type: "message_start", model: "m" };
const rules = (events: ChatEvent[], opts = {}) => validateChatStream(events, opts).map((i) => i.rule);

describe("validateChatStream", () => {
  it("accepts a well-formed text stream", () => {
    expect(validateChatStream([start, { type: "text_delta", text: "hi" }, { type: "reasoning_delta", text: "r" }, { type: "reasoning_done", part: { type: "reasoning", text: "r" } }, end()])).toEqual([]);
  });

  it("accepts a tool call stream and a bare error", () => {
    expect(validateChatStream([start, { type: "tool_call", call: { id: "a", name: "get_weather", input: { city: "Paris" } } }, end("tool_use")], { toolNames: ["get_weather"] })).toEqual([]);
    expect(validateChatStream([{ type: "error", error: { kind: "auth", message: "no", retryable: false } }])).toEqual([]);
  });

  it("rejects a bare error when not allowed", () => {
    expect(rules([{ type: "error", error: { kind: "auth", message: "no", retryable: false } }], { allowBareError: false })).toContain("start-first");
  });

  it("requires message_start first and once", () => {
    expect(rules([{ type: "text_delta", text: "x" }, end()])).toContain("start-first");
    expect(rules([start, start, end()])).toContain("start-once");
    expect(rules([{ type: "message_start", model: "" }, end()])).toContain("start-model");
  });

  it("requires exactly one terminal event, last", () => {
    expect(rules([start])).toContain("terminal");
    expect(rules([start, end(), end()])).toEqual(expect.arrayContaining(["after-terminal", "terminal"]));
    expect(rules([start, end(), { type: "text_delta", text: "late" }])).toContain("after-terminal");
    expect(rules([])).toEqual(["empty"]);
  });

  it("checks tool calls: complete object input, valid unique names and ids, offered tools", () => {
    const bad: ChatEvent[] = [
      start,
      { type: "tool_call", call: { id: "a", name: "get_weather", input: '{"city":"Par' as never } },
      { type: "tool_call", call: { id: "a", name: "1bad", input: { x: 1 } } },
      { type: "tool_call", call: { id: "", name: "other", input: [] as never } },
      { type: "tool_call", call: { id: "z", name: "get_weather", input: { d: new Date() } as never, providerMeta: "x" as never } },
      { type: "tool_call", call: null as never },
      end("tool_use"),
    ];
    const r = rules(bad, { toolNames: ["get_weather"] });
    expect(r).toEqual(expect.arrayContaining(["tool-call-input", "tool-call-id", "tool-call-name", "tool-call-unknown", "tool-call-meta", "tool-call-shape"]));
  });

  it("ties stop reasons to tool calls", () => {
    expect(rules([start, { type: "tool_call", call: { id: "a", name: "t", input: {} } }, end("end_turn")])).toContain("tool-use-stop");
    expect(rules([start, end("tool_use")])).toContain("tool-use-stop");
    expect(rules([start, { type: "tool_call", call: { id: "a", name: "t", input: {} } }, end("end_turn")], { requireToolUseStop: false })).toEqual([]);
    expect(rules([start, { type: "message_end", stopReason: "bogus" as never, usage: { inputTokens: 1, outputTokens: 1 } }])).toContain("stop-reason");
  });

  it("checks usage numbers are non-negative integers", () => {
    expect(rules([start, { type: "message_end", stopReason: "end_turn", usage: { inputTokens: -1, outputTokens: 1.5, cacheReadTokens: Number.NaN } }])).toEqual(["usage-non-negative", "usage-non-negative", "usage-non-negative"]);
    expect(rules([start, { type: "message_end", stopReason: "end_turn", usage: null as never }])).toContain("usage-shape");
    expect(rules([start, { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1 } as never }])).toContain("usage-shape");
  });

  it("checks error events", () => {
    const r = rules([start, { type: "error", error: { kind: "weird" as never, message: "", retryable: "no" as never, status: 42, retryAfter: -1 } }]);
    expect(r).toEqual(expect.arrayContaining(["error-kind", "error-message", "error-retryable", "error-status", "error-retry-after"]));
    expect(rules([start, { type: "error", error: "boom" as never }])).toContain("error-shape");
  });

  it("flags delta and reasoning shapes and unknown events", () => {
    expect(rules([start, { type: "text_delta", text: 3 as never }, { type: "reasoning_done", part: { type: "text", text: "x" } as never }, { type: "mystery" } as never, end()])).toEqual(
      expect.arrayContaining(["delta-text", "reasoning-part", "unknown-event"]),
    );
  });

  it("assertValidChatStream throws a readable error", () => {
    expect(() => assertValidChatStream([start])).toThrow(StreamValidationError);
    try {
      assertValidChatStream([start]);
    } catch (e) {
      expect((e as StreamValidationError).issues[0]!.rule).toBe("terminal");
      expect((e as Error).message).toContain("[terminal]");
    }
    const ok = [start, end()];
    expect(assertValidChatStream(ok)).toBe(ok);
  });

  it("accepts every stream the scripted provider makes", async () => {
    const p = createScriptedProvider([{ steps: [{ reasoning: "think" }, { text: "hello world" }, { tool: "x", input: { a: 1 } }] }, { steps: [{ error: { kind: "rate_limit" } }] }, { steps: [{ text: "ok" }] }]);
    const req = { model: "m", system: "", messages: [], tools: [], maxTokens: 10 };
    for (let i = 0; i < 4; i++) {
      const d = await drainStream(p, req);
      expect(d.thrown).toBeUndefined();
      expect(validateChatStream(d.events)).toEqual([]);
    }
  });
});

describe("stream helpers", () => {
  it("drainStream records throws and timeouts", async () => {
    const throwing = { async *send() { yield start; throw new Error("boom"); } };
    const d = await drainStream(throwing, { model: "m", system: "", messages: [], tools: [], maxTokens: 1 });
    expect(d.events).toEqual([start]);
    expect((d.thrown as Error).message).toBe("boom");
    const hanging = { async *send() { yield start; await new Promise(() => {}); } };
    const t = await drainStream(hanging, { model: "m", system: "", messages: [], tools: [], maxTokens: 1 }, { timeoutMs: 30 });
    expect(t.timedOut).toBe(true);
  });

  it("normalises tool calls and text", () => {
    const evs: ChatEvent[] = [start, { type: "text_delta", text: "a" }, { type: "text_delta", text: "b" }, { type: "tool_call", call: { id: "1", name: "f", input: { b: 1, a: { d: 2, c: 3 } }, providerMeta: { sig: "x" } } }, end("tool_use")];
    expect(normaliseToolCalls(evs)).toEqual([{ name: "f", input: { a: { c: 3, d: 2 }, b: 1 } }]);
    expect(JSON.stringify(normaliseToolCalls(evs)[0]!.input)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(streamText(evs)).toBe("ab");
    expect(terminalEvent(evs)?.type).toBe("message_end");
    expect(terminalEvent([start])).toBeUndefined();
  });

  it("deepEqual and JSON helpers", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual(new Date(0), new Date(0))).toBe(false);
    expect(isJsonRoundTrippable({ a: [1, "x", null] })).toBe(true);
    expect(isJsonRoundTrippable({ f: () => 1 })).toBe(false);
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(isJsonRoundTrippable(cyc)).toBe(false);
    expect(canonicalJson([{ b: 1, a: undefined }])).toEqual([{ b: 1 }]);
  });
});
