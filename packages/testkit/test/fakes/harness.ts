// A small reference harness that satisfies the HarnessApi contract, plus bug switches
// to prove describeHarnessConformance catches each broken rule.

import {
  collect,
  requiresApproval,
  type ApprovalHandler,
  type ContentPart,
  type HarnessApi,
  type HarnessEvent,
  type Message,
  type ModelProvider,
  type SkillStore,
  type TaskRequest,
  type ToolSpec,
} from "@oneseat/contracts";
import type { ConformanceTool } from "../../src/conformance/harness.js";

export type HarnessBug =
  | "run-before-approval" // runs send/pay/delete tools, then asks
  | "bodies-in-index" // puts skill bodies in the first system prompt
  | "index-when-disabled" // sends the index even with disableSkills
  | "double-done" // emits done twice
  | "denial-not-error" // denied calls return a non-error tool result
  | "throws" // throws from run() on provider errors
  | "no-skill-loaded-event"; // never emits skill_loaded

export interface ReferenceHarnessOptions {
  provider: ModelProvider;
  store: SkillStore;
  tools?: ConformanceTool[];
  bugs?: HarnessBug[];
  /** Extra text appended to the system prompt (tests use it to check seeding). */
  systemExtra?: string;
}

const LOAD_SKILL: ToolSpec = {
  name: "load_skill",
  description: "Load a skill's full instructions by name.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};

let runCounter = 0;

export function createReferenceHarness(opts: ReferenceHarnessOptions): HarnessApi {
  const bugs = new Set(opts.bugs ?? []);
  const tools = opts.tools ?? [];
  return {
    async *run(task: TaskRequest, onApproval: ApprovalHandler): AsyncIterable<HarnessEvent> {
      const runId = `run_${++runCounter}`;
      yield { type: "session_start", sessionId: task.sessionId ?? `s_${runId}`, runId };
      const useSkills = !task.disableSkills || bugs.has("index-when-disabled");
      let system = "You are OneSeat, a helpful business assistant.";
      if (opts.systemExtra) system += `\n${opts.systemExtra}`;
      if (useSkills) {
        const index = await opts.store.index();
        if (index.length) system += `\n\nSkills (call load_skill to use one):\n${index.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
        if (bugs.has("bodies-in-index")) for (const s of await opts.store.list()) system += `\n${s.manifest.body}`;
      }
      if (task.skill) {
        const s = await opts.store.get(task.skill);
        if (s) {
          system += `\n\n# Skill: ${s.manifest.frontmatter.name}\n${s.manifest.body}`;
          if (!bugs.has("no-skill-loaded-event")) yield { type: "skill_loaded", name: s.manifest.frontmatter.name, reason: "forced" };
        }
      }
      const specs: ToolSpec[] = [...tools.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema })), ...(task.disableSkills ? [] : [LOAD_SKILL])];
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: task.input }] }];
      const usage = { inputTokens: 0, outputTokens: 0 };
      const maxTurns = task.maxTurns ?? 8;
      let text = "";
      for (let turn = 1; turn <= maxTurns; turn++) {
        const r = await collect(opts.provider.send({ model: task.model, system, messages, tools: specs, maxTokens: 1024 }));
        usage.inputTokens += r.usage.inputTokens;
        usage.outputTokens += r.usage.outputTokens;
        if (r.error) {
          if (bugs.has("throws")) throw new Error(r.error.message);
          yield { type: "error", message: `${r.error.kind}: ${r.error.message}`, retryable: r.error.retryable };
          yield { type: "done", stopReason: "error", text, usage };
          return;
        }
        text = r.message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        if (text) yield { type: "text_delta", text };
        messages.push(r.message);
        const results: ContentPart[] = [];
        for (const part of r.message.content) {
          if (part.type !== "tool_use") continue;
          const call = { id: part.id, name: part.name, input: part.input };
          if (part.name === "load_skill") {
            const name = String(part.input["name"] ?? "");
            const s = await opts.store.get(name);
            if (s && !bugs.has("no-skill-loaded-event")) yield { type: "skill_loaded", name, reason: "router" };
            results.push({ type: "tool_result", toolUseId: part.id, name: part.name, content: s ? s.manifest.body : `no skill ${name}`, isError: !s });
            continue;
          }
          const tool = tools.find((t) => t.definition.name === part.name);
          if (!tool) {
            results.push({ type: "tool_result", toolUseId: part.id, name: part.name, content: `unknown tool ${part.name}`, isError: true });
            continue;
          }
          const effects = tool.definition.effects;
          const started = Date.now();
          if (requiresApproval(effects)) {
            const approvalId = `ap_${part.id}`;
            let early: string | undefined;
            if (bugs.has("run-before-approval")) early = await tool.run(part.input);
            yield { type: "approval_request", approvalId, call, effects, summary: `${part.name} ${JSON.stringify(part.input)}` };
            const d = await onApproval({ approvalId, call, effects, summary: `${part.name} ${JSON.stringify(part.input)}` });
            yield { type: "approval_result", approvalId, approved: d.approved };
            if (!d.approved) {
              const result = { callId: part.id, name: part.name, content: `The person declined this action.${d.note ? ` Note: ${d.note}` : ""}`, isError: !bugs.has("denial-not-error") };
              yield { type: "tool_end", result, durationMs: Date.now() - started };
              results.push({ type: "tool_result", toolUseId: part.id, name: part.name, content: result.content, isError: result.isError });
              continue;
            }
            yield { type: "tool_start", call, effects };
            const content = early ?? (await tool.run(part.input));
            yield { type: "tool_end", result: { callId: part.id, name: part.name, content, isError: false }, durationMs: Date.now() - started };
            results.push({ type: "tool_result", toolUseId: part.id, name: part.name, content, isError: false });
            continue;
          }
          yield { type: "tool_start", call, effects };
          const content = await tool.run(part.input);
          yield { type: "tool_end", result: { callId: part.id, name: part.name, content, isError: false }, durationMs: Date.now() - started };
          results.push({ type: "tool_result", toolUseId: part.id, name: part.name, content, isError: false });
        }
        yield { type: "turn_end", turn, usage: r.usage };
        if (results.length === 0) {
          yield { type: "done", stopReason: r.stopReason, text, usage };
          if (bugs.has("double-done")) yield { type: "done", stopReason: r.stopReason, text, usage };
          return;
        }
        messages.push({ role: "user", content: results });
      }
      yield { type: "done", stopReason: "max_turns", text, usage };
    },
  };
}
