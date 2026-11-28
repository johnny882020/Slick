// ModelProvider conformance (contract 1). Every adapter in packages/gateway calls
// describeModelProviderConformance() from its own test file with documented-format fixtures.

import { describe, expect, it } from "vitest";
import type { ChatRequest, FetchLike, ModelInfo, ModelProvider, ProviderErrorKind } from "@oneseat/contracts";
import { PROVIDER_IDS } from "@oneseat/contracts";
import { createFixtureFetch, type FixtureRoute, type HttpFixture } from "../fixtures.js";
import { scenarioRequest, textRequest, WEATHER_SCENARIO } from "../scenarios.js";
import { findSecretLeaks, makeFakeApiKey, type FakeApiKey } from "../secrets.js";
import { deepEqual, drainStream, normaliseToolCalls, streamText, terminalEvent, validateChatStream, type DrainResult } from "../stream.js";

/** Build the adapter under test. It MUST send `apiKey` (the suite checks that it did, and that it never leaks). */
export type MakeProvider = (fetch: FetchLike, apiKey: string) => ModelProvider;

export interface ProviderScenarioFixture {
  /** Overrides on the default request (model is always fixtures.model). */
  request?: Partial<Omit<ChatRequest, "signal" | "model">>;
  /** HTTP routes the scenario needs. Bodies may contain {{API_KEY}}. */
  routes: FixtureRoute[];
}

export type ErrorCaseName = "auth" | "rate_limit" | "server" | "overloaded" | "invalid_request" | "not_found";

export interface ModelProviderFixtures {
  /** Model id used in every request. */
  model: string;
  /** A plain text reply. The stream must have text and stop with end_turn. */
  text: ProviderScenarioFixture & { expectText?: string };
  /** The reply to WEATHER_SCENARIO: one get_weather call with {city: "Paris"}, stop tool_use. */
  toolCall: ProviderScenarioFixture;
  /**
   * HTTP error responses, in the provider's own format. Missing ones get a generic
   * JSON error body with the right status that echoes the API key (a real provider habit).
   */
  errors?: Partial<Record<ErrorCaseName, HttpFixture>>;
  /** Routes models() calls, if it calls the API. */
  models?: FixtureRoute[];
  /** Routes countTokens() calls, if it calls the API. */
  countTokens?: FixtureRoute[];
  /** Per-stream timeout in ms. Default 10 000. */
  timeoutMs?: number;
}

export interface ProviderCheckResult {
  name: string;
  problems: string[];
}

interface ErrorExpectation {
  status: number;
  kinds: ProviderErrorKind[];
  retryable: boolean;
  headers?: Record<string, string>;
  retryAfter?: number;
}

export const ERROR_EXPECTATIONS: Record<ErrorCaseName, ErrorExpectation> = {
  auth: { status: 401, kinds: ["auth"], retryable: false },
  rate_limit: { status: 429, kinds: ["rate_limit"], retryable: true, headers: { "retry-after": "7" }, retryAfter: 7 },
  server: { status: 500, kinds: ["server"], retryable: true },
  overloaded: { status: 529, kinds: ["overloaded", "server"], retryable: true },
  invalid_request: { status: 400, kinds: ["invalid_request"], retryable: false },
  not_found: { status: 404, kinds: ["not_found", "invalid_request"], retryable: false },
};

const ERROR_TYPES: Record<ErrorCaseName, [string, string]> = {
  auth: ["authentication_error", "UNAUTHENTICATED"],
  rate_limit: ["rate_limit_error", "RESOURCE_EXHAUSTED"],
  server: ["api_error", "INTERNAL"],
  overloaded: ["overloaded_error", "UNAVAILABLE"],
  invalid_request: ["invalid_request_error", "INVALID_ARGUMENT"],
  not_found: ["not_found_error", "NOT_FOUND"],
};

/** A generic error body readable by Anthropic-, OpenAI- and Gemini-style parsers. It echoes the key. */
export function genericErrorFixture(name: ErrorCaseName): HttpFixture {
  const exp = ERROR_EXPECTATIONS[name];
  const [type, status] = ERROR_TYPES[name];
  return {
    status: exp.status,
    headers: { "content-type": "application/json", ...(exp.headers ?? {}), "x-request-id": "req_conformance" },
    body: JSON.stringify({
      type: "error",
      error: {
        type,
        code: exp.status,
        status,
        message: `${name} failure for key {{API_KEY}} (Authorization: Bearer {{API_KEY}})`,
      },
    }),
  };
}

const MODEL_TIERS = ["frontier", "balanced", "fast"];

/** Check models() output against ModelInfo. */
export function validateModelInfos(models: unknown, providerId: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(models)) return ["models() must resolve to an array"];
  if (models.length === 0) problems.push("models() returned no models");
  const ids = new Set<string>();
  models.forEach((m: Partial<ModelInfo>, i) => {
    const at = `models[${i}]`;
    if (!m || typeof m !== "object") {
      problems.push(`${at} is not an object`);
      return;
    }
    if (typeof m.id !== "string" || m.id.length === 0) problems.push(`${at}.id must be a non-empty string`);
    else if (ids.has(m.id)) problems.push(`${at}.id "${m.id}" is duplicated`);
    else ids.add(m.id);
    if (!PROVIDER_IDS.includes(m.provider as never)) problems.push(`${at}.provider "${String(m.provider)}" is not a ProviderId`);
    else if (m.provider !== providerId) problems.push(`${at}.provider "${m.provider}" does not match provider.id "${providerId}"`);
    if (typeof m.label !== "string" || m.label.trim().length === 0) problems.push(`${at}.label must be a non-empty string`);
    if (typeof m.supportsTools !== "boolean") problems.push(`${at}.supportsTools must be a boolean`);
    for (const k of ["contextWindow", "maxOutputTokens"] as const)
      if (m[k] !== undefined && (!Number.isInteger(m[k]) || (m[k] as number) <= 0)) problems.push(`${at}.${k} must be a positive integer`);
    if (m.tier !== undefined && !MODEL_TIERS.includes(m.tier)) problems.push(`${at}.tier "${String(m.tier)}" is not one of ${MODEL_TIERS.join(", ")}`);
  });
  return problems;
}

function describeThrown(t: unknown): string {
  return t instanceof Error ? `${t.name}: ${t.message}` : String(t);
}

function drainProblems(d: DrainResult, toolNames?: string[]): string[] {
  const problems: string[] = [];
  if (d.thrown !== undefined) problems.push(`send() threw instead of emitting an error event: ${describeThrown(d.thrown)}`);
  if (d.timedOut) problems.push("stream did not finish before the timeout");
  for (const i of validateChatStream(d.events, toolNames ? { toolNames } : {}))
    problems.push(`[${i.rule}]${i.index >= 0 ? ` event #${i.index}` : ""}: ${i.message}`);
  return problems;
}

function leakProblems(values: Record<string, unknown>, key: FakeApiKey): string[] {
  return findSecretLeaks(values, [key.key, key.core]).map((l) => `API key leaked in ${l.where}: …${l.excerpt}…`);
}

function splitForStreaming(routes: FixtureRoute[]): FixtureRoute[] {
  return routes.map((r) => {
    const list = Array.isArray(r.response) ? r.response : [r.response];
    return {
      match: r.match,
      response: list.map((fx) => {
        const text = fx.chunks ? fx.chunks.join("") : fx.json !== undefined ? JSON.stringify(fx.json) : (fx.body ?? "");
        let parts = text.split(/(?<=\n\n)/);
        if (parts.length < 2) parts = text.split(/(?<=\n)/);
        if (parts.length < 2 && text.length > 1) parts = [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))];
        const headers = { ...(fx.headers ?? {}) };
        if (fx.json !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
        return { ...fx, json: undefined, body: undefined, headers, chunks: parts, chunkDelayMs: 25 };
      }),
    };
  });
}

function truncateRoutes(routes: FixtureRoute[]): FixtureRoute[] {
  return routes.map((r) => {
    const list = Array.isArray(r.response) ? r.response : [r.response];
    return {
      match: r.match,
      response: list.map((fx) => {
        const text = fx.chunks ? fx.chunks.join("") : fx.json !== undefined ? JSON.stringify(fx.json) : (fx.body ?? "");
        const headers = { ...(fx.headers ?? {}) };
        if (fx.json !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
        return { status: fx.status ?? 200, headers, chunks: [text.slice(0, Math.floor(text.length * 0.6))] };
      }),
    };
  });
}

function contentTypeOf(routes: FixtureRoute[]): string {
  for (const r of routes) {
    const list = Array.isArray(r.response) ? r.response : [r.response];
    for (const fx of list) {
      const ct = Object.entries(fx.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type");
      if (ct) return ct[1];
    }
  }
  return "text/event-stream";
}

interface Ctx {
  makeProvider: MakeProvider;
  fixtures: ModelProviderFixtures;
  key: FakeApiKey;
}

function build(ctx: Ctx, routes: FixtureRoute[]) {
  const ff = createFixtureFetch(routes, { substitutions: { "{{API_KEY}}": ctx.key.key } });
  const provider = ctx.makeProvider(ff.fetch, ctx.key.key);
  return { ff, provider };
}

function textReq(ctx: Ctx, signal?: AbortSignal): ChatRequest {
  return { ...textRequest(ctx.fixtures.model, signal), ...(ctx.fixtures.text.request ?? {}) };
}

function toolReq(ctx: Ctx): ChatRequest {
  return { ...scenarioRequest(WEATHER_SCENARIO, ctx.fixtures.model), ...(ctx.fixtures.toolCall.request ?? {}) };
}

type Check = { name: string; run: (ctx: Ctx) => Promise<string[]> };

async function sendAndCheck(ctx: Ctx, routes: FixtureRoute[], req: ChatRequest, extra: (d: DrainResult) => string[]): Promise<string[]> {
  const { provider } = build(ctx, routes);
  const d = await drainStream(provider, req, { timeoutMs: ctx.fixtures.timeoutMs ?? 10_000 });
  return [...drainProblems(d, req.tools.map((t) => t.name)), ...extra(d), ...leakProblems({ events: d.events, thrown: d.thrown }, ctx.key)];
}

function errorCheck(name: ErrorCaseName): Check {
  const exp = ERROR_EXPECTATIONS[name];
  return {
    name: `maps HTTP ${exp.status} (${name}) to an error event of kind ${exp.kinds.join(" or ")}`,
    run: async (ctx) => {
      const fx = ctx.fixtures.errors?.[name] ?? genericErrorFixture(name);
      return sendAndCheck(ctx, [{ match: () => true, response: fx }], textReq(ctx), (d) => {
        const t = terminalEvent(d.events);
        if (!t || t.type !== "error") return [`expected the stream to end with an error event, got ${t?.type ?? "nothing"}`];
        const p: string[] = [];
        if (!exp.kinds.includes(t.error.kind)) p.push(`error.kind is "${t.error.kind}", expected ${exp.kinds.join(" or ")}`);
        if (t.error.retryable !== exp.retryable) p.push(`error.retryable is ${t.error.retryable}, expected ${exp.retryable}`);
        if (t.error.status !== undefined && t.error.status !== (fx.status ?? exp.status))
          p.push(`error.status is ${t.error.status}, expected ${fx.status ?? exp.status}`);
        if (exp.retryAfter !== undefined && !ctx.fixtures.errors?.[name] && t.error.retryAfter !== exp.retryAfter)
          p.push(`error.retryAfter is ${String(t.error.retryAfter)}, expected ${exp.retryAfter} from the retry-after header`);
        if (d.events.some((e) => e.type === "message_end")) p.push("an HTTP error must not produce message_end");
        return p;
      });
    },
  };
}

const CHECKS: Check[] = [
  {
    name: "models() returns valid ModelInfo",
    run: async (ctx) => {
      const { provider } = build(ctx, ctx.fixtures.models ?? []);
      try {
        const models = await provider.models();
        return validateModelInfos(models, provider.id);
      } catch (e) {
        return [`models() rejected: ${describeThrown(e)}`, ...leakProblems({ thrown: e }, ctx.key)];
      }
    },
  },
  {
    name: "provider.id is a ProviderId",
    run: async (ctx) => {
      const { provider } = build(ctx, []);
      return PROVIDER_IDS.includes(provider.id) ? [] : [`provider.id "${String(provider.id)}" is not one of ${PROVIDER_IDS.join(", ")}`];
    },
  },
  {
    name: "text reply: valid stream, text deltas, end_turn",
    run: (ctx) =>
      sendAndCheck(ctx, ctx.fixtures.text.routes, textReq(ctx), (d) => {
        const p: string[] = [];
        const text = streamText(d.events);
        if (text.length === 0) p.push("no text_delta events");
        if (ctx.fixtures.text.expectText !== undefined && text !== ctx.fixtures.text.expectText)
          p.push(`text is ${JSON.stringify(text)}, expected ${JSON.stringify(ctx.fixtures.text.expectText)}`);
        const t = terminalEvent(d.events);
        if (t?.type !== "message_end") p.push(`expected message_end, got ${t?.type ?? "nothing"}`);
        else {
          if (t.stopReason !== "end_turn") p.push(`stopReason is "${t.stopReason}", expected "end_turn"`);
          if (t.usage.inputTokens + t.usage.outputTokens <= 0) p.push("usage reports zero tokens for a real reply");
        }
        if (d.events.some((e) => e.type === "tool_call")) p.push("text reply produced a tool_call");
        return p;
      }),
  },
  {
    name: "tool call: get_weather with complete input {city: \"Paris\"}, stop tool_use",
    run: (ctx) =>
      sendAndCheck(ctx, ctx.fixtures.toolCall.routes, toolReq(ctx), (d) => {
        const p: string[] = [];
        const calls = normaliseToolCalls(d.events);
        if (!deepEqual(calls, WEATHER_SCENARIO.expected.toolCalls))
          p.push(`tool calls are ${JSON.stringify(calls)}, expected ${JSON.stringify(WEATHER_SCENARIO.expected.toolCalls)}`);
        const t = terminalEvent(d.events);
        if (t?.type !== "message_end") p.push(`expected message_end, got ${t?.type ?? "nothing"}`);
        else if (t.stopReason !== "tool_use") p.push(`stopReason is "${t.stopReason}", expected "tool_use"`);
        return p;
      }),
  },
  {
    name: "sends the API key it was given (in a header)",
    run: async (ctx) => {
      const { ff, provider } = build(ctx, ctx.fixtures.text.routes);
      await drainStream(provider, textReq(ctx), { timeoutMs: ctx.fixtures.timeoutMs ?? 10_000 });
      if (ff.requests.length === 0) return ["send() made no HTTP request through the injected fetch"];
      const sent = ff.requests.some((r) => Object.values(r.headers).some((v) => v.includes(ctx.key.key)));
      if (sent) return [];
      const inUrl = ff.requests.some((r) => r.url.includes(ctx.key.key));
      return [inUrl ? "API key is sent in the URL; send it in a header (URLs end up in logs)" : "the API key passed to makeProvider was never sent"];
    },
  },
  {
    name: "does not mutate the request",
    run: async (ctx) => {
      const { provider } = build(ctx, ctx.fixtures.toolCall.routes);
      const req = toolReq(ctx);
      const before = structuredClone(req);
      await drainStream(provider, req, { timeoutMs: ctx.fixtures.timeoutMs ?? 10_000 });
      return deepEqual(before, req) ? [] : ["send() changed the ChatRequest it was given"];
    },
  },
  errorCheck("auth"),
  errorCheck("rate_limit"),
  errorCheck("server"),
  errorCheck("overloaded"),
  errorCheck("invalid_request"),
  errorCheck("not_found"),
  {
    name: "network failure becomes a retryable network error, not a throw",
    run: (ctx) =>
      sendAndCheck(ctx, [{ match: () => true, response: { networkError: `connect ECONNREFUSED (key ${ctx.key.key})` } }], textReq(ctx), (d) => {
        const t = terminalEvent(d.events);
        if (t?.type !== "error") return [`expected an error event, got ${t?.type ?? "nothing"}`];
        const p: string[] = [];
        if (t.error.kind !== "network") p.push(`error.kind is "${t.error.kind}", expected "network"`);
        if (!t.error.retryable) p.push("a network error should be retryable");
        return p;
      }),
  },
  {
    name: "malformed response body becomes an error event, not a throw",
    run: (ctx) =>
      sendAndCheck(
        ctx,
        [{ match: () => true, response: { status: 200, headers: { "content-type": contentTypeOf(ctx.fixtures.text.routes) }, chunks: ["data: {this is not json\n\n", "{{{garbage]]]\n\n"] } }],
        textReq(ctx),
        (d) => {
          const t = terminalEvent(d.events);
          return t?.type === "error" ? [] : [`expected an error event for a malformed body, got ${t?.type ?? "nothing"}`];
        },
      ),
  },
  {
    name: "truncated stream ends with an error event",
    run: (ctx) =>
      sendAndCheck(ctx, truncateRoutes(ctx.fixtures.text.routes), textReq(ctx), (d) => {
        const t = terminalEvent(d.events);
        return t?.type === "error" ? [] : [`expected an error event for a cut-off stream, got ${t?.type ?? "nothing"}`];
      }),
  },
  {
    name: "abort before send: error of kind aborted, no throw",
    run: async (ctx) => {
      const ac = new AbortController();
      ac.abort();
      return sendAndCheck(ctx, ctx.fixtures.text.routes, textReq(ctx, ac.signal), (d) => {
        const t = terminalEvent(d.events);
        if (t?.type !== "error") return [`expected an error event, got ${t?.type ?? "nothing"}`];
        const p: string[] = [];
        if (t.error.kind !== "aborted") p.push(`error.kind is "${t.error.kind}", expected "aborted"`);
        if (t.error.retryable) p.push("an aborted request must not be retryable");
        return p;
      });
    },
  },
  {
    name: "abort mid-stream: stops promptly with an aborted error",
    run: async (ctx) => {
      const ac = new AbortController();
      const { provider } = build(ctx, splitForStreaming(ctx.fixtures.text.routes));
      const req = textReq(ctx, ac.signal);
      const started = Date.now();
      const d = await drainStream(provider, req, {
        timeoutMs: ctx.fixtures.timeoutMs ?? 10_000,
        onEvent: () => {
          if (!ac.signal.aborted) ac.abort();
        },
      });
      const p = [...drainProblems(d), ...leakProblems({ events: d.events, thrown: d.thrown }, ctx.key)];
      const t = terminalEvent(d.events);
      if (t?.type !== "error") p.push(`expected an aborted error after abort(), got ${t?.type ?? "nothing"}`);
      else if (t.error.kind !== "aborted") p.push(`error.kind is "${t.error.kind}", expected "aborted"`);
      if (Date.now() - started > 5_000) p.push("stream took over 5 s to stop after abort()");
      return p;
    },
  },
  {
    name: "countTokens() returns a positive integer",
    run: async (ctx) => {
      const { provider } = build(ctx, ctx.fixtures.countTokens ?? []);
      try {
        const n = await provider.countTokens(toolReq(ctx));
        return Number.isInteger(n) && n > 0 ? [] : [`countTokens() returned ${String(n)}, expected a positive integer`];
      } catch (e) {
        return [`countTokens() rejected: ${describeThrown(e)}`, ...leakProblems({ thrown: e }, ctx.key)];
      }
    },
  },
  {
    name: "models() and countTokens() never leak the key on auth failure",
    run: async (ctx) => {
      const { provider } = build(ctx, [{ match: () => true, response: genericErrorFixture("auth") }]);
      const values: Record<string, unknown> = {};
      try {
        values["models() result"] = await provider.models();
      } catch (e) {
        values["models() rejection"] = e;
      }
      try {
        values["countTokens() result"] = await provider.countTokens(textReq(ctx));
      } catch (e) {
        values["countTokens() rejection"] = e;
      }
      return leakProblems(values, ctx.key);
    },
  },
];

/** Names of the checks, in order. */
export const MODEL_PROVIDER_CHECKS: readonly string[] = CHECKS.map((c) => c.name);

/** Run every check and return the problems found. Never throws. */
export async function runModelProviderConformance(makeProvider: MakeProvider, fixtures: ModelProviderFixtures, opts: { key?: FakeApiKey } = {}): Promise<ProviderCheckResult[]> {
  const ctx: Ctx = { makeProvider, fixtures, key: opts.key ?? makeFakeApiKey() };
  const out: ProviderCheckResult[] = [];
  for (const c of CHECKS) out.push({ name: c.name, problems: await safeRun(c, ctx) });
  return out;
}

async function safeRun(c: Check, ctx: Ctx): Promise<string[]> {
  try {
    return await c.run(ctx);
  } catch (e) {
    return [`check crashed: ${describeThrown(e)}`, ...leakProblems({ thrown: e }, ctx.key)];
  }
}

/** Register the ModelProvider conformance suite (vitest). Call at the top level of a test file. */
export function describeModelProviderConformance(name: string, makeProvider: MakeProvider, fixtures: ModelProviderFixtures): void {
  describe(`conformance: ModelProvider ${name}`, () => {
    const ctx: Ctx = { makeProvider, fixtures, key: makeFakeApiKey() };
    for (const c of CHECKS) {
      it(c.name, async () => {
        expect(await safeRun(c, ctx)).toEqual([]);
      });
    }
  });
}

