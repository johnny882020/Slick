// Human-readable summaries of tool actions, for approval prompts and the action log.

import type { ToolEffect } from "@oneseat/contracts";

const MAX_SUMMARY = 200;

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    const items = v.map(str).filter((x): x is string => x !== undefined);
    return items.length ? items.join(", ") : undefined;
  }
  return undefined;
}

function pick(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(input[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** "mcp__gmail__send_email" -> "send email" */
export function toolLabel(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/[_-]+/g, " ").trim() || name;
}

function compactInput(input: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = "{…}";
  }
  return clip(s, 120);
}

function money(input: Record<string, unknown>): string | undefined {
  const cents = input["amount_cents"] ?? input["amountCents"];
  const currency = pick(input, ["currency"]) ?? "";
  if (typeof cents === "number") return `${(cents / 100).toFixed(2)}${currency ? ` ${currency.toUpperCase()}` : ""}`;
  const amount = pick(input, ["amount", "total", "value"]);
  if (amount) return `${amount}${currency ? ` ${currency.toUpperCase()}` : ""}`;
  return undefined;
}

/** A one-line description of what a tool call will do, e.g. "Send email to ada@example.com: 'Your invoice'". */
export function summarizeAction(tool: string, input: Record<string, unknown>, effects: readonly ToolEffect[]): string {
  const label = toolLabel(tool);
  const to = pick(input, ["to", "recipient", "recipients", "email", "phone", "channel", "address", "payee"]);
  const subject = pick(input, ["subject", "title", "name"]);
  let s: string;
  if (effects.includes("pay")) {
    const amt = money(input);
    s = `Pay${amt ? ` ${amt}` : ""}${to ? ` to ${to}` : ""} (${label})`;
    if (!amt && !to) s = `Pay with ${label}: ${compactInput(input)}`;
  } else if (effects.includes("send")) {
    const isMail = /mail/i.test(tool) || (subject !== undefined && to !== undefined && /@/.test(to));
    if (to) s = `Send ${isMail ? "email" : label} to ${to}${subject ? `: '${clip(subject, 80)}'` : ""}`;
    else s = `Send with ${label}: ${compactInput(input)}`;
  } else if (effects.includes("delete")) {
    const target = pick(input, ["sql", "path", "id", "ids", "name", "target", "query"]);
    s = target ? `Delete with ${label}: ${clip(target, 140)}` : `Delete with ${label}: ${compactInput(input)}`;
  } else {
    s = `${label}: ${compactInput(input)}`;
  }
  return clip(s, MAX_SUMMARY);
}

/** Read-only for scheduling purposes: only reads (and network reads). */
export function isReadOnly(effects: readonly ToolEffect[]): boolean {
  return effects.length > 0 && effects.includes("read") && effects.every((e) => e === "read" || e === "network");
}
