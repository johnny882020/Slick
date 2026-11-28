import { describe, expect, it } from "vitest";
import { collect, createScriptedProvider, type ChatEvent, type ChatRequest, type ModelProvider, type ProviderError } from "@oneseat/contracts";
import { createAnthropicProvider, fixtureFetch, retryDelay, withRetry } from "../src/index.js";
import { all, assertStreamShape, FIXTURES, textRequest } from "./helpers.js";
import { join } from "node:path";

function scripted(turns: ChatEvent[][]): ModelProvider & { calls: number } {
  const p = {
    id: "local" as const,
    calls: 0,
    async models() {
      return [];
    },
    async countTokens() {
      return 1;
    },
    async *send(): AsyncGenerator<ChatEvent> {
      const t = turns[p.calls++] ?? [];
      for (const ev of t) yield ev;
    },
  };
  return p;
}

const err = (kind: ProviderError["kind"], retryable: boolean, retryAfter?: number): ChatEvent => ({
  type: "error",
  error: { kind, message: kind, retryable, ...(retryAfter !== undefined ? { retryAfter } : {}) },
});
const START: ChatEvent = { type: "message_start", model: "m" };
const END: ChatEvent = { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
const noSleep = { sleep: async () => undefined, random: () => 0.5 };

describe("withRetry", () => {
  it("retries a retryable error that came before any content, hiding the failed message_start", async () => {
    const inner = scripted([[START, err("overloaded", true)], [START, { type: "text_delta", text: "ok" }, END]]);
    const delays: number[] = [];
    const p = withRetry(inner, { ...noSleep, onRetry: (i) => delays.push(i.delayMs) });
    const events = await all(p.send(textRequest("m")));
    assertStreamShape(events);
    expect(events).toEqual([START, { type: "text_delta", text: "ok" }, END]);
    expect(inner.calls).toBe(2);
    expect(delays).toEqual([375]);
  });

  it("does not retry after content was emitted", async () => {
    const inner = scripted([[START, { type: "text_delta", text: "partial" }, err("server", true)], [START, END]]);
    const events = await all(withRetry(inner, noSleep).send(textRequest("m")));
    expect(events).toEqual([START, { type: "text_delta", text: "partial" }, err("server", true)]);
    expect(inner.calls).toBe(1);
  });

  it("does not retry non-retryable errors", async () => {
    const inner = scripted([[err("auth", false)], [START, END]]);
    expect(await all(withRetry(inner, noSleep).send(textRequest("m")))).toEqual([err("auth", false)]);
    expect(inner.calls).toBe(1);
  });

  it("gives up after maxRetries and returns the last error", async () => {
    const inner = scripted([[err("rate_limit", true, 1)], [err("rate_limit", true, 2)], [err("rate_limit", true, 3)], [START, END]]);
    const delays: number[] = [];
    const events = await all(withRetry(inner, { ...noSleep, maxRetries: 2, onRetry: (i) => delays.push(i.delayMs) }).send(textRequest("m")));
    expect(events).toEqual([err("rate_limit", true, 3)]);
    expect(inner.calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("does not retry when the provider asks for a longer wait than maxDelayMs (daily quota)", async () => {
    const inner = scripted([[err("rate_limit", true, 34_840)], [START, END]]);
    const events = await all(withRetry(inner, { ...noSleep, maxDelayMs: 30_000 }).send(textRequest("m")));
    expect(events).toEqual([err("rate_limit", true, 34_840)]);
    expect(inner.calls).toBe(1);
  });

  it("passes a message_end with no content straight through", async () => {
    const inner = scripted([[START, END]]);
    expect(await all(withRetry(inner, noSleep).send(textRequest("m")))).toEqual([START, END]);
  });

  it("turns an inner stream that ends without a terminal event into one error", async () => {
    const inner = scripted([[START]]);
    const events = await all(withRetry(inner, noSleep).send(textRequest("m")));
    expect(events).toEqual([START, { type: "error", error: expect.objectContaining({ kind: "network" }) }]);
  });

  it("contains a throwing provider", async () => {
    const thrower: ModelProvider = {
      id: "local",
      models: async () => [],
      countTokens: async () => 0,
      send: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("kaboom")) }),
      }),
    };
    expect(await all(withRetry(thrower, { ...noSleep, maxRetries: 0 }).send(textRequest("m")))).toEqual([
      { type: "error", error: { kind: "unknown", message: "kaboom", retryable: false } },
    ]);
    let n = 0;
    const lateThrower: ModelProvider = {
      ...thrower,
      async *send() {
        yield START;
        yield { type: "text_delta", text: "x" };
        if (n++ >= 0) throw "late";
      },
    };
    expect((await all(withRetry(lateThrower, noSleep).send(textRequest("m")))).at(-1)).toEqual({
      type: "error",
      error: { kind: "unknown", message: "late", retryable: false },
    });
  });

  it("stops waiting when the request is aborted during backoff", async () => {
    const ac = new AbortController();
    const inner = scripted([[err("server", true)], [START, END]]);
    const p = withRetry(inner, { baseDelayMs: 10_000 });
    const req: ChatRequest = { ...textRequest("m"), signal: ac.signal };
    setTimeout(() => ac.abort(), 10);
    const events = await all(p.send(req));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
    expect(inner.calls).toBe(1);
  });

  it("does not retry once the signal is already aborted, and reports abort after a sleep that ignores it", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = scripted([[err("server", true)], [START, END]]);
    const events = await all(withRetry(inner, noSleep).send({ ...textRequest("m"), signal: ac.signal }));
    expect(events).toEqual([err("server", true)]);

    const ac2 = new AbortController();
    const inner2 = scripted([[err("server", true)], [START, END]]);
    const sleepThenAbort = async () => ac2.abort();
    const events2 = await all(withRetry(inner2, { sleep: sleepThenAbort }).send({ ...textRequest("m"), signal: ac2.signal }));
    expect(events2).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
  });

  it("uses real timers by default", async () => {
    const inner = scripted([[err("server", true)], [START, END]]);
    const events = await all(withRetry(inner, { baseDelayMs: 1 }).send(textRequest("m")));
    expect(events).toEqual([START, END]);
  });

  it("an already-aborted signal makes the default sleep reject immediately", async () => {
    const ac = new AbortController();
    const inner = scripted([[err("server", true)], [START, END]]);
    // Abort after the first attempt's error is seen but before sleeping.
    const wrapped = withRetry(inner, {
      baseDelayMs: 1,
      onRetry: () => ac.abort(),
    });
    const events = await all(wrapped.send({ ...textRequest("m"), signal: ac.signal }));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
  });

  it("keeps the provider's other members", async () => {
    const inner = createScriptedProvider([{ steps: [{ text: "hi" }] }]);
    const p = withRetry(inner);
    expect(p.id).toBe("local");
    expect(await p.models()).toHaveLength(1);
    expect(await p.countTokens(textRequest("m"))).toBeGreaterThan(0);
    expect((await collect(p.send(textRequest("m")))).message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("works end to end with a real adapter: 429 then success", async () => {
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false }).queue("error_429", "text_only");
    const delays: number[] = [];
    const p = withRetry(createAnthropicProvider({ apiKey: "k", fetch: f }), { ...noSleep, onRetry: (i) => delays.push(i.delayMs) });
    const res = await collect(p.send(textRequest("claude-sonnet-5-5")));
    expect(res.error).toBeUndefined();
    expect(res.message.content).toEqual([{ type: "text", text: "Hello! How can I help you today?" }]);
    expect(delays).toEqual([7000]);
  });
});

describe("retryDelay", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 1 };
  it("doubles with jitter, honours retryAfter, and caps", () => {
    const e = { kind: "server" as const, message: "", retryable: true };
    expect(retryDelay(1, e, opts)).toBe(100);
    expect(retryDelay(2, e, opts)).toBe(200);
    expect(retryDelay(5, e, opts)).toBe(1000);
    expect(retryDelay(1, e, { ...opts, random: () => 0 })).toBe(50);
    expect(retryDelay(1, { ...e, retryAfter: 0.3 }, opts)).toBe(300);
    expect(retryDelay(1, { ...e, retryAfter: 60 }, opts)).toBe(1000);
  });
});
