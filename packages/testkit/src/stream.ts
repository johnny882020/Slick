// Stream validation for the ModelProvider contract (packages/contracts/src/model.ts).
// Pure functions: no vitest import, so adapters, the harness and scripts can use them.

import {
  isValidToolName,
  type ChatEvent,
  type ChatRequest,
  type ModelProvider,
  type ProviderErrorKind,
  type StopReason,
  type ToolCall,
  type Usage,
} from "@oneseat/contracts";

export const STOP_REASONS: readonly StopReason[] = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "error",
];

export const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  "auth",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "not_found",
  "network",
  "server",
  "aborted",
  "unknown",
];

export interface StreamIssue {
  /** Index of the offending event, or -1 for whole-stream issues. */
  index: number;
  rule: string;
  message: string;
}

export interface StreamValidationOptions {
  /** Tool names offered in the request. When set, every tool_call must use one of them. */
  toolNames?: readonly string[];
  /** When a stream has tool calls and ends normally, stopReason must be "tool_use". Default true. */
  requireToolUseStop?: boolean;
  /** Allow a stream that is a single error event with no message_start. Default true. */
  allowBareError?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True if a value survives JSON encoding unchanged (no functions, undefined, NaN, cycles, class instances). */
export function isJsonRoundTrippable(v: unknown): boolean {
  try {
    return deepEqual(JSON.parse(JSON.stringify(v)), v);
  } catch {
    return false;
  }
}

/** Structural equality for JSON-like values. Key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function checkUsage(u: unknown, index: number, issues: StreamIssue[]): void {
  if (!isPlainObject(u)) {
    issues.push({ index, rule: "usage-shape", message: "message_end.usage must be an object" });
    return;
  }
  const usage = u as unknown as Usage;
  const fields: (keyof Usage)[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
  for (const f of fields) {
    const v = usage[f];
    const required = f === "inputTokens" || f === "outputTokens";
    if (v === undefined) {
      if (required) issues.push({ index, rule: "usage-shape", message: `usage.${f} is required` });
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
      issues.push({ index, rule: "usage-non-negative", message: `usage.${f} must be a non-negative integer, got ${String(v)}` });
  }
}

function checkToolCall(call: unknown, index: number, opts: StreamValidationOptions, seenIds: Set<string>, issues: StreamIssue[]): void {
  if (!isPlainObject(call)) {
    issues.push({ index, rule: "tool-call-shape", message: "tool_call.call must be an object" });
    return;
  }
  const c = call as unknown as ToolCall;
  if (typeof c.id !== "string" || c.id.length === 0)
    issues.push({ index, rule: "tool-call-id", message: "tool_call.call.id must be a non-empty string" });
  else if (seenIds.has(c.id)) issues.push({ index, rule: "tool-call-id", message: `duplicate tool call id "${c.id}"` });
  else seenIds.add(c.id);
  if (typeof c.name !== "string" || !isValidToolName(c.name))
    issues.push({ index, rule: "tool-call-name", message: `tool_call name "${String(c.name)}" is not a valid tool name` });
  else if (opts.toolNames && !opts.toolNames.includes(c.name))
    issues.push({ index, rule: "tool-call-unknown", message: `tool_call "${c.name}" was not offered in the request` });
  if (!isPlainObject(c.input))
    issues.push({ index, rule: "tool-call-input", message: "tool_call input must be a complete, parsed JSON object (not a string, array or partial)" });
  else if (!isJsonRoundTrippable(c.input))
    issues.push({ index, rule: "tool-call-input", message: "tool_call input must be plain JSON" });
  if (c.providerMeta !== undefined && !isPlainObject(c.providerMeta))
    issues.push({ index, rule: "tool-call-meta", message: "tool_call providerMeta must be an object when present" });
}

/**
 * Check a ChatEvent stream against the contract:
 * message_start first, then deltas / tool calls, then exactly one message_end or error, nothing after.
 */
export function validateChatStream(events: readonly ChatEvent[], opts: StreamValidationOptions = {}): StreamIssue[] {
  const issues: StreamIssue[] = [];
  const allowBareError = opts.allowBareError ?? true;
  const requireToolUseStop = opts.requireToolUseStop ?? true;
  if (events.length === 0) return [{ index: -1, rule: "empty", message: "stream produced no events" }];

  const first = events[0]!;
  const bare = first.type === "error" && events.length === 1;
  if (first.type !== "message_start" && !(bare && allowBareError))
    issues.push({ index: 0, rule: "start-first", message: `first event must be message_start, got ${first.type}` });

  let terminals = 0;
  let terminalIndex = -1;
  let toolCalls = 0;
  const seenIds = new Set<string>();
  events.forEach((ev, i) => {
    if (terminals > 0) issues.push({ index: i, rule: "after-terminal", message: `${ev.type} after the terminal event` });
    switch (ev.type) {
      case "message_start":
        if (i !== 0) issues.push({ index: i, rule: "start-once", message: "message_start must appear once, first" });
        if (typeof ev.model !== "string" || ev.model.length === 0)
          issues.push({ index: i, rule: "start-model", message: "message_start.model must be a non-empty string" });
        break;
      case "text_delta":
      case "reasoning_delta":
        if (typeof ev.text !== "string") issues.push({ index: i, rule: "delta-text", message: `${ev.type}.text must be a string` });
        break;
      case "reasoning_done":
        if (!isPlainObject(ev.part) || ev.part.type !== "reasoning" || typeof ev.part.text !== "string")
          issues.push({ index: i, rule: "reasoning-part", message: "reasoning_done.part must be a ReasoningPart" });
        break;
      case "tool_call":
        toolCalls++;
        checkToolCall(ev.call, i, opts, seenIds, issues);
        break;
      case "message_end":
        terminals++;
        terminalIndex = i;
        if (!STOP_REASONS.includes(ev.stopReason))
          issues.push({ index: i, rule: "stop-reason", message: `unknown stopReason "${String(ev.stopReason)}"` });
        checkUsage(ev.usage, i, issues);
        if (requireToolUseStop && toolCalls > 0 && ev.stopReason !== "tool_use" && ev.stopReason !== "max_tokens")
          issues.push({ index: i, rule: "tool-use-stop", message: `stream had ${toolCalls} tool call(s) but stopReason is "${ev.stopReason}"` });
        if (toolCalls === 0 && ev.stopReason === "tool_use")
          issues.push({ index: i, rule: "tool-use-stop", message: 'stopReason "tool_use" without any tool_call event' });
        break;
      case "error": {
        terminals++;
        terminalIndex = i;
        const e = ev.error as unknown;
        if (!isPlainObject(e)) {
          issues.push({ index: i, rule: "error-shape", message: "error.error must be a ProviderError object" });
          break;
        }
        const pe = ev.error;
        if (!PROVIDER_ERROR_KINDS.includes(pe.kind))
          issues.push({ index: i, rule: "error-kind", message: `unknown error kind "${String(pe.kind)}"` });
        if (typeof pe.message !== "string" || pe.message.length === 0)
          issues.push({ index: i, rule: "error-message", message: "error.message must be a non-empty string" });
        if (typeof pe.retryable !== "boolean")
          issues.push({ index: i, rule: "error-retryable", message: "error.retryable must be a boolean" });
        if (pe.status !== undefined && (!Number.isInteger(pe.status) || pe.status < 100 || pe.status > 599))
          issues.push({ index: i, rule: "error-status", message: `error.status must be an HTTP status, got ${String(pe.status)}` });
        if (pe.retryAfter !== undefined && (typeof pe.retryAfter !== "number" || !(pe.retryAfter >= 0)))
          issues.push({ index: i, rule: "error-retry-after", message: "error.retryAfter must be a non-negative number of seconds" });
        break;
      }
      default:
        issues.push({ index: i, rule: "unknown-event", message: `unknown event type "${(ev as { type?: unknown }).type as string}"` });
    }
  });
  if (terminals === 0) issues.push({ index: -1, rule: "terminal", message: "stream ended without message_end or error" });
  else if (terminals > 1) issues.push({ index: -1, rule: "terminal", message: `stream has ${terminals} terminal events, expected exactly one` });
  else if (terminalIndex !== events.length - 1)
    issues.push({ index: terminalIndex, rule: "terminal", message: "terminal event is not the last event" });
  return issues;
}

export class StreamValidationError extends Error {
  override name = "StreamValidationError";
  constructor(
    readonly issues: StreamIssue[],
    readonly events: readonly ChatEvent[],
  ) {
    super(`invalid ChatEvent stream:\n${issues.map((i) => `  - [${i.rule}] ${i.index >= 0 ? `#${i.index} ` : ""}${i.message}`).join("\n")}`);
  }
}

/** Throw a StreamValidationError listing every issue, or return the events unchanged. */
export function assertValidChatStream(events: readonly ChatEvent[], opts: StreamValidationOptions = {}): readonly ChatEvent[] {
  const issues = validateChatStream(events, opts);
  if (issues.length > 0) throw new StreamValidationError(issues, events);
  return events;
}

export interface DrainResult {
  events: ChatEvent[];
  /** Set when send() or iteration threw. The contract says it never should. */
  thrown?: unknown;
  /** Set when the stream did not finish within the timeout. */
  timedOut?: boolean;
}

/** Drain provider.send(req) and record whether it threw. Never throws itself. */
export async function drainStream(
  provider: Pick<ModelProvider, "send">,
  req: ChatRequest,
  opts: { timeoutMs?: number; onEvent?: (ev: ChatEvent, index: number) => void } = {},
): Promise<DrainResult> {
  const events: ChatEvent[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const run = (async (): Promise<DrainResult> => {
    try {
      for await (const ev of provider.send(req)) {
        events.push(ev);
        opts.onEvent?.(ev, events.length - 1);
      }
      return { events };
    } catch (thrown) {
      return { events, thrown };
    }
  })();
  try {
    const r = await Promise.race([run, timeout]);
    return r === "timeout" ? { events, timedOut: true } : r;
  } finally {
    clearTimeout(timer);
  }
}

export interface NormalisedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Strip ids and provider metadata so calls from different providers can be compared. */
export function normaliseToolCalls(events: readonly ChatEvent[]): NormalisedToolCall[] {
  const out: NormalisedToolCall[] = [];
  for (const ev of events) if (ev.type === "tool_call") out.push({ name: ev.call.name, input: canonicalJson(ev.call.input) as Record<string, unknown> });
  return out;
}

/** Deep copy with object keys sorted, for stable comparison and printing. */
export function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = canonicalJson(x);
    }
    return o;
  }
  return v;
}

/** The terminal event of a stream, if any. */
export function terminalEvent(events: readonly ChatEvent[]): Extract<ChatEvent, { type: "message_end" | "error" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "message_end" || ev.type === "error") return ev;
  }
  return undefined;
}

/** Concatenate text_delta events. */
export function streamText(events: readonly ChatEvent[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}
