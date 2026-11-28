import { describe, expect, it } from "vitest";
import { isRetryableKind, kindForStatus, parseRetryAfter, providerError, redact, redactHeaders, REDACTED } from "../src/index.js";
import { errorFromResponse, errorFromThrown, parseDuration } from "../src/errors.js";

describe("redact", () => {
  it("removes exact secrets, longest first", () => {
    expect(redact("key=abcd1234 and abcd1234-extended", ["abcd1234", "abcd1234-extended"])).toBe(`key=${REDACTED} and ${REDACTED}`);
    expect(redact("short abc stays", ["abc"])).toBe("short abc stays");
    expect(redact("nothing", [undefined, ""])).toBe("nothing");
  });

  it("removes well-known key shapes even when not told about them", () => {
    const anthropic = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const openai = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
    const google = "AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW";
    const out = redact(`a ${anthropic} b ${openai} c ${google}`);
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  });

  it("keeps labels but drops values for bearer tokens, query keys and header-like text", () => {
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload")).not.toContain("eyJhbGci");
    expect(redact("curl -H 'Bearer abcdefgh12345678'")).toBe(`curl -H 'Bearer ${REDACTED}'`);
    expect(redact("GET /v1beta/models?key=zzzzzzzzzz&alt=sse")).toBe(`GET /v1beta/models?key=${REDACTED}&alt=sse`);
    expect(redact('{"x-api-key": "plainvalue"}')).toBe(`{"x-api-key": "${REDACTED}"}`);
    expect(redact("x-goog-api-key=qwertyuiop")).toBe(`x-goog-api-key=${REDACTED}`);
  });

  it("leaves ordinary text alone", () => {
    const s = "Rate limit reached for gpt-5 in organization org-123. Please try again in 7s.";
    expect(redact(s)).toBe(s);
  });
});

describe("redactHeaders", () => {
  it("replaces secret headers and secret values, lower-casing names", () => {
    expect(
      redactHeaders({ "X-Api-Key": "k1", Authorization: "Bearer k2", "Content-Type": "application/json", "X-Org": "my-org-secret" }, ["my-org-secret"]),
    ).toEqual({ "x-api-key": REDACTED, authorization: REDACTED, "content-type": "application/json", "x-org": REDACTED });
    expect(redactHeaders(new Headers({ "x-goog-api-key": "g", accept: "text/event-stream" }))).toEqual({ "x-goog-api-key": REDACTED, accept: "text/event-stream" });
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe("status mapping", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [400, "invalid_request"],
    [413, "invalid_request"],
    [422, "invalid_request"],
    [408, "network"],
    [409, "server"],
    [429, "rate_limit"],
    [503, "overloaded"],
    [529, "overloaded"],
    [500, "server"],
    [504, "server"],
    [418, "unknown"],
    [302, "unknown"],
  ] as const)("%i -> %s", (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });

  it("retryable kinds", () => {
    expect(["rate_limit", "overloaded", "network", "server"].every((k) => isRetryableKind(k as never))).toBe(true);
    expect(["auth", "invalid_request", "not_found", "aborted", "unknown"].some((k) => isRetryableKind(k as never))).toBe(false);
  });

  it("providerError honours overrides and drops bad retryAfter", () => {
    expect(providerError("server", "x", { retryable: false })).toEqual({ kind: "server", message: "x", retryable: false });
    expect(providerError("rate_limit", "x", { retryAfter: -1 })).toEqual({ kind: "rate_limit", message: "x", retryable: true });
    expect(providerError("rate_limit", "x", { retryAfter: Number.NaN })).not.toHaveProperty("retryAfter");
  });
});

describe("retry hints", () => {
  it("parses retry-after seconds, HTTP dates and retry-after-ms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "7" }))).toBe(7);
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }))).toBe(1.5);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(0.25);
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "Fri, 27 Nov 2026 12:00:30 GMT" }), now)).toBe(30);
    expect(parseRetryAfter(new Headers({ "retry-after": "Fri, 27 Nov 2026 11:00:00 GMT" }), now)).toBe(0);
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });

  it("parses protobuf durations", () => {
    expect(parseDuration("7s")).toBe(7);
    expect(parseDuration("0.5s")).toBe(0.5);
    expect(parseDuration("7m")).toBeUndefined();
    expect(parseDuration(7)).toBeUndefined();
  });
});

describe("errorFromResponse / errorFromThrown", () => {
  it("uses the status text when the body is empty and survives an unreadable body", async () => {
    const e = await errorFromResponse(new Response(null, { status: 502, statusText: "Bad Gateway" }), { provider: "P", secrets: [] });
    expect(e).toEqual({ kind: "server", status: 502, retryable: true, message: "P API error 502: Bad Gateway" });
    const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error("boom")) }), { status: 500 });
    const e2 = await errorFromResponse(broken, { provider: "P", secrets: [] });
    expect(e2.kind).toBe("server");
  });

  it("ignores body parsers that cannot read the body, and truncates long messages", async () => {
    const e = await errorFromResponse(new Response("x".repeat(5000), { status: 400 }), { provider: "P", secrets: [], parseBody: () => ({ message: "never" }) });
    expect(e.message.length).toBeLessThan(700);
    expect(e.message.endsWith("…")).toBe(true);
  });

  it("maps abort errors and plain values", () => {
    expect(errorFromThrown(new DOMException("x", "AbortError"), { provider: "P", secrets: [] }).kind).toBe("aborted");
    const ac = new AbortController();
    ac.abort();
    expect(errorFromThrown(new Error("whatever"), { provider: "P", secrets: [], signal: ac.signal }).kind).toBe("aborted");
    expect(errorFromThrown("string failure", { provider: "P", secrets: [] })).toEqual({ kind: "network", retryable: true, message: "P: network error: string failure" });
    expect(errorFromThrown({ name: 3 }, { provider: "P", secrets: [] }).kind).toBe("network");
  });
});

import { providerError as pe } from "../src/errors.js";
describe("out-of-credit errors are final", () => {
  it("never retries an empty balance or exhausted quota, whatever the kind", () => {
    // The exact messages the three providers returned for accounts with no credit (2026-11-27).
    expect(pe("invalid_request", "Anthropic API error 400: invalid_request_error: Your credit balance is too low to access the Anthropic API.").retryable).toBe(false);
    expect(pe("server", "OpenAI stream error: credit_balance_exhausted: You have no credits remaining.").retryable).toBe(false);
    expect(pe("rate_limit", "OpenAI API error 429: insufficient_quota: You exceeded your current quota, please check your plan and billing details.").retryable).toBe(false);
    expect(pe("rate_limit", "Too many requests").retryable).toBe(true);
    // Gemini's per-minute free-tier limit uses "quota" wording but clears in seconds.
    expect(pe("rate_limit", "Gemini API error 429: RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.").retryable).toBe(true);
    expect(pe("server", "Internal error").retryable).toBe(true);
  });
});
