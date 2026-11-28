// Loads MCP servers from mcp.json and exposes their tools as mcp__<server>__<tool>.
//
// Effects come from MCP annotations, taken only when explicitly true:
//   readOnlyHint -> read, destructiveHint -> delete (ignored when readOnlyHint),
//   openWorldHint -> network. A tool with no read-only hint also gets "write".
// The config file can add effects such as send or pay per tool.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { toToolName, type ToolEffect } from "@oneseat/contracts";
import { fail, type RegisteredTool } from "../tools/registry.js";
import { errorMessage, isRecord, silentLogger, type Logger } from "../util.js";
import { McpClient, renderMcpContent, type McpClientOptions, type McpServerConfig, type McpTool } from "./client.js";

const EFFECTS: readonly ToolEffect[] = ["read", "write", "network", "send", "pay", "delete"];

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/** Parse mcp.json: {"mcpServers": {"id": {"command", "args", "env", "effects"}}}. */
export function parseMcpConfig(text: string): { config: McpConfig; issues: string[] } {
  const issues: string[] = [];
  const config: McpConfig = { servers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { config, issues: [`mcp.json is not valid JSON: ${errorMessage(e)}`] };
  }
  if (!isRecord(raw) || !isRecord(raw["mcpServers"])) return { config, issues: ['mcp.json needs an "mcpServers" object'] };
  for (const [id, v] of Object.entries(raw["mcpServers"])) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      issues.push(`server id "${id}" must be 1-32 letters, digits, _ or -`);
      continue;
    }
    if (!isRecord(v) || typeof v["command"] !== "string" || v["command"] === "") {
      issues.push(`server "${id}" needs a "command"`);
      continue;
    }
    const s: McpServerConfig = { command: v["command"] };
    if (v["args"] !== undefined) {
      if (Array.isArray(v["args"]) && v["args"].every((a) => typeof a === "string")) s.args = v["args"] as string[];
      else issues.push(`server "${id}": args must be a list of strings`);
    }
    if (v["env"] !== undefined) {
      if (isRecord(v["env"]) && Object.values(v["env"]).every((x) => typeof x === "string")) s.env = v["env"] as Record<string, string>;
      else issues.push(`server "${id}": env must map names to strings`);
    }
    if (typeof v["cwd"] === "string") s.cwd = v["cwd"];
    if (typeof v["timeoutMs"] === "number" && v["timeoutMs"] > 0) s.timeoutMs = v["timeoutMs"];
    if (v["disabled"] === true) s.disabled = true;
    if (v["effects"] !== undefined) {
      if (!isRecord(v["effects"])) issues.push(`server "${id}": effects must map tool names to effect lists`);
      else {
        s.effects = {};
        for (const [tool, list] of Object.entries(v["effects"])) {
          if (Array.isArray(list) && list.every((e) => EFFECTS.includes(e as ToolEffect))) s.effects[tool] = list as ToolEffect[];
          else issues.push(`server "${id}": effects.${tool} must list ${EFFECTS.join(", ")}`);
        }
      }
    }
    config.servers[id] = s;
  }
  return { config, issues };
}

export async function loadMcpConfig(path: string): Promise<{ config: McpConfig; issues: string[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: { servers: {} }, issues: [] };
    throw e;
  }
  return parseMcpConfig(text);
}

/**
 * A tool's effects from its MCP annotations, with the spec's defaults (MCP 2025-06-18): a missing
 * readOnlyHint means the tool can change things, a missing destructiveHint means it can destroy,
 * and a missing openWorldHint means it reaches outside the machine. MCP has no "send" hint, so a
 * tool that changes things in the open world (send_email, post_message) counts as a send.
 * So only a read-only tool, or one that states it is neither destructive nor open-world, runs
 * without asking the person. Overrides in mcp.json only add effects.
 */
export function mcpToolEffects(tool: McpTool, overrides?: Record<string, ToolEffect[]>): ToolEffect[] {
  const a = tool.annotations ?? {};
  const out = new Set<ToolEffect>();
  const openWorld = a.openWorldHint !== false;
  if (a.readOnlyHint === true) out.add("read");
  else {
    out.add("write");
    if (a.destructiveHint !== false) out.add("delete");
    if (openWorld) out.add("send");
  }
  if (openWorld) out.add("network");
  for (const e of overrides?.["*"] ?? []) out.add(e);
  for (const e of overrides?.[tool.name] ?? []) out.add(e);
  // An override that adds an outward effect makes the tool non-read-only.
  if ([...out].some((e) => e !== "read" && e !== "network")) out.delete("read");
  return EFFECTS.filter((e) => out.has(e));
}

/** mcp__<server>__<tool>, valid on every provider; long names get a hash suffix. */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  const name = toToolName(raw);
  if (raw.length <= 64) return name;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

export interface McpServerStatus {
  id: string;
  connected: boolean;
  tools: number;
  error?: string;
}

export interface McpManagerOptions extends McpClientOptions {
  config: McpConfig;
  /** Build a client (tests). */
  createClient?: (id: string, config: McpServerConfig) => McpClient;
}

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolsByServer = new Map<string, RegisteredTool[]>();
  private readonly errors = new Map<string, string>();
  private readonly logger: Logger;

  constructor(private readonly opts: McpManagerOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  static async fromFile(path: string, opts: Omit<McpManagerOptions, "config"> = {}): Promise<McpManager> {
    const { config, issues } = await loadMcpConfig(path);
    for (const i of issues) (opts.logger ?? silentLogger).warn(`mcp config: ${i}`);
    return new McpManager({ ...opts, config });
  }

  /** Start every enabled server. A server that fails is logged and skipped. */
  async start(): Promise<McpServerStatus[]> {
    await Promise.all(
      Object.entries(this.opts.config.servers)
        .filter(([, c]) => !c.disabled)
        .map(([id, c]) => this.startServer(id, c)),
    );
    return this.status();
  }

  private async startServer(id: string, config: McpServerConfig): Promise<void> {
    const client = this.opts.createClient?.(id, config) ?? new McpClient(id, config, this.opts);
    this.clients.set(id, client);
    try {
      await client.start();
      const tools = await client.listTools();
      this.toolsByServer.set(id, tools.map((t) => this.wrap(id, client, t, config)));
      this.errors.delete(id);
      this.logger.info(`mcp ${id}: ${tools.length} tools`);
    } catch (e) {
      this.errors.set(id, errorMessage(e));
      this.toolsByServer.set(id, []);
      this.logger.warn(`mcp ${id} unavailable`, errorMessage(e));
      await client.close().catch(() => undefined);
    }
  }

  private wrap(server: string, client: McpClient, tool: McpTool, config: McpServerConfig): RegisteredTool {
    const desc = (tool.description ?? tool.title ?? tool.annotations?.title ?? `${tool.name} (from ${server})`).trim() || tool.name;
    const schema = { ...tool.inputSchema, type: "object" };
    return {
      definition: {
        name: mcpToolName(server, tool.name),
        description: desc.length > 1024 ? `${desc.slice(0, 1021)}...` : desc,
        inputSchema: schema,
        effects: mcpToolEffects(tool, config.effects),
        source: "mcp",
        owner: server,
      },
      run: async (input, ctx) => {
        if (!client.connected) return fail(`MCP server "${server}" is not running`);
        try {
          const res = await client.callTool(tool.name, input, { signal: ctx.signal });
          return { content: renderMcpContent(res), isError: res.isError === true };
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
    };
  }

  tools(): RegisteredTool[] {
    return [...this.toolsByServer.values()].flat();
  }

  status(): McpServerStatus[] {
    return Object.keys(this.opts.config.servers).map((id) => {
      const s: McpServerStatus = {
        id,
        connected: this.clients.get(id)?.connected ?? false,
        tools: this.toolsByServer.get(id)?.length ?? 0,
      };
      const err = this.errors.get(id);
      if (err) s.error = err;
      return s;
    });
  }

  client(id: string): McpClient | undefined {
    return this.clients.get(id);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
  }
}
