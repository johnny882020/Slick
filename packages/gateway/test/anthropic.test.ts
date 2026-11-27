import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect, type ChatRequest } from "@oneseat/contracts";
import {
  ANTHROPIC_FALLBACK_MODELS,
  buildAnthropicCountRequest,
  buildAnthropicRequest,
  createAnthropicProvider,
  fixtureFetch,
} from "../src/index.js";
import { all, assertStreamShape, FIXTURES, jsonResponse, sseResponse, stubFetch, textRequest, weatherTurn1, WEATHER_TOOL } from "./helpers.js";

const DIR = join(FIXTURES, "anthropic");
const MODEL = "claude-opus-5-5";

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
const START = { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } };

describe("buildAnthropicRequest", () => {
  const base: ChatRequest = weatherTurn1(MODEL);

  it("maps the scenario to the Messages API shape", () => {
    expect(buildAnthropicRequest(base)).toEqual({
      model: MODEL,
      max_tokens: 1024,
      system: "You are a weather bot",
      messages: [{ role: "user", content: [{ type: "text", text: "What's the weather in Paris?" }] }],
      tools: [{ name: "get_weather", description: WEATHER_TOOL.description, input_schema: WEATHER_TOOL.inputSchema }],
      stream: true,
    });
  });

  it("maps tool_choice auto/any/none/named", () => {
    expect(buildAnthropicRequest({ ...base, toolChoice: "auto" })["tool_choice"]).toBeUndefined();
    expect(buildAnthropicRequest({ ...base, toolChoice: "any" })["tool_choice"]).toEqual({ type: "any" });
    expect(buildAnthropicRequest({ ...base, toolChoice: "none" })["tool_choice"]).toEqual({ type: "none" });
    expect(buildAnthropicRequest({ ...base, toolChoice: { name: "get_weather" } })["tool_choice"]).toEqual({
      type: "tool",
      name: "get_weather",
    });
  });

  it("omits system, tools and tool_choice when empty; maps effort and temperature", () => {
    const body = buildAnthropicRequest({ ...textRequest(MODEL), toolChoice: "any", effort: "high", temperature: 0.2 });
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body["output_config"]).toEqual({ effort: "high" });
    expect(body["temperature"]).toBe(0.2);
  });

  it("forces the tool schema root to an object", () => {
    const body = buildAnthropicRequest({ ...base, tools: [{ name: "ping", description: "Ping", inputSchema: {} }] });
    expect((body["tools"] as Record<string, unknown>[])[0]?.["input_schema"]).toEqual({ type: "object", properties: {} });
  });

  it("maps images, tool results (first, with is_error), and drops empty text", () => {
    const body = buildAnthropicRequest({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "Here is a photo" },
            { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
            { type: "tool_result", toolUseId: "toolu_1", name: "get_weather", content: "boom", isError: true },
          ],
        },
      ],
    });
    expect(body["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true },
          { type: "text", text: "Here is a photo" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
      },
    ]);
  });

  it("round-trips signed thinking, redacted thinking, and drops unsigned reasoning", () => {
    const body = buildAnthropicRequest({
      ...base,
      messages: [
        base.messages[0]!,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "from another provider" },
            { type: "reasoning", text: "openai meta only", providerMeta: { openai: { encryptedContent: "x" } } },
            { type: "reasoning", text: "I should call the tool", providerMeta: { anthropic: { signature: "sig-123" } } },
            { type: "reasoning", text: "", providerMeta: { anthropic: { redactedData: "EmwKAhgB" } } },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
      ],
    });
    expect((body["messages"] as { content: unknown[] }[])[1]?.content).toEqual([
      { type: "thinking", thinking: "I should call the tool", signature: "sig-123" },
      { type: "redacted_thinking", data: "EmwKAhgB" },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("merges consecutive same-role turns and skips turns that end up empty", () => {
    const body = buildAnthropicRequest({
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "unsigned" }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t", name: "n", content: "r" }] },
      ],
    });
    expect(body["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: "r" },
          { type: "text", text: "a" },
        ],
      },
    ]);
  });

  it("count request drops generation-only fields", () => {
    const body = buildAnthropicCountRequest({ ...base, effort: "low", temperature: 1 });
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "system", "tools"]);
  });
});

describe("Anthropic stream decoding", () => {
  it("round-trips a signed thinking block into the next request", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("thinking");
    const p = createAnthropicProvider({ apiKey: "k-test", fetch: f });
    const events = await all(p.send({ ...weatherTurn1(MODEL), effort: "high" }));
    assertStreamShape(events);
    expect(events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("")).toBe(
      "The user wants the weather in Paris. I should call get_weather.",
    );
    const done = events.find((e) => e.type === "reasoning_done");
    const signature =
      "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds-zhNhcV8ZdG5HPmXyS4WZSbDuRBOGlOnwQe7Sdnyq9eNrz8";
    expect(done).toEqual({
      type: "reasoning_done",
      part: {
        type: "reasoning",
        text: "The user wants the weather in Paris. I should call get_weather.",
        providerMeta: { anthropic: { signature } },
      },
    });
    const res = await collect((async function* () { yield* events; })());
    expect(res.message.content.map((c) => c.type)).toEqual(["reasoning", "tool_use"]);
    const next = buildAnthropicRequest({
      ...weatherTurn1(MODEL),
      messages: [
        weatherTurn1(MODEL).messages[0]!,
        res.message,
        { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_01ThinkThenCall", name: "get_weather", content: "18C" }] },
      ],
    });
    expect((next["messages"] as { content: unknown[] }[])[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "The user wants the weather in Paris. I should call get_weather.",
      signature,
    });
  });

  it("emits redacted_thinking as a reasoning part that round-trips", async () => {
    const body = sse([
      START,
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "Done." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    const p = createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) });
    const res = await collect(p.send(textRequest(MODEL)));
    expect(res.message.content).toEqual([
      { type: "reasoning", text: "", providerMeta: { anthropic: { redactedData: "EmwKAhgBEgy3va3pzix" } } },
      { type: "text", text: "Done." },
    ]);
  });

  it("emits a mid-stream error event as the single terminal event", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("stream_error");
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: f }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "error"]);
    expect(events[2]).toEqual({
      type: "error",
      error: { kind: "overloaded", message: "Anthropic stream error: overloaded_error: Overloaded", retryable: true },
    });
  });

  it("maps HTTP 529 overloaded_error", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("error_529");
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: f }).send(textRequest(MODEL)));
    expect(events).toEqual([
      { type: "error", error: { kind: "overloaded", status: 529, retryable: true, message: "Anthropic API error 529: overloaded_error: Overloaded" } },
    ]);
  });

  it("reports cache usage and the model from message_start", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("text_only");
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: f }).send(textRequest("claude-sonnet-5-5")));
    expect(events[0]).toEqual({ type: "message_start", model: "claude-sonnet-5-5" });
    expect(events[events.length - 1]).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 25, outputTokens: 10, cacheReadTokens: 2048 },
    });
  });

  it("uses the initial tool input when no json deltas arrive, and tolerates a missing message_stop", async () => {
    const body = sse([
      START,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "get_weather", input: { city: "Oslo" } } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 9, cache_creation_input_tokens: 12 } },
    ]);
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events.slice(1)).toEqual([
      { type: "tool_call", call: { id: "toolu_x", name: "get_weather", input: { city: "Oslo" } } },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 9, cacheWriteTokens: 12 } },
    ]);
  });

  it.each([
    ["refusal", "refusal"],
    ["stop_sequence", "stop_sequence"],
    ["model_context_window_exceeded", "max_tokens"],
    ["something_new", "end_turn"],
  ])("maps stop_reason %s to %s", async (raw, want) => {
    const body = sse([START, { type: "message_delta", delta: { stop_reason: raw }, usage: { output_tokens: 1 } }, { type: "message_stop" }]);
    const res = await collect(createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(res.stopReason).toBe(want);
  });

  it("reports invalid tool JSON as an error event", async () => {
    const body = sse([
      START,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "Par' } },
      { type: "content_block_stop", index: 0 },
    ]);
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events[events.length - 1]).toMatchObject({ type: "error", error: { kind: "unknown", message: expect.stringContaining("invalid JSON") } });
  });

  it("ignores unknown events, unknown deltas and blocks, and non-object data", async () => {
    const body = sse([
      START,
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s", name: "web_search" } },
      { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 9 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "Hi" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "" } },
      { type: "content_block_stop", index: 1 },
      { type: "future_event" },
      { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]) + "event: x\ndata: [1,2]\n\n";
    const res = await collect(createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(res.message.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(res.stopReason).toBe("end_turn");
  });

  it("an error event without details is a server error", async () => {
    const body = sse([START, { type: "error" }]);
    const events = await all(createAnthropicProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(events[events.length - 1]).toMatchObject({ type: "error", error: { kind: "server", message: "Anthropic stream error: unknown error" } });
  });
});

describe("Anthropic HTTP details", () => {
  it("sends version and key headers, merges custom headers, and the key cannot be overridden", async () => {
    const f = stubFetch(() => sseResponse(sse([START, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }])));
    const p = createAnthropicProvider({
      apiKey: "real-key",
      baseUrl: "https://proxy.example.com/anthropic/",
      fetch: f,
      headers: { "anthropic-beta": "some-beta", "x-api-key": "spoof" },
    });
    await all(p.send(textRequest(MODEL)));
    expect(f.calls[0]?.url).toBe("https://proxy.example.com/anthropic/v1/messages");
    const h = f.calls[0]?.init?.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("real-key");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["anthropic-beta"]).toBe("some-beta");
    expect(h["accept"]).toBe("text/event-stream");
  });

  it("uses the default base URL and global fetch when none is given", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return jsonResponse({ input_tokens: 3 });
    }) as typeof fetch;
    try {
      const n = await createAnthropicProvider({ apiKey: "k" }).countTokens(textRequest(MODEL));
      expect(n).toBe(3);
      expect(seen).toEqual(["https://api.anthropic.com/v1/messages/count_tokens"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("models() lists the API models with labels and tiers", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("models");
    const models = await createAnthropicProvider({ apiKey: "k", fetch: f }).models();
    expect(models).toEqual([
      { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", supportsTools: true, tier: "frontier" },
      { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", supportsTools: true, tier: "balanced" },
      { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", supportsTools: true, tier: "fast" },
    ]);
    expect(f.requests[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(f.requests[0]?.method).toBe("GET");
  });

  it("models() follows pagination", async () => {
    const pages = [
      { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { bad: true }, {}], has_more: true, last_id: "claude-opus-5-5" },
      { data: [{ id: "claude-future-x" }], has_more: true },
    ];
    const f = stubFetch(() => jsonResponse(pages.shift()));
    const models = await createAnthropicProvider({ apiKey: "k", fetch: f }).models();
    expect(models.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-future-x"]);
    expect(models[1]).toEqual({ id: "claude-future-x", provider: "anthropic", label: "claude-future-x", supportsTools: true });
    expect(f.calls[1]?.url).toContain("after_id=claude-opus-5-5");
  });

  it("models() falls back to the static list on auth failure or an empty list", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("error_401");
    expect(await createAnthropicProvider({ apiKey: "k", fetch: f }).models()).toEqual(ANTHROPIC_FALLBACK_MODELS);
    const empty = stubFetch(() => jsonResponse({ nope: 1 }));
    expect(await createAnthropicProvider({ apiKey: "k", fetch: empty }).models()).toEqual(ANTHROPIC_FALLBACK_MODELS);
    const notJson = stubFetch(() => new Response("<html>", { status: 200 }));
    expect(await createAnthropicProvider({ apiKey: "k", fetch: notJson }).models()).toEqual(ANTHROPIC_FALLBACK_MODELS);
  });

  it("countTokens uses the count endpoint, falling back to an estimate", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("count_tokens");
    const p = createAnthropicProvider({ apiKey: "k", fetch: f });
    expect(await p.countTokens(weatherTurn1(MODEL))).toBe(402);
    expect(f.requests[0]?.body).toEqual(buildAnthropicCountRequest(weatherTurn1(MODEL)));
    const odd = stubFetch(() => jsonResponse({ tokens: "many" }));
    expect(await createAnthropicProvider({ apiKey: "k", fetch: odd }).countTokens(weatherTurn1(MODEL))).toBeGreaterThan(10);
  });
});
