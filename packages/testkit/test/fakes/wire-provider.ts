// A small ModelProvider over an invented SSE wire format, used to prove the conformance
// suite passes a correct adapter and catches broken ones. Each `bug` breaks one rule.

import {
  estimateTokens,
  type ChatEvent,
  type ChatRequest,
  type FetchLike,
  type ModelProvider,
  type ProviderError,
  type ProviderErrorKind,
  type ProviderId,
  type StopReason,
} from "@oneseat/contracts";
import { sseChunks, type FixtureRoute } from "../../src/fixtures.js";

export type WireBug =
  | "leak-key" // copies the raw error body (which echoes the key) into the error message
  | "no-start" // skips message_start
  | "throw-on-http-error" // throws instead of yielding an error event
  | "ignore-abort" // never passes the signal to fetch, never checks it
  | "string-args" // emits tool_call input as the raw JSON string
  | "double-end" // emits message_end twice
  | "key-in-url" // sends the key as ?key= instead of a header
  | "truncation-ok" // treats a cut-off stream as a normal end
  | "bad-models" // models() returns junk
  | "zero-tokens" // countTokens() returns 0
  | "no-key"; // never sends the key

export const BASE = "https://wire.test";

export function createWireProvider(opts: { fetch: FetchLike; apiKey: string; id?: ProviderId; bugs?: WireBug[] }): ModelProvider {
  const bugs = new Set(opts.bugs ?? []);
  const id = opts.id ?? "local";
  const redact = (s: string) => (bugs.has("leak-key") ? s : s.split(opts.apiKey).join("[REDACTED]"));
  const kindFor = (status: number): ProviderErrorKind =>
    status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status === 529 ? "overloaded" : status === 404 ? "not_found" : status >= 500 ? "server" : status >= 400 ? "invalid_request" : "unknown";
  const err = (kind: ProviderErrorKind, message: string, extra: Partial<ProviderError> = {}): ChatEvent => ({
    type: "error",
    error: { kind, message: redact(message), retryable: kind === "rate_limit" || kind === "server" || kind === "overloaded" || kind === "network", ...extra },
  });
  const headers = (): Record<string, string> => (bugs.has("no-key") || bugs.has("key-in-url") ? { "content-type": "application/json" } : { "content-type": "application/json", "x-api-key": opts.apiKey });
  const url = (path: string) => `${BASE}${path}${bugs.has("key-in-url") ? `?key=${opts.apiKey}` : ""}`;

  async function* send(req: ChatRequest): AsyncIterable<ChatEvent> {
    const signal = bugs.has("ignore-abort") ? undefined : req.signal;
    if (signal?.aborted) {
      yield err("aborted", "request aborted", { retryable: false });
      return;
    }
    let res: Response;
    try {
      const { signal: _s, ...body } = req;
      res = await opts.fetch(url("/v1/chat"), { method: "POST", headers: headers(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (e) {
      if (signal?.aborted) yield err("aborted", "request aborted", { retryable: false });
      else yield err("network", `network error: ${(e as Error).message}`);
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (bugs.has("throw-on-http-error")) throw new Error(`HTTP ${res.status}`);
      let message = `HTTP ${res.status}`;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* keep status text */
      }
      const ra = Number(res.headers.get("retry-after"));
      yield err(kindFor(res.status), message, { status: res.status, ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: ra } : {}) });
      return;
    }
    if (!bugs.has("no-start")) yield { type: "message_start", model: req.model };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let ended = false;
    const args = new Map<string, { name: string; json: string }>();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal?.aborted) yield err("aborted", "request aborted", { retryable: false });
          else yield err("network", `stream broke: ${(e as Error).message}`);
          return;
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev: { t: string; v?: string; id?: string; name?: string; stop?: StopReason; usage?: { in: number; out: number } };
          try {
            ev = JSON.parse(line.slice(6)) as typeof ev;
          } catch {
            yield err("server", "malformed event from the server");
            return;
          }
          if (ev.t === "text") yield { type: "text_delta", text: ev.v ?? "" };
          else if (ev.t === "tool_start") args.set(ev.id!, { name: ev.name!, json: "" });
          else if (ev.t === "tool_args") args.get(ev.id!)!.json += ev.v ?? "";
          else if (ev.t === "tool_end") {
            const a = args.get(ev.id!)!;
            let input: unknown;
            try {
              input = bugs.has("string-args") ? a.json : JSON.parse(a.json || "{}");
            } catch {
              yield err("server", "tool arguments were not JSON");
              return;
            }
            yield { type: "tool_call", call: { id: ev.id!, name: a.name, input: input as Record<string, unknown> } };
          } else if (ev.t === "end") {
            const end: ChatEvent = { type: "message_end", stopReason: ev.stop ?? "end_turn", usage: { inputTokens: ev.usage?.in ?? 0, outputTokens: ev.usage?.out ?? 0 } };
            yield end;
            if (bugs.has("double-end")) yield end;
            ended = true;
            return;
          }
        }
        if (signal?.aborted) {
          yield err("aborted", "request aborted", { retryable: false });
          return;
        }
      }
      if (!ended) {
        if (bugs.has("truncation-ok")) yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
        else yield err("network", "stream ended before the end event");
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    id,
    async models() {
      if (bugs.has("bad-models")) return [{ id: "", provider: "nope", label: "", supportsTools: "yes" }] as never;
      return [
        { id: "wire-large", provider: id, label: "Wire Large", contextWindow: 200_000, maxOutputTokens: 8192, supportsTools: true, tier: "frontier" },
        { id: "wire-small", provider: id, label: "Wire Small", supportsTools: true, tier: "fast" },
      ];
    },
    send,
    async countTokens(req) {
      if (bugs.has("zero-tokens")) return 0;
      try {
        const { signal: _s, ...body } = req;
        const res = await opts.fetch(url("/v1/count"), { method: "POST", headers: headers(), body: JSON.stringify(body) });
        if (res.ok) {
          const n = (await res.json()) as { tokens?: number };
          if (Number.isInteger(n.tokens) && n.tokens! > 0) return n.tokens!;
        }
      } catch {
        /* fall back */
      }
      return Math.max(1, estimateTokens(req));
    },
  };
}

// ---- fixtures in the wire format ----

export const WIRE_TEXT: FixtureRoute[] = [
  {
    match: "POST https://wire.test/v1/chat",
    response: {
      headers: { "content-type": "text/event-stream" },
      chunks: sseChunks([{ data: { t: "text", v: "Hel" } }, { data: { t: "text", v: "lo." } }, { data: { t: "end", stop: "end_turn", usage: { in: 12, out: 3 } } }]),
    },
  },
];

export const WIRE_TOOL: FixtureRoute[] = [
  {
    match: "POST https://wire.test/v1/chat",
    response: {
      headers: { "content-type": "text/event-stream" },
      chunks: sseChunks([
        { data: { t: "text", v: "Checking." } },
        { data: { t: "tool_start", id: "tc_1", name: "get_weather" } },
        { data: { t: "tool_args", id: "tc_1", v: '{"ci' } },
        { data: { t: "tool_args", id: "tc_1", v: 'ty":"Paris"}' } },
        { data: { t: "tool_end", id: "tc_1" } },
        { data: { t: "end", stop: "tool_use", usage: { in: 40, out: 9 } } },
      ]),
    },
  },
];

export const WIRE_COUNT: FixtureRoute[] = [{ match: "POST https://wire.test/v1/count", response: { json: { tokens: 42 } } }];

export const WIRE_FIXTURES = {
  model: "wire-large",
  text: { routes: WIRE_TEXT, expectText: "Hello." },
  toolCall: { routes: WIRE_TOOL },
  countTokens: WIRE_COUNT,
};
