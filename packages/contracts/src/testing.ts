// A deterministic ModelProvider for tests. Each call to send() plays the next
// scripted turn. A turn is a list of steps: text, tool calls, then a stop.
// It records every request so tests can assert what the harness sent.

import type { ChatEvent, ChatRequest, ModelInfo, ModelProvider, ProviderId, StopReason, Usage } from "./model.js";
import { estimateTokens } from "./model.js";

export type ScriptStep =
  | { text: string }
  | { reasoning: string }
  | { tool: string; input: Record<string, unknown>; id?: string }
  | { error: { kind: "rate_limit" | "server" | "auth" | "network"; message?: string } };

export interface ScriptedTurn {
  steps: ScriptStep[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
}

/** A turn can also be computed from the request (to react to tool results). */
export type ScriptEntry = ScriptedTurn | ((req: ChatRequest, index: number) => ScriptedTurn);

export interface ScriptedProvider extends ModelProvider {
  readonly requests: ChatRequest[];
  /** Turns left to play. */
  remaining(): number;
}

export function createScriptedProvider(
  script: ScriptEntry[],
  opts: { id?: ProviderId; models?: ModelInfo[]; chunk?: number } = {},
): ScriptedProvider {
  const requests: ChatRequest[] = [];
  let i = 0;
  const chunk = opts.chunk ?? 8;
  const id = opts.id ?? "local";
  return {
    id,
    requests,
    remaining: () => script.length - i,
    async models() {
      return opts.models ?? [{ id: "scripted-1", provider: id, label: "Scripted", supportsTools: true, tier: "fast" }];
    },
    async countTokens(req) {
      return estimateTokens(req);
    },
    async *send(req: ChatRequest): AsyncIterable<ChatEvent> {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const entry = script[i];
      const index = i++;
      if (!entry) {
        yield { type: "error", error: { kind: "invalid_request", message: "script exhausted", retryable: false } };
        return;
      }
      const turn = typeof entry === "function" ? entry(req, index) : entry;
      yield { type: "message_start", model: req.model };
      let sawTool = false;
      let n = 0;
      for (const step of turn.steps) {
        if (req.signal?.aborted) {
          yield { type: "error", error: { kind: "aborted", message: "aborted", retryable: false } };
          return;
        }
        if ("text" in step) {
          for (let k = 0; k < step.text.length; k += chunk) yield { type: "text_delta", text: step.text.slice(k, k + chunk) };
        } else if ("reasoning" in step) {
          yield { type: "reasoning_delta", text: step.reasoning };
          yield { type: "reasoning_done", part: { type: "reasoning", text: step.reasoning } };
        } else if ("tool" in step) {
          sawTool = true;
          yield { type: "tool_call", call: { id: step.id ?? `call_${index}_${n++}`, name: step.tool, input: step.input } };
        } else {
          yield {
            type: "error",
            error: {
              kind: step.error.kind,
              message: step.error.message ?? step.error.kind,
              retryable: step.error.kind === "rate_limit" || step.error.kind === "server" || step.error.kind === "network",
            },
          };
          return;
        }
      }
      const usage: Usage = {
        inputTokens: turn.usage?.inputTokens ?? estimateTokens(req),
        outputTokens: turn.usage?.outputTokens ?? 10,
      };
      yield { type: "message_end", stopReason: turn.stopReason ?? (sawTool ? "tool_use" : "end_turn"), usage };
    },
  };
}
