import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requiresApproval } from "@oneseat/contracts";
import { McpClient, McpError, MCP_PROTOCOL_VERSION, renderMcpContent, type McpServerConfig } from "../src/mcp/client.js";
import { loadMcpConfig, McpManager, mcpToolEffects, mcpToolName, parseMcpConfig } from "../src/mcp/manager.js";
import { approveAll, collect, done, ofType, onCleanup, setup, task, tmpDir } from "./helpers.js";

const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

function server(env: Record<string, string> = {}, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: process.execPath, args: [SERVER], env, ...extra };
}

async function started(env: Record<string, string> = {}, opts: { requestTimeoutMs?: number } = {}) {
  const client = new McpClient("fake", server(env), opts);
  onCleanup(() => void client.close(200));
  await client.start();
  return client;
}

function logged(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("McpClient", () => {
  it("initializes, lists tools across pages and calls them", async () => {
    const log = join(tmpDir(), "log.jsonl");
    const client = await started({ FAKE_MCP_LOG: log });
    expect(client.connected).toBe(true);
    expect(client.initializeResult).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "fake" } });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "echo",
      "add",
      "send_email",
      "delete_file",
      "web.search",
      "fail_tool",
      "slow",
      "crash",
      "rpc_error",
      "media",
      "structured",
      "bad",
    ]);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
    expect(tools[1]!.title).toBe("Add numbers");
    expect(tools[11]!.inputSchema).toEqual({ type: "object" });
    expect(renderMcpContent(await client.callTool("echo", { text: "hi" }))).toBe("hi");
    const add = await client.callTool("add", { a: 2, b: 3 });
    expect(add.structuredContent).toEqual({ sum: 5 });
    expect(await client.callTool("fail_tool", {})).toMatchObject({ isError: true });
    expect(renderMcpContent(await client.callTool("media", {}))).toBe(
      "[image: image/png]\nresource text\n[resource: file:///b.bin]\n[resource link: file:///c.txt]\n[mystery content]",
    );
    expect(renderMcpContent(await client.callTool("structured", {}))).toBe('{"rows":2}');
    await expect(client.callTool("rpc_error", {})).rejects.toMatchObject({ name: "McpError", code: -32000, message: "server exploded" });
    await expect(client.callTool("weird", {})).rejects.toThrow("invalid result");
    await expect(client.request("nope/method")).rejects.toMatchObject({ code: -32601 });

    // What the server saw: the handshake, both list pages, and our replies to its requests.
    const msgs = logged(log);
    expect(msgs[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oneseat" } },
    });
    expect(msgs[1]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(msgs.find((m) => m["id"] === "srv-1")).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
    expect(msgs.find((m) => m["id"] === "srv-2")).toMatchObject({ error: { code: -32601 } });
    expect(msgs.filter((m) => m["method"] === "tools/list").map((m) => m["params"])).toEqual([{}, { cursor: "p2" }]);

    await client.close();
    expect(client.connected).toBe(false);
    await client.close(); // no-op
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow("is not running");
    expect(() => client.notify("x")).toThrow("is not running");
  });

  it("times out, cancels and survives a slow call", async () => {
    const log = join(tmpDir(), "log.jsonl");
    const client = await started({ FAKE_MCP_LOG: log }, { requestTimeoutMs: 5000 });
    await expect(client.callTool("slow", { ms: 2000 }, { timeoutMs: 50 })).rejects.toThrow("timed out after 50 ms");
    const ac = new AbortController();
    const p = client.callTool("slow", { ms: 2000 }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("was cancelled");
    const pre = new AbortController();
    pre.abort();
    await expect(client.callTool("slow", { ms: 10 }, { signal: pre.signal })).rejects.toThrow("was cancelled");
    expect(renderMcpContent(await client.callTool("slow", { ms: 10 }))).toBe("slow done");
    await new Promise((r) => setTimeout(r, 50));
    const cancels = logged(log).filter((m) => m["method"] === "notifications/cancelled");
    expect(cancels.map((c) => (c["params"] as { reason: string }).reason)).toEqual(["timeout", "cancelled", "cancelled"]);
  });

  it("fails pending calls when the server exits", async () => {
    const client = await started();
    await expect(client.callTool("crash", {})).rejects.toThrow(/exited with code 3/);
    expect(client.connected).toBe(false);
  });

  it("reports handshake failures and bad tool lists", async () => {
    const bad = new McpClient("bad", server({ FAKE_MCP_MODE: "bad-init" }));
    await expect(bad.start()).rejects.toThrow("unsupported protocol");
    expect(bad.connected).toBe(false);

    const hang = new McpClient("hang", server({ FAKE_MCP_MODE: "hang-init" }), { requestTimeoutMs: 100 });
    await expect(hang.start()).rejects.toThrow("initialize timed out");

    const missing = new McpClient("missing", { command: join(tmpDir(), "no-such-binary") });
    await expect(missing.start()).rejects.toThrow(/failed to start|exited/);

    const list = await started({ FAKE_MCP_MODE: "bad-list" });
    await expect(list.listTools()).rejects.toThrow("no tools array");
    await expect(list.start()).rejects.toThrow("already running");
  });

  it("escalates to SIGKILL for a server that ignores shutdown", async () => {
    const client = await started({ FAKE_MCP_MODE: "stubborn" });
    const t0 = Date.now();
    await client.close(100);
    expect(client.connected).toBe(false);
    // POSIX: the server ignores SIGTERM, so close() waits out the grace period, then SIGKILLs.
    // Windows has no catchable SIGTERM: Node's kill() terminates at once, before any grace.
    if (process.platform === "win32") expect(Date.now() - t0).toBeLessThan(5_000);
    else expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });
});

describe("MCP config and effects", () => {
  it("parses mcp.json and reports problems", async () => {
    const good = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          gmail: { command: "node", args: ["s.js"], env: { A: "1" }, cwd: "/tmp", timeoutMs: 100, effects: { send_email: ["send"], "*": ["network"] } },
          off: { command: "x", disabled: true },
          "bad id!": { command: "x" },
          nocmd: {},
          badargs: { command: "x", args: [1], env: { A: 1 }, effects: { t: ["fly"] } },
          badeffects: { command: "x", effects: [] },
        },
      }),
    );
    expect(good.config.servers["gmail"]).toEqual({
      command: "node",
      args: ["s.js"],
      env: { A: "1" },
      cwd: "/tmp",
      timeoutMs: 100,
      effects: { send_email: ["send"], "*": ["network"] },
    });
    expect(good.config.servers["off"]!.disabled).toBe(true);
    expect(good.issues).toHaveLength(6);
    expect(parseMcpConfig("{").issues[0]).toContain("not valid JSON");
    expect(parseMcpConfig("{}").issues[0]).toContain('"mcpServers"');
    const missing = await loadMcpConfig(join(tmpDir(), "none.json"));
    expect(missing).toEqual({ config: { servers: {} }, issues: [] });
    await expect(loadMcpConfig(tmpDir())).rejects.toThrow();
  });

  it("maps annotations and overrides to effects", () => {
    const t = (annotations?: Record<string, boolean>) => ({ name: "x", inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) });
    expect(mcpToolEffects(t({ readOnlyHint: true, openWorldHint: false }))).toEqual(["read"]);
    expect(mcpToolEffects(t({ readOnlyHint: true }))).toEqual(["read", "network"]);
    expect(mcpToolEffects(t({ readOnlyHint: true, destructiveHint: true, openWorldHint: false }))).toEqual(["read"]);
    expect(mcpToolEffects(t({ destructiveHint: true, openWorldHint: false }))).toEqual(["write", "delete"]);
    // Security scan F1: an unannotated tool (send_email, delete_file) takes the spec defaults,
    // destructive and open-world, so it asks the person before it runs.
    expect(mcpToolEffects(t())).toEqual(["write", "network", "send", "delete"]);
    expect(requiresApproval(mcpToolEffects(t()))).toBe(true);
    // An honest send_email: not destructive, but open-world, so still a send.
    expect(mcpToolEffects(t({ destructiveHint: false, openWorldHint: true }))).toEqual(["write", "network", "send"]);
    // Only a tool that states it is neither destructive nor open-world runs without asking.
    expect(mcpToolEffects(t({ destructiveHint: false, openWorldHint: false }))).toEqual(["write"]);
    expect(requiresApproval(mcpToolEffects(t({ destructiveHint: false, openWorldHint: false })))).toBe(false);
    expect(mcpToolEffects(t({ readOnlyHint: true, openWorldHint: false }), { x: ["send"] })).toEqual(["send"]);
    expect(mcpToolEffects(t({ readOnlyHint: true }), { x: ["send"] })).toEqual(["network", "send"]);
    expect(mcpToolEffects(t({ destructiveHint: false, openWorldHint: false }), { "*": ["pay"] })).toEqual(["write", "pay"]);
    expect(mcpToolName("github", "create-issue")).toBe("mcp__github__create-issue");
    expect(mcpToolName("srv", "a.b c")).toBe("mcp__srv__a_b_c");
    const long = mcpToolName("server", "x".repeat(80));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
    expect(mcpToolName("server", "y".repeat(80))).not.toBe(long.replace(/x/g, "y"));
  });
});

describe("McpManager and the harness", () => {
  it("exposes MCP tools as mcp__<server>__<tool> with effects, and asks before send", async () => {
    const dir = tmpDir();
    const cfg = join(dir, "mcp.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          fake: { command: process.execPath, args: [SERVER], effects: { send_email: ["send"] } },
          broken: { command: process.execPath, args: [SERVER], env: { FAKE_MCP_MODE: "bad-init" } },
          off: { command: "nope", disabled: true },
        },
      }),
    );
    const lines: string[] = [];
    const mgr = await McpManager.fromFile(cfg, { logger: { debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error() {} } });
    onCleanup(() => void mgr.close());
    const status = await mgr.start();
    expect(status).toEqual([
      { id: "fake", connected: true, tools: 12 },
      { id: "broken", connected: false, tools: 0, error: "unsupported protocol" },
      { id: "off", connected: false, tools: 0 },
    ]);
    expect(mgr.client("fake")!.connected).toBe(true);
    const byName = new Map(mgr.tools().map((t) => [t.definition.name, t.definition]));
    // Spec defaults: no openWorldHint means open-world; no destructiveHint means destructive.
    expect(byName.get("mcp__fake__echo")).toMatchObject({ effects: ["read", "network"], source: "mcp", owner: "fake", description: "Echo text back" });
    expect(byName.get("mcp__fake__send_email")!.effects).toEqual(["write", "network", "send", "delete"]);
    expect(byName.get("mcp__fake__delete_file")!.effects).toEqual(["write", "network", "send", "delete"]);
    expect(byName.get("mcp__fake__web_search")!.effects).toEqual(["read", "network"]);
    expect(byName.get("mcp__fake__add")!.description).toBe("Add numbers");
    expect(byName.get("mcp__fake__bad")!.description).toBe("bad (from fake)");

    const { harness, provider } = setup(
      [
        {
          steps: [
            { tool: "mcp__fake__echo", input: { text: "hello" } },
            { tool: "mcp__fake__web_search", input: {} },
          ],
        },
        { steps: [{ tool: "mcp__fake__send_email", input: { to: "ada@example.com", subject: "Your invoice" } }] },
        { steps: [{ tool: "mcp__fake__fail_tool", input: {} }, { tool: "mcp__fake__rpc_error", input: {} }, { tool: "mcp__fake__echo", input: {} }] },
        { steps: [{ text: "all done" }] },
      ],
      { mcp: mgr },
    );
    const events = await collect(harness.run(task("use mcp"), approveAll));
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fake__send_email");
    const ends = ofType(events, "tool_end").map((e) => [e.result.name, e.result.isError, e.result.content]);
    expect(ends).toEqual([
      ["mcp__fake__echo", false, "hello"],
      ["mcp__fake__web_search", false, ""],
      ["mcp__fake__send_email", false, "sent to ada@example.com"],
      ["mcp__fake__fail_tool", true, "it failed"],
      ["mcp__fake__rpc_error", true, "server exploded"],
      ["mcp__fake__echo", true, "Invalid input for mcp__fake__echo: input.text is required"],
    ]);
    // The unannotated fail_tool and rpc_error take the spec defaults, so they ask too (scan F1).
    expect(ofType(events, "approval_request").map((a) => a.summary)).toEqual([
      "Send email to ada@example.com: 'Your invoice'",
      "Send with fail tool: {}",
      "Send with rpc error: {}",
    ]);
    expect(done(events).text).toBe("all done");

    // A server that went away gives a clear tool error.
    await mgr.client("fake")!.close();
    const echo = mgr.tools().find((t) => t.definition.name === "mcp__fake__echo")!;
    const out = await echo.run({ text: "x" }, {} as never);
    expect(out).toEqual({ content: 'MCP server "fake" is not running', isError: true });
    await mgr.close();
    expect(lines.some((l) => l.includes("mcp fake: 12 tools"))).toBe(true);
  });

  it("logs config problems and accepts a client factory", async () => {
    const dir = tmpDir();
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { x: {} } }));
    const warns: string[] = [];
    const mgr = await McpManager.fromFile(cfg, { logger: { debug() {}, info() {}, warn: (m) => warns.push(m), error() {} } });
    expect(warns[0]).toContain('server "x" needs a "command"');
    expect(await mgr.start()).toEqual([]);
    const custom = new McpManager({
      config: { servers: { f: server() } },
      createClient: (id, c) => new McpClient(id, c, { requestTimeoutMs: 2000 }),
    });
    onCleanup(() => void custom.close());
    expect((await custom.start())[0]!.connected).toBe(true);
    expect(McpError.name).toBe("McpError");
  });
});
