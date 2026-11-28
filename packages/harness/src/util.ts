// Small shared helpers: ids, secret redaction, stderr logging, abortable sleep,
// an async event queue and text truncation.

import { randomUUID } from "node:crypto";

export function newId(prefix = ""): string {
  return prefix ? `${prefix}_${randomUUID()}` : randomUUID();
}

// ---------------------------------------------------------------------------
// Redaction

const SECRET_PATTERNS: RegExp[] = [
  // Header style: "authorization: Bearer abc", "x-api-key: abc", "x-goog-api-key=abc".
  /\b(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|token)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;&}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[REDACTED]";

/**
 * Replaces known secret values (keys passed to auth.set) and anything that looks
 * like a credential. One instance is shared by the daemon, harness and logs.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  remove(secret: string | undefined): void {
    if (secret) this.secrets.delete(secret);
  }

  /** Replace only exact known secret values. */
  redactKnown(text: string): string {
    let out = text;
    // Longest first so a key that contains another key is fully replaced.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
    return out;
  }

  /** Replace known secrets and anything that looks like a credential. */
  redact(text: string): string {
    let out = this.redactKnown(text);
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (match, name?: string, sep?: string) =>
        typeof name === "string" && typeof sep === "string" && match.toLowerCase().startsWith(name.toLowerCase())
          ? `${name}${sep}${REDACTED}`
          : REDACTED,
      );
    }
    return out;
  }

  /** Redact every string inside a JSON-like value (known secrets only when knownOnly). */
  redactValue<T>(value: T, knownOnly = false): T {
    if (typeof value === "string") return (knownOnly ? this.redactKnown(value) : this.redact(value)) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v, knownOnly)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(v, knownOnly);
      return out as T;
    }
    return value;
  }

  get size(): number {
    return this.secrets.size;
  }

  /**
   * Redact a text stream whose chunks may split a secret. push() returns what is
   * safe to show now, holding back a tail that could be the start of a known secret;
   * flush() returns the rest.
   */
  stream(): { push(chunk: string): string; flush(): string } {
    let buf = "";
    const secrets = () => [...this.secrets];
    return {
      push: (chunk) => {
        buf = this.redactKnown(buf + chunk);
        const list = secrets();
        if (list.length === 0) {
          const out = buf;
          buf = "";
          return out;
        }
        // Longest suffix of buf that is a proper prefix of some secret.
        let hold = 0;
        for (const s of list)
          for (let n = Math.min(s.length - 1, buf.length); n > hold; n--)
            if (buf.endsWith(s.slice(0, n))) {
              hold = n;
              break;
            }
        const out = buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        return out;
      },
      flush: () => {
        const out = this.redactKnown(buf);
        buf = "";
        return out;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Logging (stderr only, always redacted)

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export function createLogger(
  redactor: Redactor,
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
  minLevel: LogLevel = (process.env["ONESEAT_LOG_LEVEL"] as LogLevel | undefined) ?? "info",
): Logger {
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  const min = Math.max(0, order.indexOf(minLevel));
  const log = (level: LogLevel, msg: string, data?: unknown) => {
    if (order.indexOf(level) < min) return;
    let line = `[oneseat ${level}] ${msg}`;
    if (data !== undefined) {
      let rendered: string;
      if (data instanceof Error) rendered = data.message;
      else {
        try {
          rendered = JSON.stringify(data);
        } catch {
          rendered = String(data);
        }
      }
      line += ` ${rendered}`;
    }
    write(redactor.redact(line));
  };
  return {
    debug: (m, d) => log("debug", m, d),
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Timing

export class AbortError extends Error {
  override name = "AbortError";
  constructor(message = "aborted") {
    super(message);
  }
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Resolve with the promise, or reject with AbortError when the signal fires first. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Async queue: a push-based AsyncIterable. Closing ends iteration; return()
// (a consumer breaking out of for-await) calls onReturn.

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  constructor(private readonly onReturn?: () => void) {}

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        if (!this.closed) this.onReturn?.();
        this.closed = true;
        this.items.length = 0;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Text helpers

/** Cap text at max characters, keeping the head and noting how much was cut. */
export function truncateText(text: string, max: number, what = "output"): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, Math.max(0, max));
  return {
    text: `${head}\n[${what} truncated: showing ${head.length} of ${text.length} characters]`,
    truncated: true,
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
