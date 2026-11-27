// HTTP fixtures for provider tests: a fetch that serves recorded or documented-format
// responses (CI), and a fetch wrapper that records real traffic with secrets removed (nightly).

import type { FetchLike } from "@oneseat/contracts";
import { REDACTED, redactHeaders, redactSecrets, redactUrl } from "./secrets.js";

export interface HttpFixture {
  /** HTTP status. Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** Whole body as text. */
  body?: string;
  /** Body as JSON (sets content-type: application/json). */
  json?: unknown;
  /** Body split into chunks, delivered one by one (SSE / NDJSON streams). */
  chunks?: string[];
  /** Delay before each chunk, in ms. Default 0. */
  chunkDelayMs?: number;
  /** Make fetch() reject with a TypeError (DNS failure, connection reset). */
  networkError?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FixtureRoute {
  /** Substring of, or RegExp tested against, "METHOD URL"; or a predicate. */
  match: string | RegExp | ((req: RecordedRequest) => boolean);
  /** Responses served in order. The last one repeats. */
  response: HttpFixture | HttpFixture[];
}

export interface FixtureFetchOptions {
  /** Served when no route matches. Default: 404 JSON error. */
  fallback?: HttpFixture;
  /** Text substitutions applied to bodies and headers, e.g. {"{{API_KEY}}": key}. */
  substitutions?: Record<string, string>;
}

export interface FixtureFetch {
  fetch: FetchLike;
  /** Every request, in order, with headers as sent (lowercased names). */
  requests: RecordedRequest[];
  /** Requests no route matched. */
  unmatched: RecordedRequest[];
}

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

function substitute(text: string, subs: Record<string, string> | undefined): string {
  if (!subs) return text;
  let out = text;
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  return out;
}

async function bodyToString(body: unknown): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBufferView);
  if (body instanceof Blob) return body.text();
  return "[unreadable body]";
}

/** Normalise fetch(input, init) into a RecordedRequest. */
export async function describeRequest(input: string | URL | Request, init?: RequestInit): Promise<RecordedRequest> {
  if (input instanceof Request) {
    const headers: Record<string, string> = {};
    input.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = init?.body !== undefined ? await bodyToString(init.body) : await input.clone().text().catch(() => undefined);
    return { method: (init?.method ?? input.method).toUpperCase(), url: input.url, headers, ...(body ? { body } : {}) };
  }
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
  const body = await bodyToString(init?.body);
  return { method: (init?.method ?? "GET").toUpperCase(), url: String(input), headers, ...(body !== undefined ? { body } : {}) };
}

function routeMatches(route: FixtureRoute, req: RecordedRequest): boolean {
  const line = `${req.method} ${req.url}`;
  if (typeof route.match === "string") return line.includes(route.match);
  if (route.match instanceof RegExp) {
    route.match.lastIndex = 0;
    return route.match.test(line);
  }
  return route.match(req);
}

/** Build a Response for a fixture, streaming chunks and honouring the abort signal. */
export function fixtureResponse(fx: HttpFixture, opts: { signal?: AbortSignal | null; substitutions?: Record<string, string> } = {}): Response {
  const subs = opts.substitutions;
  const headers = new Headers();
  for (const [k, v] of Object.entries(fx.headers ?? {})) headers.set(k, substitute(v, subs));
  let chunks: string[];
  if (fx.chunks) chunks = fx.chunks.map((c) => substitute(c, subs));
  else if (fx.json !== undefined) {
    chunks = [substitute(JSON.stringify(fx.json), subs)];
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else chunks = fx.body !== undefined ? [substitute(fx.body, subs)] : [];
  const status = fx.status ?? 200;
  const nullBody = status === 204 || status === 304;
  const encoder = new TextEncoder();
  const signal = opts.signal ?? undefined;
  const delay = fx.chunkDelayMs ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          try {
            controller.error(abortError());
          } catch {
            /* already closed */
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    async pull(controller) {
      if (signal?.aborted) return;
      const next = chunks.shift();
      if (next === undefined) {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        controller.close();
        return;
      }
      if (delay > 0) await new Promise<void>((r) => (timer = setTimeout(r, delay)));
      if (signal?.aborted) return;
      controller.enqueue(encoder.encode(next));
    },
    cancel() {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    },
  });
  return new Response(nullBody ? null : stream, { status, headers });
}

/**
 * A fetch that serves fixtures by route. Records every request so tests can
 * assert on headers (the API key was sent) and bodies (the request shape).
 */
export function createFixtureFetch(routes: readonly FixtureRoute[], opts: FixtureFetchOptions = {}): FixtureFetch {
  const requests: RecordedRequest[] = [];
  const unmatched: RecordedRequest[] = [];
  const served = new Map<FixtureRoute, number>();
  const fetch: FetchLike = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const req = await describeRequest(input, init);
    requests.push(req);
    if (signal?.aborted) throw abortError();
    const route = routes.find((r) => routeMatches(r, req));
    let fx: HttpFixture;
    if (!route) {
      unmatched.push(req);
      fx = opts.fallback ?? { status: 404, json: { error: { type: "not_found", message: `no fixture for ${req.method} ${redactUrl(req.url)}` } } };
    } else {
      const list = Array.isArray(route.response) ? route.response : [route.response];
      const n = served.get(route) ?? 0;
      served.set(route, n + 1);
      fx = list[Math.min(n, list.length - 1)]!;
    }
    if (fx.networkError !== undefined) throw new TypeError(fx.networkError || "fetch failed");
    return fixtureResponse(fx, { signal: signal ?? null, ...(opts.substitutions ? { substitutions: opts.substitutions } : {}) });
  };
  return { fetch, requests, unmatched };
}

/** Format Server-Sent Events as chunks: one chunk per event. */
export function sseChunks(events: readonly { event?: string; data: unknown }[]): string[] {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
}

export interface Recording {
  request: RecordedRequest;
  response: { status: number; headers: Record<string, string>; chunks: string[] };
  recordedAt: string;
}

export interface RecordingFetchOptions {
  /** The real fetch. Default globalThis.fetch. */
  fetch?: FetchLike;
  /** Values to remove from everything recorded (API keys, org ids). */
  secrets: readonly string[];
  /** Called once the response body has been fully read. */
  onRecord: (rec: Recording) => void | Promise<void>;
}

/**
 * Wrap a real fetch and record each exchange with secret headers, query keys and
 * secret values removed. The caller still gets a streaming response.
 */
export function createRecordingFetch(opts: RecordingFetchOptions): FetchLike {
  const real = opts.fetch ?? (globalThis.fetch as FetchLike);
  const clean = (s: string) => redactSecrets(s, opts.secrets);
  return async (input, init) => {
    const req = await describeRequest(input, init);
    const res = await real(input, init);
    const request: RecordedRequest = {
      method: req.method,
      url: clean(redactUrl(req.url)),
      headers: Object.fromEntries(Object.entries(redactHeaders(req.headers)).map(([k, v]) => [k, clean(v)])),
      ...(req.body !== undefined ? { body: clean(req.body) } : {}),
    };
    const resHeaders = Object.fromEntries(Object.entries(redactHeaders(res.headers)).map(([k, v]) => [k, clean(v)]));
    if (!res.body) {
      await opts.onRecord({ request, response: { status: res.status, headers: resHeaders, chunks: [] }, recordedAt: new Date().toISOString() });
      return res;
    }
    const [forCaller, forRecord] = res.body.tee();
    void (async () => {
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      const reader = forRecord.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(clean(decoder.decode(value, { stream: true })));
        }
        const tail = decoder.decode();
        if (tail) chunks.push(clean(tail));
      } catch {
        chunks.push("[stream interrupted]");
      }
      await opts.onRecord({ request, response: { status: res.status, headers: resHeaders, chunks }, recordedAt: new Date().toISOString() });
    })();
    return new Response(forCaller, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Turn a recording into a route that replays it. Matches on method + path (no query). */
export function routeFromRecording(rec: Recording): FixtureRoute {
  const u = new URL(rec.request.url);
  const headers = { ...rec.response.headers };
  for (const [k, v] of Object.entries(headers)) if (v === REDACTED) delete headers[k];
  delete headers["content-length"];
  delete headers["content-encoding"];
  return { match: `${rec.request.method} ${u.origin}${u.pathname}`, response: { status: rec.response.status, headers, chunks: rec.response.chunks } };
}
