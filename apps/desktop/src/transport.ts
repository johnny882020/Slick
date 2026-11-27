// Transport between the UI and the shell.
//  - TauriTransport: the desktop app (invoke/listen from @tauri-apps/api).
//  - WebSocketTransport: a plain browser against dev/bridge.mjs (development, e2e).
// Both speak the same commands and events (see protocol.ts).

import { SHELL_ERRORS } from "./protocol";

export type Unlisten = () => void;

export interface Transport {
  readonly kind: "tauri" | "websocket" | "memory";
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten>;
  close(): void;
}

/** Every failure from the shell or the daemon, with a JSON-RPC style code. */
export class ShellError extends Error {
  override name = "ShellError";
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Normalise whatever a transport rejected with. */
export function toShellError(e: unknown): ShellError {
  if (e instanceof ShellError) return e;
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof o.message === "string") return new ShellError(o.message, typeof o.code === "number" ? o.code : -32603, o.data);
  }
  if (typeof e === "string") {
    // Tauri reports ACL refusals as plain strings.
    const forbidden = /not allowed|denied|permission/i.test(e);
    return new ShellError(e, forbidden ? SHELL_ERRORS.forbidden : -32603);
  }
  return new ShellError(String(e), -32603);
}

// ---------------------------------------------------------------- Tauri

export interface TauriDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<Unlisten>;
}

export class TauriTransport implements Transport {
  readonly kind = "tauri" as const;
  constructor(private readonly deps: TauriDeps) {}

  static async create(): Promise<TauriTransport> {
    const [core, event] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
    return new TauriTransport({
      invoke: (cmd, args) => core.invoke(cmd, args),
      listen: (name, handler) => event.listen(name, handler),
    });
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await this.deps.invoke(cmd, args)) as T;
    } catch (e) {
      throw toShellError(e);
    }
  }

  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
    return this.deps.listen(event, (e) => handler(e.payload as T));
  }

  close(): void {}
}

// ---------------------------------------------------------------- WebSocket

/** Wire format of the dev bridge. */
export type BridgeClientMessage = { id: number; cmd: string; args?: Record<string, unknown> };
export type BridgeServerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: number; message: string; data?: unknown } }
  | { event: string; payload: unknown };

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export interface WebSocketTransportOptions {
  /** Defaults to the browser WebSocket. */
  factory?: WsFactory;
  /** Per-call timeout (ms). Default 5 minutes (skills.install can be slow). */
  timeoutMs?: number;
  /** Reconnect delays (ms), the last repeats. */
  reconnectDelays?: number[];
}

const OPEN = 1;

export class WebSocketTransport implements Transport {
  readonly kind = "websocket" as const;
  private ws: WsLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: ShellError) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly queue: string[] = [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private closed = false;
  private attempt = 0;
  private readonly factory: WsFactory;
  private readonly timeoutMs: number;
  private readonly delays: number[];

  constructor(
    private readonly url: string,
    opts: WebSocketTransportOptions = {},
  ) {
    this.factory = opts.factory ?? ((u) => new WebSocket(u) as unknown as WsLike);
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.delays = opts.reconnectDelays ?? [250, 500, 1000, 2000, 5000];
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = this.factory(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const msg of this.queue.splice(0)) ws.send(msg);
      this.emit("transport://open", null);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Calls in flight are lost with the socket.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new ShellError("lost connection to the OneSeat dev bridge", SHELL_ERRORS.daemonUnavailable));
        this.pending.delete(id);
      }
      this.emit("transport://closed", null);
      if (!this.closed) {
        const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 1000;
        this.attempt += 1;
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  private onMessage(raw: unknown): void {
    let msg: BridgeServerMessage;
    try {
      msg = JSON.parse(String(raw)) as BridgeServerMessage;
    } catch {
      return;
    }
    if ("event" in msg) {
      this.emit(msg.event, msg.payload);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ShellError(msg.error.message, msg.error.code, msg.error.data));
  }

  private emit(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) {
      try {
        h(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new ShellError("transport closed", SHELL_ERRORS.daemonUnavailable));
    const id = this.nextId++;
    const msg: BridgeClientMessage = args === undefined ? { id, cmd } : { id, cmd, args };
    const text = JSON.stringify(msg);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ShellError(`${cmd} timed out`, SHELL_ERRORS.timeout));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (this.ws && this.ws.readyState === OPEN) this.ws.send(text);
      else this.queue.push(text);
    });
  }

  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const h = handler as (payload: unknown) => void;
    set.add(h);
    return Promise.resolve(() => set.delete(h));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ShellError("transport closed", SHELL_ERRORS.daemonUnavailable));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- choose

export function isTauri(w: unknown = globalThis): boolean {
  return !!w && typeof w === "object" && "__TAURI_INTERNALS__" in w;
}

/** The bridge URL for browser mode: ?bridge=ws://... or the page's own host at /rpc. */
export function bridgeUrl(loc: { protocol: string; host: string; search: string }): string {
  const fromQuery = new URLSearchParams(loc.search).get("bridge");
  if (fromQuery && /^wss?:\/\//.test(fromQuery)) return fromQuery;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/rpc`;
}

export async function createTransport(): Promise<Transport> {
  if (isTauri()) return TauriTransport.create();
  return new WebSocketTransport(bridgeUrl(location));
}
