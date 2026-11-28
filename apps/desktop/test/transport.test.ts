import { describe, expect, it, vi } from "vitest";
import { Api, describeError } from "../src/api";
import { SHELL_ERRORS } from "../src/protocol";
import { ShellError, TauriTransport, WebSocketTransport, bridgeUrl, isTauri, toShellError, type WsFactory } from "../src/transport";

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  last() {
    return JSON.parse(this.sent[this.sent.length - 1]!) as { id: number; cmd: string; args?: Record<string, unknown> };
  }
}

const factory: WsFactory = (url) => new FakeWs(url);

function setup(opts: { timeoutMs?: number } = {}) {
  FakeWs.instances = [];
  const t = new WebSocketTransport("ws://test/rpc", { factory, reconnectDelays: [5], ...opts });
  return { t, ws: () => FakeWs.instances[FakeWs.instances.length - 1]! };
}

describe("WebSocketTransport", () => {
  it("queues calls until the socket opens, then routes replies by id", async () => {
    const { t, ws } = setup();
    const a = t.invoke<number>("daemon_call", { method: "skills.list", params: {} });
    const b = t.invoke<string>("key_status");
    expect(ws().sent).toHaveLength(0);
    ws().open();
    expect(ws().sent).toHaveLength(2);
    const [m1, m2] = ws().sent.map((s) => JSON.parse(s));
    expect(m1).toEqual({ id: 1, cmd: "daemon_call", args: { method: "skills.list", params: {} } });
    expect(m2).toEqual({ id: 2, cmd: "key_status" });
    ws().reply({ id: 2, ok: true, result: "two" });
    ws().reply({ id: 1, ok: true, result: 1 });
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe("two");
    t.close();
  });

  it("turns error replies into ShellError with the code", async () => {
    const { t, ws } = setup();
    ws().open();
    const p = t.invoke("daemon_call", { method: "apps.run" });
    ws().reply({ id: ws().last().id, ok: false, error: { code: SHELL_ERRORS.forbidden, message: "nope", data: { x: 1 } } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShellError);
    expect((err as ShellError).code).toBe(SHELL_ERRORS.forbidden);
    expect((err as ShellError).data).toEqual({ x: 1 });
    t.close();
  });

  it("dispatches events to listeners and supports unlisten", async () => {
    const { t, ws } = setup();
    ws().open();
    const got: unknown[] = [];
    const off = await t.listen("daemon://notification", (p) => got.push(p));
    ws().reply({ event: "daemon://notification", payload: { method: "harness.event", params: { runId: "r" } } });
    ws().reply({ event: "other", payload: 1 });
    off();
    ws().reply({ event: "daemon://notification", payload: 2 });
    expect(got).toEqual([{ method: "harness.event", params: { runId: "r" } }]);
    t.close();
  });

  it("ignores junk and unknown ids", () => {
    const { t, ws } = setup();
    ws().open();
    expect(() => ws().onmessage?.({ data: "not json" })).not.toThrow();
    expect(() => ws().reply({ id: 999, ok: true, result: 1 })).not.toThrow();
    t.close();
  });

  it("fails calls in flight when the socket drops, then reconnects", async () => {
    const { t, ws } = setup();
    const first = ws();
    first.open();
    const p = t.invoke("key_status");
    first.close();
    await expect(p).rejects.toMatchObject({ code: SHELL_ERRORS.daemonUnavailable });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWs.instances.length).toBe(2);
    const second = ws();
    const q = t.invoke<string>("key_status");
    second.open();
    second.reply({ id: second.last().id, ok: true, result: "ok" });
    await expect(q).resolves.toBe("ok");
    t.close();
  });

  it("times out calls that get no answer", async () => {
    const { t, ws } = setup({ timeoutMs: 10 });
    ws().open();
    await expect(t.invoke("key_status")).rejects.toMatchObject({ code: SHELL_ERRORS.timeout });
    t.close();
  });

  it("rejects everything after close", async () => {
    const { t, ws } = setup();
    ws().open();
    const p = t.invoke("key_status");
    t.close();
    await expect(p).rejects.toBeInstanceOf(ShellError);
    await expect(t.invoke("key_status")).rejects.toBeInstanceOf(ShellError);
  });
});

describe("TauriTransport", () => {
  it("passes invoke and listen through and normalises errors", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "bad") throw { code: -32012, message: "forbidden" };
      if (cmd === "acl") throw "command daemon_call not allowed by ACL";
      return { cmd };
    });
    let handler: ((e: { payload: unknown }) => void) | undefined;
    const listen = vi.fn(async (_name: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return () => {};
    });
    const t = new TauriTransport({ invoke, listen });
    await expect(t.invoke("key_status")).resolves.toEqual({ cmd: "key_status" });
    await expect(t.invoke("bad")).rejects.toMatchObject({ code: -32012, message: "forbidden" });
    await expect(t.invoke("acl")).rejects.toMatchObject({ code: SHELL_ERRORS.forbidden });
    const got: unknown[] = [];
    await t.listen("daemon://status", (p) => got.push(p));
    handler?.({ payload: { state: "running" } });
    expect(got).toEqual([{ state: "running" }]);
    expect(listen).toHaveBeenCalledWith("daemon://status", expect.any(Function));
  });
});

describe("helpers", () => {
  it("toShellError", () => {
    expect(toShellError(new ShellError("x", 1)).code).toBe(1);
    expect(toShellError({ message: "m" }).code).toBe(-32603);
    expect(toShellError(42).message).toBe("42");
    expect(toShellError("permission denied").code).toBe(SHELL_ERRORS.forbidden);
  });

  it("bridgeUrl and isTauri", () => {
    expect(bridgeUrl({ protocol: "http:", host: "127.0.0.1:4780", search: "" })).toBe("ws://127.0.0.1:4780/rpc");
    expect(bridgeUrl({ protocol: "https:", host: "h", search: "" })).toBe("wss://h/rpc");
    expect(bridgeUrl({ protocol: "http:", host: "h", search: "?bridge=ws://other:1/rpc" })).toBe("ws://other:1/rpc");
    expect(bridgeUrl({ protocol: "http:", host: "h", search: "?bridge=javascript:alert(1)" })).toBe("ws://h/rpc");
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isTauri({})).toBe(false);
    expect(isTauri(null)).toBe(false);
  });
});

describe("Api", () => {
  it("sends daemon calls through daemon_call and refuses shell-only methods locally", async () => {
    const calls: [string, unknown][] = [];
    const transport = {
      kind: "memory" as const,
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args]);
        return null as T;
      },
      listen: async () => () => {},
      close() {},
    };
    const api = new Api(transport);
    await api.call("skills.list", {});
    await api.keySave("openai", "sk-0123456789");
    await api.keySave("local", "", "http://localhost:11434/v1");
    await api.pinOpen("foo");
    await api.appExport("foo");
    await api.keyDelete("openai");
    await api.daemonStatus();
    // @ts-expect-error apps.run is not a UI method
    await expect(api.call("apps.run", { appId: "x", skill: "y", input: "" })).rejects.toMatchObject({ code: SHELL_ERRORS.forbidden });
    // @ts-expect-error auth.set is not a UI method
    await expect(api.call("auth.set", { provider: "openai", apiKey: "k" })).rejects.toBeInstanceOf(ShellError);
    expect(calls).toEqual([
      ["daemon_call", { method: "skills.list", params: {} }],
      ["key_save", { provider: "openai", apiKey: "sk-0123456789", baseUrl: null }],
      ["key_save", { provider: "local", apiKey: "", baseUrl: "http://localhost:11434/v1" }],
      ["pin_open", { appId: "foo" }],
      ["app_export", { appId: "foo" }],
      ["key_delete", { provider: "openai" }],
      ["daemon_status", undefined],
    ]);
  });

  it("describes errors in plain words", () => {
    expect(describeError(new ShellError("gone", SHELL_ERRORS.daemonUnavailable))).toMatch(/engine is not available/);
    expect(describeError(new ShellError("slow", SHELL_ERRORS.timeout))).toMatch(/too long/);
    expect(describeError(new ShellError("no key set for openai", -32001))).toMatch(/Setup/);
    expect(describeError(new ShellError("other", -1))).toBe("other");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("s")).toBe("s");
  });
});
