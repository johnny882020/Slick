// OpenAI Responses API adapter (the API Codex models use).
// POST {base}/v1/responses with stream: true, store: false.
// Docs: https://platform.openai.com/docs/api-reference/responses-streaming

import {
  estimateTokens,
  type ChatEvent,
  type ChatRequest,
  type ModelInfo,
  type ModelProvider,
  type ProviderConfig,
  type ProviderErrorKind,
  type ReasoningPart,
  type StopReason,
  type Usage,
} from "@oneseat/contracts";
import { providerError, type ErrorBodyParser } from "../errors.js";
import {
  TruncatedStreamError,
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

export const OPENAI_BASE_URL = "https://api.openai.com";
const LABEL = "OpenAI";

/**
 * CONFIG, not a statement of what OpenAI currently serves: the list shown when
 * GET /v1/models is unreachable. Override it with `fallbackModels`. models()
 * returns the live list whenever the API answers.
 */
export const OPENAI_FALLBACK_MODELS: readonly ModelInfo[] = [
  { id: "gpt-5", provider: "openai", label: "GPT-5", supportsTools: true, tier: "frontier" },
  { id: "gpt-5-codex", provider: "openai", label: "GPT-5 Codex", supportsTools: true, tier: "frontier" },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini", supportsTools: true, tier: "fast" },
];

export interface OpenAIProviderOptions extends ProviderConfig {
  /** Shown when the models endpoint fails. Defaults to OPENAI_FALLBACK_MODELS. */
  fallbackModels?: readonly ModelInfo[];
}

/** providerMeta shape for OpenAI reasoning items (round-trip with store: false). */
export interface OpenAIReasoningMeta {
  openai: { encryptedContent: string };
}

/** Prefix for tool results marked isError (the Responses API has no error flag). */
export const TOOL_ERROR_PREFIX = "Error: ";

type Item = Record<string, unknown>;

function inputItems(req: ChatRequest): Item[] {
  const items: Item[] = [];
  for (const m of req.messages) {
    let content: Item[] = [];
    const flush = () => {
      if (content.length > 0) items.push({ type: "message", role: m.role, content });
      content = [];
    };
    for (const p of m.content) {
      switch (p.type) {
        case "text":
          if (p.text.length > 0) content.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: p.text });
          break;
        case "image":
          if (m.role === "user") content.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}` });
          break;
        case "tool_use":
          flush();
          items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input) });
          break;
        case "tool_result":
          flush();
          items.push({
            type: "function_call_output",
            call_id: p.toolUseId,
            output: p.isError ? `${TOOL_ERROR_PREFIX}${p.content}` : p.content,
          });
          break;
        case "reasoning": {
          const meta = p.providerMeta?.["openai"];
          if (isRecord(meta) && typeof meta["encryptedContent"] === "string" && meta["encryptedContent"]) {
            flush();
            // No item id: with store: false the server keeps nothing to look it up by.
            items.push({
              type: "reasoning",
              summary: p.text ? [{ type: "summary_text", text: p.text }] : [],
              encrypted_content: meta["encryptedContent"],
            });
          }
          break;
        }
      }
    }
    flush();
  }
  return items;
}

function toolChoice(req: ChatRequest): unknown {
  const c = req.toolChoice;
  if (!c || c === "auto") return undefined;
  if (c === "any") return "required";
  if (c === "none") return "none";
  return { type: "function", name: c.name };
}

/** Pure: the JSON body for POST /v1/responses. */
export function buildOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model };
  if (req.system) body["instructions"] = req.system;
  body["input"] = inputItems(req);
  if (req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: toObjectSchema(t.inputSchema),
      strict: false,
    }));
    const tc = toolChoice(req);
    if (tc !== undefined) body["tool_choice"] = tc;
  }
  body["max_output_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.effort) {
    body["reasoning"] = { effort: req.effort };
    // store: false means reasoning must travel with the request to be reused.
    body["include"] = ["reasoning.encrypted_content"];
  }
  body["store"] = false;
  body["stream"] = true;
  return body;
}

/** Pure: the JSON body for POST /v1/responses/input_tokens. */
export function buildOpenAICountRequest(req: ChatRequest): Record<string, unknown> {
  const { stream: _s, store: _st, max_output_tokens: _m, include: _i, temperature: _t, ...rest } = buildOpenAIRequest(req);
  return rest;
}

const ERROR_CODES: Record<string, ProviderErrorKind> = {
  rate_limit_exceeded: "rate_limit",
  insufficient_quota: "rate_limit",
  // No credit left on the account: an account limit, not a server fault (never retried).
  credit_balance_exhausted: "rate_limit",
  billing_hard_limit_reached: "rate_limit",
  server_error: "server",
  server_is_overloaded: "overloaded",
  slow_down: "overloaded",
  invalid_api_key: "auth",
  invalid_prompt: "invalid_request",
  context_length_exceeded: "invalid_request",
  model_not_found: "not_found",
  vector_store_timeout: "server",
};

export const parseOpenAIError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return {};
  const e = isRecord(body["error"]) ? body["error"] : body;
  const message = str(e["message"]);
  const code = str(e["code"]) ?? str(e["type"]);
  const kind = code ? ERROR_CODES[code] : undefined;
  return { ...(message ? { message: code ? `${code}: ${message}` : message } : {}), ...(kind ? { kind } : {}) };
};

interface PendingCall {
  callId: string;
  name: string;
  args: string;
  emitted: boolean;
}

class OpenAIDecoder implements StreamDecoder {
  private calls = new Map<string, PendingCall>();
  private sawCall = false;
  private refusal = false;
  private reasoning = new Map<string, string>();
  private done = false;

  constructor(private readonly model: string) {}

  private key(d: Record<string, unknown>, item?: Record<string, unknown>): string {
    return str(item?.["id"]) ?? str(d["item_id"]) ?? `idx_${num(d["output_index"]) ?? 0}`;
  }

  private emitCall(pc: PendingCall): ChatEvent[] {
    if (pc.emitted) return [];
    pc.emitted = true;
    this.sawCall = true;
    return [{ type: "tool_call", call: { id: pc.callId, name: pc.name, input: parseToolInput(pc.args, LABEL, pc.name) } }];
  }

  private usageOf(resp: Record<string, unknown>): Usage {
    const u = isRecord(resp["usage"]) ? resp["usage"] : {};
    const input = num(u["input_tokens"]) ?? 0;
    const details = isRecord(u["input_tokens_details"]) ? u["input_tokens_details"] : {};
    const cached = num(details["cached_tokens"]) ?? 0;
    const usage: Usage = { inputTokens: Math.max(0, input - cached), outputTokens: num(u["output_tokens"]) ?? 0 };
    if (cached > 0) usage.cacheReadTokens = cached;
    return usage;
  }

  /** Emit calls that completed but whose output_item.done never arrived. */
  private flushCalls(): ChatEvent[] {
    const out: ChatEvent[] = [];
    for (const pc of this.calls.values()) out.push(...this.emitCall(pc));
    return out;
  }

  onMessage(msg: SSEMessage): ChatEvent[] {
    const d = parseJsonData(msg.data, LABEL);
    if (!isRecord(d)) return [];
    const type = str(d["type"]) ?? msg.event;
    switch (type) {
      case "response.created": {
        const r = isRecord(d["response"]) ? d["response"] : {};
        return [{ type: "message_start", model: str(r["model"]) ?? this.model }];
      }
      case "response.output_item.added": {
        const item = isRecord(d["item"]) ? d["item"] : {};
        if (item["type"] === "function_call") {
          this.calls.set(this.key(d, item), {
            callId: str(item["call_id"]) ?? str(item["id"]) ?? `call_${this.calls.size}`,
            name: str(item["name"]) ?? "",
            args: str(item["arguments"]) ?? "",
            emitted: false,
          });
        }
        return [];
      }
      case "response.output_text.delta": {
        const t = str(d["delta"]) ?? "";
        return t ? [{ type: "text_delta", text: t }] : [];
      }
      case "response.refusal.delta": {
        this.refusal = true;
        const t = str(d["delta"]) ?? "";
        return t ? [{ type: "text_delta", text: t }] : [];
      }
      case "response.function_call_arguments.delta": {
        const pc = this.calls.get(this.key(d));
        if (pc) pc.args += str(d["delta"]) ?? "";
        return [];
      }
      case "response.function_call_arguments.done": {
        const pc = this.calls.get(this.key(d));
        const args = str(d["arguments"]);
        if (pc && args !== undefined) pc.args = args;
        return [];
      }
      case "response.reasoning_summary_text.delta": {
        const t = str(d["delta"]) ?? "";
        const k = this.key(d);
        this.reasoning.set(k, (this.reasoning.get(k) ?? "") + t);
        return t ? [{ type: "reasoning_delta", text: t }] : [];
      }
      case "response.reasoning_summary_part.added": {
        // A new summary paragraph: separate it from the previous one.
        const k = this.key(d);
        const prev = this.reasoning.get(k);
        if (prev) this.reasoning.set(k, `${prev}\n\n`);
        return [];
      }
      case "response.output_item.done": {
        const item = isRecord(d["item"]) ? d["item"] : {};
        if (item["type"] === "function_call") {
          const k = this.key(d, item);
          const pc = this.calls.get(k) ?? {
            callId: str(item["call_id"]) ?? str(item["id"]) ?? `call_${this.calls.size}`,
            name: str(item["name"]) ?? "",
            args: "",
            emitted: false,
          };
          const args = str(item["arguments"]);
          if (args !== undefined) pc.args = args;
          if (str(item["name"])) pc.name = str(item["name"]) as string;
          this.calls.set(k, pc);
          return this.emitCall(pc);
        }
        if (item["type"] === "reasoning") {
          const k = this.key(d, item);
          let text = this.reasoning.get(k) ?? "";
          if (!text && Array.isArray(item["summary"])) {
            text = item["summary"]
              .map((s) => (isRecord(s) ? (str(s["text"]) ?? "") : ""))
              .filter(Boolean)
              .join("\n\n");
          }
          const enc = str(item["encrypted_content"]);
          if (!text && !enc) return [];
          const part: ReasoningPart = { type: "reasoning", text: text.trim() };
          if (enc) part.providerMeta = { openai: { encryptedContent: enc } };
          return [{ type: "reasoning_done", part }];
        }
        return [];
      }
      case "response.completed": {
        const r = isRecord(d["response"]) ? d["response"] : {};
        const events = this.flushCalls();
        this.done = true;
        const stopReason: StopReason = this.sawCall ? "tool_use" : this.refusal ? "refusal" : "end_turn";
        events.push({ type: "message_end", stopReason, usage: this.usageOf(r) });
        return events;
      }
      case "response.incomplete": {
        const r = isRecord(d["response"]) ? d["response"] : {};
        const details = isRecord(r["incomplete_details"]) ? r["incomplete_details"] : {};
        const reason = str(details["reason"]);
        this.done = true;
        // Arguments of an unfinished call are not trustworthy: do not emit them.
        const stopReason: StopReason =
          reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : this.sawCall ? "tool_use" : "end_turn";
        return [{ type: "message_end", stopReason, usage: this.usageOf(r) }];
      }
      case "response.failed": {
        const r = isRecord(d["response"]) ? d["response"] : {};
        const info = parseOpenAIError(isRecord(r["error"]) ? { error: r["error"] } : {}, 0);
        return [
          { type: "error", error: providerError(info.kind ?? "server", `${LABEL} response failed: ${info.message ?? "unknown error"}`) },
        ];
      }
      case "error": {
        const info = parseOpenAIError(d, 0);
        return [{ type: "error", error: providerError(info.kind ?? "server", `${LABEL} stream error: ${info.message ?? "unknown error"}`) }];
      }
      default:
        return [];
    }
  }

  onEnd(): ChatEvent[] {
    if (this.done) return [];
    throw new TruncatedStreamError(`${LABEL}: stream ended before response.completed`);
  }
}

const CHAT_MODEL = /^(gpt-|o\d|codex|chatgpt-)/i;
const NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|embedding|image|dall-e|moderation|search-preview|instruct|davinci|babbage)/i;

function tierOf(id: string): ModelInfo["tier"] {
  if (/(nano|mini)/i.test(id)) return "fast";
  return "balanced";
}

export function createOpenAIProvider(config: OpenAIProviderOptions): ModelProvider {
  const fetch = resolveFetch(config);
  const base = config.baseUrl ?? OPENAI_BASE_URL;
  const secrets = secretsOf(config);
  const fallback = config.fallbackModels ?? OPENAI_FALLBACK_MODELS;
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(config.headers ?? {}),
    authorization: `Bearer ${config.apiKey}`,
  });

  return {
    id: "openai",
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
        if (!isRecord(body) || !Array.isArray(body["data"])) return fallback.map((m) => ({ ...m }));
        const out: ModelInfo[] = [];
        for (const m of body["data"]) {
          const id = isRecord(m) ? str(m["id"]) : undefined;
          if (!id || !CHAT_MODEL.test(id) || NOT_CHAT.test(id)) continue;
          const known = fallback.find((k) => k.id === id);
          out.push(known ? { ...known } : { id, provider: "openai", label: id, supportsTools: true, tier: tierOf(id) });
        }
        out.sort((a, b) => a.id.localeCompare(b.id));
        return out.length > 0 ? out : fallback.map((m) => ({ ...m }));
      } catch {
        return fallback.map((m) => ({ ...m }));
      }
    },
    send(req: ChatRequest): AsyncIterable<ChatEvent> {
      return streamChat({
        provider: LABEL,
        fetch,
        url: joinUrl(base, "/v1/responses"),
        headers: { ...headers(), accept: "text/event-stream" },
        body: buildOpenAIRequest(req),
        ...(req.signal ? { signal: req.signal } : {}),
        secrets,
        parseErrorBody: parseOpenAIError,
        model: req.model,
        decoder: new OpenAIDecoder(req.model),
      });
    },
    async countTokens(req: ChatRequest): Promise<number> {
      try {
        const body = await requestJson({
          provider: LABEL,
          fetch,
          url: joinUrl(base, "/v1/responses/input_tokens"),
          method: "POST",
          headers: headers(),
          body: buildOpenAICountRequest(req),
          secrets,
          parseErrorBody: parseOpenAIError,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        const n = isRecord(body) ? num(body["input_tokens"]) : undefined;
        return n ?? estimateTokens(req);
      } catch {
        return estimateTokens(req);
      }
    },
  };
}
