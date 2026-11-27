// Run view state: a pure reducer over HarnessEvent.

import type { HarnessEvent, ToolCall, ToolEffect, Usage } from "@oneseat/contracts";
import { bundleFromToolContent, bundlesFromText, makeDraft, type ArtifactDraft } from "./artifacts";

export type RunStatus = "running" | "waiting" | "done" | "cancelled" | "error";

export interface TextItem {
  kind: "text";
  key: string;
  text: string;
}

export interface ToolItem {
  kind: "tool";
  key: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
  effects: ToolEffect[];
  status: "running" | "ok" | "error";
  result?: string;
  durationMs?: number;
}

export interface ApprovalItem {
  kind: "approval";
  key: string;
  approvalId: string;
  call: ToolCall;
  effects: ToolEffect[];
  summary: string;
  status: "pending" | "approved" | "denied";
}

export interface ErrorItem {
  kind: "error";
  key: string;
  message: string;
  retryable: boolean;
}

export type RunItem = TextItem | ToolItem | ApprovalItem | ErrorItem;

export interface RunState {
  runId: string;
  /** The task text, when this UI started the run. */
  input?: string;
  sessionId?: string;
  status: RunStatus;
  skills: { name: string; reason: "router" | "forced" }[];
  filesRead: { skill: string; file: string }[];
  items: RunItem[];
  /** Sum of turn_end usage, replaced by done.usage when present. */
  usage: Usage;
  turns: number;
  stopReason?: string;
  finalText?: string;
  error?: string;
  artifacts: ArtifactDraft[];
  /** Monotonic counter for item keys. */
  seq: number;
}

export function initialRun(runId: string, input?: string): RunState {
  return {
    runId,
    ...(input !== undefined ? { input } : {}),
    status: "running",
    skills: [],
    filesRead: [],
    items: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    turns: 0,
    artifacts: [],
    seq: 0,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  const cr = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cw = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  if (cr) out.cacheReadTokens = cr;
  if (cw) out.cacheWriteTokens = cw;
  return out;
}

type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function push(s: RunState, item: WithoutKey<RunItem>): RunState {
  const key = `${s.runId}:${s.seq}`;
  return { ...s, seq: s.seq + 1, items: [...s.items, { ...item, key } as RunItem] };
}

export function addDrafts(s: RunState, drafts: ArtifactDraft[]): RunState {
  const fresh = drafts.filter((d) => !s.artifacts.some((a) => a.key === d.key));
  return fresh.length ? { ...s, artifacts: [...s.artifacts, ...fresh] } : s;
}

export function isFinished(s: RunState): boolean {
  return s.status === "done" || s.status === "cancelled" || s.status === "error";
}

export function pendingApprovals(s: RunState): ApprovalItem[] {
  return s.items.filter((i): i is ApprovalItem => i.kind === "approval" && i.status === "pending");
}

export function reduceRun(s: RunState, ev: HarnessEvent): RunState {
  switch (ev.type) {
    case "session_start":
      return { ...s, sessionId: ev.sessionId };
    case "skill_loaded":
      if (s.skills.some((k) => k.name === ev.name)) return s;
      return { ...s, skills: [...s.skills, { name: ev.name, reason: ev.reason }] };
    case "skill_file_read":
      return { ...s, filesRead: [...s.filesRead, { skill: ev.skill, file: ev.file }] };
    case "text_delta": {
      if (!ev.text) return s;
      const last = s.items[s.items.length - 1];
      if (last && last.kind === "text") {
        const items = s.items.slice(0, -1);
        items.push({ ...last, text: last.text + ev.text });
        return { ...s, items };
      }
      return push(s, { kind: "text", text: ev.text });
    }
    case "tool_start":
      return push(s, {
        kind: "tool",
        callId: ev.call.id,
        name: ev.call.name,
        input: ev.call.input,
        effects: ev.effects,
        status: "running",
      });
    case "tool_end": {
      const idx = findLastIndex(s.items, (i) => i.kind === "tool" && i.callId === ev.result.callId && i.status === "running");
      let next: RunState;
      if (idx === -1) {
        // An end without a start (should not happen); show it anyway.
        next = push(s, {
          kind: "tool",
          callId: ev.result.callId,
          name: ev.result.name,
          input: {},
          effects: [],
          status: ev.result.isError ? "error" : "ok",
          result: ev.result.content,
          durationMs: ev.durationMs,
        });
      } else {
        const items = [...s.items];
        const item = items[idx] as ToolItem;
        items[idx] = { ...item, status: ev.result.isError ? "error" : "ok", result: ev.result.content, durationMs: ev.durationMs };
        next = { ...s, items };
      }
      if (!ev.result.isError) {
        const bundle = bundleFromToolContent(ev.result.content);
        if (bundle) next = addDrafts(next, [makeDraft(s.runId, bundle)]);
      }
      return next;
    }
    case "approval_request": {
      if (s.items.some((i) => i.kind === "approval" && i.approvalId === ev.approvalId)) return s;
      const next = push(s, {
        kind: "approval",
        approvalId: ev.approvalId,
        call: ev.call,
        effects: ev.effects,
        summary: ev.summary,
        status: "pending",
      });
      return { ...next, status: isFinished(s) ? s.status : "waiting" };
    }
    case "approval_result": {
      const items = s.items.map((i) =>
        i.kind === "approval" && i.approvalId === ev.approvalId ? { ...i, status: ev.approved ? ("approved" as const) : ("denied" as const) } : i,
      );
      const next = { ...s, items };
      const waiting = pendingApprovals(next).length > 0;
      return { ...next, status: isFinished(s) ? s.status : waiting ? "waiting" : "running" };
    }
    case "turn_end":
      return { ...s, turns: Math.max(s.turns, ev.turn), usage: addUsage(s.usage, ev.usage) };
    case "done": {
      const hasUsage = ev.usage.inputTokens > 0 || ev.usage.outputTokens > 0;
      // Pending approvals can no longer be answered.
      const items = s.items.map((i) => (i.kind === "approval" && i.status === "pending" ? { ...i, status: "denied" as const } : i));
      const next: RunState = {
        ...s,
        items,
        status: ev.stopReason === "cancelled" ? "cancelled" : "done",
        stopReason: ev.stopReason,
        finalText: ev.text,
        usage: hasUsage ? ev.usage : s.usage,
      };
      return addDrafts(next, bundlesFromText(ev.text).map((b) => makeDraft(s.runId, b)));
    }
    case "error":
      return { ...push(s, { kind: "error", message: ev.message, retryable: ev.retryable }), status: "error", error: ev.message };
    default:
      return s;
  }
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

/** The visible text of a run: all text items joined. */
export function runText(s: RunState): string {
  return s.items
    .filter((i): i is TextItem => i.kind === "text")
    .map((i) => i.text)
    .join("");
}

/** The draft id in a make_artifact result ({ draftId, ... }), if any. */
export function draftIdFromToolResult(name: string, content: string, isError: boolean): string | null {
  if (isError || name !== "make_artifact") return null;
  try {
    const v = JSON.parse(content) as { draftId?: unknown };
    return typeof v.draftId === "string" && v.draftId ? v.draftId : null;
  } catch {
    return null;
  }
}
