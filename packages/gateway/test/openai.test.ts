import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect, type ChatRequest, type ModelInfo } from "@oneseat/contracts";
import { buildOpenAICountRequest, buildOpenAIRequest, createOpenAIProvider, fixtureFetch, OPENAI_FALLBACK_MODELS } from "../src/index.js";
import { all, assertStreamShape, FIXTURES, jsonResponse, sseResponse, stubFetch, textRequest, weatherTurn1, WEATHER_TOOL } from "./helpers.js";

const DIR = join(FIXTURES, "openai");
const MODEL = "gpt-5-codex";

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
const CREATED = { type: "response.created", response: { id: "r", model: MODEL } };
const COMPLETED = { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } };

describe("buildOpenAIRequest", () => {
  const base: ChatRequest = weatherTurn1(MODEL);

  it("maps the scenario to the Responses API shape", () => {
    expect(buildOpenAIRequest(base)).toEqual({
      model: MODEL,
      instructions: "You are a weather bot",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather in Paris?" }] }],
      tools: [{ type: "function", name: "get_weather", description: WEATHER_TOOL.description, parameters: WEATHER_TOOL.inputSchema, strict: false }],
      max_output_tokens: 1024,
      store: false,
      stream: true,
    });
  });

  it("maps tool_choice auto/any/none/named", () => {
    expect(buildOpenAIRequest({ ...base, toolChoice: "auto" })["tool_choice"]).toBeUndefined();
    expect(buildOpenAIRequest({ ...base, toolChoice: "any" })["tool_choice"]).toBe("required");
    expect(buildOpenAIRequest({ ...base, toolChoice: "none" })["tool_choice"]).toBe("none");
    expect(buildOpenAIRequest({ ...base, toolChoice: { name: "get_weather" } })["tool_choice"]).toEqual({ type: "function", name: "get_weather" });
  });

  it("maps effort to reasoning.effort and asks for encrypted reasoning (store is false)", () => {
    const body = buildOpenAIRequest({ ...textRequest(MODEL), effort: "low", temperature: 0.5 });
    expect(body["reasoning"]).toEqual({ effort: "low" });
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["temperature"]).toBe(0.5);
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("tools");
  });

  it("maps assistant text to output_text, images to input_image, and error results with a prefix", () => {
    const body = buildOpenAIRequest({
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/jpeg", data: "/9j/4AAQ" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "image", mediaType: "image/png", data: "ignored" },
            { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
            { type: "text", text: "" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "call_1", name: "get_weather", content: "timeout", isError: true },
            { type: "text", text: "and now?" },
          ],
        },
      ],
    });
    expect(body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_1", output: "Error: timeout" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
    ]);
  });

  it("round-trips encrypted reasoning without an item id, and drops other reasoning", () => {
    const body = buildOpenAIRequest({
      ...base,
      messages: [
        base.messages[0]!,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "anthropic", providerMeta: { anthropic: { signature: "s" } } },
            { type: "reasoning", text: "Summary", providerMeta: { openai: { encryptedContent: "gAAAA" } } },
            { type: "reasoning", text: "", providerMeta: { openai: { encryptedContent: "gBBBB" } } },
          ],
        },
      ],
    });
    expect((body["input"] as unknown[]).slice(1)).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "gAAAA" },
      { type: "reasoning", summary: [], encrypted_content: "gBBBB" },
    ]);
  });

  it("count request drops generation-only fields", () => {
    const body = buildOpenAICountRequest({ ...base, effort: "high", temperature: 1 });
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "model", "reasoning", "tools"]);
  });
});

describe("OpenAI stream decoding", () => {
  it("decodes reasoning summaries and encrypted content, then round-trips them", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("reasoning");
    const events = await all(createOpenAIProvider({ apiKey: "k", fetch: f }).send({ ...weatherTurn1(MODEL), effort: "high" }));
    assertStreamShape(events);
    const summary = "**Checking the weather**\n\nThe user asked about Paris, so I will call get_weather.";
    expect(events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("")).toBe(summary);
    expect(events.find((e) => e.type === "reasoning_done")).toEqual({
      type: "reasoning_done",
      part: { type: "reasoning", text: summary, providerMeta: { openai: { encryptedContent: "gAAAAABoX1ENCRYPTEDREASONINGBLOBexample0123456789==" } } },
    });
    const res = await collect((async function* () { yield* events; })());
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 88, outputTokens: 210 });
    const next = buildOpenAIRequest({ ...weatherTurn1(MODEL), messages: [weatherTurn1(MODEL).messages[0]!, res.message] });
    expect((next["input"] as unknown[]).slice(1)).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: summary }], encrypted_content: "gAAAAABoX1ENCRYPTEDREASONINGBLOBexample0123456789==" },
      { type: "function_call", call_id: "call_ReasonedCall0001", name: "get_weather", arguments: '{"city":"Paris"}' },
    ]);
  });

  it("reports cached input tokens separately", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("text_only");
    const res = await collect(createOpenAIProvider({ apiKey: "k", fetch: f }).send(textRequest("gpt-5-mini")));
    expect(res.usage).toEqual({ inputTokens: 25, outputTokens: 10, cacheReadTokens: 2048 });
  });

  it("maps response.failed and stream error events to one error", async () => {
    const failed = await all(createOpenAIProvider({ apiKey: "k", fetch: fixtureFetch(DIR, { record: false }).queue("failed") }).send(textRequest(MODEL)));
    assertStreamShape(failed);
    expect(failed[failed.length - 1]).toEqual({
      type: "error",
      error: { kind: "server", retryable: true, message: "OpenAI response failed: server_error: The server had an error processing your request." },
    });
    const err = await all(createOpenAIProvider({ apiKey: "k", fetch: fixtureFetch(DIR, { record: false }).queue("stream_error") }).send(textRequest(MODEL)));
    expect(err[err.length - 1]).toMatchObject({ type: "error", error: { kind: "rate_limit", retryable: true } });
  });

  it("emits a call from function_call_arguments.done if output_item.done never arrives", async () => {
    const body = sse([
      CREATED,
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_a", name: "get_weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"city":' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"city":"Rome"}' },
      COMPLETED,
    ]);
    const res = await collect(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(weatherTurn1(MODEL)));
    expect(res.message.content).toEqual([{ type: "tool_use", id: "call_a", name: "get_weather", input: { city: "Rome" } }]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("handles output_item.done for a call that was never announced, and refusals", async () => {
    const body = sse([
      CREATED,
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_z", name: "get_weather", arguments: "{}" } },
      COMPLETED,
    ]);
    const res = await collect(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(weatherTurn1(MODEL)));
    expect(res.message.content).toEqual([{ type: "tool_use", id: "call_z", name: "get_weather", input: {} }]);

    const refusal = sse([CREATED, { type: "response.refusal.delta", delta: "I can't help with that." }, { type: "response.refusal.delta", delta: "" }, COMPLETED]);
    const r2 = await collect(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(refusal)) }).send(textRequest(MODEL)));
    expect(r2.stopReason).toBe("refusal");
    expect(r2.message.content).toEqual([{ type: "text", text: "I can't help with that." }]);
  });

  it("maps incomplete content_filter to refusal and other reasons by content", async () => {
    const incomplete = (reason: string) =>
      sse([CREATED, { type: "response.incomplete", response: { incomplete_details: { reason }, usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const run = async (reason: string) =>
      (await collect(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(incomplete(reason))) }).send(textRequest(MODEL)))).stopReason;
    expect(await run("content_filter")).toBe("refusal");
    expect(await run("something_else")).toBe("end_turn");
  });

  it("reads summary text from the item when no deltas came, and skips empty reasoning", async () => {
    const body = sse([
      CREATED,
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "A" }, { type: "summary_text", text: "B" }, {}] } },
      { type: "response.output_item.done", output_index: 1, item: { id: "rs_2", type: "reasoning", summary: [] } },
      { type: "response.output_item.done", output_index: 2, item: { id: "msg", type: "message" } },
      { type: "response.output_text.delta", delta: "" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_3", delta: "" },
      { type: "response.reasoning_summary_part.added", item_id: "rs_4" },
      { type: "response.function_call_arguments.delta", item_id: "unknown", delta: "x" },
      { type: "response.function_call_arguments.done", item_id: "unknown", arguments: "x" },
      { type: "response.some_future_event" },
      COMPLETED,
    ]);
    const events = await all(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(events.filter((e) => e.type === "reasoning_done")).toEqual([{ type: "reasoning_done", part: { type: "reasoning", text: "A\n\nB" } }]);
  });

  it("separates summary paragraphs when a new summary part starts", async () => {
    const body = sse([
      CREATED,
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "One." },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Two." },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      COMPLETED,
    ]);
    const res = await collect(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(res.message.content).toEqual([{ type: "reasoning", text: "One.\n\nTwo." }]);
  });

  it("a body that ends cleanly before response.completed is a retryable network error", async () => {
    const body = sse([CREATED, { type: "response.output_text.delta", delta: "partial" }]);
    const events = await all(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: { kind: "network", retryable: true, message: "OpenAI: stream ended before response.completed" },
    });
  });

  it("uses the request model when response.created has none, and errors without details", async () => {
    const body = sse([{ type: "response.created", response: {} }, { type: "error" }]);
    const events = await all(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(events).toEqual([
      { type: "message_start", model: MODEL },
      { type: "error", error: { kind: "server", retryable: true, message: "OpenAI stream error: unknown error" } },
    ]);
    const failed = sse([CREATED, { type: "response.failed", response: {} }]);
    const e2 = await all(createOpenAIProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(failed)) }).send(textRequest(MODEL)));
    expect(e2[e2.length - 1]).toMatchObject({ type: "error", error: { kind: "server" } });
  });
});

describe("OpenAI HTTP details", () => {
  it("sends a bearer token to {base}/v1/responses", async () => {
    const f = stubFetch(() => sseResponse(sse([CREATED, COMPLETED])));
    await all(createOpenAIProvider({ apiKey: "sk-real", fetch: f, baseUrl: "https://gw.example.com", headers: { "openai-organization": "org_1" } }).send(textRequest(MODEL)));
    expect(f.calls[0]?.url).toBe("https://gw.example.com/v1/responses");
    const h = f.calls[0]?.init?.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer sk-real");
    expect(h["openai-organization"]).toBe("org_1");
  });

  it("models() keeps chat models only and labels known ones from the fallback config", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("models");
    const models = await createOpenAIProvider({ apiKey: "k", fetch: f }).models();
    expect(models.map((m) => m.id)).toEqual(["gpt-5", "gpt-5-codex", "gpt-5-mini", "o4-mini"]);
    expect(models.find((m) => m.id === "gpt-5-codex")?.label).toBe("GPT-5 Codex");
    expect(models.find((m) => m.id === "o4-mini")).toEqual({ id: "o4-mini", provider: "openai", label: "o4-mini", supportsTools: true, tier: "fast" });
  });

  it("models() uses a configurable fallback list", async () => {
    const custom: ModelInfo[] = [{ id: "my-model", provider: "openai", label: "Mine", supportsTools: true }];
    const down = stubFetch(() => new Response("", { status: 503 }));
    expect(await createOpenAIProvider({ apiKey: "k", fetch: down }).models()).toEqual(OPENAI_FALLBACK_MODELS);
    expect(await createOpenAIProvider({ apiKey: "k", fetch: down, fallbackModels: custom }).models()).toEqual(custom);
    const odd = stubFetch(() => jsonResponse({ data: [{ id: "whisper-1" }, { id: "gpt-9-turbo" }, 7] }));
    expect((await createOpenAIProvider({ apiKey: "k", fetch: odd }).models()).map((m) => m.id)).toEqual(["gpt-9-turbo"]);
    const none = stubFetch(() => jsonResponse({ data: [{ id: "whisper-1" }] }));
    expect(await createOpenAIProvider({ apiKey: "k", fetch: none }).models()).toEqual(OPENAI_FALLBACK_MODELS);
    const weird = stubFetch(() => jsonResponse([]));
    expect(await createOpenAIProvider({ apiKey: "k", fetch: weird }).models()).toEqual(OPENAI_FALLBACK_MODELS);
  });

  it("countTokens calls /v1/responses/input_tokens", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("input_tokens");
    expect(await createOpenAIProvider({ apiKey: "k", fetch: f }).countTokens(weatherTurn1(MODEL))).toBe(88);
    expect(f.requests[0]?.url).toBe("https://api.openai.com/v1/responses/input_tokens");
    expect(f.requests[0]?.body).toEqual(buildOpenAICountRequest(weatherTurn1(MODEL)));
    const odd = stubFetch(() => jsonResponse({}));
    expect(await createOpenAIProvider({ apiKey: "k", fetch: odd }).countTokens(weatherTurn1(MODEL))).toBeGreaterThan(0);
  });
});
