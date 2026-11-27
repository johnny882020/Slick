import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ChatEvent, ChatRequest, FetchLike, Message, ModelProvider, ProviderId, ToolSpec } from "@oneseat/contracts";
import {
  createAnthropicProvider,
  createGoogleProvider,
  createLocalProvider,
  createOpenAIProvider,
  fixtureFetch,
  type FixtureFetch,
  type FixtureFetchOptions,
} from "../src/index.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export const WEATHER_TOOL: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", description: "City name, e.g. Paris" } },
    required: ["city"],
    additionalProperties: false,
  },
};

export const WEATHER_SYSTEM = "You are a weather bot";
export const WEATHER_QUESTION: Message = { role: "user", content: [{ type: "text", text: "What's the weather in Paris?" }] };
export const WEATHER_RESULT = '{"city":"Paris","temperature_c":18,"conditions":"partly cloudy"}';

export function weatherTurn1(model: string): ChatRequest {
  return { model, system: WEATHER_SYSTEM, messages: [WEATHER_QUESTION], tools: [WEATHER_TOOL], maxTokens: 1024 };
}

export function weatherTurn2(model: string, assistant: Message, callId: string): ChatRequest {
  return {
    ...weatherTurn1(model),
    messages: [
      WEATHER_QUESTION,
      assistant,
      { role: "user", content: [{ type: "tool_result", toolUseId: callId, name: "get_weather", content: WEATHER_RESULT }] },
    ],
  };
}

export function textRequest(model: string, text = "Hi"): ChatRequest {
  return { model, system: "", messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [], maxTokens: 64 };
}

export async function all(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** Assert the ModelProvider stream contract on a finished event list. */
export function assertStreamShape(events: ChatEvent[]): void {
  if (events.length === 0) throw new Error("empty stream");
  const terminal = events.filter((e) => e.type === "message_end" || e.type === "error");
  if (terminal.length !== 1) throw new Error(`expected exactly one terminal event, got ${terminal.length}`);
  const last = events[events.length - 1] as ChatEvent;
  if (last.type !== "message_end" && last.type !== "error") throw new Error(`last event was ${last.type}`);
  const starts = events.filter((e) => e.type === "message_start").length;
  if (last.type === "message_end") {
    if (events[0]?.type !== "message_start") throw new Error("message_start must come first");
    if (starts !== 1) throw new Error(`expected one message_start, got ${starts}`);
  } else if (starts > 1 || (starts === 1 && events[0]?.type !== "message_start")) {
    throw new Error("bad message_start placement");
  }
}

export interface ProviderCase {
  id: ProviderId;
  model: string;
  envKey?: string;
  dir: string;
  make(fetch: FetchLike, apiKey?: string): ModelProvider;
}

export const TEST_KEY = "sk-test-SECRET-0123456789abcdef";

export const PROVIDER_CASES: ProviderCase[] = [
  {
    id: "anthropic",
    model: "claude-opus-5-5",
    envKey: "ANTHROPIC_API_KEY",
    dir: join(FIXTURES, "anthropic"),
    make: (fetch, apiKey = TEST_KEY) => createAnthropicProvider({ apiKey, fetch }),
  },
  {
    id: "openai",
    model: "gpt-5-codex",
    envKey: "OPENAI_API_KEY",
    dir: join(FIXTURES, "openai"),
    make: (fetch, apiKey = TEST_KEY) => createOpenAIProvider({ apiKey, fetch }),
  },
  {
    id: "google",
    model: "gemini-2.5-pro",
    envKey: "GEMINI_API_KEY",
    dir: join(FIXTURES, "google"),
    make: (fetch, apiKey = TEST_KEY) => createGoogleProvider({ apiKey, fetch }),
  },
  {
    id: "local",
    model: "qwen3:8b",
    dir: join(FIXTURES, "local"),
    make: (fetch, apiKey = TEST_KEY) => createLocalProvider({ apiKey, fetch }),
  },
];

export function fixtures(c: ProviderCase, opts: FixtureFetchOptions = {}): FixtureFetch {
  return fixtureFetch(c.dir, { record: false, ...opts });
}

/** A fetch that answers every request with the given Response factory. */
export function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike & {
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    return respond(url, init);
  }) as FetchLike & { calls: { url: string; init?: RequestInit }[] };
  f.calls = calls;
  return f;
}

export function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
