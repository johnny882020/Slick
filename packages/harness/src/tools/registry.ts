// The tool registry: ToolDefinitions with effects, plus how to run each one.

import {
  validateToolSpec,
  type HarnessEvent,
  type TaskRequest,
  type ToolDefinition,
  type ToolEffect,
} from "@oneseat/contracts";
import type { SkillSession } from "../router.js";

export interface ToolContext {
  runId: string;
  sessionId: string;
  task: TaskRequest;
  signal: AbortSignal;
  skills: SkillSession;
  emit(event: HarnessEvent): void;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Effects for this particular input (e.g. db_execute adds "delete" for DELETE). Defaults to definition.effects. */
  effectsFor?(input: Record<string, unknown>, ctx: ToolContext): ToolEffect[] | Promise<ToolEffect[]>;
  /** One-line, human-readable description of the action, shown in approvals and the action log. */
  summarize?(input: Record<string, unknown>, ctx: ToolContext): string | Promise<string>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export function ok(value: unknown): ToolOutput {
  return { content: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

export function fail(message: string): ToolOutput {
  return { content: message, isError: true };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool, opts: { replace?: boolean } = {}): void {
    const issues = validateToolSpec(tool.definition);
    if (issues.length > 0)
      throw new Error(`invalid tool "${tool.definition.name}": ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    if (this.tools.has(tool.definition.name) && !opts.replace)
      throw new Error(`tool "${tool.definition.name}" is already registered`);
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Remove every tool owned by an MCP server or skill. */
  unregisterOwner(owner: string): number {
    let n = 0;
    for (const [name, t] of this.tools)
      if (t.definition.owner === owner) {
        this.tools.delete(name);
        n++;
      }
    return n;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
