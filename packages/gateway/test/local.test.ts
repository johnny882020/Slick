import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "@oneseat/contracts";
import { buildLocalRequest, createLocalProvider, fixtureFetch } from "../src/index.js";
import { all, assertStreamShape, FIXTURES, jsonResponse, sseResponse, stubFetch, textRequest, weatherTurn1 } from "./helpers.js";

const DIR = join(FIXTURES, "local");
const MODEL = "qwen3:8b";

function sse(chunks: unknown[], done = true): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}
function delta(d: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: "c", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: d, finish_reason: finish }] };
}

describe("local provider", () => {
  it("is marked experimental and defaults to Ollama's address", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("text_only");
    const p = createLocalProvider({ apiKey: "", fetch: f });
    expect(p.experimental).toBe(true);
    expect(p.id).toBe("local");
    await all(p.send(textRequest("llama3.2:3b")));
    expect(f.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(f.requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("builds a Chat Completions body with tools, tool_choice and effort", () => {
    const req = { ...weatherTurn1(MODEL), effort: "low" as const, temperature: 0 };
    expect(buildLocalRequest({ ...req, toolChoice: "any" })["tool_choice"]).toBe("required");
    expect(buildLocalRequest({ ...req, toolChoice: "none" })["tool_choice"]).toBe("none");
    expect(buildLocalRequest({ ...req, toolChoice: { name: "get_weather" } })["tool_choice"]).toEqual({ type: "function", function: { name: "get_weather" } });
    const body = buildLocalRequest(req);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["temperature"]).toBe(0);
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  it("maps mixed user content, images, error results, and skips empty turns", () => {
    const body = buildLocalRequest({
      ...textRequest(MODEL),
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        { role: "user", content: [{ type: "text", text: "pic" }, { type: "image", mediaType: "image/gif", data: "R0lG" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "hidden" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure." }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", name: "t", content: "bad", isError: true }] },
      ],
    });
    expect(body["messages"]).toEqual([
      { role: "user", content: "a\nb" },
      {
        role: "user",
        content: [
          { type: "text", text: "pic" },
          { type: "image_url", image_url: { url: "data:image/gif;base64,R0lG" } },
        ],
      },
      { role: "assistant", content: "Sure." },
      { role: "tool", tool_call_id: "c1", content: "Error: bad" },
    ]);
  });

  it("streams reasoning (Ollama `reasoning` field) before text", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("reasoning");
    const events = await all(createLocalProvider({ apiKey: "", fetch: f }).send(textRequest(MODEL)));
    assertStreamShape(events);
    expect(events.map((e) => e.type)).toEqual(["message_start", "reasoning_delta", "reasoning_delta", "reasoning_done", "text_delta", "message_end"]);
    // The stream had no [DONE] and no usage: finish_reason is enough.
    expect(events[events.length - 1]).toEqual({ type: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("accepts `reasoning_content`, parsed-object arguments, missing ids, and stop-with-tools", async () => {
    const body = sse([
      delta({ reasoning_content: "think" }),
      delta({ tool_calls: [{ function: { name: "get_weather", arguments: { city: "Oslo" } } }] }),
      delta({}, "stop"),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } },
    ]);
    const res = await collect(createLocalProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(weatherTurn1(MODEL)));
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 4, outputTokens: 4, cacheReadTokens: 6 });
    const call = res.message.content.find((p) => p.type === "tool_use");
    expect(call).toMatchObject({ type: "tool_use", name: "get_weather", input: { city: "Oslo" } });
    expect(call && call.type === "tool_use" ? call.id : "").toMatch(/^call_[0-9a-f]{8}0$/);
  });

  it("maps length and content_filter, ignores events after [DONE] and odd chunks", async () => {
    const run = async (finish: string) => {
      const body = sse([delta({ content: "x" }, finish)]) + "data: {\"choices\":[]}\n\n";
      return (await collect(createLocalProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)))).stopReason;
    };
    expect(await run("length")).toBe("max_tokens");
    expect(await run("content_filter")).toBe("refusal");
    const odd = sse([[1, 2], { choices: [7] }, delta({ content: "ok" }, "stop")]);
    const res = await collect(createLocalProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(odd)) }).send(textRequest(MODEL)));
    expect(res.message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("an error chunk in the stream is one error event", async () => {
    const body = sse([{ error: { message: "model not loaded", type: "server_error" } }], false);
    const events = await all(createLocalProvider({ apiKey: "k", fetch: stubFetch(() => sseResponse(body)) }).send(textRequest(MODEL)));
    expect(events).toEqual([{ type: "error", error: { kind: "server", retryable: true, message: "Local model server stream error: server_error: model not loaded" } }]);
  });

  it("sends a bearer token only when a key is set, to a custom base URL", async () => {
    const f = stubFetch(() => sseResponse(sse([delta({ content: "hi" }, "stop")])));
    await all(createLocalProvider({ apiKey: "lm-studio", baseUrl: "http://localhost:1234", fetch: f }).send(textRequest(MODEL)));
    expect(f.calls[0]?.url).toBe("http://localhost:1234/v1/chat/completions");
    expect((f.calls[0]?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer lm-studio");
  });

  it("models() lists served models and returns [] when no server answers", async () => {
    const f = fixtureFetch(DIR, { record: false }).queue("models");
    expect(await createLocalProvider({ apiKey: "", fetch: f }).models()).toEqual([
      { id: "qwen3:8b", provider: "local", label: "qwen3:8b (local, experimental)", supportsTools: true },
      { id: "llama3.2:3b", provider: "local", label: "llama3.2:3b (local, experimental)", supportsTools: true },
    ]);
    const down = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await createLocalProvider({ apiKey: "", fetch: down }).models()).toEqual([]);
    const odd = stubFetch(() => jsonResponse({ models: [] }));
    expect(await createLocalProvider({ apiKey: "", fetch: odd }).models()).toEqual([]);
    const partial = stubFetch(() => jsonResponse({ data: [{ id: "a" }, { name: "b" }, null] }));
    expect((await createLocalProvider({ apiKey: "", fetch: partial }).models()).map((m) => m.id)).toEqual(["a"]);
  });

  it("countTokens estimates locally without a request", async () => {
    const f = stubFetch(() => {
      throw new Error("no request expected");
    });
    expect(await createLocalProvider({ apiKey: "", fetch: f }).countTokens(weatherTurn1(MODEL))).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
  });
});
