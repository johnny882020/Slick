#!/usr/bin/env node
// Dev bridge: run the OneSeat UI in a plain browser (development and e2e tests).
//
// Serves the built UI (dist/) and bridges a WebSocket at /rpc to a daemon child process,
// implementing the same commands as the Rust core (daemon_call with the same allowlist,
// key_save / key_delete / key_status, pin_open, app_export, daemon_status) and forwarding
// daemon notifications as "daemon://notification" events.
//
// In this mode keys are kept in memory only (never written anywhere) and sent to the
// daemon with auth.set, just like the Rust core does after reading the keychain.
//
//   node dev/bridge.mjs [--port 4780] [--dist dist] [--home DIR]
//
// Env:
//   BRIDGE_PORT      port (default 4780), bound to 127.0.0.1 only
//   ONESEAT_DAEMON   daemon entry (.js/.mjs/.cjs run with node; default: dev/fake-daemon.mjs)
//   ONESEAT_NODE     node binary for the daemon (default: this node)
//   ONESEAT_HOME     data dir passed to the daemon (default: a fresh temp dir)
//   FAKE_DAEMON_STEP_MS  passed through to the fake daemon
//
// Test hooks: GET /__health, POST /__reset (fresh daemon, keys and data dir).
// Pinned pages: GET /pinned/<id>/ serves <home>/apps/<id>/index.html with PINNED_APP_CSP.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { APP_ID, PROVIDERS, SHELL_ERRORS, UI_METHODS, readPinnedCsp } from "./protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", process.env.BRIDGE_PORT ?? 4780));
const DIST = resolve(arg("dist", join(here, "..", "dist")));
const DAEMON = resolve(process.env.ONESEAT_DAEMON || join(here, "fake-daemon.mjs"));
const NODE = process.env.ONESEAT_NODE || process.execPath;
const FIXED_HOME = arg("home", process.env.ONESEAT_HOME || "");
const PINNED_APP_CSP = readPinnedCsp();
const MAIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`;

const log = (...a) => console.error("[bridge]", ...a);

// Same redaction idea as src-tauri/src/redact.rs, for daemon stderr.
const secrets = new Set();
function redact(line) {
  let out = line;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join("[REDACTED]");
  return out
    .replace(/((?:x-api-key|x-goog-api-key|authorization|api[_-]?key|apikey)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,;"'}\]]+)/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}|\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]");
}

// ---------------------------------------------------------------- daemon child

class Daemon {
  constructor(home) {
    this.home = home;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.state = "starting";
    this.restarts = 0;
    this.lastError = null;
    this.version = null;
    this.stopped = false;
    this.delay = 250;
    this.readyWaiters = [];
    this.start();
  }

  status() {
    return {
      state: this.state,
      restarts: this.restarts,
      pid: this.child?.pid ?? null,
      version: this.version,
      lastError: this.lastError,
      description: `${NODE} ${DAEMON} (dev bridge)`,
    };
  }

  setState(state) {
    this.state = state;
    // A daemon replaced by /__reset must not report its own shutdown to the UI.
    if (daemon === this) broadcast("daemon://status", this.status());
    if (state === "running") for (const w of this.readyWaiters.splice(0)) w();
  }

  start() {
    if (this.stopped) return;
    const startedAt = Date.now();
    const env = { ...process.env, ONESEAT_HOME: this.home, ONESEAT_SHELL: "dev-bridge" };
    delete env.NODE_OPTIONS;
    const isScript = /\.(m|c)?js$/.test(DAEMON);
    const child = isScript
      ? spawn(NODE, [DAEMON], { env, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(DAEMON, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.setState("starting");
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => log(redact(line)));
    child.on("error", (e) => {
      this.lastError = `cannot start the daemon: ${e.message}`;
      log(this.lastError);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p.reject({ code: SHELL_ERRORS.daemonUnavailable, message: "the OneSeat daemon exited; it is restarting" });
      this.pending.clear();
      if (this.stopped) return this.setState("stopped");
      this.restarts += 1;
      this.lastError = `daemon exited (${code})`;
      this.setState("restarting");
      this.delay = Date.now() - startedAt > 60_000 ? 250 : Math.min(this.delay * 2, 5000);
      setTimeout(() => this.start(), this.delay);
    });
    void this.handshake(child);
  }

  async handshake(child) {
    try {
      const hello = await this.callNow("daemon.hello", { client: "oneseat-dev-bridge" });
      this.version = hello.version ?? null;
      for (const [provider, cred] of keys) {
        await this.callNow("auth.set", { provider, apiKey: cred.apiKey, ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}) });
      }
      if (this.child === child) {
        this.lastError = null;
        this.setState("running");
      }
    } catch (e) {
      this.lastError = `handshake failed: ${e.message}`;
      log(this.lastError);
      if (this.child === child) child.kill();
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`daemon stdout (not JSON): ${redact(line).slice(0, 300)}`);
      return;
    }
    if (msg && msg.jsonrpc === "2.0" && msg.id === undefined && typeof msg.method === "string") {
      broadcast("daemon://notification", { method: msg.method, params: msg.params });
      return;
    }
    const p = this.pending.get(Number(msg?.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    if (msg.error) p.reject({ code: msg.error.code ?? -32603, message: String(msg.error.message ?? "error"), data: msg.error.data });
    else p.resolve(msg.result);
  }

  callNow(method, params, timeoutMs = 300_000) {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject({ code: SHELL_ERRORS.daemonUnavailable, message: "the OneSeat daemon is not running" });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: SHELL_ERRORS.timeout, message: `the OneSeat daemon did not answer ${method} in time` });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(method, params) {
    if (this.state !== "running") {
      await Promise.race([
        new Promise((r) => this.readyWaiters.push(r)),
        new Promise((_, rej) => setTimeout(() => rej({ code: SHELL_ERRORS.daemonUnavailable, message: "the OneSeat daemon is not ready" }), 15_000)),
      ]);
    }
    return this.callNow(method, params);
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }
}

// ---------------------------------------------------------------- keys (memory only)

/** provider -> { apiKey, baseUrl? }. Never written to disk or logged. */
const keys = new Map();

function validateCredential(provider, apiKey, baseUrl) {
  if (!PROVIDERS.includes(provider)) throw { code: -32602, message: `unknown provider "${String(provider).slice(0, 32)}"` };
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
  if (provider === "local" && !url) throw { code: -32602, message: "a local model needs a base URL, for example http://localhost:11434/v1" };
  if (provider !== "local" && !key) throw { code: -32602, message: "paste your API key" };
  if (key) {
    if (key.length < 8) throw { code: -32602, message: "that key is too short; check you copied all of it" };
    if (key.length > 1024) throw { code: -32602, message: "that key is too long; check you copied only the key" };
    if (/[\s\p{Cc}]/u.test(key)) throw { code: -32602, message: "the key contains spaces or line breaks; copy only the key" };
  }
  if (url && !/^https?:\/\/[^\s/@]+(\/|$)/.test(url)) throw { code: -32602, message: "the base URL must start with http:// or https://" };
  return { apiKey: key, ...(url ? { baseUrl: url } : {}) };
}

async function keyStatus() {
  let active = null;
  try {
    if (daemon.state === "running") active = await daemon.callNow("auth.status", {}, 5000);
  } catch {
    active = null;
  }
  return {
    keychain: { available: true, message: null },
    providers: PROVIDERS.map((p) => ({
      provider: p,
      stored: keys.has(p),
      active: active ? Boolean(active[p]) : null,
      baseUrl: keys.get(p)?.baseUrl ?? null,
    })),
    daemon: daemon.status(),
  };
}

// ---------------------------------------------------------------- commands

const commands = {
  async daemon_call({ method, params } = {}) {
    if (typeof method !== "string" || !UI_METHODS.includes(method)) {
      throw { code: SHELL_ERRORS.forbidden, message: `the method "${String(method).slice(0, 64)}" cannot be called from the UI` };
    }
    const p = params ?? {};
    if (typeof p !== "object" || Array.isArray(p)) throw { code: -32602, message: "params must be an object" };
    return daemon.call(method, p);
  },
  daemon_status: () => daemon.status(),
  async key_save({ provider, apiKey, baseUrl } = {}) {
    const cred = validateCredential(provider, apiKey, baseUrl);
    keys.set(provider, cred);
    if (cred.apiKey.length >= 6) secrets.add(cred.apiKey);
    try {
      await daemon.call("auth.set", { provider, ...cred });
    } catch (e) {
      log(`saved the ${provider} key, but the daemon did not take it: ${redact(String(e.message))}`);
    }
    return keyStatus();
  },
  async key_delete({ provider } = {}) {
    if (!PROVIDERS.includes(provider)) throw { code: -32602, message: "unknown provider" };
    const old = keys.get(provider);
    keys.delete(provider);
    if (old) secrets.delete(old.apiKey);
    try {
      await daemon.call("auth.clear", { provider });
    } catch {
      /* not running: nothing to clear */
    }
    return keyStatus();
  },
  key_status: () => keyStatus(),
  pin_open({ appId } = {}) {
    if (typeof appId !== "string" || !APP_ID.test(appId)) throw { code: -32602, message: "invalid app id" };
    if (!existsSync(join(home, "apps", appId, "index.html"))) throw { code: -32004, message: `the page for ${appId} is missing. Pin the app again.` };
    // No native windows in a browser: the UI opens this URL in a tab.
    return { url: `/pinned/${appId}/` };
  },
  app_export({ appId } = {}) {
    if (typeof appId !== "string" || !APP_ID.test(appId)) throw { code: -32602, message: "invalid app id" };
    const src = join(home, "apps", appId);
    if (!existsSync(join(src, "app.json"))) throw { code: -32004, message: `cannot read app.json for ${appId}` };
    const out = join(home, "exports", appId);
    mkdirSync(out, { recursive: true });
    for (const f of ["index.html", "app.json"]) cpSync(join(src, f), join(out, f));
    return { dir: out, command: `pnpm --filter @oneseat/desktop export-app -- --app "${out}"` };
  },
};

// ---------------------------------------------------------------- http + ws

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function servePinned(res, id) {
  const file = join(home, "apps", id, "index.html");
  if (!APP_ID.test(id) || !existsSync(file)) return send(res, 404, "Not found", { "Content-Type": "text/plain", "Content-Security-Policy": PINNED_APP_CSP });
  send(res, 200, readFileSync(file), {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": PINNED_APP_CSP,
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
}

function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return send(res, 400, "Bad request");
  }
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, "Forbidden");
  let target = file;
  if (!existsSync(target) || statSync(target).isDirectory()) target = join(DIST, "index.html");
  if (!existsSync(target)) return send(res, 503, "UI not built: run `pnpm --filter @oneseat/desktop build`", { "Content-Type": "text/plain" });
  const headers = { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" };
  if (target.endsWith(".html")) headers["Content-Security-Policy"] = MAIN_CSP;
  send(res, 200, readFileSync(target), headers);
}

let home;
let ownsHome = false;
let daemon;

function freshHome() {
  if (home && ownsHome) rmSync(home, { recursive: true, force: true });
  if (FIXED_HOME) {
    home = resolve(FIXED_HOME);
    ownsHome = false;
  } else {
    home = mkdtempSync(join(tmpdir(), "oneseat-bridge-"));
    ownsHome = true;
  }
  mkdirSync(join(home, "apps"), { recursive: true });
}

function boot() {
  freshHome();
  daemon = new Daemon(home);
}

async function reset() {
  const old = daemon;
  old.stop();
  keys.clear();
  secrets.clear();
  await new Promise((r) => setTimeout(r, 50));
  boot();
  await daemon.call("daemon.hello", { client: "oneseat-dev-bridge" });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/__health") return send(res, 200, JSON.stringify({ ok: true, daemon: daemon.status() }), { "Content-Type": "application/json" });
  if (url.pathname === "/__reset" && req.method === "POST") {
    reset().then(
      () => send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" }),
      (e) => send(res, 500, JSON.stringify({ ok: false, error: e.message }), { "Content-Type": "application/json" }),
    );
    return;
  }
  const pinned = url.pathname.match(/^\/pinned\/([^/]+)\/(index\.html)?$/);
  if (pinned) return servePinned(res, pinned[1]);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  serveStatic(res, url.pathname);
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(event, payload) {
  const text = JSON.stringify({ event, payload });
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
  if (url.pathname !== "/rpc" || !okOrigin) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const { id, cmd, args } = msg ?? {};
      if (typeof id !== "number") return;
      const fn = commands[cmd];
      try {
        if (!fn) throw { code: -32601, message: `unknown command ${String(cmd).slice(0, 40)}` };
        const result = await fn(args ?? {});
        ws.send(JSON.stringify({ id, ok: true, result: result ?? null }));
      } catch (e) {
        const error = { code: typeof e?.code === "number" ? e.code : -32603, message: redact(String(e?.message ?? e)) };
        if (e?.data !== undefined) error.data = e.data;
        ws.send(JSON.stringify({ id, ok: false, error }));
      }
    });
  });
});

boot();
server.listen(PORT, "127.0.0.1", () => {
  log(`OneSeat dev bridge on http://127.0.0.1:${PORT} (daemon: ${DAEMON})`);
});

function shutdown() {
  daemon?.stop();
  if (home && ownsHome) rmSync(home, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
