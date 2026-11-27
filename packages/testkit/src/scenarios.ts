// Shared scenarios. Gate 2: one scenario, run on every provider, same tool call out.

import type { ChatRequest, Message, StopReason, ToolSpec } from "@oneseat/contracts";
import type { NormalisedToolCall } from "./stream.js";

export interface ToolCallScenario {
  name: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  toolChoice?: ChatRequest["toolChoice"];
  maxTokens: number;
  temperature?: number;
  expected: {
    toolCalls: NormalisedToolCall[];
    stopReason: StopReason;
  };
}

export const GET_WEATHER_TOOL: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", description: "City name, e.g. Paris" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** The default gate 2 scenario. */
export const WEATHER_SCENARIO: ToolCallScenario = {
  name: "weather",
  system: "You are a weather bot",
  messages: [{ role: "user", content: [{ type: "text", text: "What's the weather in Paris?" }] }],
  tools: [GET_WEATHER_TOOL],
  maxTokens: 1024,
  temperature: 0,
  expected: { toolCalls: [{ name: "get_weather", input: { city: "Paris" } }], stopReason: "tool_use" },
};

/** Build the ChatRequest for a scenario. */
export function scenarioRequest(scenario: ToolCallScenario, model: string, signal?: AbortSignal): ChatRequest {
  return {
    model,
    system: scenario.system,
    messages: structuredClone(scenario.messages),
    tools: structuredClone(scenario.tools),
    maxTokens: scenario.maxTokens,
    ...(scenario.toolChoice !== undefined ? { toolChoice: scenario.toolChoice } : {}),
    ...(scenario.temperature !== undefined ? { temperature: scenario.temperature } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** A plain text request (no tools) used by the provider conformance suite. */
export function textRequest(model: string, signal?: AbortSignal): ChatRequest {
  return {
    model,
    system: "You are terse.",
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
    tools: [],
    maxTokens: 256,
    ...(signal ? { signal } : {}),
  };
}
