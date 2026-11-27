// One Server-Sent Events parser for every provider.
// Follows the WHATWG "event stream interpretation" rules:
//   - lines end in CRLF, LF or CR (a CR at the end of one read and an LF at the
//     start of the next count as one line break)
//   - lines starting with ":" are comments
//   - "field: value" strips one leading space from the value
//   - several data lines join with "\n"
//   - a blank line dispatches the event; an event with no data is not dispatched
// Bytes are decoded with a streaming TextDecoder, so a multi-byte UTF-8
// character split across two reads is decoded correctly.
// One leniency: data still buffered when the stream ends is dispatched (some
// local servers omit the final blank line).

export interface SSEMessage {
  /** Event type. "message" when the server sent no `event:` field. */
  event: string;
  /** Data lines joined with "\n". */
  data: string;
  /** Last event id seen, when the server sent one. */
  id?: string;
  /** Reconnection time in ms, when the server sent one. */
  retry?: number;
  /**
   * True when the stream ended before the blank line that closes this event.
   * The data may be cut short (a dropped connection), or the server may just
   * have omitted the final blank line.
   */
  unterminated?: true;
}

export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

export interface ParseSSEOptions {
  /** Stop reading (and reject with an AbortError) when this aborts. */
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

async function* readChunks(source: ByteSource, signal?: AbortSignal): AsyncGenerator<Uint8Array | string> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader !== "function") {
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      if (signal?.aborted) throw abortError(signal);
      yield chunk;
    }
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  // Avoid an unhandled rejection when the abort promise is never awaited again.
  aborted?.catch(() => undefined);
  try {
    for (;;) {
      const r = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (r.done) return;
      if (r.value) yield r.value;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    // Stop the underlying body: the caller may have broken out early or aborted.
    reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export async function* parseSSE(source: ByteSource, opts: ParseSSEOptions = {}): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let first = true;
  let eventType = "";
  let data: string[] = [];
  let hasData = false;
  let lastId: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SSEMessage | undefined => {
    if (!hasData) {
      eventType = "";
      return undefined;
    }
    const msg: SSEMessage = { event: eventType || "message", data: data.join("\n") };
    if (lastId !== undefined) msg.id = lastId;
    if (retry !== undefined) msg.retry = retry;
    eventType = "";
    data = [];
    hasData = false;
    return msg;
  };

  const processLine = (line: string): SSEMessage | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data.push(value);
        hasData = true;
        break;
      case "id":
        if (!value.includes("\u0000")) lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  };

  /** Pull complete lines out of buf. At EOF a trailing CR is a full line break. */
  function* drain(eof: boolean): Generator<SSEMessage> {
    let start = 0;
    for (;;) {
      let i = start;
      let found = -1;
      while (i < buf.length) {
        const c = buf.charCodeAt(i);
        if (c === 10 || c === 13) {
          found = i;
          break;
        }
        i++;
      }
      if (found === -1) break;
      let next = found + 1;
      if (buf.charCodeAt(found) === 13) {
        if (found + 1 >= buf.length && !eof) break; // CR at the end: wait to see if LF follows
        if (buf.charCodeAt(found + 1) === 10) next = found + 2;
      }
      const msg = processLine(buf.slice(start, found));
      start = next;
      if (msg) yield msg;
    }
    buf = buf.slice(start);
  }

  for await (const chunk of readChunks(source, opts.signal)) {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    buf += text;
    yield* drain(false);
  }
  buf += decoder.decode();
  yield* drain(true);
  if (buf.length > 0) {
    const msg = processLine(buf);
    buf = "";
    if (msg) yield msg;
  }
  const tail = dispatch();
  if (tail) yield { ...tail, unterminated: true };
}
