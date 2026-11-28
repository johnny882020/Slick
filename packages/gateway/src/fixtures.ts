// Fixture replay (and recording) for provider tests.
//
//   const f = fixtureFetch("fixtures/anthropic");
//   f.queue("weather_tool_call");               // serve fixtures/anthropic/weather_tool_call.sse next
//   const p = createAnthropicProvider({ apiKey: "test", fetch: f });
//   ... f.requests[0].body                       // the JSON the adapter sent (headers redacted)
//
// A case is `<case>.sse` (served as text/event-stream) or `<case>.json`
// (application/json), plus an optional `<case>.meta.json` with
// `{ "status": 429, "headers": { "retry-after": "7" } }`.
//
// Recording: with `record: true` (default: ONESEAT_RECORD=1) each queued case is
// fetched live with the real fetch and written to disk. Secret headers are
// never written; response headers and bodies pass through redact().

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "@oneseat/contracts";
import { redact, redactHeaders } from "./errors.js";

export interface RecordedRequest {
  url: string;
  method: string;
  /** Request headers, secrets replaced with [REDACTED]. */
  headers: Record<string, string>;
  /** Parsed JSON body (or raw text when not JSON). */
  body: unknown;
  /** The fixture case that answered. */
  case: string;
}

export interface FixtureMeta {
  status?: number;
  headers?: Record<string, string>;
}

export interface FixtureFetchOptions {
  /** Split each body into chunks of this many bytes (exercises partial reads and split UTF-8). Default: whole body. */
  chunkSize?: number;
  /** Wait this long between chunks. Default 0. */
  chunkDelayMs?: number;
  /** Record live instead of replaying. Default: process.env.ONESEAT_RECORD === "1". */
  record?: boolean;
  /** Fetch used when recording. Default: globalThis.fetch. */
  realFetch?: FetchLike;
  /** Extra values to strip from anything written to disk. */
  secrets?: string[];
}

export interface FixtureFetch extends FetchLike {
  readonly requests: RecordedRequest[];
  /** Cases to serve, in order, one per request. */
  queue(...cases: string[]): FixtureFetch;
  /** Cases not yet served. */
  pending(): string[];
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable", 529: "Overloaded" };

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A ReadableStream over bytes, in chunks, that errors when `signal` aborts (as real fetch bodies do). */
export function chunkedStream(bytes: Uint8Array, opts: { chunkSize?: number; chunkDelayMs?: number; signal?: AbortSignal } = {}): ReadableStream<Uint8Array> {
  const size = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : bytes.length || 1;
  let offset = 0;
  let onAbort: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (opts.signal) {
        onAbort = () => {
          try {
            controller.error(abortError());
          } catch {
            /* already closed */
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    async pull(controller) {
      if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
      if (opts.signal?.aborted) return;
      if (offset >= bytes.length) {
        if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() {
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    },
  });
}

function headersOf(init: RequestInit | undefined, input: string | URL | Request): Record<string, string> {
  const h = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v, k) => h.set(k, v));
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

async function bodyOf(init: RequestInit | undefined, input: string | URL | Request): Promise<unknown> {
  let text: string | undefined;
  if (typeof init?.body === "string") text = init.body;
  else if (input instanceof Request) text = await input.clone().text();
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function fixtureFetch(dir: string, options: FixtureFetchOptions = {}): FixtureFetch {
  const queue: string[] = [];
  const requests: RecordedRequest[] = [];
  const record = options.record ?? process.env["ONESEAT_RECORD"] === "1";

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError();
    const name = queue.shift();
    const rawHeaders = headersOf(init, input);
    const secrets = [
      ...(options.secrets ?? []),
      ...Object.entries(rawHeaders)
        .filter(([k]) => ["x-api-key", "authorization", "x-goog-api-key", "api-key"].includes(k))
        .map(([, v]) => v.replace(/^Bearer\s+/i, "")),
    ];
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = redact(urlOf(input), secrets);
    const entry: RecordedRequest = {
      url,
      method,
      headers: redactHeaders(rawHeaders, secrets),
      body: await bodyOf(init, input),
      case: name ?? "",
    };
    requests.push(entry);
    if (!name) throw new Error(`fixtureFetch: no fixture queued for ${method} ${url}`);

    if (record) return recordCase(dir, name, input, init, secrets, options);

    const metaPath = join(dir, `${name}.meta.json`);
    const meta: FixtureMeta = existsSync(metaPath) ? (JSON.parse(await readFile(metaPath, "utf8")) as FixtureMeta) : {};
    let bytes: Uint8Array;
    let contentType: string;
    if (existsSync(join(dir, `${name}.sse`))) {
      bytes = new Uint8Array(await readFile(join(dir, `${name}.sse`)));
      contentType = "text/event-stream; charset=utf-8";
    } else if (existsSync(join(dir, `${name}.json`))) {
      bytes = new Uint8Array(await readFile(join(dir, `${name}.json`)));
      contentType = "application/json";
    } else {
      throw new Error(`fixtureFetch: no fixture file for case "${name}" in ${dir}`);
    }
    const status = meta.status ?? 200;
    const headers = new Headers({ "content-type": contentType, ...(meta.headers ?? {}) });
    const body = chunkedStream(bytes, {
      ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
      ...(options.chunkDelayMs ? { chunkDelayMs: options.chunkDelayMs } : {}),
      ...(signal ? { signal } : {}),
    });
    return new Response(body, { status, statusText: STATUS_TEXT[status] ?? "", headers });
  };

  const f = fn as FixtureFetch;
  Object.defineProperty(f, "requests", { value: requests });
  f.queue = (...cases: string[]) => {
    queue.push(...cases);
    return f;
  };
  f.pending = () => [...queue];
  return f;
}

/** Headers worth keeping in a recorded fixture. Everything else is noise (dates, cookies, ids). */
const KEEP_RESPONSE_HEADERS = ["retry-after", "retry-after-ms", "content-type"];

async function recordCase(
  dir: string,
  name: string,
  input: string | URL | Request,
  init: RequestInit | undefined,
  secrets: string[],
  options: FixtureFetchOptions,
): Promise<Response> {
  const real = options.realFetch ?? ((i: string | URL | Request, n?: RequestInit) => globalThis.fetch(i, n));
  const res = await real(input, init);
  const text = redact(await res.text(), secrets);
  const contentType = res.headers.get("content-type") ?? "";
  const isSse = contentType.includes("event-stream");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.${isSse ? "sse" : "json"}`), text);
  const kept: Record<string, string> = {};
  for (const k of KEEP_RESPONSE_HEADERS) {
    const v = res.headers.get(k);
    if (v && k !== "content-type") kept[k] = v;
  }
  const meta: FixtureMeta = {};
  if (res.status !== 200) meta.status = res.status;
  if (Object.keys(kept).length > 0) meta.headers = redactHeaders(kept, secrets);
  if (Object.keys(meta).length > 0) await writeFile(join(dir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return new Response(text, { status: res.status, statusText: res.statusText, headers: { "content-type": contentType } });
}
