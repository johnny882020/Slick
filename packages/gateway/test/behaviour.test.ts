// Behaviour every adapter must share, run against each provider's fixtures.

import { describe, expect, it } from "vitest";
import { collect, type ChatEvent } from "@oneseat/contracts";
import { chunkedStream } from "../src/index.js";
import {
  all,
  assertStreamShape,
  fixtures,
  PROVIDER_CASES,
  stubFetch,
  TEST_KEY,
  textRequest,
  weatherTurn1,
} from "./helpers.js";

const MULTIBYTE = "Grüße aus München — 東京は雨 🌧️, 18°C 👩‍💻";

describe.each(PROVIDER_CASES)("$id adapter", (c) => {
  it("streams text-only responses as text deltas", async () => {
    const f = fixtures(c).queue("text_only");
    const events = await all(c.make(f).send(textRequest(c.model)));
    assertStreamShape(events);
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(1);
    const res = await collect((async function* () { yield* events; })());
    expect(res.message.content).toEqual([{ type: "text", text: "Hello! How can I help you today?" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage.outputTokens).toBe(10);
  });

  it("emits two tool_call events for parallel calls, in order, each once", async () => {
    const f = fixtures(c).queue("parallel_tools");
    const events = await all(c.make(f).send(weatherTurn1(c.model)));
    assertStreamShape(events);
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls.map((x) => ({ name: x.name, input: x.input }))).toEqual([
      { name: "get_weather", input: { city: "Paris" } },
      { name: "get_weather", input: { city: "London" } },
    ]);
    expect(new Set(calls.map((x) => x.id)).size).toBe(2);
    const end = events[events.length - 1];
    expect(end).toMatchObject({ type: "message_end", stopReason: "tool_use" });
  });

  it("maps a length cut-off to stopReason max_tokens", async () => {
    const f = fixtures(c).queue("max_tokens");
    const res = await collect(c.make(f).send(textRequest(c.model, "Tell me a story")));
    expect(res.stopReason).toBe("max_tokens");
    expect(res.message.content).toEqual([{ type: "text", text: "Once upon a time, in a city" }]);
  });

  it("decodes multi-byte UTF-8 split across every byte boundary", async () => {
    const f = fixtures(c, { chunkSize: 1 }).queue("multibyte");
    const res = await collect(c.make(f).send(textRequest(c.model)));
    expect(res.error).toBeUndefined();
    expect(res.message.content).toEqual([{ type: "text", text: MULTIBYTE }]);
  });

  it("turns a 429 into one rate_limit error with retryAfter", async () => {
    const f = fixtures(c).queue("error_429");
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<ChatEvent, { type: "error" }>;
    expect(ev.type).toBe("error");
    expect(ev.error).toMatchObject({ kind: "rate_limit", status: 429, retryable: true, retryAfter: 7 });
  });

  it("turns a 401 into one non-retryable auth error", async () => {
    const f = fixtures(c).queue("error_401");
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "auth", status: 401, retryable: false }) }]);
  });

  it("ends with one aborted error when the signal aborts mid-stream", async () => {
    const ac = new AbortController();
    const f = fixtures(c, { chunkSize: 16, chunkDelayMs: 2 }).queue("text_only");
    const events: ChatEvent[] = [];
    for await (const ev of c.make(f).send({ ...textRequest(c.model), signal: ac.signal })) {
      events.push(ev);
      if (ev.type === "message_start" || ev.type === "text_delta") ac.abort();
    }
    assertStreamShape(events);
    expect(events[events.length - 1]).toEqual({
      type: "error",
      error: expect.objectContaining({ kind: "aborted", retryable: false }),
    });
  });

  it("ends with one aborted error when the signal is aborted before sending, without calling fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = stubFetch(() => {
      throw new Error("must not be called");
    });
    const events = await all(c.make(f).send({ ...textRequest(c.model), signal: ac.signal }));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
    expect(f.calls).toHaveLength(0);
  });

  it("aborts while fetch is still waiting for headers, even if fetch ignores the signal", async () => {
    const ac = new AbortController();
    const f = stubFetch(() => new Promise<Response>(() => undefined));
    setTimeout(() => ac.abort(), 5);
    const events = await all(c.make(f).send({ ...textRequest(c.model), signal: ac.signal }));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
  });

  it("never throws: a network failure is one retryable network error", async () => {
    const f = stubFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:443") });
    });
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toEqual([
      { type: "error", error: expect.objectContaining({ kind: "network", retryable: true, message: expect.stringContaining("ECONNREFUSED") }) },
    ]);
  });

  it("reports a stream cut off mid-response as one network error after message_start", async () => {
    const f = fixtures(c).queue("text_only");
    // Serve only the first 40% of the fixture body.
    const cut = stubFetch(async (url, init) => {
      const full = await f(url, init);
      const bytes = new Uint8Array(await full.arrayBuffer());
      return new Response(chunkedStream(bytes.slice(0, Math.floor(bytes.length * 0.4))), { headers: { "content-type": "text/event-stream" } });
    });
    const events = await all(c.make(cut).send(textRequest(c.model)));
    assertStreamShape(events);
    expect(events[0]?.type).toBe("message_start");
    expect(events[events.length - 1]).toEqual({ type: "error", error: expect.objectContaining({ kind: "network", retryable: true }) });
  });

  it("reports malformed event JSON as one error, not a throw", async () => {
    const f = stubFetch(
      () => new Response("data: {not json\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    const events = await all(c.make(f).send(textRequest(c.model)));
    assertStreamShape(events);
    expect(events[events.length - 1]).toEqual({ type: "error", error: expect.objectContaining({ kind: "unknown" }) });
  });

  it("reports a 2xx JSON body (no stream) as one error", async () => {
    const f = stubFetch(() => new Response('{"error":{"message":"proxy says no"}}', { headers: { "content-type": "application/json" } }));
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ retryable: false, message: expect.stringContaining("expected an event stream") }) }]);
  });

  it("reports a missing body as one server error", async () => {
    const f = stubFetch(() => new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "server" }) }]);
  });

  it.each([
    [400, "invalid_request", false],
    [403, "auth", false],
    [404, "not_found", false],
    [422, "invalid_request", false],
    [500, "server", true],
    [502, "server", true],
    [503, "overloaded", true],
    [529, "overloaded", true],
  ] as const)("maps HTTP %i to %s (retryable %s)", async (status, kind, retryable) => {
    const f = stubFetch(() => new Response("upstream said no", { status }));
    const events = await all(c.make(f).send(textRequest(c.model)));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind, status, retryable }) }]);
  });

  it("never leaks the API key into error events, even when the server echoes it", async () => {
    const secret = `${TEST_KEY}-leaky`;
    const echo = stubFetch((url, init) => {
      const h = new Headers(init?.headers);
      const echoed = [h.get("x-api-key"), h.get("authorization"), h.get("x-goog-api-key"), url].join(" | ");
      return new Response(JSON.stringify({ error: { message: `bad key: ${echoed}`, type: "authentication_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const events = await all(c.make(echo, secret).send(textRequest(c.model)));
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("SECRET-0123456789");
    expect(text).toContain("[REDACTED]");

    // Thrown network errors that mention the key are redacted too.
    const thrower = stubFetch(() => {
      throw new Error(`connect failed with header x-api-key: ${secret}`);
    });
    const events2 = await all(c.make(thrower, secret).send(textRequest(c.model)));
    expect(JSON.stringify(events2)).not.toContain(secret);

    // And keys in a stream error event.
    const streamErr = stubFetch(() =>
      new Response(`data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `oops ${secret}`, code: "server_error", status: "INTERNAL" }, code: "server_error", message: `oops ${secret}` })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const events3 = await all(c.make(streamErr, secret).send(textRequest(c.model)));
    expect(JSON.stringify(events3)).not.toContain(secret);
  });

  it("sends the key only in the provider's auth header, and the recorder redacts it", async () => {
    const f = fixtures(c).queue("text_only");
    await all(c.make(f).send(textRequest(c.model)));
    const req = f.requests[0];
    expect(req).toBeDefined();
    expect(JSON.stringify(req)).not.toContain(TEST_KEY);
    expect(req?.url).not.toContain(TEST_KEY);
    const authHeader = { anthropic: "x-api-key", openai: "authorization", google: "x-goog-api-key", local: "authorization" }[c.id];
    expect(req?.headers[authHeader]).toBe("[REDACTED]");
    expect(req?.headers["content-type"]).toBe("application/json");
  });

  it("countTokens falls back to an estimate when the endpoint fails", async () => {
    const f = stubFetch(() => new Response("nope", { status: 500 }));
    const n = await c.make(f).countTokens(weatherTurn1(c.model));
    expect(n).toBeGreaterThan(0);
  });

  it("models() never throws", async () => {
    const f = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const models = await c.make(f).models();
    expect(Array.isArray(models)).toBe(true);
    for (const m of models) expect(m.provider).toBe(c.id);
  });
});
