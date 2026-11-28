// withRetry: retry retryable failures, but only before any content reached the caller.
// message_start is held back until the first content event, so a retried attempt
// never shows the caller a second message_start.

import type { ChatEvent, ChatRequest, ModelProvider, ProviderError } from "@oneseat/contracts";
import { providerError } from "./errors.js";

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** First backoff delay. Doubles each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including a provider's retry-after. Default 30 s. */
  maxDelayMs?: number;
  /** Called before each retry (for logging; messages are already redacted). */
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. Returns [0, 1). */
  random?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Delay before retry number `attempt` (1-based). Exported for tests. */
export function retryDelay(
  attempt: number,
  error: ProviderError,
  opts: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  if (error.retryAfter !== undefined) return Math.min(opts.maxDelayMs, Math.max(0, error.retryAfter * 1000));
  const exp = opts.baseDelayMs * 2 ** (attempt - 1);
  // "Equal jitter": half fixed, half random, so waits never collapse to zero.
  const jittered = exp / 2 + (exp / 2) * opts.random();
  return Math.min(opts.maxDelayMs, Math.round(jittered));
}

const CONTENT: ReadonlySet<ChatEvent["type"]> = new Set(["text_delta", "reasoning_delta", "reasoning_done", "tool_call"]);

export function withRetry<P extends ModelProvider>(provider: P, options: RetryOptions = {}): P {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 30_000);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  async function* send(req: ChatRequest): AsyncGenerator<ChatEvent> {
    for (let attempt = 0; ; attempt++) {
      let held: ChatEvent | undefined;
      let emitted = false;
      let failure: ProviderError | undefined;
      try {
        for await (const ev of provider.send(req)) {
          if (!emitted && ev.type === "message_start") {
            held = ev;
            continue;
          }
          if (!emitted && ev.type === "error") {
            failure = ev.error;
            break;
          }
          if (!emitted && (CONTENT.has(ev.type) || ev.type === "message_end")) {
            emitted = true;
            if (held) yield held;
          }
          yield ev;
          if (ev.type === "error" || ev.type === "message_end") return;
        }
      } catch (e) {
        // Providers must not throw, but a wrapped third-party one might.
        if (emitted) {
          yield { type: "error", error: providerError("unknown", e instanceof Error ? e.message : String(e)) };
          return;
        }
        failure = providerError("unknown", e instanceof Error ? e.message : String(e));
      }
      if (!failure) {
        // The inner stream ended without a terminal event.
        if (!emitted && held) yield held;
        yield { type: "error", error: providerError("network", "stream ended before the response completed") };
        return;
      }
      // A provider that asks for a longer wait than we allow (a daily quota: "retry in 9h") will
      // refuse again after our capped wait; report it now instead of stalling the run.
      const waitTooLong = failure.retryAfter !== undefined && failure.retryAfter * 1000 > maxDelayMs;
      const canRetry = failure.retryable && !waitTooLong && attempt < maxRetries && !req.signal?.aborted;
      if (!canRetry) {
        yield { type: "error", error: failure };
        return;
      }
      const delayMs = retryDelay(attempt + 1, failure, { baseDelayMs, maxDelayMs, random });
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: failure });
      try {
        await sleep(delayMs, req.signal);
      } catch {
        yield { type: "error", error: providerError("aborted", "request aborted while waiting to retry") };
        return;
      }
      if (req.signal?.aborted) {
        yield { type: "error", error: providerError("aborted", "request aborted while waiting to retry") };
        return;
      }
    }
  }

  const wrapped = Object.create(provider) as P;
  Object.defineProperty(wrapped, "send", { value: send, enumerable: true });
  return wrapped;
}
