// Error normalisation and secret redaction.
// Every message that leaves the gateway (error events, recorded fixtures) goes
// through redact(): API keys must never appear in an error, a log or a fixture.

import type { ProviderError, ProviderErrorKind } from "@oneseat/contracts";

export const REDACTED = "[REDACTED]";

/** Header names whose values are always secret. Lower case. */
export const SECRET_HEADERS: readonly string[] = [
  "x-api-key",
  "authorization",
  "x-goog-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
  "set-cookie",
];

// Well-known key shapes, so a key is redacted even when we were not told about it.
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /AIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // auth header values
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, // keys in query strings
  /((?:x-api-key|x-goog-api-key|api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, // "header: value" in text
];

/**
 * Remove secrets from a string. `secrets` are exact values to strip (the
 * configured API key and extra header values); well-known key shapes are
 * always stripped too.
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  const exact = secrets.filter((s): s is string => typeof s === "string" && s.length >= 4);
  // Longest first, so a secret that contains another is removed whole.
  exact.sort((a, b) => b.length - a.length);
  for (const s of exact) out = out.split(s).join(REDACTED);
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (match: string, prefix?: string) => {
      if (typeof prefix === "string" && match.startsWith(prefix) && prefix !== match) {
        // Keep the label ("Bearer ", "?key=", "x-api-key: ") and drop the value.
        return /^(bearer|basic)$/i.test(prefix) ? `${prefix} ${REDACTED}` : `${prefix}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/** Copy of headers with secret values replaced. Also strips any header whose value is a known secret. */
export function redactHeaders(
  headers: Record<string, string> | Headers | undefined,
  secrets: readonly (string | undefined)[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: [string, string][] =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) {
    const lk = k.toLowerCase();
    out[lk] = SECRET_HEADERS.includes(lk) ? REDACTED : redact(v, secrets);
  }
  return out;
}

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  overloaded: true,
  invalid_request: false,
  not_found: false,
  network: true,
  server: true,
  aborted: false,
  unknown: false,
};

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE[kind];
}

export function providerError(
  kind: ProviderErrorKind,
  message: string,
  extra: { status?: number; retryAfter?: number; retryable?: boolean } = {},
): ProviderError {
  const err: ProviderError = { kind, message, retryable: extra.retryable ?? RETRYABLE[kind] };
  if (extra.status !== undefined) err.status = extra.status;
  if (extra.retryAfter !== undefined && Number.isFinite(extra.retryAfter) && extra.retryAfter >= 0)
    err.retryAfter = extra.retryAfter;
  return err;
}

/** HTTP status -> error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 422) return "invalid_request";
  if (status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status === 409 || status >= 500) return "server";
  return "unknown";
}

/**
 * Parse retry hints. Supports `retry-after-ms`, `retry-after` as seconds or an
 * HTTP date. Returns seconds.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Number(ms.trim()) / 1000;
  const ra = headers.get("retry-after");
  if (!ra) return undefined;
  const v = ra.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

/** Parse a protobuf Duration string ("7s", "1.5s") into seconds. */
export function parseDuration(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
  return m ? Number(m[1]) : undefined;
}

export function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (e && typeof e === "object" && "name" in e) {
    const name = (e as { name?: unknown }).name;
    return name === "AbortError";
  }
  return false;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : "";
    return `${e.message}${causeMsg}`;
  }
  return String(e);
}

/** Map a thrown value (fetch rejection, body read failure) to a ProviderError. */
export function errorFromThrown(
  e: unknown,
  ctx: { provider: string; signal?: AbortSignal; secrets: readonly (string | undefined)[] },
): ProviderError {
  if (isAbortError(e, ctx.signal)) return providerError("aborted", `${ctx.provider}: request aborted`);
  return providerError("network", redact(`${ctx.provider}: network error: ${messageOf(e)}`, ctx.secrets));
}

const MAX_MESSAGE = 600;

export function truncate(s: string, max = MAX_MESSAGE): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** What a provider adapter can pull out of an error body. */
export interface ErrorBodyInfo {
  message?: string;
  /** Overrides the status-based kind, e.g. Anthropic "overloaded_error". */
  kind?: ProviderErrorKind;
  /** Seconds, e.g. Gemini RetryInfo.retryDelay. */
  retryAfter?: number;
}

export type ErrorBodyParser = (body: unknown, status: number) => ErrorBodyInfo;

/** Build a ProviderError from a non-2xx response. Never throws. */
export async function errorFromResponse(
  res: Response,
  ctx: { provider: string; secrets: readonly (string | undefined)[]; parseBody?: ErrorBodyParser },
): Promise<ProviderError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body unreadable: fall back to the status line */
  }
  let info: ErrorBodyInfo = {};
  if (text && ctx.parseBody) {
    try {
      info = ctx.parseBody(JSON.parse(text), res.status);
    } catch {
      info = {};
    }
  }
  const kind = info.kind ?? kindForStatus(res.status);
  const detail = info.message ?? (text ? text : res.statusText);
  const message = truncate(redact(`${ctx.provider} API error ${res.status}${detail ? `: ${detail}` : ""}`, ctx.secrets));
  const retryAfter = parseRetryAfter(res.headers) ?? info.retryAfter;
  return providerError(kind, message, { status: res.status, ...(retryAfter !== undefined ? { retryAfter } : {}) });
}
