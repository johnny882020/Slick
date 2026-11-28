// Google Gemini API adapter.
// POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse
// Docs: https://ai.google.dev/api/generate-content and https://ai.google.dev/gemini-api/docs/thought-signatures
//
// Thought signatures: Gemini attaches an opaque `thoughtSignature` to the
// functionCall part it produced. It must be sent back on that same part in the
// next request, or multi-step tool use fails on thinking models. We keep it in
// ToolUsePart.providerMeta.google.thoughtSignature.

import {
  estimateTokens,
  type ChatEvent,
  type ChatRequest,
  type Effort,
  type ModelInfo,
  type ModelProvider,
  type ProviderConfig,
  type ProviderErrorKind,
  type ReasoningPart,
  type StopReason,
  type Usage,
} from "@oneseat/contracts";
import { parseDuration, providerError, type ErrorBodyParser } from "../errors.js";
import {
  TruncatedStreamError,
  fnv1a,
  isRecord,
  joinUrl,
  num,
  parseJsonData,
  requestJson,
  resolveFetch,
  secretsOf,
  str,
  streamChat,
  type StreamDecoder,
} from "../http.js";
import { toGeminiSchema } from "../schema.js";
import type { SSEMessage } from "../sse.js";

export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
const LABEL = "Gemini";

/**
 * CONFIG, not a statement of what Google currently serves: the list shown when
 * GET /v1beta/models is unreachable. Override it with `fallbackModels`.
 */
export const GOOGLE_FALLBACK_MODELS: readonly ModelInfo[] = [
  // Shown only when the models endpoint fails. These are the ids Google's API itself names as
  // replacements for the retired 2.5 models (checked 2026-11-27); the live list wins otherwise.
  { id: "gemini-3.1-pro-preview", provider: "google", label: "Gemini 3.1 Pro (preview)", supportsTools: true, tier: "frontier" },
  { id: "gemini-3.8-flash", provider: "google", label: "Gemini 3.8 Flash", supportsTools: true, tier: "balanced" },
];

export interface GoogleProviderOptions extends ProviderConfig {
  fallbackModels?: readonly ModelInfo[];
}

/** providerMeta shape for Gemini tool calls and thoughts. */
export interface GoogleMeta {
  google: {
    /** Opaque signature to send back on the same part. */
    thoughtSignature?: string;
    /** The call id Gemini itself sent, when it sent one (ours are generated otherwise). */
    id?: string;
  };
}

function googleMeta(meta: Record<string, unknown> | undefined): GoogleMeta["google"] {
  const g = meta?.["google"];
  if (!isRecord(g)) return {};
  const out: GoogleMeta["google"] = {};
  if (typeof g["thoughtSignature"] === "string" && g["thoughtSignature"]) out.thoughtSignature = g["thoughtSignature"];
  if (typeof g["id"] === "string" && g["id"]) out.id = g["id"];
  return out;
}

export function modelPath(model: string): string {
  return model.replace(/^models\//, "");
}

/**
 * effort -> thinkingConfig. Gemini 2.x takes a token budget; later models take
 * a thinking level. Heuristic by model name; documented here so it is easy to change.
 */
export function geminiThinkingConfig(model: string, effort: Effort): Record<string, unknown> {
  const id = modelPath(model);
  if (/^gemini-(1|2)\./.test(id)) {
    const budget = { low: 1024, medium: 8192, high: 24576 }[effort];
    return { thinkingBudget: budget, includeThoughts: true };
  }
  const level = effort === "medium" && !/flash/.test(id) ? "high" : effort;
  return { thinkingLevel: level, includeThoughts: true };
}

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

function contentsOf(req: ChatRequest): Content[] {
  // Gemini keys tool results by name; it also accepts the call id when it sent one.
  const nativeIds = new Map<string, string>();
  for (const m of req.messages)
    for (const p of m.content) if (p.type === "tool_use") {
      const id = googleMeta(p.providerMeta).id;
      if (id) nativeIds.set(p.id, id);
    }

  const out: Content[] = [];
  for (const m of req.messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const responses: Part[] = [];
    const parts: Part[] = [];
    for (const p of m.content) {
      switch (p.type) {
        case "text":
          if (p.text.length > 0) parts.push({ text: p.text });
          break;
        case "image":
          parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
          break;
        case "tool_use": {
          const meta = googleMeta(p.providerMeta);
          const part: Part = { functionCall: { ...(meta.id ? { id: meta.id } : {}), name: p.name, args: p.input } };
          if (meta.thoughtSignature) part["thoughtSignature"] = meta.thoughtSignature;
          parts.push(part);
          break;
        }
        case "tool_result": {
          const id = nativeIds.get(p.toolUseId);
          responses.push({
            functionResponse: {
              ...(id ? { id } : {}),
              name: p.name,
              response: p.isError ? { error: p.content } : { result: p.content },
            },
          });
          break;
        }
        case "reasoning": {
          // Only thoughts that carry a Gemini signature are worth sending back.
          const sig = googleMeta(p.providerMeta).thoughtSignature;
          if (sig) parts.push({ text: p.text, thought: true, thoughtSignature: sig });
          break;
        }
      }
    }
    const all = [...responses, ...parts];
    if (all.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...all);
    else out.push({ role, parts: all });
  }
  return out;
}

function toolConfig(req: ChatRequest): Record<string, unknown> | undefined {
  const c = req.toolChoice;
  if (!c || c === "auto") return undefined;
  if (c === "any") return { functionCallingConfig: { mode: "ANY" } };
  if (c === "none") return { functionCallingConfig: { mode: "NONE" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [c.name] } };
}

function toolsOf(req: ChatRequest): Record<string, unknown>[] {
  return [
    {
      functionDeclarations: req.tools.map((t) => {
        const parameters = toGeminiSchema(t.inputSchema);
        return { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) };
      }),
    },
  ];
}

/** Pure: the JSON body for :streamGenerateContent. */
export function buildGoogleRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (req.system) body["systemInstruction"] = { parts: [{ text: req.system }] };
  body["contents"] = contentsOf(req);
  if (req.tools.length > 0) {
    body["tools"] = toolsOf(req);
    const tc = toolConfig(req);
    if (tc) body["toolConfig"] = tc;
  }
  const gen: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (req.temperature !== undefined) gen["temperature"] = req.temperature;
  if (req.effort) gen["thinkingConfig"] = geminiThinkingConfig(req.model, req.effort);
  body["generationConfig"] = gen;
  return body;
}

/** Pure: the JSON body for :countTokens. */
export function buildGoogleCountRequest(req: ChatRequest): Record<string, unknown> {
  const { generationConfig: _g, ...rest } = buildGoogleRequest(req);
  return { generateContentRequest: { model: `models/${modelPath(req.model)}`, ...rest } };
}

const STATUS_KINDS: Record<string, ProviderErrorKind> = {
  INVALID_ARGUMENT: "invalid_request",
  FAILED_PRECONDITION: "invalid_request",
  OUT_OF_RANGE: "invalid_request",
  UNAUTHENTICATED: "auth",
  PERMISSION_DENIED: "auth",
  NOT_FOUND: "not_found",
  RESOURCE_EXHAUSTED: "rate_limit",
  UNAVAILABLE: "overloaded",
  INTERNAL: "server",
  DEADLINE_EXCEEDED: "server",
  ABORTED: "server",
  CANCELLED: "aborted",
};

export const parseGoogleError: ErrorBodyParser = (body) => {
  const env = Array.isArray(body) ? body[0] : body;
  if (!isRecord(env) || !isRecord(env["error"])) return {};
  const e = env["error"];
  const status = str(e["status"]);
  const message = str(e["message"]);
  let kind: ProviderErrorKind | undefined = status ? STATUS_KINDS[status] : undefined;
  let retryAfter: number | undefined;
  if (Array.isArray(e["details"])) {
    for (const d of e["details"]) {
      if (!isRecord(d)) continue;
      // An invalid key comes back as 400 INVALID_ARGUMENT with reason API_KEY_INVALID.
      if (d["reason"] === "API_KEY_INVALID") kind = "auth";
      const delay = parseDuration(d["retryDelay"]);
      if (delay !== undefined) retryAfter = delay;
    }
  }
  return {
    ...(message ? { message: status ? `${status}: ${message}` : message } : {}),
    ...(kind ? { kind } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
};

const REFUSAL = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);
const TOOL_FAILURE = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"]);

class GoogleDecoder implements StreamDecoder {
  private started = false;
  private callIndex = 0;
  private sawCall = false;
  private finishReason: string | undefined;
  private blocked = false;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private thought = "";
  private thoughtSignature: string | undefined;
  private inThought = false;
  private responseId = "";

  constructor(
    private readonly model: string,
    /** Hash of the request body: makes generated call ids stable per request and distinct across turns. */
    private readonly salt: string,
  ) {}

  private flushThought(): ChatEvent[] {
    if (!this.inThought) return [];
    this.inThought = false;
    const part: ReasoningPart = { type: "reasoning", text: this.thought };
    if (this.thoughtSignature) part.providerMeta = { google: { thoughtSignature: this.thoughtSignature } };
    this.thought = "";
    this.thoughtSignature = undefined;
    return [{ type: "reasoning_done", part }];
  }

  private applyUsage(u: unknown): void {
    if (!isRecord(u)) return;
    const prompt = (num(u["promptTokenCount"]) ?? 0) + (num(u["toolUsePromptTokenCount"]) ?? 0);
    const cached = num(u["cachedContentTokenCount"]) ?? 0;
    const output = (num(u["candidatesTokenCount"]) ?? 0) + (num(u["thoughtsTokenCount"]) ?? 0);
    this.usage = { inputTokens: Math.max(0, prompt - cached), outputTokens: output };
    if (cached > 0) this.usage.cacheReadTokens = cached;
  }

  onMessage(msg: SSEMessage): ChatEvent[] {
    const d = parseJsonData(msg.data, LABEL);
    const chunk = Array.isArray(d) ? d[0] : d;
    if (!isRecord(chunk)) return [];
    if (isRecord(chunk["error"])) {
      const info = parseGoogleError(chunk, 0);
      return [{ type: "error", error: providerError(info.kind ?? "server", `${LABEL} stream error: ${info.message ?? "unknown error"}`) }];
    }
    const events: ChatEvent[] = [];
    if (!this.started) {
      this.started = true;
      events.push({ type: "message_start", model: str(chunk["modelVersion"]) ?? this.model });
    }
    if (str(chunk["responseId"])) this.responseId = str(chunk["responseId"]) as string;
    this.applyUsage(chunk["usageMetadata"]);
    const feedback = isRecord(chunk["promptFeedback"]) ? chunk["promptFeedback"] : undefined;
    if (feedback && str(feedback["blockReason"])) this.blocked = true;

    const candidates = Array.isArray(chunk["candidates"]) ? chunk["candidates"] : [];
    const cand = isRecord(candidates[0]) ? candidates[0] : undefined;
    if (!cand) return events;
    const content = isRecord(cand["content"]) ? cand["content"] : {};
    const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
    for (const raw of parts) {
      if (!isRecord(raw)) continue;
      const sig = str(raw["thoughtSignature"]);
      if (raw["thought"] === true) {
        this.inThought = true;
        const t = str(raw["text"]) ?? "";
        this.thought += t;
        if (sig) this.thoughtSignature = sig;
        if (t) events.push({ type: "reasoning_delta", text: t });
        continue;
      }
      if (isRecord(raw["functionCall"])) {
        events.push(...this.flushThought());
        const fc = raw["functionCall"];
        const name = str(fc["name"]) ?? "";
        const args = isRecord(fc["args"]) ? fc["args"] : {};
        const nativeId = str(fc["id"]);
        const index = this.callIndex++;
        const id = nativeId ?? `call_${fnv1a(`${this.salt}|${this.responseId}|${index}|${name}`)}${index}`;
        const meta: GoogleMeta["google"] = {};
        if (sig) meta.thoughtSignature = sig;
        if (nativeId) meta.id = nativeId;
        this.sawCall = true;
        events.push({
          type: "tool_call",
          call: { id, name, input: args, ...(Object.keys(meta).length > 0 ? { providerMeta: { google: meta } } : {}) },
        });
        continue;
      }
      const text = str(raw["text"]);
      if (text !== undefined) {
        events.push(...this.flushThought());
        // A signature on a plain text part cannot round-trip (TextPart has no providerMeta); it is optional there.
        if (text) events.push({ type: "text_delta", text });
      }
    }
    const fr = str(cand["finishReason"]);
    if (fr) {
      this.finishReason = fr;
      if (TOOL_FAILURE.has(fr)) {
        events.push(...this.flushThought());
        const message = str(cand["finishMessage"]);
        events.push({
          type: "error",
          error: providerError("server", `${LABEL}: generation stopped with ${fr}${message ? `: ${message}` : ""}`, { retryable: true }),
        });
      }
    }
    return events;
  }

  onEnd(): ChatEvent[] {
    const events = this.flushThought();
    let stopReason: StopReason;
    if (this.finishReason === undefined) {
      if (!this.blocked) throw new TruncatedStreamError(`${LABEL}: stream ended without a finishReason`);
      stopReason = "refusal";
    } else if (this.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
    else if (REFUSAL.has(this.finishReason)) stopReason = "refusal";
    else stopReason = this.sawCall ? "tool_use" : "end_turn";
    events.push({ type: "message_end", stopReason, usage: { ...this.usage } });
    return events;
  }
}

function tierOf(id: string): ModelInfo["tier"] {
  if (/lite/.test(id)) return "fast";
  if (/pro/.test(id)) return "frontier";
  if (/flash/.test(id)) return "balanced";
  return undefined;
}

export function createGoogleProvider(config: GoogleProviderOptions): ModelProvider {
  const fetch = resolveFetch(config);
  const base = config.baseUrl ?? GOOGLE_BASE_URL;
  const secrets = secretsOf(config);
  const fallback = config.fallbackModels ?? GOOGLE_FALLBACK_MODELS;
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(config.headers ?? {}),
    "x-goog-api-key": config.apiKey,
  });

  return {
    id: "google",
    async models(): Promise<ModelInfo[]> {
      try {
        const out: ModelInfo[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const q = new URLSearchParams({ pageSize: "1000" });
          if (pageToken) q.set("pageToken", pageToken);
          const body = await requestJson({
            provider: LABEL,
            fetch,
            url: joinUrl(base, `/v1beta/models?${q.toString()}`),
            method: "GET",
            headers: headers(),
            secrets,
            parseErrorBody: parseGoogleError,
          });
          if (!isRecord(body) || !Array.isArray(body["models"])) break;
          for (const m of body["models"]) {
            if (!isRecord(m)) continue;
            const methods = Array.isArray(m["supportedGenerationMethods"]) ? m["supportedGenerationMethods"] : [];
            if (!methods.includes("generateContent")) continue;
            const name = str(m["name"]);
            if (!name) continue;
            const id = modelPath(name);
            const info: ModelInfo = {
              id,
              provider: "google",
              label: str(m["displayName"]) ?? id,
              supportsTools: /gemini/.test(id),
            };
            const ctx = num(m["inputTokenLimit"]);
            const maxOut = num(m["outputTokenLimit"]);
            const tier = tierOf(id);
            if (ctx !== undefined) info.contextWindow = ctx;
            if (maxOut !== undefined) info.maxOutputTokens = maxOut;
            if (tier) info.tier = tier;
            out.push(info);
          }
          pageToken = str(body["nextPageToken"]);
          if (!pageToken) break;
        }
        return out.length > 0 ? out : fallback.map((m) => ({ ...m }));
      } catch {
        return fallback.map((m) => ({ ...m }));
      }
    },
    send(req: ChatRequest): AsyncIterable<ChatEvent> {
      const body = buildGoogleRequest(req);
      return streamChat({
        provider: LABEL,
        fetch,
        url: joinUrl(base, `/v1beta/models/${encodeURIComponent(modelPath(req.model))}:streamGenerateContent?alt=sse`),
        headers: { ...headers(), accept: "text/event-stream" },
        body,
        ...(req.signal ? { signal: req.signal } : {}),
        secrets,
        parseErrorBody: parseGoogleError,
        model: req.model,
        decoder: new GoogleDecoder(req.model, fnv1a(JSON.stringify(body))),
      });
    },
    async countTokens(req: ChatRequest): Promise<number> {
      try {
        const body = await requestJson({
          provider: LABEL,
          fetch,
          url: joinUrl(base, `/v1beta/models/${encodeURIComponent(modelPath(req.model))}:countTokens`),
          method: "POST",
          headers: headers(),
          body: buildGoogleCountRequest(req),
          secrets,
          parseErrorBody: parseGoogleError,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        const n = isRecord(body) ? num(body["totalTokens"]) : undefined;
        return n ?? estimateTokens(req);
      } catch {
        return estimateTokens(req);
      }
    },
  };
}
