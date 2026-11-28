import { describe, expect, it } from "vitest";
import {
  createFixtureFetch,
  createRecordingFetch,
  describeRequest,
  findSecretLeaks,
  fixtureResponse,
  makeFakeApiKey,
  redactHeaders,
  redactSecrets,
  redactUrl,
  REDACTED,
  routeFromRecording,
  sseChunks,
  type Recording,
} from "../src/index.js";

describe("secrets", () => {
  it("makes unique fake keys", () => {
    const a = makeFakeApiKey();
    const b = makeFakeApiKey("sk-ant-");
    expect(a.key).not.toBe(b.key);
    expect(a.key.endsWith(a.core)).toBe(true);
    expect(b.key.startsWith("sk-ant-")).toBe(true);
  });

  it("finds leaks in strings, objects, errors and causes", () => {
    const { key, core } = makeFakeApiKey();
    const err = new Error("outer", { cause: new Error(`inner ${key}`) });
    const withProp = Object.assign(new Error("x"), { headers: { authorization: `Bearer ${key}` } });
    const leaks = findSecretLeaks({ s: `key=${key}`, o: { deep: [{ v: core }] }, e: err, p: withProp, clean: "nothing here", n: 12n, u: undefined }, [key, core]);
    expect(leaks.map((l) => l.where).sort()).toEqual(["e", "e", "o", "p", "p", "s", "s"]);
    expect(leaks.every((l) => !l.excerpt.includes(core))).toBe(true);
    const cyc: Record<string, unknown> = { k: key };
    cyc["me"] = cyc;
    expect(findSecretLeaks({ cyc }, [key])).toHaveLength(1);
    expect(findSecretLeaks({ x: "short" }, ["short"])).toEqual([]);
  });

  it("redacts text, headers and urls", () => {
    expect(redactSecrets("a SECRET b SECRETSECRET", ["SECRET", ""])).toBe(`a ${REDACTED} b ${REDACTED}${REDACTED}`);
    expect(redactHeaders({ Authorization: "Bearer x", "X-Api-Key": "k", "x-goog-api-key": "g", accept: "json" })).toEqual({ authorization: REDACTED, "x-api-key": REDACTED, "x-goog-api-key": REDACTED, accept: "json" });
    expect(redactHeaders(new Headers({ cookie: "c" }))).toEqual({ cookie: REDACTED });
    expect(redactHeaders([["a", "b"]])).toEqual({ a: "b" });
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactUrl("https://x/v1?alt=sse&key=abc&token=t#f")).toBe(`https://x/v1?alt=sse&key=${REDACTED}&token=${REDACTED}#f`);
  });
});

describe("fixture fetch", () => {
  it("routes by string, RegExp and predicate, serving responses in order", async () => {
    const ff = createFixtureFetch([
      { match: "POST https://a.test/chat", response: [{ json: { n: 1 } }, { json: { n: 2 } }] },
      { match: /GET https:\/\/a\.test\/models/, response: { body: "models", headers: { "x-k": "{{KEY}}" } } },
      { match: (r) => r.headers["x-special"] === "1", response: { status: 204 } },
    ], { substitutions: { "{{KEY}}": "sub" } });
    const r1 = await ff.fetch("https://a.test/chat", { method: "POST", body: "{}" });
    const r2 = await ff.fetch("https://a.test/chat", { method: "POST" });
    const r3 = await ff.fetch("https://a.test/chat", { method: "POST" });
    expect(await r1.json()).toEqual({ n: 1 });
    expect(r1.headers.get("content-type")).toBe("application/json");
    expect(await r2.json()).toEqual({ n: 2 });
    expect(await r3.json()).toEqual({ n: 2 });
    const m = await ff.fetch(new URL("https://a.test/models"));
    expect(await m.text()).toBe("models");
    expect(m.headers.get("x-k")).toBe("sub");
    const s = await ff.fetch("https://b.test/x", { headers: { "X-Special": "1" } });
    expect(s.status).toBe(204);
    const miss = await ff.fetch("https://c.test/none?key=secret");
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain(REDACTED);
    expect(ff.unmatched).toHaveLength(1);
    expect(ff.requests[0]).toMatchObject({ method: "POST", url: "https://a.test/chat", body: "{}" });
  });

  it("accepts Request objects and other body types", async () => {
    const ff = createFixtureFetch([{ match: () => true, response: { body: "ok" } }]);
    await ff.fetch(new Request("https://a.test/r", { method: "POST", body: "req-body", headers: { "x-a": "1" } }));
    await ff.fetch("https://a.test/b", { method: "POST", body: new TextEncoder().encode("bytes") });
    await ff.fetch("https://a.test/c", { method: "POST", body: new URLSearchParams({ a: "1" }) });
    await ff.fetch("https://a.test/d", { method: "POST", body: new Blob(["blob"]) });
    await ff.fetch("https://a.test/e", { method: "POST", body: new ArrayBuffer(2) });
    expect(ff.requests.map((r) => r.body)).toEqual(["req-body", "bytes", "a=1", "blob", "\u0000\u0000"]);
    expect(ff.requests[0]!.headers["x-a"]).toBe("1");
    const r = await describeRequest("https://a.test", { method: "POST", body: new ReadableStream() as never });
    expect(r.body).toBe("[unreadable body]");
  });

  it("streams chunks with delays and simulates network failure", async () => {
    const ff = createFixtureFetch([
      { match: "stream", response: { chunks: sseChunks([{ event: "e", data: { a: 1 } }, { data: "raw" }]), chunkDelayMs: 5 } },
      { match: "down", response: { networkError: "" } },
    ]);
    const res = await ff.fetch("https://a.test/stream");
    expect(await res.text()).toBe('event: e\ndata: {"a":1}\n\ndata: raw\n\n');
    await expect(ff.fetch("https://a.test/down")).rejects.toThrow(TypeError);
  });

  it("honours abort before and during the body", async () => {
    const ff = createFixtureFetch([{ match: () => true, response: { chunks: ["a", "b", "c"], chunkDelayMs: 20 } }]);
    const pre = new AbortController();
    pre.abort();
    await expect(ff.fetch("https://a.test", { signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
    const ac = new AbortController();
    const res = await ff.fetch("https://a.test", { signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("a");
    ac.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancelling a fixture body is clean", async () => {
    const ac = new AbortController();
    const res = fixtureResponse({ chunks: ["a", "b"] }, { signal: ac.signal });
    await res.body!.cancel();
    ac.abort();
    const empty = fixtureResponse({});
    expect(await empty.text()).toBe("");
  });
});

describe("recording fetch", () => {
  it("records with secrets removed and still streams to the caller", async () => {
    const { key } = makeFakeApiKey();
    const upstream = createFixtureFetch([{ match: () => true, response: { status: 200, headers: { "set-cookie": "s", "x-echo": key }, chunks: [`data: hello ${key}\n\n`, "data: bye\n\n"] } }]);
    const recs: Recording[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const rf = createRecordingFetch({ fetch: upstream.fetch, secrets: [key], onRecord: (r) => (recs.push(r), done()) });
    const res = await rf(`https://api.test/v1/x?key=${key}`, { method: "POST", headers: { "x-api-key": key, accept: "a" }, body: JSON.stringify({ k: key }) });
    expect(await res.text()).toContain(`hello ${key}`);
    await finished;
    const rec = recs[0]!;
    expect(JSON.stringify(rec)).not.toContain(key);
    expect(rec.request.headers["x-api-key"]).toBe(REDACTED);
    expect(rec.request.url).toContain(`key=${REDACTED}`);
    expect(rec.response.headers["set-cookie"]).toBe(REDACTED);
    expect(rec.response.chunks.join("")).toContain(`hello ${REDACTED}`);
    const route = routeFromRecording(rec);
    expect(route.match).toBe("POST https://api.test/v1/x");
    expect((route.response as { headers: Record<string, string> }).headers["set-cookie"]).toBeUndefined();
    const replay = createFixtureFetch([route]);
    expect(await (await replay.fetch("https://api.test/v1/x", { method: "POST" })).text()).toContain("bye");
  });

  it("records bodiless responses and interrupted streams", async () => {
    const recs: Recording[] = [];
    const noBody = createRecordingFetch({ fetch: async () => new Response(null, { status: 204 }), secrets: [], onRecord: (r) => void recs.push(r) });
    await noBody("https://x.test/a");
    expect(recs[0]!.response).toEqual({ status: 204, headers: {}, chunks: [] });
    let fin!: () => void;
    const p = new Promise<void>((r) => (fin = r));
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("reset"));
      },
    });
    const rf = createRecordingFetch({ fetch: async () => new Response(broken), secrets: [], onRecord: (r) => (recs.push(r), fin()) });
    const res = await rf("https://x.test/b");
    await res.text().catch(() => "");
    await p;
    expect(recs[1]!.response.chunks).toContain("[stream interrupted]");
  });
});
