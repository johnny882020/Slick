// Context management. When the estimated request is over budget:
//   1. truncate old tool results (keep the head, note the cut), oldest first;
//   2. drop whole earlier turns (a turn starts at a user message with no tool results);
//   3. truncate every remaining tool result except the latest ones;
//   4. drop the oldest tool steps of the current turn.
// The stored history is never changed: this shapes one request.

import { estimateTokens, type ContentPart, type Message, type ToolSpec, type ToolUsePart } from "@oneseat/contracts";

export interface FitOptions {
  budgetTokens: number;
  /** Characters kept from a truncated tool result. */
  keepHeadChars?: number;
  /** Tool results that are truncated only as a last resort (skill instructions). */
  protectedTools?: string[];
}

export interface FitResult {
  messages: Message[];
  truncatedResults: number;
  droppedMessages: number;
  /** load_skill inputs whose results are no longer in the context. */
  droppedSkillLoads: string[];
  estimatedTokens: number;
}

const NOTE_SHORTENED = "[Earlier parts of this conversation were removed to fit the context window.]";

function isFreshUser(m: Message): boolean {
  return m.role === "user" && !m.content.some((p) => p.type === "tool_result");
}

function truncatePart(p: ContentPart, keep: number): ContentPart | undefined {
  if (p.type !== "tool_result" || p.content.length <= keep + 200) return undefined;
  return {
    ...p,
    content: `${p.content.slice(0, keep)}\n[tool result truncated to fit the context: ${p.content.length} characters originally; run the tool again if you need the rest]`,
  };
}

function skillLoadsIn(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages)
    for (const p of m.content)
      if (p.type === "tool_use" && p.name === "load_skill" && typeof (p as ToolUsePart).input["name"] === "string")
        out.push((p as ToolUsePart).input["name"] as string);
  return out;
}

export function fitContext(req: { system: string; messages: Message[]; tools: ToolSpec[] }, opts: FitOptions): FitResult {
  const keep = opts.keepHeadChars ?? 600;
  const protectedTools = new Set(opts.protectedTools ?? ["load_skill"]);
  const est = (messages: Message[]) => estimateTokens({ system: req.system, messages, tools: req.tools });
  let messages = req.messages;
  let tokens = est(messages);
  const result = (extra: Partial<FitResult> = {}): FitResult => ({
    messages,
    truncatedResults: 0,
    droppedMessages: 0,
    droppedSkillLoads: [],
    estimatedTokens: tokens,
    ...extra,
  });
  if (tokens <= opts.budgetTokens) return result();

  messages = messages.map((m) => ({ ...m, content: [...m.content] }));
  let truncatedResults = 0;
  let droppedMessages = 0;
  const dropped: Message[] = [];

  const truncatePass = (includeProtected: boolean) => {
    for (let i = 0; i < messages.length - 1 && tokens > opts.budgetTokens; i++) {
      const m = messages[i]!;
      for (let j = 0; j < m.content.length && tokens > opts.budgetTokens; j++) {
        const p = m.content[j]!;
        if (p.type !== "tool_result" || (!includeProtected && protectedTools.has(p.name))) continue;
        const t = truncatePart(p, keep);
        if (!t) continue;
        m.content[j] = t;
        truncatedResults++;
        tokens = est(messages);
      }
    }
  };

  // 1. Old tool results.
  truncatePass(false);

  // 2. Whole earlier turns.
  while (tokens > opts.budgetTokens) {
    const next = messages.findIndex((m, i) => i > 0 && isFreshUser(m));
    if (next <= 0) break;
    const removed = messages.splice(0, next);
    dropped.push(...removed);
    droppedMessages += removed.length;
    tokens = est(messages);
  }

  // 3. Every remaining old tool result, skill instructions included.
  if (tokens > opts.budgetTokens) truncatePass(true);

  // 4. Oldest tool steps of the current turn (assistant tool_use + user tool_result pairs).
  while (tokens > opts.budgetTokens && messages.length > 3) {
    const a = messages[1]!;
    const u = messages[2]!;
    if (a.role !== "assistant" || u.role !== "user" || !u.content.some((p) => p.type === "tool_result")) break;
    dropped.push(...messages.splice(1, 2));
    droppedMessages += 2;
    tokens = est(messages);
  }

  if (droppedMessages > 0 && messages[0]) {
    const first = messages[0];
    if (first.role === "user") messages[0] = { ...first, content: [{ type: "text", text: NOTE_SHORTENED }, ...first.content] };
    else messages.unshift({ role: "user", content: [{ type: "text", text: NOTE_SHORTENED }] });
    tokens = est(messages);
  }
  const kept = new Set(skillLoadsIn(messages));
  const droppedSkillLoads = [...new Set(skillLoadsIn(dropped))].filter((n) => !kept.has(n));
  return result({ truncatedResults, droppedMessages, droppedSkillLoads });
}
