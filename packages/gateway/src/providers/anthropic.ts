// Anthropic Messages API adapter.
// POST {base}/v1/messages with stream: true. Docs: https://docs.anthropic.com/en/api/messages-streaming

import {
  estimateTokens,
  type ChatEvent,
  type ChatRequest,
  type ContentPart,
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

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
const LABEL = "Anthropic";

/** Used when GET /v1/models fails (offline, restricted key). */
export const ANTHROPIC_FALLBACK_MODELS: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", supportsTools: true, tier: "frontier" },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", supportsTools: true, tier: "balanced" },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", supportsTools: true, tier: "fast" },
];

/** providerMeta shape for Anthropic reasoning parts. */
export interface AnthropicReasoningMeta {
  anthropic: { signature?: string; redactedData?: string };
}

function anthropicMeta(meta: Record<string, unknown> | undefined): { signature?: string; redactedData?: string } {
  const a = meta?.["anthropic"];
  if (!isRecord(a)) return {};
  const out: { signature?: string; redactedData?: string } = {};
  if (typeof a["signature"] === "string" && a["signature"]) out.signature = a["signature"];
  if (typeof a["redactedData"] === "string" && a["redactedData"]) out.redactedData = a["redactedData"];
  return out;
}

type Block = Record<string, unknown>;

function toBlocks(parts: ContentPart[]): Block[] {
  const results: Block[] = [];
  const rest: Block[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        if (p.text.length > 0) rest.push({ type: "text", text: p.text });
        break;
      case "image":
        rest.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });
        break;
      case "tool_use":
        rest.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
        break;
      case "tool_result":
        results.push({
          type: "tool_result",
          tool_use_id: p.toolUseId,
          content: p.content,
          ...(p.isError ? { is_error: true } : {}),
        });
        break;
      case "reasoning": {
        // Only signed thinking can be sent back; unsigned reasoning (from another provider) is dropped.
        const m = anthropicMeta(p.providerMeta);
        if (m.redactedData) rest.push({ type: "redacted_thinking", data: m.redactedData });
        else if (m.signature) rest.push({ type: "thinking", thinking: p.text, signature: m.signature });
        break;
      }
    }
  }
  // Anthropic wants tool_result blocks first in a user turn.
  return [...results, ...rest];
}

function toolChoice(req: ChatRequest): Block | undefined {
  const c = req.toolChoice;
  if (!c || c === "auto") return undefined;
  if (c === "any") return { type: "any" };
  if (c === "none") return { type: "none" };
  return { type: "tool", name: c.name };
}

function messagesOf(req: ChatRequest): Block[] {
  const out: { role: string; content: Block[] }[] = [];
  for (const m of req.messages) {
    const content = toBlocks(m.content);
    if (content.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      // Merge consecutive same-role turns; keep tool_results first.
      const merged = [...prev.content, ...content];
      prev.content = [...merged.filter((b) => b["type"] === "tool_result"), ...merged.filter((b) => b["type"] !== "tool_result")];
    } else out.push({ role: m.role, content });
  }
  return out;
}

/** Pure: the JSON body for POST /v1/messages. */
export function buildAnthropicRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
  };
  if (req.system) body["system"] = req.system;
  body["messages"] = messagesOf(req);
  if (req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toObjectSchema(t.inputSchema),
    }));
    const tc = toolChoice(req);
    if (tc) body["tool_choice"] = tc;
  }
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.effort) body["output_config"] = { effort: req.effort };
  body["stream"] = true;
  return body;
}

/** Pure: the JSON body for POST /v1/messages/count_tokens. */
export function buildAnthropicCountRequest(req: ChatRequest): Record<string, unknown> {
  const { max_tokens: _m, stream: _s, temperature: _t, output_config: _o, ...rest } = buildAnthropicRequest(req);
  return rest;
}

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  refusal: "refusal",
  pause_turn: "end_turn",
  model_context_window_exceeded: "max_tokens",
};

const ERROR_KINDS: Record<string, ProviderErrorKind> = {
  invalid_request_error: "invalid_request",
  request_too_large: "invalid_request",
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "auth",
  not_found_error: "not_found",
  rate_limit_error: "rate_limit",
  overloaded_error: "overloaded",
  api_error: "server",
  timeout_error: "server",
};

export const parseAnthropicError: ErrorBodyParser = (body) => {
  if (!isRecord(body) || !isRecord(body["error"])) return {};
  const e = body["error"];
  const type = str(e["type"]);
  const message = str(e["message"]);
  return {
    ...(message ? { message: type ? `${type}: ${message}` : message } : {}),
    ...(type && ERROR_KINDS[type] ? { kind: ERROR_KINDS[type] } : {}),
  };
};

interface OpenBlock {
  type: string;
  id?: string;
  name?: string;
  json?: string;
  initialInput?: Record<string, unknown>;
  thinking?: string;
  signature?: string;
  redactedData?: string;
}

class AnthropicDecoder implements StreamDecoder {
  private blocks = new Map<number, OpenBlock>();
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private stopReason: StopReason | undefined;
  private finished = false;

  constructor(private readonly model: string) {}

  private applyUsage(u: unknown): void {
    if (!isRecord(u)) return;
    const input = num(u["input_tokens"]);
    const output = num(u["output_tokens"]);
    const read = num(u["cache_read_input_tokens"]);
    const write = num(u["cache_creation_input_tokens"]);
    if (input !== undefined) this.usage.inputTokens = input;
    if (output !== undefined) this.usage.outputTokens = output;
    if (read !== undefined && read > 0) this.usage.cacheReadTokens = read;
    if (write !== undefined && write > 0) this.usage.cacheWriteTokens = write;
  }

  onMessage(msg: SSEMessage): ChatEvent[] {
    if (msg.event === "ping") return [];
    const d = parseJsonData(msg.data, LABEL);
    if (!isRecord(d)) return [];
    const type = str(d["type"]) ?? msg.event;
    switch (type) {
      case "message_start": {
        const m = isRecord(d["message"]) ? d["message"] : {};
        this.applyUsage(m["usage"]);
        return [{ type: "message_start", model: str(m["model"]) ?? this.model }];
      }
      case "content_block_start": {
        const index = num(d["index"]) ?? 0;
        const cb = isRecord(d["content_block"]) ? d["content_block"] : {};
        const bt = str(cb["type"]) ?? "";
        const block: OpenBlock = { type: bt };
        const events: ChatEvent[] = [];
        if (bt === "tool_use") {
          block.id = str(cb["id"]) ?? `toolu_${index}`;
          block.name = str(cb["name"]) ?? "";
          block.json = "";
          if (isRecord(cb["input"]) && Object.keys(cb["input"]).length > 0) block.initialInput = cb["input"];
        } else if (bt === "thinking") {
          block.thinking = str(cb["thinking"]) ?? "";
          block.signature = str(cb["signature"]) ?? "";
          if (block.thinking) events.push({ type: "reasoning_delta", text: block.thinking });
        } else if (bt === "redacted_thinking") {
          block.redactedData = str(cb["data"]) ?? "";
        } else if (bt === "text") {
          const t = str(cb["text"]);
          if (t) events.push({ type: "text_delta", text: t });
        }
        this.blocks.set(index, block);
        return events;
      }
      case "content_block_delta": {
        const index = num(d["index"]) ?? 0;
        const block = this.blocks.get(index);
        const delta = isRecord(d["delta"]) ? d["delta"] : {};
        switch (str(delta["type"])) {
          case "text_delta": {
            const t = str(delta["text"]) ?? "";
            return t ? [{ type: "text_delta", text: t }] : [];
          }
          case "input_json_delta":
            if (block) block.json = (block.json ?? "") + (str(delta["partial_json"]) ?? "");
            return [];
          case "thinking_delta": {
            const t = str(delta["thinking"]) ?? "";
            if (block) block.thinking = (block.thinking ?? "") + t;
            return t ? [{ type: "reasoning_delta", text: t }] : [];
          }
          case "signature_delta":
            if (block) block.signature = (block.signature ?? "") + (str(delta["signature"]) ?? "");
            return [];
          default:
            return []; // citations_delta and future delta types
        }
      }
      case "content_block_stop": {
        const index = num(d["index"]) ?? 0;
        const block = this.blocks.get(index);
        this.blocks.delete(index);
        if (!block) return [];
        if (block.type === "tool_use") {
          const name = block.name ?? "";
          const input = block.json ? parseToolInput(block.json, LABEL, name) : (block.initialInput ?? {});
          return [{ type: "tool_call", call: { id: block.id ?? `toolu_${index}`, name, input } }];
        }
        if (block.type === "thinking") {
          const part: ReasoningPart = { type: "reasoning", text: block.thinking ?? "" };
          if (block.signature) part.providerMeta = { anthropic: { signature: block.signature } };
          return [{ type: "reasoning_done", part }];
        }
        if (block.type === "redacted_thinking" && block.redactedData) {
          return [
            { type: "reasoning_done", part: { type: "reasoning", text: "", providerMeta: { anthropic: { redactedData: block.redactedData } } } },
          ];
        }
        return [];
      }
      case "message_delta": {
        const delta = isRecord(d["delta"]) ? d["delta"] : {};
        const sr = str(delta["stop_reason"]);
        if (sr) this.stopReason = STOP[sr] ?? "end_turn";
        this.applyUsage(d["usage"]);
        return [];
      }
      case "message_stop":
        this.finished = true;
        return [{ type: "message_end", stopReason: this.stopReason ?? "end_turn", usage: { ...this.usage } }];
      case "error": {
        const info = parseAnthropicError(d, 0);
        const kind = info.kind ?? "server";
        return [{ type: "error", error: providerError(kind, `${LABEL} stream error: ${info.message ?? "unknown error"}`) }];
      }
      default:
        return [];
    }
  }

  onEnd(): ChatEvent[] {
    if (this.finished) return [];
    if (this.blocks.size > 0 || this.stopReason === undefined) {
      throw new TruncatedStreamError(`${LABEL}: stream ended before message_stop`);
    }
    // message_delta arrived but message_stop did not: the response is complete enough.
    return [{ type: "message_end", stopReason: this.stopReason, usage: { ...this.usage } }];
  }
}

function tierOf(id: string): ModelInfo["tier"] {
  if (/opus/i.test(id)) return "frontier";
  if (/haiku/i.test(id)) return "fast";
  if (/sonnet/i.test(id)) return "balanced";
  return undefined;
}

export function createAnthropicProvider(config: ProviderConfig): ModelProvider {
  const fetch = resolveFetch(config);
  const base = config.baseUrl ?? ANTHROPIC_BASE_URL;
  const secrets = secretsOf(config);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(config.headers ?? {}),
    "x-api-key": config.apiKey,
  });

  return {
    id: "anthropic",
    async models(): Promise<ModelInfo[]> {
      try {
        const out: ModelInfo[] = [];
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const q = new URLSearchParams({ limit: "1000" });
          if (after) q.set("after_id", after);
          const body = await requestJson({
            provider: LABEL,
            fetch,
            url: joinUrl(base, `/v1/models?${q.toString()}`),
            method: "GET",
            headers: headers(),
            secrets,
            parseErrorBody: parseAnthropicError,
          });
          if (!isRecord(body) || !Array.isArray(body["data"])) break;
          for (const m of body["data"]) {
            if (!isRecord(m)) continue;
            const id = str(m["id"]);
            if (!id) continue;
            const known = ANTHROPIC_FALLBACK_MODELS.find((k) => k.id === id);
            const tier = tierOf(id);
            out.push({
              ...(known ?? {}),
              id,
              provider: "anthropic",
              label: str(m["display_name"]) ?? known?.label ?? id,
              supportsTools: true,
              ...(tier ? { tier } : {}),
            });
          }
          if (body["has_more"] !== true) break;
          after = str(body["last_id"]);
          if (!after) break;
        }
        return out.length > 0 ? out : ANTHROPIC_FALLBACK_MODELS.map((m) => ({ ...m }));
      } catch {
        return ANTHROPIC_FALLBACK_MODELS.map((m) => ({ ...m }));
      }
    },
    send(req: ChatRequest): AsyncIterable<ChatEvent> {
      return streamChat({
        provider: LABEL,
        fetch,
        url: joinUrl(base, "/v1/messages"),
        headers: { ...headers(), accept: "text/event-stream" },
        body: buildAnthropicRequest(req),
        ...(req.signal ? { signal: req.signal } : {}),
        secrets,
        parseErrorBody: parseAnthropicError,
        model: req.model,
        decoder: new AnthropicDecoder(req.model),
      });
    },
    async countTokens(req: ChatRequest): Promise<number> {
      try {
        const body = await requestJson({
          provider: LABEL,
          fetch,
          url: joinUrl(base, "/v1/messages/count_tokens"),
          method: "POST",
          headers: headers(),
          body: buildAnthropicCountRequest(req),
          secrets,
          parseErrorBody: parseAnthropicError,
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
