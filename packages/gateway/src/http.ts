// Shared transport: one POST-and-stream driver that every adapter uses.
// It owns the stream guarantees of the ModelProvider contract:
//   - message_start comes first (injected if a decoder forgot it)
//   - exactly one terminal event (message_end or error), then the stream ends
//   - send() never throws: every failure becomes one `error` event
//   - API keys never appear in an error message

import type { ChatEvent, FetchLike, ProviderConfig, ProviderError } from "@oneseat/contracts";
import {
  errorFromResponse,
  errorFromThrown,
  providerError,
  redact,
  truncate,
  type ErrorBodyParser,
} from "./errors.js";
import { parseSSE, type SSEMessage } from "./sse.js";

/** Thrown by a decoder when the provider sent something it cannot read. */
export class DecodeError extends Error {
  override readonly name: string = "DecodeError";
}

/** Thrown by a decoder's onEnd() when the body stopped before the response completed. Retryable. */
export class TruncatedStreamError extends DecodeError {
  override readonly name: string = "TruncatedStreamError";
}

/** A provider's stream state machine. */
export interface StreamDecoder {
  /** Handle one SSE message. Return the normalised events it produces. */
  onMessage(msg: SSEMessage): ChatEvent[];
  /** The body ended. Return the final events (usually message_end). */
  onEnd(): ChatEvent[];
}

export interface StreamSpec {
  /** Human label used in error messages, e.g. "Anthropic". */
  provider: string;
  fetch: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Values that must never appear in an error message. */
  secrets: readonly (string | undefined)[];
  parseErrorBody?: ErrorBodyParser;
  /** Model id for an injected message_start. */
  model: string;
  decoder: StreamDecoder;
}

export function parseJsonData(data: string, provider: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new DecodeError(`${provider}: malformed stream event: ${truncate(data, 120)}`);
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function resolveFetch(config: ProviderConfig): FetchLike {
  if (config.fetch) return config.fetch;
  return (input, init) => globalThis.fetch(input, init);
}

/** Every value in the config that must be kept out of messages. */
export function secretsOf(config: ProviderConfig): string[] {
  return [config.apiKey, ...Object.values(config.headers ?? {})].filter((s) => typeof s === "string" && s.length > 0);
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function isTerminal(ev: ChatEvent): boolean {
  return ev.type === "message_end" || ev.type === "error";
}

/** POST a JSON body and turn the SSE response into normalised ChatEvents. */
export async function* streamChat(spec: StreamSpec): AsyncGenerator<ChatEvent> {
  const { provider, signal, secrets } = spec;
  let started = false;
  const errorEvent = (error: ProviderError): ChatEvent => ({ type: "error", error });

  /** Enforce ordering; returns the events to yield and whether the stream is over. */
  const gate = (events: ChatEvent[]): { out: ChatEvent[]; done: boolean } => {
    const out: ChatEvent[] = [];
    for (const raw of events) {
      // Stream-level errors quote the provider; make sure no secret rides along.
      const ev: ChatEvent =
        raw.type === "error"
          ? { type: "error", error: { ...raw.error, message: truncate(redact(raw.error.message, secrets)) } }
          : raw;
      if (ev.type === "message_start") {
        if (started) continue;
        started = true;
        out.push(ev);
        continue;
      }
      if (!started && ev.type !== "error") {
        started = true;
        out.push({ type: "message_start", model: spec.model });
      }
      out.push(ev);
      if (isTerminal(ev)) return { out, done: true };
    }
    return { out, done: false };
  };

  if (signal?.aborted) {
    yield errorEvent(providerError("aborted", `${provider}: request aborted`));
    return;
  }

  let res: Response;
  try {
    res = await raceAbort(
      spec.fetch(spec.url, {
        method: "POST",
        headers: spec.headers,
        body: JSON.stringify(spec.body),
        ...(signal ? { signal } : {}),
      }),
      signal,
    );
  } catch (e) {
    yield errorEvent(errorFromThrown(e, { provider, ...(signal ? { signal } : {}), secrets }));
    return;
  }

  if (!res.ok) {
    yield errorEvent(
      await errorFromResponse(res, { provider, secrets, ...(spec.parseErrorBody ? { parseBody: spec.parseErrorBody } : {}) }),
    );
    return;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // A 2xx JSON body where we asked for a stream: usually an error envelope from a proxy.
    const err = await errorFromResponse(res, {
      provider,
      secrets,
      ...(spec.parseErrorBody ? { parseBody: spec.parseErrorBody } : {}),
    });
    yield errorEvent({ ...err, kind: err.kind === "unknown" ? "server" : err.kind, retryable: false, message: err.message.replace(" API error 200", ": expected an event stream") });
    return;
  }

  if (!res.body) {
    yield errorEvent(providerError("server", `${provider}: response had no body`));
    return;
  }

  try {
    for await (const msg of parseSSE(res.body, signal ? { signal } : {})) {
      let events: ChatEvent[];
      try {
        events = spec.decoder.onMessage(msg);
      } catch (e) {
        // An unreadable event at the very end of the body means the connection was cut.
        const err = msg.unterminated
          ? decodeFailure(new TruncatedStreamError(`${provider}: stream ended before the response completed`), provider, secrets)
          : decodeFailure(e, provider, secrets);
        yield errorEvent(err);
        return;
      }
      const { out, done } = gate(events);
      for (const ev of out) yield ev;
      if (done) return;
    }
    if (signal?.aborted) {
      yield errorEvent(providerError("aborted", `${provider}: request aborted`));
      return;
    }
    let tail: ChatEvent[];
    try {
      tail = spec.decoder.onEnd();
    } catch (e) {
      yield errorEvent(decodeFailure(e, provider, secrets));
      return;
    }
    const { out, done } = gate(tail);
    for (const ev of out) yield ev;
    if (!done) yield errorEvent(providerError("network", `${provider}: stream ended before the response completed`));
  } catch (e) {
    yield errorEvent(errorFromThrown(e, { provider, ...(signal ? { signal } : {}), secrets }));
  }
}

function decodeFailure(e: unknown, provider: string, secrets: readonly (string | undefined)[]): ProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof TruncatedStreamError) return providerError("network", truncate(redact(msg, secrets)));
  const text = e instanceof DecodeError ? msg : `${provider}: failed to read stream: ${msg}`;
  return providerError("unknown", truncate(redact(text, secrets)));
}

export interface JsonRequestSpec {
  provider: string;
  fetch: FetchLike;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  secrets: readonly (string | undefined)[];
  parseErrorBody?: ErrorBodyParser;
  signal?: AbortSignal;
}

export class ProviderRequestError extends Error {
  override readonly name = "ProviderRequestError";
  constructor(readonly error: ProviderError) {
    super(error.message);
  }
}

/** Non-streaming JSON request (models, token counts). Throws ProviderRequestError with a redacted message. */
export async function requestJson(spec: JsonRequestSpec): Promise<unknown> {
  let res: Response;
  try {
    res = await spec.fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
  } catch (e) {
    throw new ProviderRequestError(
      errorFromThrown(e, { provider: spec.provider, secrets: spec.secrets, ...(spec.signal ? { signal: spec.signal } : {}) }),
    );
  }
  if (!res.ok) {
    throw new ProviderRequestError(
      await errorFromResponse(res, {
        provider: spec.provider,
        secrets: spec.secrets,
        ...(spec.parseErrorBody ? { parseBody: spec.parseErrorBody } : {}),
      }),
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderRequestError(providerError("server", `${spec.provider}: response was not JSON`));
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse tool-call arguments. Empty means {}. Must be a JSON object. */
export function parseToolInput(raw: string, provider: string, name: string): Record<string, unknown> {
  const t = raw.trim();
  if (t === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    throw new DecodeError(`${provider}: tool call "${name}" had invalid JSON arguments`);
  }
  if (!isRecord(v)) throw new DecodeError(`${provider}: tool call "${name}" arguments were not a JSON object`);
  return v;
}

/** 32-bit FNV-1a, hex. Used for stable generated ids. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
