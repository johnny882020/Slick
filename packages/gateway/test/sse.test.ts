import { describe, expect, it } from "vitest";
import { chunkedStream, parseSSE, type SSEMessage } from "../src/index.js";

const enc = new TextEncoder();

async function parseAll(input: string | Uint8Array, chunkSize?: number, signal?: AbortSignal): Promise<SSEMessage[]> {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const out: SSEMessage[] = [];
  for await (const m of parseSSE(chunkedStream(bytes, chunkSize ? { chunkSize } : {}), signal ? { signal } : {})) out.push(m);
  return out;
}

describe("parseSSE", () => {
  it("parses event, data, id and retry fields", async () => {
    const msgs = await parseAll("event: ping\ndata: {\"a\":1}\nid: 42\nretry: 3000\n\n");
    expect(msgs).toEqual([{ event: "ping", data: '{"a":1}', id: "42", retry: 3000 }]);
  });

  it("defaults the event type to message and keeps the last id across events", async () => {
    const msgs = await parseAll("id: 7\ndata: one\n\ndata: two\n\n");
    expect(msgs).toEqual([
      { event: "message", data: "one", id: "7" },
      { event: "message", data: "two", id: "7" },
    ]);
  });

  it("joins multi-line data with newlines", async () => {
    const msgs = await parseAll("data: first\ndata: second\ndata:third\n\n");
    expect(msgs[0]?.data).toBe("first\nsecond\nthird");
  });

  it("strips exactly one leading space from a value", async () => {
    const msgs = await parseAll("data:  two spaces\n\n");
    expect(msgs[0]?.data).toBe(" two spaces");
  });

  it("ignores comments, unknown fields, bad retry values and ids with NUL", async () => {
    const msgs = await parseAll(": keep-alive\nfoo: bar\nretry: soon\nid: a\u0000b\ndata: x\n\n:another comment\n\n");
    expect(msgs).toEqual([{ event: "message", data: "x" }]);
  });

  it("treats a field line with no colon as a field with an empty value", async () => {
    const msgs = await parseAll("data\n\ndata: y\n\n");
    expect(msgs).toEqual([
      { event: "message", data: "" },
      { event: "message", data: "y" },
    ]);
  });

  it("does not dispatch an event that has no data", async () => {
    const msgs = await parseAll("event: lonely\n\ndata: z\n\n");
    expect(msgs).toEqual([{ event: "message", data: "z" }]);
  });

  it("handles CRLF, LF and lone CR line endings", async () => {
    const msgs = await parseAll("data: crlf\r\n\r\ndata: lf\n\ndata: cr\r\rdata: mixed\r\n\n");
    expect(msgs.map((m) => m.data)).toEqual(["crlf", "lf", "cr", "mixed"]);
  });

  it("handles a CRLF split across two reads (CR at the end of one chunk)", async () => {
    const text = "data: a\r\n\r\ndata: b\r\n\r\n";
    for (let size = 1; size <= text.length; size++) {
      const msgs = await parseAll(text, size);
      expect(msgs.map((m) => m.data), `chunk size ${size}`).toEqual(["a", "b"]);
    }
  });

  it("decodes multi-byte UTF-8 split across reads at every offset", async () => {
    const text = 'data: {"t":"Grüße 東京 🌧️ 18°C 👩‍💻"}\n\n';
    for (const size of [1, 2, 3, 5, 7]) {
      const msgs = await parseAll(text, size);
      expect(JSON.parse(msgs[0]?.data ?? "{}")).toEqual({ t: "Grüße 東京 🌧️ 18°C 👩‍💻" });
    }
  });

  it("strips a leading byte-order mark, even when split", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("data: bom\n\n")]);
    expect((await parseAll(bytes, 1))[0]?.data).toBe("bom");
    expect((await parseAll(bytes))[0]?.data).toBe("bom");
  });

  it("dispatches data still buffered when the stream ends without a blank line", async () => {
    expect((await parseAll("data: tail")).map((m) => m.data)).toEqual(["tail"]);
    expect((await parseAll("data: tail\n")).map((m) => m.data)).toEqual(["tail"]);
    expect((await parseAll("data: tail\r")).map((m) => m.data)).toEqual(["tail"]);
  });

  it("accepts an async iterable of strings and bytes", async () => {
    async function* src() {
      yield "data: he";
      yield enc.encode("llo\n");
      yield "\n";
    }
    const out: SSEMessage[] = [];
    for await (const m of parseSSE(src())) out.push(m);
    expect(out).toEqual([{ event: "message", data: "hello" }]);
  });

  it("stops with an AbortError when the signal aborts mid-stream", async () => {
    const ac = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(enc.encode("data: one\n\n"));
        // Never closes on its own: only the abort can end the read.
      },
    });
    const got: string[] = [];
    const run = (async () => {
      for await (const m of parseSSE(stream, { signal: ac.signal })) {
        got.push(m.data);
        ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(got).toEqual(["one"]);
  });

  it("rejects at once if the signal is already aborted, for iterables too", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop now"));
    await expect(parseAll("data: x\n\n", undefined, ac.signal)).rejects.toThrow("stop now");
    async function* src() {
      yield "data: x\n\n";
    }
    const it = parseSSE(src(), { signal: ac.signal });
    await expect(it.next()).rejects.toThrow("stop now");
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode("data: again\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const m of parseSSE(stream)) {
      expect(m.data).toBe("again");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
