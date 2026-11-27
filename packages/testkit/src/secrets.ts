// Secret handling for tests: make fake keys, find leaks, redact recordings.
// CLAUDE.md: never write a key to a skill, a log, a prompt, a fixture or an error message.

import { randomBytes } from "node:crypto";

/** Header names whose values are always redacted. */
export const SECRET_HEADERS: readonly string[] = ["x-api-key", "authorization", "x-goog-api-key", "api-key", "proxy-authorization", "cookie", "set-cookie"];

export const REDACTED = "[REDACTED]";

export interface FakeApiKey {
  /** The whole key, e.g. "sk-oneseat-test-3f9c...". */
  key: string;
  /** The random core. A leak of the core alone (a partly masked key) still counts. */
  core: string;
}

/** A realistic-looking key that is unique per call. */
export function makeFakeApiKey(prefix = "sk-oneseat-test-"): FakeApiKey {
  const core = randomBytes(18).toString("hex");
  return { key: `${prefix}${core}`, core };
}

export interface SecretLeak {
  where: string;
  secret: string;
  excerpt: string;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const parts = [value.name, value.message, value.stack ?? ""];
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) parts.push(safeString(cause));
    for (const [k, v] of Object.entries(value)) parts.push(`${k}=${safeString(v)}`);
    return parts.join("\n");
  }
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_k, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (v instanceof Error) return safeString(v);
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[cycle]";
          seen.add(v);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * Look for any of the secrets in each labelled value. Values are stringified
 * (Errors include message, stack, cause and own properties).
 */
export function findSecretLeaks(values: Record<string, unknown>, secrets: readonly string[]): SecretLeak[] {
  const leaks: SecretLeak[] = [];
  const needles = secrets.filter((s) => s.length >= 8);
  for (const [where, value] of Object.entries(values)) {
    const text = safeString(value);
    for (const secret of needles) {
      const at = text.indexOf(secret);
      if (at >= 0) {
        const excerpt = text.slice(Math.max(0, at - 30), at) + REDACTED + text.slice(at + secret.length, at + secret.length + 30);
        leaks.push({ where, secret: `${secret.slice(0, 4)}…(${secret.length} chars)`, excerpt });
      }
    }
  }
  return leaks;
}

/** Replace every occurrence of each secret with [REDACTED]. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
  return out;
}

/** Copy headers with secret header values replaced. */
export function redactHeaders(headers: Headers | Record<string, string> | [string, string][] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: [string, string][] =
    headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [k, v] of entries) out[k.toLowerCase()] = SECRET_HEADERS.includes(k.toLowerCase()) ? REDACTED : v;
  return out;
}

/** Remove common query-string credentials (?key=, ?api_key=, ?access_token=). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&#]*/gi, `$1${REDACTED}`);
}
