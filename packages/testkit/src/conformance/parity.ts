// Gate 2: the same tool-call result on all 3 providers.

import { describe, expect, it } from "vitest";
import type { ModelProvider, StopReason } from "@oneseat/contracts";
import { scenarioRequest, WEATHER_SCENARIO, type ToolCallScenario } from "../scenarios.js";
import { deepEqual, drainStream, normaliseToolCalls, terminalEvent, validateChatStream, type NormalisedToolCall } from "../stream.js";

export interface ParityProvider {
  name: string;
  provider: ModelProvider;
  /** Model to use. Default: the first model from provider.models(). */
  model?: string;
}

export interface ParityProviderResult {
  name: string;
  model: string;
  toolCalls: NormalisedToolCall[];
  stopReason: StopReason | "none";
  /** Contract or scenario problems for this provider. */
  problems: string[];
}

export interface ParityResult {
  scenario: string;
  results: ParityProviderResult[];
  /** Cross-provider disagreements. */
  disagreements: string[];
}

/** Run one scenario on every provider and compare normalised tool calls and stop reasons. */
export async function runToolCallParity(
  providers: readonly ParityProvider[],
  scenario: ToolCallScenario = WEATHER_SCENARIO,
  opts: { timeoutMs?: number } = {},
): Promise<ParityResult> {
  const results: ParityProviderResult[] = [];
  for (const p of providers) {
    const problems: string[] = [];
    let model = p.model ?? "";
    if (!model) {
      try {
        model = (await p.provider.models())[0]?.id ?? "";
      } catch (e) {
        problems.push(`models() rejected: ${(e as Error).message}`);
      }
      if (!model) problems.push("no model given and models() returned none");
    }
    const d = await drainStream(p.provider, scenarioRequest(scenario, model), { timeoutMs: opts.timeoutMs ?? 30_000 });
    if (d.thrown !== undefined) problems.push(`send() threw: ${(d.thrown as Error)?.message ?? String(d.thrown)}`);
    if (d.timedOut) problems.push("stream timed out");
    for (const i of validateChatStream(d.events, { toolNames: scenario.tools.map((t) => t.name) })) problems.push(`[${i.rule}] ${i.message}`);
    const t = terminalEvent(d.events);
    if (t?.type === "error") problems.push(`provider error (${t.error.kind}): ${t.error.message}`);
    const toolCalls = normaliseToolCalls(d.events);
    const stopReason: StopReason | "none" = t?.type === "message_end" ? t.stopReason : t?.type === "error" ? "error" : "none";
    if (!deepEqual(toolCalls, scenario.expected.toolCalls))
      problems.push(`tool calls ${JSON.stringify(toolCalls)} differ from expected ${JSON.stringify(scenario.expected.toolCalls)}`);
    if (stopReason !== scenario.expected.stopReason) problems.push(`stopReason "${stopReason}" differs from expected "${scenario.expected.stopReason}"`);
    results.push({ name: p.name, model, toolCalls, stopReason, problems });
  }
  const disagreements: string[] = [];
  const ref = results[0];
  if (ref)
    for (const r of results.slice(1)) {
      if (!deepEqual(r.toolCalls, ref.toolCalls))
        disagreements.push(`${r.name} tool calls ${JSON.stringify(r.toolCalls)} != ${ref.name} ${JSON.stringify(ref.toolCalls)}`);
      if (r.stopReason !== ref.stopReason) disagreements.push(`${r.name} stopReason "${r.stopReason}" != ${ref.name} "${ref.stopReason}"`);
    }
  return { scenario: scenario.name, results, disagreements };
}

/** The describe() title. The gates runner parses provider names from it. */
export function parityTitle(providers: readonly { name: string }[], scenario: ToolCallScenario): string {
  return `conformance: cross-provider tool-call parity (${providers.map((p) => p.name).join(", ")}): ${scenario.name}`;
}

/**
 * Register gate 2 (vitest): the scenario runs once on every provider; each must produce the
 * expected tool calls and stop reason, and all must agree.
 */
export function describeCrossProviderToolCallParity(
  providers: readonly ParityProvider[],
  scenario: ToolCallScenario = WEATHER_SCENARIO,
  opts: { minProviders?: number; timeoutMs?: number } = {},
): void {
  const minProviders = opts.minProviders ?? 3;
  describe(parityTitle(providers, scenario), () => {
    let pending: Promise<ParityResult> | undefined;
    const result = () => (pending ??= runToolCallParity(providers, scenario, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}));
    it(`covers at least ${minProviders} providers`, () => {
      expect(providers.length).toBeGreaterThanOrEqual(minProviders);
      expect(new Set(providers.map((p) => p.name)).size).toBe(providers.length);
    });
    for (const p of providers) {
      it(`${p.name}: ${scenario.expected.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ") || "no tool calls"}, stop ${scenario.expected.stopReason}`, async () => {
        const r = (await result()).results.find((x) => x.name === p.name)!;
        expect(r.problems).toEqual([]);
      });
    }
    it("all providers agree on tool calls and stop reason", async () => {
      expect((await result()).disagreements).toEqual([]);
    });
  });
}
