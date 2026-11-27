// Gate 2 — contract conformance: the same tool-call result on every provider.
//
// Scenario: system "You are a weather bot", user "What's the weather in Paris?",
// tool get_weather {city: string}.
//   Turn 1: every provider yields the same normalised tool_call and stopReason "tool_use".
//   Turn 2: the tool result goes back; every provider streams "It is 18°C in Paris."
//           with end_turn. The wire bodies each adapter builds for turn 2 are snapshotted.
//
// Replays hand-written fixtures by default. With ONESEAT_RECORD=1 and a real key
// in the environment, the same test re-records fixtures from the live API.

import { describe, expect, it } from "vitest";
import { collect, type ChatEvent, type ToolCall } from "@oneseat/contracts";
import { fixtureFetch } from "../src/index.js";
import { all, assertStreamShape, PROVIDER_CASES, weatherTurn1, weatherTurn2, type ProviderCase } from "./helpers.js";

function recording(c: ProviderCase): string | undefined {
  if (process.env["ONESEAT_RECORD"] !== "1" || !c.envKey) return undefined;
  return process.env[c.envKey] || undefined;
}

interface Turn1Result {
  events: ChatEvent[];
  call: ToolCall;
  stopReason: string;
}

const turn1Results = new Map<string, Turn1Result>();

describe("gate 2: weather tool call conformance", () => {
  for (const c of PROVIDER_CASES) {
    describe(c.id, () => {
      const liveKey = recording(c);
      const model = liveKey && process.env[`ONESEAT_RECORD_${c.id.toUpperCase()}_MODEL`] ? (process.env[`ONESEAT_RECORD_${c.id.toUpperCase()}_MODEL`] as string) : c.model;

      it("turn 1 yields one get_weather tool call with stopReason tool_use", async () => {
        const f = fixtureFetch(c.dir, { record: Boolean(liveKey), ...(liveKey ? { secrets: [liveKey] } : {}) }).queue("weather_tool_call");
        const p = c.make(f, liveKey);
        const events = await all(p.send(weatherTurn1(model)));
        assertStreamShape(events);
        expect(events[0]).toEqual({ type: "message_start", model: expect.any(String) });
        const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
        expect(calls).toHaveLength(1);
        const call = calls[0] as ToolCall;
        const res = await collect((async function* () { yield* events; })());
        turn1Results.set(c.id, { events, call, stopReason: res.stopReason });
        expect({ name: call.name, input: call.input }).toEqual({ name: "get_weather", input: { city: "Paris" } });
        expect(call.id).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(res.stopReason).toBe("tool_use");

        // The turn-1 wire request carries the scenario, keys redacted.
        const sent = f.requests[0];
        expect(sent?.method).toBe("POST");
        expect(JSON.stringify(sent?.headers)).not.toContain(liveKey ?? "sk-test-SECRET");
      });

      it("turn 2 sends the tool result back and streams the final answer", async () => {
        const t1 = turn1Results.get(c.id);
        expect(t1, "turn 1 must pass first").toBeDefined();
        const { events, call } = t1 as Turn1Result;
        const assistant = (await collect((async function* () { yield* events; })())).message;
        // chunkSize 1: every multi-byte character (°) is split across reads.
        const f = fixtureFetch(c.dir, { record: Boolean(liveKey), chunkSize: liveKey ? 0 : 1, ...(liveKey ? { secrets: [liveKey] } : {}) }).queue(
          "weather_final_text",
        );
        const p = c.make(f, liveKey);
        const events2 = await all(p.send(weatherTurn2(model, assistant, call.id)));
        assertStreamShape(events2);
        const res = await collect((async function* () { yield* events2; })());
        expect(res.error).toBeUndefined();
        expect(res.stopReason).toBe("end_turn");
        if (!liveKey) {
          expect(res.message.content).toEqual([{ type: "text", text: "It is 18°C in Paris." }]);
          expect(f.requests[0]?.body).toMatchSnapshot(`${c.id} turn 2 request body`);
        }
      });
    });
  }

  it("all providers agree on the normalised tool call", () => {
    const normalised = PROVIDER_CASES.map((c) => {
      const r = turn1Results.get(c.id);
      return r ? { name: r.call.name, input: r.call.input, stopReason: r.stopReason } : undefined;
    });
    expect(normalised).toHaveLength(4);
    for (const n of normalised) expect(n).toEqual({ name: "get_weather", input: { city: "Paris" }, stopReason: "tool_use" });
  });
});

describe("gate 2: turn 2 request bodies link the tool result to the call", () => {
  async function turn2Body(id: string): Promise<Record<string, unknown>> {
    const c = PROVIDER_CASES.find((x) => x.id === id) as ProviderCase;
    const f1 = fixtureFetch(c.dir, { record: false }).queue("weather_tool_call");
    const r1 = await collect(c.make(f1).send(weatherTurn1(c.model)));
    const call = r1.message.content.find((p) => p.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error("no call");
    const f2 = fixtureFetch(c.dir, { record: false }).queue("weather_final_text");
    await collect(c.make(f2).send(weatherTurn2(c.model, r1.message, call.id)));
    return f2.requests[0]?.body as Record<string, unknown>;
  }

  it("anthropic: tool_use in the assistant turn, tool_result with the same id in a user turn", async () => {
    const body = await turn2Body("anthropic");
    expect(body["system"]).toBe("You are a weather bot");
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "What's the weather in Paris?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_01A09q90qw90lq917835lq9", name: "get_weather", input: { city: "Paris" } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01A09q90qw90lq917835lq9", content: expect.stringContaining("temperature_c") }],
      },
    ]);
  });

  it("openai: function_call then function_call_output with the same call_id, store false", async () => {
    const body = await turn2Body("openai");
    expect(body["instructions"]).toBe("You are a weather bot");
    expect(body["store"]).toBe(false);
    expect(body["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather in Paris?" }] },
      { type: "function_call", call_id: "call_Kp3Dq1ZtWm8xVb2Ln5Rs", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_Kp3Dq1ZtWm8xVb2Ln5Rs", output: expect.stringContaining("temperature_c") },
    ]);
  });

  it("google: functionCall keeps its thoughtSignature; functionResponse is keyed by name", async () => {
    const body = await turn2Body("google");
    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "You are a weather bot" }] });
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "What's the weather in Paris?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "get_weather", args: { city: "Paris" } },
            thoughtSignature: "CiQBVKhc7mVhMjU2X3NpZ25hdHVyZV9mb3JfcGFyaXNfd2VhdGhlcl9jYWxs",
          },
        ],
      },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { result: expect.stringContaining("temperature_c") } } }] },
    ]);
  });

  it("local: assistant tool_calls then a tool message with the same tool_call_id", async () => {
    const body = await turn2Body("local");
    expect(body["messages"]).toEqual([
      { role: "system", content: "You are a weather bot" },
      { role: "user", content: "What's the weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_9h1kq2x7", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "call_9h1kq2x7", content: expect.stringContaining("temperature_c") },
    ]);
  });
});
