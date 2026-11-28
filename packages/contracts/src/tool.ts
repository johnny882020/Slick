// Contract 3 — ToolCall.
// MCP tool schema. The gateway translates it for each provider.
// FROZEN at end of week 2.

/** JSON Schema object, as used by MCP `inputSchema`. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
};

/** MCP Tool shape (name, description, inputSchema). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider data that must round-trip (see ToolUsePart.providerMeta). */
  providerMeta?: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  /** Text content. Structured results are JSON-encoded. */
  content: string;
  isError: boolean;
}

/**
 * What a tool can do to the world. The harness asks a person before
 * any tool with "send", "pay" or "delete" runs.
 */
export type ToolEffect = "read" | "write" | "network" | "send" | "pay" | "delete";

export const APPROVAL_EFFECTS: readonly ToolEffect[] = ["send", "pay", "delete"];

export type ToolSource = "builtin" | "mcp" | "skill";

export interface ToolDefinition extends ToolSpec {
  effects: ToolEffect[];
  source: ToolSource;
  /** MCP server id or skill name that owns the tool. */
  owner?: string;
}

export function requiresApproval(effects: readonly ToolEffect[]): boolean {
  return effects.some((e) => APPROVAL_EFFECTS.includes(e));
}

/**
 * Tool names must be valid on every provider. This is the intersection:
 * Anthropic ^[a-zA-Z0-9_-]{1,64}$, OpenAI ^[a-zA-Z0-9_-]{1,64}$,
 * Gemini must start with a letter or underscore.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/** Make any string a valid tool name (MCP tools like "github.create-issue"). */
export function toToolName(raw: string): string {
  let s = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = `_${s}`;
  return s.slice(0, 64);
}

export interface ToolSpecIssue {
  path: string;
  message: string;
}

/** Validate a ToolSpec against the cross-provider rules. */
export function validateToolSpec(spec: ToolSpec): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  if (!isValidToolName(spec.name)) issues.push({ path: "name", message: `invalid tool name "${spec.name}"` });
  if (!spec.description || spec.description.trim().length === 0)
    issues.push({ path: "description", message: "description is required" });
  if (spec.description && spec.description.length > 1024)
    issues.push({ path: "description", message: "description over 1024 characters" });
  const s = spec.inputSchema;
  if (!s || typeof s !== "object") issues.push({ path: "inputSchema", message: "inputSchema must be an object" });
  else if (s.type !== "object") issues.push({ path: "inputSchema.type", message: 'inputSchema.type must be "object"' });
  return issues;
}
