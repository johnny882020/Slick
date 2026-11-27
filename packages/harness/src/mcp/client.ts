// A minimal MCP client over stdio: JSON-RPC 2.0, one JSON object per line.
// initialize -> notifications/initialized -> tools/list (paginated) -> tools/call.
// Requests time out; a server that exits fails every pending request.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";
import type { JsonSchema, ToolEffect } from "@oneseat/contracts";
import { errorMessage, isRecord, silentLogger, type Logger } from "../util.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Extra effects per tool name, e.g. {"send_email": ["send"]}. "*" applies to every tool. */
  effects?: Record<string, ToolEffect[]>;
  disabled?: boolean;
  /** Per-request timeout for this server. */
  timeoutMs?: number;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: McpToolAnnotations;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: string; [k: string]: unknown };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
}

export class McpError extends Error {
  override name = "McpError";
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}

const BASE_ENV_KEYS = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];

export interface McpClientOptions {
  requestTimeoutMs?: number;
  logger?: Logger;
  clientInfo?: { name: string; version: string };
}

export class McpClient {
  readonly id: string;
  readonly config: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly clientInfo: { name: string; version: string };
  private exited: Promise<void> | undefined;
  initializeResult: McpInitializeResult | undefined;

  constructor(id: string, config: McpServerConfig, opts: McpClientOptions = {}) {
    this.id = id;
    this.config = config;
    this.logger = opts.logger ?? silentLogger;
    this.timeoutMs = config.timeoutMs ?? opts.requestTimeoutMs ?? 30_000;
    this.clientInfo = opts.clientInfo ?? { name: "oneseat", version: "0.1.0" };
  }

  get connected(): boolean {
    return this.child !== undefined && this.initializeResult !== undefined;
  }

  /** Spawn the server and run the initialize handshake. */
  async start(): Promise<McpInitializeResult> {
    if (this.child) throw new McpError(`MCP server ${this.id} is already running`);
    const env: Record<string, string> = {};
    for (const k of BASE_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, this.config.env ?? {});
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: platform() === "win32" && !/\.(exe|com)$/i.test(this.config.command),
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.on("exit", (code, signal) => {
        this.logger.debug(`mcp ${this.id} exited`, { code, signal });
        this.failAll(new McpError(`MCP server ${this.id} exited${code !== null ? ` with code ${code}` : ""}`));
        this.child = undefined;
        this.initializeResult = undefined;
        resolve();
      });
    });
    child.on("error", (e) => {
      this.logger.warn(`mcp ${this.id} failed to start`, e.message);
      this.failAll(new McpError(`MCP server ${this.id} failed to start: ${e.message}`));
      this.child = undefined;
      this.initializeResult = undefined;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.logger.debug(`mcp ${this.id} stderr: ${line}`);
    });
    child.stdin.on("error", () => {
      /* server closed its stdin */
    });
    try {
      const result = (await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo,
      })) as McpInitializeResult;
      if (!isRecord(result) || typeof result.protocolVersion !== "string")
        throw new McpError(`MCP server ${this.id} sent an invalid initialize result`);
      this.initializeResult = result;
      this.notify("notifications/initialized");
      return result;
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger.debug(`mcp ${this.id} sent a non-JSON line`);
      return;
    }
    if (!isRecord(msg)) return;
    const id = msg["id"];
    if (typeof msg["method"] === "string") {
      if (id !== undefined && id !== null) this.onServerRequest(id as number | string, msg["method"]);
      return; // notifications (logging, progress, list_changed) are ignored
    }
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    if (isRecord(msg["error"])) {
      const err = msg["error"];
      p.reject(new McpError(String(err["message"] ?? "MCP error"), typeof err["code"] === "number" ? err["code"] : undefined, err["data"]));
    } else p.resolve(msg["result"]);
  }

  private onServerRequest(id: number | string, method: string): void {
    if (method === "ping") this.write({ jsonrpc: "2.0", id, result: {} });
    else this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported by client: ${method}` } });
  }

  private write(msg: unknown): void {
    if (!this.child) throw new McpError(`MCP server ${this.id} is not running`);
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  request(method: string, params?: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!this.child) return Promise.reject(new McpError(`MCP server ${this.id} is not running`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
      const cancel = (reason: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try {
          this.notify("notifications/cancelled", { requestId: id, reason });
        } catch {
          /* not running */
        }
      };
      const timer = setTimeout(() => {
        cancel("timeout");
        reject(new McpError(`MCP ${this.id} ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        cancel("cancelled");
        reject(new McpError(`MCP ${this.id} ${method} was cancelled`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup });
      try {
        this.write(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        cleanup();
        reject(e instanceof Error ? e : new McpError(errorMessage(e)));
      }
      if (opts.signal?.aborted) onAbort();
    });
  }

  /** Every tool the server offers, following nextCursor pages. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {});
      if (!isRecord(res) || !Array.isArray(res["tools"])) throw new McpError(`MCP ${this.id} tools/list returned no tools array`);
      for (const t of res["tools"] as unknown[]) {
        if (!isRecord(t) || typeof t["name"] !== "string") continue;
        const tool: McpTool = {
          name: t["name"],
          inputSchema: isRecord(t["inputSchema"]) ? (t["inputSchema"] as JsonSchema) : { type: "object" },
        };
        if (typeof t["title"] === "string") tool.title = t["title"];
        if (typeof t["description"] === "string") tool.description = t["description"];
        if (isRecord(t["annotations"])) tool.annotations = t["annotations"] as McpToolAnnotations;
        tools.push(tool);
      }
      const next = res["nextCursor"];
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpCallResult> {
    const res = await this.request("tools/call", { name, arguments: args }, opts);
    if (!isRecord(res)) throw new McpError(`MCP ${this.id} tools/call returned an invalid result`);
    const out: McpCallResult = { content: Array.isArray(res["content"]) ? (res["content"] as McpContent[]) : [] };
    if (res["isError"] === true) out.isError = true;
    if (res["structuredContent"] !== undefined) out.structuredContent = res["structuredContent"];
    return out;
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.cleanup();
      p.reject(err);
    }
  }

  /** stdio shutdown: close stdin, then SIGTERM, then SIGKILL. */
  async close(graceMs = 1500): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = this.exited!;
    const waitExit = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    if (await waitExit(graceMs)) return;
    child.kill("SIGTERM");
    if (await waitExit(graceMs)) return;
    child.kill("SIGKILL");
    await waitExit(graceMs);
  }
}

/** Render a tools/call result as text for the model. */
export function renderMcpContent(result: McpCallResult): string {
  const parts: string[] = [];
  for (const c of result.content) {
    if (c.type === "text" && typeof c["text"] === "string") parts.push(c["text"]);
    else if ((c.type === "image" || c.type === "audio") && typeof c["mimeType"] === "string")
      parts.push(`[${c.type}: ${c["mimeType"]}]`);
    else if (c.type === "resource" && isRecord(c["resource"])) {
      const r = c["resource"];
      parts.push(typeof r["text"] === "string" ? r["text"] : `[resource: ${String(r["uri"])}]`);
    } else if (c.type === "resource_link") parts.push(`[resource link: ${String(c["uri"])}]`);
    else parts.push(`[${c.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}
