import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect, type ChatRequest } from "@oneseat/contracts";
import {
  buildGoogleCountRequest,
  buildGoogleRequest,
  createGoogleProvider,
  fixtureFetch,
  geminiThinkingConfig,
  GOOGLE_FALLBACK_MODELS,
} from "../src/index.js";
import { all, assertStreamShape, FIXTURES, jsonResponse, sseResponse, stubFetch, textRequest, weatherTurn1, WEATHER_QUESTION } from "./helpers.js";

const DIR = join(FIXTURES, "google");
const MODEL = "gemini-2.5-pro";

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
}
function chunk(parts: unknown[], finishReason?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), index: 0 }], modelVersion: MODEL, ...extra };
}

describe("buildGoogleRequest", () => {
  const base: ChatRequest = weatherTurn1(MODEL);

  it("maps the scenario to generateContent", () => {
    expect(buildGoogleRequest(base)).toEqual({
      systemInstruction: { parts: [{ text: "You are a weather bot" }] },
      contents: [{ role: "user", parts: [{ text: "What's the weather in Paris?" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get the current weather for a city",
              parameters: { type: "object", properties: { city: { type: "string", description: "City name, e.g. Paris" } }, required: ["city"] },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1024 },
    });
  });

  it("maps tool_choice to functionCallingConfig", () => {
    expect(buildGoogleRequest({ ...base, toolChoice: "auto" })["toolConfig"]).toBeUndefined();
    expect(buildGoogleRequest({ ...base, toolChoice: "any" })["toolConfig"]).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(buildGoogleRequest({ ...base, toolChoice: "none" })["toolConfig"]).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(buildGoogleRequest({ ...base, toolChoice: { name: "get_weather" } })["toolConfig"]).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
    });
  });

  it("omits parameters for a tool with no properties", () => {
    const body = buildGoogleRequest({ ...base, tools: [{ name: "now", description: "Current time", inputSchema: { type: "object" } }] });
    expect(body["tools"]).toEqual([{ functionDeclarations: [{ name: "now", description: "Current time" }] }]);
  });

  it("maps effort to thinkingConfig, temperature, and skips empty system", () => {
    const body = buildGoogleRequest({ ...textRequest(MODEL), effort: "medium", temperature: 0.3 });
    expect(body["generationConfig"]).toEqual({ maxOutputTokens: 64, temperature: 0.3, thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } });
    expect(body).not.toHaveProperty("systemInstruction");
    expect(body).not.toHaveProperty("tools");
  });

  it("geminiThinkingConfig: budgets for 2.x, levels otherwise", () => {
    expect(geminiThinkingConfig("gemini-2.5-flash", "low")).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    expect(geminiThinkingConfig("models/gemini-2.5-pro", "high")).toEqual({ thinkingBudget: 24576, includeThoughts: true });
    expect(geminiThinkingConfig("gemini-next-pro", "medium")).toEqual({ thinkingLevel: "high", includeThoughts: true });
    expect(geminiThinkingConfig("gemini-next-flash", "medium")).toEqual({ thinkingLevel: "medium", includeThoughts: true });
    expect(geminiThinkingConfig("gemini-next-pro", "low")).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("maps images, errors, native ids, signed thoughts, and merges same-role turns", () => {
    const body = buildGoogleRequest({
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image", mediaType: "image/webp", data: "UklGR" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "unsigned" },
            { type: "reasoning", text: "signed thought", providerMeta: { google: { thoughtSignature: "TS1" } } },
            { type: "tool_use", id: "fc_native", name: "get_weather", input: { city: "Paris" }, providerMeta: { google: { id: "fc_native" } } },
            { type: "tool_use", id: "call_gen", name: "get_weather", input: { city: "Rome" }, providerMeta: { anthropic: { x: 1 } } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "thanks" },
            { type: "tool_result", toolUseId: "fc_native", name: "get_weather", content: "18C" },
            { type: "tool_result", toolUseId: "call_gen", name: "get_weather", content: "no data", isError: true },
          ],
        },
        { role: "user", content: [{ type: "text", text: "" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
      ],
    });
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "see" }, { inlineData: { mimeType: "image/webp", data: "UklGR" } }] },
      {
        role: "model",
        parts: [
          { text: "signed thought", thought: true, thoughtSignature: "TS1" },
          { functionCall: { id: "fc_native", name: "get_weather", args: { city: "Paris" } } },
          { functionCall: { name: "get_weather", args: { city: "Rome" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "fc_native", name: "get_weather", response: { result: "18C" } } },
          { functionResponse: { name: "get_weather", response: { error: "no data" } } },
          { text: "thanks" },
          { text: "more" },
        ],
      },
    ]);
  });

  it("count request wraps a generateContentRequest without generationConfig", () => {
    expect(buildGoogleCountRequest({ ...base, model: "models/gemini-2.5-pro" })).toEqual({
      generateContentRequest: {
        model: "models/gemini-2.5-pro",
        systemInstruction: { parts: [{ text: "You are a weather bot" }] },
        contents: [{ role: "user", parts: [{ text: "What's the weather in Paris?" }] }],
        tools: buildGoogleRequest(base)["tools"],
      },
    });
  });
});

describe("Gemini thought signatures", () => {
  it("keeps the signature on the call and sends it back on the same part", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("thinking");
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: f }).send({ ...weatherTurn1(MODEL), effort: "high" }));
    assertStreamShape(events);
    expect(events.map((e) => e.type)).toEqual(["message_start", "reasoning_delta", "reasoning_delta", "reasoning_done", "tool_call", "message_end"]);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({
      type: "tool_call",
      call: { name: "get_weather", input: { city: "Paris" }, providerMeta: { google: { thoughtSignature: "CiQBVKhc7nRoaW5raW5nX3RoZW5fY2FsbF9zaWduYXR1cmU=" } } },
    });
    const res = await collect((async function* () { yield* events; })());
    expect(res.usage).toEqual({ inputTokens: 61, outputTokens: 99 });
    const next = buildGoogleRequest({ ...weatherTurn1(MODEL), messages: [WEATHER_QUESTION, res.message] });
    // The unsigned thought summary is dropped; the signed call keeps its signature.
    expect((next["contents"] as unknown[])[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "CiQBVKhc7nRoaW5raW5nX3RoZW5fY2FsbF9zaWduYXR1cmU=" },
      ],
    });
  });

  it("parallel calls: only the first carries the signature, and order is preserved on the way back", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("parallel_tools");
    const res = await collect(createGoogleProvider({ apiKey: "k", fetch: f }).send(weatherTurn1(MODEL)));
    const calls = res.message.content.filter((p) => p.type === "tool_use");
    expect(calls.map((c) => (c.type === "tool_use" ? c.providerMeta : undefined))).toEqual([
      { google: { thoughtSignature: "CiQBVKhc7nBhcmFsbGVsX2ZpcnN0X2NhbGxfc2lnbmF0dXJl" } },
      undefined,
    ]);
    const next = buildGoogleRequest({ ...weatherTurn1(MODEL), messages: [WEATHER_QUESTION, res.message] });
    expect(((next["contents"] as { parts: unknown[] }[])[1]?.parts)).toEqual([
      { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "CiQBVKhc7nBhcmFsbGVsX2ZpcnN0X2NhbGxfc2lnbmF0dXJl" },
      { functionCall: { name: "get_weather", args: { city: "London" } } },
    ]);
  });

  it("keeps a signature found on a thought part", async () => {
    const body = sse([chunk([{ text: "pondering", thought: true, thoughtSignature: "TSX" }]), chunk([{ text: "Answer" }], "STOP")]);
    const res = await collect(createGoogleProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(res.message.content).toEqual([
      { type: "reasoning", text: "pondering", providerMeta: { google: { thoughtSignature: "TSX" } } },
      { type: "text", text: "Answer" },
    ]);
  });
});

describe("Gemini call ids", () => {
  it("generates ids that are stable for the same request and differ across turns", async () => {
    const run = async (req: ChatRequest) => {
      const f = fixtureFetch(DIR, { record: false }).queue("parallel_tools");
      const r = await collect(createGoogleProvider({ apiKey: "k", fetch: f }).send(req));
      return r.message.content.flatMap((p) => (p.type === "tool_use" ? [p.id] : []));
    };
    const a = await run(weatherTurn1(MODEL));
    const b = await run(weatherTurn1(MODEL));
    const c = await run({ ...weatherTurn1(MODEL), messages: [{ role: "user", content: [{ type: "text", text: "And tomorrow?" }] }] });
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
    expect(c[0]).not.toBe(a[0]);
    for (const id of [...a, ...c]) expect(id).toMatch(/^call_[0-9a-f]{8}\d+$/);
  });

  it("uses Gemini's own id when it sends one and round-trips it", async () => {
    const body = sse([chunk([{ functionCall: { id: "fc-123", name: "get_weather", args: { city: "Nice" } } }], "STOP")]);
    const res = await collect(createGoogleProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(weatherTurn1(MODEL)));
    expect(res.message.content).toEqual([
      { type: "tool_use", id: "fc-123", name: "get_weather", input: { city: "Nice" }, providerMeta: { google: { id: "fc-123" } } },
    ]);
  });
});

describe("Gemini finish reasons and errors", () => {
  it.each([
    ["safety", "refusal"],
    ["prompt_blocked", "refusal"],
    ["max_tokens", "max_tokens"],
  ])("%s -> %s", async (fixture, stop) => {
    const f = fixtureFetch(DIR, { record: false }).queue(fixture);
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: f }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events[events.length - 1]).toMatchObject({ type: "message_end", stopReason: stop });
  });

  it("MALFORMED_FUNCTION_CALL is a retryable error", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("malformed_call");
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: f }).send(weatherTurn1(MODEL)));
    assertStreamShape(events);
    expect(events[events.length - 1]).toEqual({
      type: "error",
      error: { kind: "server", retryable: true, message: "Gemini: generation stopped with MALFORMED_FUNCTION_CALL: Malformed function call: get_weather(city=Paris" },
    });
  });

  it("an invalid API key (400 API_KEY_INVALID) is an auth error", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("error_api_key_invalid");
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: f }).send(textRequest(MODEL)));
    expect(events).toEqual([
      { type: "error", error: { kind: "auth", status: 400, retryable: false, message: "Gemini API error 400: INVALID_ARGUMENT: API key not valid. Please pass a valid API key." } },
    ]);
  });

  it("an error object inside the stream ends it", async () => {
    const body = sse([chunk([{ text: "Hi" }]), { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }]);
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "error"]);
    expect(events[2]).toMatchObject({ error: { kind: "overloaded", retryable: true } });
    const bare = sse([{ error: {} }]);
    const e2 = await all(createGoogleProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(bare)) }).send(textRequest(MODEL)));
    expect(e2).toEqual([{ type: "error", error: { kind: "server", retryable: true, message: "Gemini stream error: unknown error" } }]);
  });

  it("an error body sent as a JSON array is understood", async () => {
    const f = stubFetch(() => jsonResponse([{ error: { code: 404, message: "models/x is not found", status: "NOT_FOUND" } }], 404));
    const events = await all(createGoogleProvider({ apiKey: "k", fetch: f }).send(textRequest(MODEL)));
    expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "not_found", message: expect.stringContaining("NOT_FOUND") }) }]);
  });

  it("tolerates odd chunks: arrays, no candidates, non-object parts, finishReason OTHER", async () => {
    const body = sse([
      [chunk([{ text: "A" }])],
      { usageMetadata: { promptTokenCount: 3 } },
      chunk([7, { inlineData: { mimeType: "image/png", data: "x" } }, { text: "" }, { text: "B" }], "OTHER", { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }),
    ]);
    const res = await collect(createGoogleProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(res.message.content).toEqual([{ type: "text", text: "AB" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});

describe("Gemini HTTP details", () => {
  it("posts to :streamGenerateContent?alt=sse with the key in x-goog-api-key", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("text_only");
    const res = await collect(createGoogleProvider({ apiKey: "AIzaFAKEKEY", fetch: f }).send(textRequest("models/gemini-2.5-flash")));
    expect(res.usage).toEqual({ inputTokens: 25, outputTokens: 10, cacheReadTokens: 2048 });
    const req = f.requests[0];
    expect(req?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(req?.url).not.toContain("key=");
    expect(req?.headers["x-goog-api-key"]).toBe("[REDACTED]");
  });

  it("models() follows pages, keeps generateContent models, and reads limits", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("models", "models_page2");
    const models = await createGoogleProvider({ apiKey: "k", fetch: f }).models();
    expect(models).toEqual([
      { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro", supportsTools: true, contextWindow: 1048576, maxOutputTokens: 65536, tier: "frontier" },
      { id: "gemini-2.5-flash-lite", provider: "google", label: "Gemini 2.5 Flash-Lite", supportsTools: true, contextWindow: 1048576, maxOutputTokens: 65536, tier: "fast" },
      { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash", supportsTools: true, contextWindow: 1048576, maxOutputTokens: 65536, tier: "balanced" },
      { id: "gemma-3-27b-it", provider: "google", label: "Gemma 3 27B", supportsTools: false, contextWindow: 131072, maxOutputTokens: 8192 },
    ]);
    expect(f.requests[1]?.url).toContain("pageToken=page-2");
  });

  it("models() falls back to the configured list", async () => {
    const down = stubFetch(() => new Response("", { status: 500 }));
    expect(await createGoogleProvider({ apiKey: "k", fetch: down }).models()).toEqual(GOOGLE_FALLBACK_MODELS);
    const custom = [{ id: "g", provider: "google" as const, label: "G", supportsTools: true }];
    const empty = stubFetch(() => jsonResponse({ models: [{ name: "models/e", supportedGenerationMethods: ["embedContent"] }, 3, { supportedGenerationMethods: ["generateContent"] }] }));
    expect(await createGoogleProvider({ apiKey: "k", fetch: empty, fallbackModels: custom }).models()).toEqual(custom);
    const weird = stubFetch(() => jsonResponse({}));
    expect(await createGoogleProvider({ apiKey: "k", fetch: weird }).models()).toEqual(GOOGLE_FALLBACK_MODELS);
  });

  it("countTokens uses :countTokens", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("count_tokens");
    expect(await createGoogleProvider({ apiKey: "k", fetch: f }).countTokens(weatherTurn1(MODEL))).toBe(61);
    expect(f.requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens");
    const odd = stubFetch(() => jsonResponse({}));
    expect(await createGoogleProvider({ apiKey: "k", fetch: odd }).countTokens(weatherTurn1(MODEL))).toBeGreaterThan(0);
    const down = stubFetch(() => new Response("", { status: 500 }));
    expect(await createGoogleProvider({ apiKey: "k", fetch: down }).countTokens(weatherTurn1(MODEL))).toBeGreaterThan(0);
  });
});
