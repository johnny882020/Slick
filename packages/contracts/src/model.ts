// Contract 1 — ModelProvider.
// One call shape for all models: messages, tools, stream, usage.
// FROZEN at end of week 2. Changes need a lead review (see CLAUDE.md).

import type { JsonSchema, ToolCall, ToolSpec } from "./tool.js";

export type ProviderId = "anthropic" | "openai" | "google" | "local";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google", "local"];

export interface ModelInfo {
  /** Provider's own model id, e.g. "claude-opus-5-5". */
  id: string;
  provider: ProviderId;
  /** Human label for the UI, e.g. "Claude Opus 5.5". */
  label: string;
  /** Max input tokens, when known. */
  contextWindow?: number;
  /** Max output tokens, when known. */
  maxOutputTokens?: number;
  supportsTools: boolean;
  /** Coarse tier so the UI can suggest a default. */
  tier?: "frontier" | "balanced" | "fast";
}

export type Role = "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque provider data that must round-trip on the next request
   * (for example a Gemini thought signature). Adapters own its shape.
   */
  providerMeta?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  /** Tool name. Some providers (Gemini) key results by name, not id. */
  name: string;
  content: string;
  isError?: boolean;
}

export interface ImagePart {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64 data, no data: prefix. */
  data: string;
}

/**
 * Reasoning the model produced. Adapters that need it to round-trip
 * (Anthropic signed thinking) put the signature in providerMeta.
 * Other adapters may drop it when they build a request.
 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerMeta?: Record<string, unknown>;
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart | ImagePart | ReasoningPart;

export interface Message {
  role: Role;
  content: ContentPart[];
}

export type Effort = "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  /** Harness instructions + skill index. */
  system: string;
  messages: Message[];
  /** MCP JSON Schema tool specs. */
  tools: ToolSpec[];
  maxTokens: number;
  effort?: Effort;
  temperature?: number;
  /** Ask for a specific tool, any tool, or none. Default "auto". */
  toolChoice?: "auto" | "any" | "none" | { name: string };
  signal?: AbortSignal;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "not_found"
  | "network"
  | "server"
  | "aborted"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
  /** Seconds to wait, when the provider says. */
  retryAfter?: number;
}

/**
 * Normalised stream. Every adapter emits, in order:
 *   message_start, then any number of text_delta / reasoning_delta / tool_call,
 *   then exactly one message_end (or one error, which ends the stream).
 * tool_call is emitted once per call, with complete, parsed input.
 */
export type ChatEvent =
  | { type: "message_start"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_done"; part: ReasoningPart }
  | { type: "tool_call"; call: ToolCall }
  | { type: "message_end"; stopReason: StopReason; usage: Usage }
  | { type: "error"; error: ProviderError };

export interface ModelProvider {
  id: ProviderId;
  models(): Promise<ModelInfo[]>;
  send(req: ChatRequest): AsyncIterable<ChatEvent>;
  countTokens(req: ChatRequest): Promise<number>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderConfig {
  apiKey: string;
  /** Override the API base URL (proxies, local servers, fixtures). */
  baseUrl?: string;
  /** Inject fetch for tests and fixture replay. */
  fetch?: FetchLike;
  /** Extra headers, e.g. organisation ids. Never log these. */
  headers?: Record<string, string>;
}

export type ProviderFactory = (config: ProviderConfig) => ModelProvider;

/** Collect a stream into one assistant message. Useful in tests and simple callers. */
export interface CollectedResponse {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  error?: ProviderError;
}

export async function collect(stream: AsyncIterable<ChatEvent>): Promise<CollectedResponse> {
  const content: ContentPart[] = [];
  let text = "";
  let stopReason: StopReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let error: ProviderError | undefined;
  const flush = () => {
    if (text) {
      content.push({ type: "text", text });
      text = "";
    }
  };
  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_done":
        flush();
        content.push(ev.part);
        break;
      case "tool_call":
        flush();
        content.push({
          type: "tool_use",
          id: ev.call.id,
          name: ev.call.name,
          input: ev.call.input,
          ...(ev.call.providerMeta ? { providerMeta: ev.call.providerMeta } : {}),
        });
        break;
      case "message_end":
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
      case "error":
        error = ev.error;
        stopReason = "error";
        break;
      default:
        break;
    }
  }
  flush();
  return { message: { role: "assistant", content }, stopReason, usage, ...(error ? { error } : {}) };
}

/** Rough token estimate (4 chars per token) for when a provider has no count endpoint. */
export function estimateTokens(req: Pick<ChatRequest, "system" | "messages" | "tools">): number {
  let chars = req.system.length;
  for (const m of req.messages) {
    for (const p of m.content) {
      if (p.type === "text" || p.type === "reasoning") chars += p.text.length;
      else if (p.type === "tool_use") chars += p.name.length + JSON.stringify(p.input).length;
      else if (p.type === "tool_result") chars += p.content.length;
      else if (p.type === "image") chars += 1600 * 4; // ~1.6k tokens per image
    }
  }
  for (const t of req.tools) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4);
}

export type { JsonSchema };
