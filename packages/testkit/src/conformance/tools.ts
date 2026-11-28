// ToolCall conformance (contract 3): names valid on every provider, object schemas,
// and an approval effect on every tool that sends, pays or deletes.

import { describe, expect, it } from "vitest";
import { isValidToolName, requiresApproval, validateToolSpec, type JsonSchema, type ToolDefinition, type ToolEffect } from "@oneseat/contracts";

export const TOOL_EFFECTS: readonly ToolEffect[] = ["read", "write", "network", "send", "pay", "delete"];
const SOURCES = ["builtin", "mcp", "skill"];

/** Name words that mean an outward effect. A tool whose name has one must declare the effect. */
export const EFFECT_WORDS: Record<"send" | "pay" | "delete", readonly string[]> = {
  send: ["send", "email", "mail", "sms", "publish", "post", "reply", "forward", "notify", "broadcast", "tweet", "dm", "submit", "share", "invite"],
  pay: ["pay", "payment", "charge", "refund", "transfer", "payout", "purchase", "buy", "checkout", "withdraw", "wire"],
  delete: ["delete", "remove", "destroy", "purge", "drop", "erase", "wipe", "unlink", "rm", "trash", "truncate"],
};

/** Verb-like prefixes that make a name read-only even if it contains an effect word ("list_messages", "get_payment"). */
const READ_PREFIXES = new Set(["get", "list", "read", "search", "find", "fetch", "query", "count", "lookup", "show", "view", "describe", "preview", "draft", "check"]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Effects a tool name implies. "send_invoice" -> [send]; "list_messages" -> []. */
export function impliedEffects(name: string): ("send" | "pay" | "delete")[] {
  const w = words(name);
  if (w.length > 0 && READ_PREFIXES.has(w[0]!)) return [];
  const out: ("send" | "pay" | "delete")[] = [];
  for (const effect of ["send", "pay", "delete"] as const) if (w.some((x) => EFFECT_WORDS[effect].includes(x))) out.push(effect);
  return out;
}

function schemaProblems(s: JsonSchema, path: string, out: string[], depth = 0): void {
  if (depth > 32) {
    out.push(`${path}: schema nests too deeply`);
    return;
  }
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    out.push(`${path}: schema must be an object`);
    return;
  }
  if ("$ref" in s) out.push(`${path}: $ref is not portable across providers; inline the schema`);
  if ("$defs" in s || "definitions" in s) out.push(`${path}: $defs/definitions are not portable across providers`);
  const t = s.type;
  if (t === "object" || (Array.isArray(t) && t.includes("object"))) {
    if (s.properties !== undefined && (typeof s.properties !== "object" || Array.isArray(s.properties))) out.push(`${path}.properties must be an object`);
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string")) out.push(`${path}.required must be a list of strings`);
      else for (const r of s.required) if (!s.properties || !(r in s.properties)) out.push(`${path}.required names "${r}", which is not in properties`);
    }
    for (const [k, v] of Object.entries(s.properties ?? {})) schemaProblems(v, `${path}.properties.${k}`, out, depth + 1);
  }
  if (t === "array" || (Array.isArray(t) && t.includes("array"))) {
    if (s.items === undefined) out.push(`${path}: array schema needs items (Gemini and OpenAI strict mode require it)`);
    else if (Array.isArray(s.items)) s.items.forEach((it, i) => schemaProblems(it, `${path}.items[${i}]`, out, depth + 1));
    else schemaProblems(s.items, `${path}.items`, out, depth + 1);
  }
  if (t === undefined && s.enum === undefined && !("anyOf" in s) && !("oneOf" in s) && !("allOf" in s) && !("const" in s) && depth > 0)
    out.push(`${path}: property has no type`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) out.push(`${path}.enum must be a non-empty list`);
}

/** Problems for one tool definition. */
export function checkToolDefinition(tool: ToolDefinition): string[] {
  const p: string[] = [];
  for (const i of validateToolSpec(tool)) p.push(`${i.path}: ${i.message}`);
  if (tool.inputSchema && typeof tool.inputSchema === "object") schemaProblems(tool.inputSchema, "inputSchema", p);
  if (!Array.isArray(tool.effects)) p.push("effects must be a list");
  else {
    if (tool.effects.length === 0) p.push('effects must not be empty (use ["read"] for read-only tools)');
    for (const e of tool.effects) if (!TOOL_EFFECTS.includes(e)) p.push(`unknown effect "${String(e)}"`);
    for (const e of impliedEffects(tool.name))
      if (!tool.effects.includes(e)) p.push(`"${tool.name}" looks like it can ${e}; declare the "${e}" effect so a person approves it`);
    if (tool.effects.some((e) => e === "send" || e === "pay" || e === "delete") && !requiresApproval(tool.effects)) p.push("send/pay/delete tools must require approval");
  }
  if (!SOURCES.includes(tool.source)) p.push(`source "${String(tool.source)}" must be one of ${SOURCES.join(", ")}`);
  return p;
}

/** Problems across a tool list: each tool's problems plus duplicate names. */
export function checkToolDefinitions(tools: readonly ToolDefinition[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Map<string, number>();
  for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  tools.forEach((t, i) => {
    const key = isValidToolName(t.name) ? t.name : `#${i} ${JSON.stringify(t.name)}`;
    const p = checkToolDefinition(t);
    if ((seen.get(t.name) ?? 0) > 1) p.push(`tool name "${t.name}" is used ${seen.get(t.name)} times`);
    out[key] = [...(out[key] ?? []), ...p];
  });
  return out;
}

/** Register ToolCall conformance for a tool list (vitest). */
export function describeToolCallConformance(tools: readonly ToolDefinition[], name = "tools"): void {
  describe(`conformance: ToolCall ${name}`, () => {
    const results = checkToolDefinitions(tools);
    it("has at least one tool", () => expect(tools.length).toBeGreaterThan(0));
    for (const [tool, problems] of Object.entries(results)) it(tool, () => expect(problems).toEqual([]));
  });
}
