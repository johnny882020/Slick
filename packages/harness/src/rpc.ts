// JSON-RPC 2.0 over newline-delimited streams.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { RPC_ERRORS } from "@oneseat/contracts";
import { errorMessage, isRecord } from "./util.js";

export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcHandler {
  /** Handle a request; the result is sent back. Throw RpcError for protocol errors. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Format an unexpected error message (redaction). */
  formatError?(e: unknown): string;
}

export interface LineConnection {
  /** Send a notification or any JSON-RPC message. */
  send(message: unknown): void;
  close(): void;
  /** Resolves when the input ends. */
  readonly closed: Promise<void>;
}

/** Max accepted line (an app bundle can be up to 5 MB of HTML, JSON-escaped). */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

export function serveLines(input: Readable, output: Writable, handler: RpcHandler): LineConnection {
  let open = true;
  const send = (message: unknown) => {
    if (!open) return;
    try {
      output.write(JSON.stringify(message) + "\n");
    } catch {
      open = false;
    }
  };
  const fmt = (e: unknown) => (handler.formatError ? handler.formatError(e) : errorMessage(e));
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const closed = new Promise<void>((resolve) => rl.on("close", () => resolve()));
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE_CHARS) {
      send({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.invalidRequest, message: "message too large" } });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.parse, message: "parse error" } });
      return;
    }
    if (!isRecord(msg) || msg["jsonrpc"] !== "2.0" || typeof msg["method"] !== "string") {
      const id = isRecord(msg) && (typeof msg["id"] === "number" || typeof msg["id"] === "string") ? msg["id"] : null;
      send({ jsonrpc: "2.0", id, error: { code: RPC_ERRORS.invalidRequest, message: "invalid request" } });
      return;
    }
    const id = msg["id"];
    const isNotification = id === undefined;
    if (!isNotification && typeof id !== "number" && typeof id !== "string") {
      send({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.invalidRequest, message: "id must be a number or string" } });
      return;
    }
    const params = msg["params"] ?? {};
    handler.request(msg["method"], params).then(
      (result) => {
        if (!isNotification) send({ jsonrpc: "2.0", id, result: result ?? null });
      },
      (e: unknown) => {
        if (isNotification) return;
        if (e instanceof RpcError)
          send({ jsonrpc: "2.0", id, error: { code: e.code, message: fmt(e), ...(e.data !== undefined ? { data: e.data } : {}) } });
        else send({ jsonrpc: "2.0", id, error: { code: RPC_ERRORS.internal, message: fmt(e) } });
      },
    );
  });
  return {
    send,
    close() {
      open = false;
      rl.close();
    },
    closed,
  };
}
