import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collect } from "@oneseat/contracts";
import { chunkedStream, createAnthropicProvider, createGoogleProvider, fixtureFetch } from "../src/index.js";
import { FIXTURES, sseResponse, stubFetch, textRequest } from "./helpers.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "oneseat-fixtures-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("fixtureFetch replay", () => {
  it("serves queued cases in order and records each request", async () => {
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false }).queue("models", "count_tokens");
    expect(f.pending()).toEqual(["models", "count_tokens"]);
    const r1 = await f("https://x/v1/models", { method: "GET" });
    expect(r1.headers.get("content-type")).toBe("application/json");
    const r2 = await f(new URL("https://x/count"), { method: "POST", body: "not json", headers: { "x-api-key": "zzz-secret" } });
    expect(await r2.json()).toEqual({ input_tokens: 402 });
    expect(f.requests).toEqual([
      { url: "https://x/v1/models", method: "GET", headers: {}, body: undefined, case: "models" },
      { url: "https://x/count", method: "POST", headers: { "x-api-key": "[REDACTED]" }, body: "not json", case: "count_tokens" },
    ]);
    expect(f.pending()).toEqual([]);
  });

  it("accepts Request objects", async () => {
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false }).queue("count_tokens");
    await f(new Request("https://x/y", { method: "POST", body: '{"a":1}', headers: { authorization: "Bearer tok-123456789" } }));
    expect(f.requests[0]).toMatchObject({ url: "https://x/y", method: "POST", body: { a: 1 }, headers: { authorization: "[REDACTED]" } });
  });

  it("applies status and headers from <case>.meta.json", async () => {
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false }).queue("error_429");
    const res = await f("https://x", {});
    expect(res.status).toBe(429);
    expect(res.statusText).toBe("Too Many Requests");
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("rejects when nothing is queued or the case has no file", async () => {
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false });
    await expect(f("https://x/key=SHOULDNOTLEAK123", { method: "POST" })).rejects.toThrow("no fixture queued for POST https://x/key=SHOULDNOTLEAK123");
    f.queue("does_not_exist");
    await expect(f("https://x")).rejects.toThrow('no fixture file for case "does_not_exist"');
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fixtureFetch(join(FIXTURES, "anthropic"), { record: false }).queue("text_only");
    await expect(f("https://x", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("defaults record mode from ONESEAT_RECORD", () => {
    const prev = process.env["ONESEAT_RECORD"];
    process.env["ONESEAT_RECORD"] = "0";
    try {
      expect(() => fixtureFetch(FIXTURES)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env["ONESEAT_RECORD"];
      else process.env["ONESEAT_RECORD"] = prev;
    }
  });
});

describe("chunkedStream", () => {
  it("splits bytes and handles empty input", async () => {
    const read = async (s: ReadableStream<Uint8Array>) => {
      const parts: number[] = [];
      for await (const c of s as unknown as AsyncIterable<Uint8Array>) parts.push(c.length);
      return parts;
    };
    expect(await read(chunkedStream(new Uint8Array(10), { chunkSize: 4 }))).toEqual([4, 4, 2]);
    expect(await read(chunkedStream(new Uint8Array(0)))).toEqual([]);
  });

  it("errors with AbortError when the signal aborts, and stays quiet if cancelled", async () => {
    const ac = new AbortController();
    const s = chunkedStream(new Uint8Array(100), { chunkSize: 1, chunkDelayMs: 1, signal: ac.signal });
    const reader = s.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });

    const ac2 = new AbortController();
    const s2 = chunkedStream(new Uint8Array(4), { signal: ac2.signal });
    await s2.cancel();
    ac2.abort();

    const ac3 = new AbortController();
    const s3 = chunkedStream(new Uint8Array(4), { signal: ac3.signal });
    const r3 = s3.getReader();
    await r3.read();
    await r3.read(); // closes
    ac3.abort(); // erroring a closed stream is ignored
  });
});

describe("fixtureFetch recording (ONESEAT_RECORD=1)", () => {
  it("records SSE bodies live, never writing the key, and replays them afterwards", async () => {
    const dir = await tempDir();
    const key = "sk-ant-api03-LIVEKEYLIVEKEYLIVEKEY";
    const sseBody =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":3}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"echo ' +
      key +
      '"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const real = stubFetch(() => sseResponse(sseBody, { headers: { "content-type": "text/event-stream", "retry-after": "2", "set-cookie": "a=b", "request-id": "r" } }));
    const rec = fixtureFetch(dir, { record: true, realFetch: real }).queue("live_case");
    const res = await collect(createAnthropicProvider({ apiKey: key, fetch: rec }).send(textRequest("claude-haiku-5-5")));
    expect(res.stopReason).toBe("end_turn");
    expect(real.calls).toHaveLength(1);
    expect((real.calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe(key);

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["live_case.meta.json", "live_case.sse"]);
    const written = (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
    expect(written).not.toContain(key);
    expect(written).not.toContain("a=b");
    expect(JSON.parse(await readFile(join(dir, "live_case.meta.json"), "utf8"))).toEqual({ headers: { "retry-after": "2" } });
    expect(JSON.stringify(rec.requests)).not.toContain(key);

    const replay = fixtureFetch(dir, { record: false }).queue("live_case");
    const again = await collect(createAnthropicProvider({ apiKey: "other", fetch: replay }).send(textRequest("claude-haiku-5-5")));
    expect(again.message.content).toEqual([{ type: "text", text: "echo [REDACTED]" }]);
  });

  it("records JSON error responses with their status", async () => {
    const dir = await tempDir();
    const real = stubFetch(() => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}', { status: 429, headers: { "content-type": "application/json" } }));
    const rec = fixtureFetch(dir, { record: true, realFetch: real, secrets: ["extra-secret"] }).queue("err");
    const res = await collect(createGoogleProvider({ apiKey: "AIzaLIVE", fetch: rec }).send(textRequest("gemini-2.5-flash")));
    expect(res.error?.kind).toBe("rate_limit");
    expect(JSON.parse(await readFile(join(dir, "err.meta.json"), "utf8"))).toEqual({ status: 429 });
    expect(await readFile(join(dir, "err.json"), "utf8")).toContain("RESOURCE_EXHAUSTED");
  });

  it("uses global fetch when no realFetch is given and writes no meta for a plain 200", async () => {
    const dir = await tempDir();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    try {
      const rec = fixtureFetch(dir, { record: true }).queue("plain");
      const res = await rec("https://example.invalid/x");
      expect(await res.json()).toEqual({ ok: true });
      expect(await readdir(dir)).toEqual(["plain.json"]);
    } finally {
      globalThis.fetch = original;
    }
    await writeFile(join(dir, "unused.txt"), "");
  });
});
