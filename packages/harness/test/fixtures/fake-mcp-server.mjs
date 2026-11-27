// A tiny MCP server over stdio for tests (JSON-RPC 2.0, newline-delimited).
// FAKE_MCP_MODE: "" | "bad-init" | "hang-init" | "bad-list" | "stubborn"
// FAKE_MCP_LOG: file that receives every message the client sent (one JSON per line).
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MCP_MODE ?? "";
const logFile = process.env.FAKE_MCP_LOG;

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const PAGE1 = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "add", title: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];
const PAGE2 = [
  { name: "send_email", description: "Send an email", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" } } } },
  { name: "delete_file", description: "Delete a file", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "web.search", description: "Search the web", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: "fail_tool", description: "Always fails", inputSchema: { type: "object" } },
  { name: "slow", description: "Waits", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "crash", description: "Exits", inputSchema: { type: "object" } },
  { name: "rpc_error", description: "Returns a JSON-RPC error", inputSchema: { type: "object" } },
  { name: "media", description: "Returns mixed content", inputSchema: { type: "object" } },
  { name: "structured", description: "Returns structured content only", inputSchema: { type: "object" } },
  { name: "bad" },
];

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (mode !== "stubborn") process.exit(0);
});

function handle(msg) {
  if (logFile) appendFileSync(logFile, JSON.stringify(msg) + "\n");
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to our ping
  if (method === "initialize") {
    if (mode === "hang-init") return;
    if (mode === "bad-init") return error(id, -32602, "unsupported protocol");
    return reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } });
  }
  if (method === "notifications/initialized") {
    process.stdout.write("this line is not json\n");
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
    send({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
    send({ jsonrpc: "2.0", id: "srv-2", method: "sampling/createMessage", params: {} });
    process.stderr.write("fake server ready\n");
    return;
  }
  if (method === "notifications/cancelled") return;
  if (method === "tools/list") {
    if (mode === "bad-list") return reply(id, {});
    if (!params?.cursor) return reply(id, { tools: PAGE1, nextCursor: "p2" });
    return reply(id, { tools: [...PAGE2, "not a tool"] });
  }
  if (method === "tools/call") {
    const a = params.arguments ?? {};
    switch (params.name) {
      case "echo":
        return reply(id, { content: [{ type: "text", text: a.text }] });
      case "add":
        return reply(id, { content: [{ type: "text", text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } });
      case "send_email":
        return reply(id, { content: [{ type: "text", text: `sent to ${a.to}` }] });
      case "fail_tool":
        return reply(id, { content: [{ type: "text", text: "it failed" }], isError: true });
      case "slow":
        return setTimeout(() => reply(id, { content: [{ type: "text", text: "slow done" }] }), a.ms ?? 1000);
      case "crash":
        return process.exit(3);
      case "rpc_error":
        return error(id, -32000, "server exploded");
      case "media":
        return reply(id, {
          content: [
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///a.txt", text: "resource text" } },
            { type: "resource", resource: { uri: "file:///b.bin", blob: "AA" } },
            { type: "resource_link", uri: "file:///c.txt" },
            { type: "mystery" },
          ],
        });
      case "structured":
        return reply(id, { content: [], structuredContent: { rows: 2 } });
      case "web.search":
        return reply(id, { content: [] });
      case "weird":
        return reply(id, "not an object");
      default:
        return error(id, -32602, `unknown tool ${params.name}`);
    }
  }
  if (method === "bogus/result") return reply(id, "not an object");
  return error(id, -32601, `method not found: ${method}`);
}
