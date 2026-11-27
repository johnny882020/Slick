// Local / OpenAI-compatible Chat Completions adapter (Ollama, LM Studio, llama.cpp server, vLLM).
// POST {base}/v1/chat/completions with stream: true.
// EXPERIMENTAL: local servers differ in how well they stream tool calls and report usage.

import {
  estimateTokens,
  type ChatEvent,
  type ChatRequest,
  type ModelInfo,
  type ModelProvider,
  type ProviderConfig,
  type StopReason,
  type Usage,
} from "@oneseat/contracts";
import { providerError } from "../errors.js";
import {
  TruncatedStreamError,
  fnv1a,
  isRecord,
  joinUrl,
  num,
  parseJsonData,
  parseToolInput,
  requestJson,
  resolveFetch,
  secretsOf,
  str,
  streamChat,
  type StreamDecoder,
} from "../http.js";
import { toObjectSchema } from "../schema.js";
import type { SSEMessage } from "../sse.js";
import { parseOpenAIError, TOOL_ERROR_PREFIX } from "./openai.js";

/** Ollama's default address. LM Studio uses http://localhost:1234. */
export const LOCAL_BASE_URL = "http://localhost:11434";
const LABEL = "Local model server";

export interface LocalProvider extends ModelProvider {
  readonly experimental: true;
}

type Msg = Record<string, unknown>;

function messagesOf(req: ChatRequest): Msg[] {
  const out: Msg[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const calls = m.content.flatMap((p) =>
        p.type === "tool_use" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }] : [],
      );
      if (!text && calls.length === 0) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: tool results become role "tool" messages, first.
    const parts: Msg[] = [];
    for (const p of m.content) {
      if (p.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: p.toolUseId, content: p.isError ? `${TOOL_ERROR_PREFIX}${p.content}` : p.content });
      } else if (p.type === "text" && p.text) {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image") {
        parts.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
      }
    }
    if (parts.length === 0) continue;
    const onlyText = parts.every((p) => p["type"] === "text");
    out.push({ role: "user", content: onlyText ? parts.map((p) => p["text"] as string).join("\n") : parts });
  }
  return out;
}

function toolChoice(req: ChatRequest): unknown {
  const c = req.toolChoice;
  if (!c || c === "auto") return undefined;
  if (c === "any") return "required";
  if (c === "none") return "none";
  return { type: "function", function: { name: c.name } };
}

/** Pure: the JSON body for POST /v1/chat/completions. */
export function buildLocalRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, messages: messagesOf(req) };
  if (req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toObjectSchema(t.inputSchema) },
    }));
    const tc = toolChoice(req);
    if (tc !== undefined) body["tool_choice"] = tc;
  }
  body["max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.effort) body["reasoning_effort"] = req.effort;
  body["stream"] = true;
  body["stream_options"] = { include_usage: true };
  return body;
}

const FINISH: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

interface PendingCall {
  id?: string;
  name: string;
  args: string;
}

class LocalDecoder implements StreamDecoder {
  private calls = new Map<number, PendingCall>();
  private finish: string | undefined;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private reasoning = "";
  private reasoningOpen = false;
  private done = false;
  private started = false;

  constructor(
    private readonly model: string,
    private readonly salt: string,
  ) {}

  private closeReasoning(): ChatEvent[] {
    if (!this.reasoningOpen) return [];
    this.reasoningOpen = false;
    const text = this.reasoning;
    this.reasoning = "";
    return [{ type: "reasoning_done", part: { type: "reasoning", text } }];
  }

  private finishEvents(): ChatEvent[] {
    const events = this.closeReasoning();
    const sorted = [...this.calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, pc] of sorted) {
      const id = pc.id ?? `call_${fnv1a(`${this.salt}|${index}|${pc.name}`)}${index}`;
      events.push({ type: "tool_call", call: { id, name: pc.name, input: parseToolInput(pc.args, LABEL, pc.name) } });
    }
    let stopReason: StopReason = (this.finish && FINISH[this.finish]) || "end_turn";
    // Some servers report "stop" even when they returned tool calls.
    if (sorted.length > 0 && stopReason === "end_turn") stopReason = "tool_use";
    this.done = true;
    events.push({ type: "message_end", stopReason, usage: { ...this.usage } });
    return events;
  }

  onMessage(msg: SSEMessage): ChatEvent[] {
    if (this.done) return [];
    if (msg.data.trim() === "[DONE]") return this.finishEvents();
    const d = parseJsonData(msg.data, LABEL);
    if (!isRecord(d)) return [];
    if (isRecord(d["error"])) {
      const info = parseOpenAIError(d, 0);
      return [{ type: "error", error: providerError(info.kind ?? "server", `${LABEL} stream error: ${info.message ?? "unknown error"}`) }];
    }
    const events: ChatEvent[] = [];
    if (!this.started) {
      this.started = true;
      events.push({ type: "message_start", model: str(d["model"]) ?? this.model });
    }
    if (isRecord(d["usage"])) {
      const u = d["usage"];
      this.usage = { inputTokens: num(u["prompt_tokens"]) ?? 0, outputTokens: num(u["completion_tokens"]) ?? 0 };
      const details = isRecord(u["prompt_tokens_details"]) ? u["prompt_tokens_details"] : {};
      const cached = num(details["cached_tokens"]);
      if (cached) {
        this.usage.inputTokens = Math.max(0, this.usage.inputTokens - cached);
        this.usage.cacheReadTokens = cached;
      }
    }
    const choices = Array.isArray(d["choices"]) ? d["choices"] : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    if (!choice) return events;
    const delta = isRecord(choice["delta"]) ? choice["delta"] : {};
    // Ollama sends `reasoning`, LM Studio / vLLM send `reasoning_content`.
    const r = str(delta["reasoning_content"]) ?? str(delta["reasoning"]);
    if (r) {
      this.reasoningOpen = true;
      this.reasoning += r;
      events.push({ type: "reasoning_delta", text: r });
    }
    const c = str(delta["content"]);
    if (c) {
      events.push(...this.closeReasoning());
      events.push({ type: "text_delta", text: c });
    }
    if (Array.isArray(delta["tool_calls"])) {
      events.push(...this.closeReasoning());
      delta["tool_calls"].forEach((tc, pos) => {
        if (!isRecord(tc)) return;
        const index = num(tc["index"]) ?? pos;
        const fn = isRecord(tc["function"]) ? tc["function"] : {};
        const pc = this.calls.get(index) ?? { name: "", args: "" };
        const id = str(tc["id"]);
        if (id) pc.id = id;
        const name = str(fn["name"]);
        if (name) pc.name = name;
        const args = fn["arguments"];
        // Most servers stream argument text; a few send a parsed object in one go.
        if (typeof args === "string") pc.args += args;
        else if (isRecord(args)) pc.args = JSON.stringify(args);
        this.calls.set(index, pc);
      });
    }
    const fr = str(choice["finish_reason"]);
    if (fr) this.finish = fr;
    return events;
  }

  onEnd(): ChatEvent[] {
    if (this.done) return [];
    // Some servers close the stream without [DONE]; a finish_reason is enough.
    if (this.finish) return this.finishEvents();
    throw new TruncatedStreamError(`${LABEL}: stream ended before a finish_reason`);
  }
}

export function createLocalProvider(config: ProviderConfig): LocalProvider {
  const fetch = resolveFetch(config);
  const base = config.baseUrl ?? LOCAL_BASE_URL;
  const secrets = secretsOf(config);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(config.headers ?? {}),
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  });

  return {
    id: "local",
    experimental: true,
    async models(): Promise<ModelInfo[]> {
      try {
        const body = await requestJson({
          provider: LABEL,
          fetch,
          url: joinUrl(base, "/v1/models"),
          method: "GET",
          headers: headers(),
          secrets,
          parseErrorBody: parseOpenAIError,
        });
        if (!isRecord(body) || !Array.isArray(body["data"])) return [];
        return body["data"].flatMap((m): ModelInfo[] => {
          const id = isRecord(m) ? str(m["id"]) : undefined;
          return id ? [{ id, provider: "local", label: `${id} (local, experimental)`, supportsTools: true }] : [];
        });
      } catch {
        // No server running: nothing to offer.
        return [];
      }
    },
    send(req: ChatRequest): AsyncIterable<ChatEvent> {
      const body = buildLocalRequest(req);
      return streamChat({
        provider: LABEL,
        fetch,
        url: joinUrl(base, "/v1/chat/completions"),
        headers: { ...headers(), accept: "text/event-stream" },
        body,
        ...(req.signal ? { signal: req.signal } : {}),
        secrets,
        parseErrorBody: parseOpenAIError,
        model: req.model,
        decoder: new LocalDecoder(req.model, fnv1a(JSON.stringify(body))),
      });
    },
    async countTokens(req: ChatRequest): Promise<number> {
      return estimateTokens(req);
    },
  };
}
