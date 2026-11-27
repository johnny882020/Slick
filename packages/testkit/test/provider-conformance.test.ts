import { describe, expect, it } from "vitest";
import { createScriptedProvider, type ModelProvider } from "@oneseat/contracts";
import {
  describeCrossProviderToolCallParity,
  describeModelProviderConformance,
  ERROR_EXPECTATIONS,
  genericErrorFixture,
  makeFakeApiKey,
  MODEL_PROVIDER_CHECKS,
  parityTitle,
  runModelProviderConformance,
  runToolCallParity,
  validateModelInfos,
  WEATHER_SCENARIO,
  createFixtureFetch,
} from "../src/index.js";
import { createWireProvider, WIRE_FIXTURES, WIRE_TOOL, type WireBug } from "./fakes/wire-provider.js";

// The suite as other streams use it: a correct adapter passes every check.
describeModelProviderConformance("wire (reference)", (fetch, apiKey) => createWireProvider({ fetch, apiKey }), WIRE_FIXTURES);

// Gate 2 as the gateway uses it, here with three fixture-backed adapters.
describeCrossProviderToolCallParity(
  (["anthropic", "openai", "google"] as const).map((id) => ({ name: id, provider: createWireProvider({ id, fetch: createFixtureFetch(WIRE_TOOL).fetch, apiKey: "k-123456789" }), model: "wire-large" })),
);

async function problemsFor(bugs: WireBug[]) {
  const results = await runModelProviderConformance((fetch, apiKey) => createWireProvider({ fetch, apiKey, bugs }), WIRE_FIXTURES);
  return Object.fromEntries(results.filter((r) => r.problems.length > 0).map((r) => [r.name, r.problems]));
}

describe("ModelProvider conformance catches broken adapters", () => {
  it("passes the reference adapter on every check", async () => {
    expect(await problemsFor([])).toEqual({});
    expect(MODEL_PROVIDER_CHECKS.length).toBeGreaterThanOrEqual(15);
  });

  const cases: [WireBug, RegExp, RegExp][] = [
    ["leak-key", /maps HTTP 401/, /API key leaked/],
    ["no-start", /text reply/, /first event must be message_start/],
    ["throw-on-http-error", /maps HTTP 500/, /send\(\) threw/],
    ["ignore-abort", /abort mid-stream/, /expected an aborted error/],
    ["string-args", /tool call: get_weather/, /complete, parsed JSON object/],
    ["double-end", /text reply/, /terminal events, expected exactly one/],
    ["key-in-url", /sends the API key/, /sent in the URL/],
    ["no-key", /sends the API key/, /never sent/],
    ["truncation-ok", /truncated stream/, /expected an error event for a cut-off stream/],
    ["bad-models", /models\(\) returns valid ModelInfo/, /id must be a non-empty string/],
    ["zero-tokens", /countTokens\(\) returns a positive integer/, /expected a positive integer/],
  ];
  for (const [bug, check, problem] of cases)
    it(`catches "${bug}"`, async () => {
      const found = await problemsFor([bug]);
      const name = Object.keys(found).find((n) => check.test(n));
      expect(name, `no failing check matched ${check} for ${bug}; failing: ${Object.keys(found).join(" | ")}`).toBeDefined();
      expect(found[name!]!.join("\n")).toMatch(problem);
    });

  it("reports a crash in makeProvider as a problem, not a throw", async () => {
    const results = await runModelProviderConformance(() => {
      throw new Error("ctor failed");
    }, WIRE_FIXTURES);
    expect(results.every((r) => r.problems.some((p) => p.includes("ctor failed")))).toBe(true);
  });

  it("uses provider-specific error fixtures when given", async () => {
    const key = makeFakeApiKey();
    const results = await runModelProviderConformance((fetch, apiKey) => createWireProvider({ fetch, apiKey }), {
      ...WIRE_FIXTURES,
      errors: { rate_limit: { status: 429, json: { error: { message: "slow down" } } } },
    }, { key });
    expect(results.find((r) => r.name.includes("429"))!.problems).toEqual([]);
  });

  it("generic error fixtures echo the key and carry the right status", () => {
    for (const name of Object.keys(ERROR_EXPECTATIONS) as (keyof typeof ERROR_EXPECTATIONS)[]) {
      const fx = genericErrorFixture(name);
      expect(fx.status).toBe(ERROR_EXPECTATIONS[name].status);
      expect(fx.body).toContain("{{API_KEY}}");
    }
    expect(genericErrorFixture("rate_limit").headers!["retry-after"]).toBe("7");
  });

  it("validates ModelInfo lists", () => {
    expect(validateModelInfos("x", "local")).toEqual(["models() must resolve to an array"]);
    expect(validateModelInfos([], "local")).toEqual(["models() returned no models"]);
    const p = validateModelInfos(
      [
        { id: "a", provider: "openai", label: "A", supportsTools: true },
        { id: "a", provider: "local", label: " ", supportsTools: 1, contextWindow: -5, tier: "huge" },
        null,
      ],
      "local",
    );
    expect(p.join("\n")).toMatch(/does not match provider.id/);
    expect(p.join("\n")).toMatch(/duplicated/);
    expect(p.join("\n")).toMatch(/label/);
    expect(p.join("\n")).toMatch(/supportsTools/);
    expect(p.join("\n")).toMatch(/contextWindow/);
    expect(p.join("\n")).toMatch(/tier/);
    expect(p.join("\n")).toMatch(/not an object/);
    expect(validateModelInfos([{ id: "x", provider: "mars", label: "X", supportsTools: true }], "local").join()).toMatch(/not a ProviderId/);
  });
});

function scripted(id: "anthropic" | "openai" | "google", input: Record<string, unknown> = { city: "Paris" }, stopReason?: "end_turn"): ModelProvider {
  return createScriptedProvider([{ steps: [{ text: "Let me check." }, { tool: "get_weather", input }], ...(stopReason ? { stopReason } : {}) }], { id });
}

describe("cross-provider parity", () => {
  it("agrees when every provider makes the same call", async () => {
    const r = await runToolCallParity([
      { name: "anthropic", provider: scripted("anthropic") },
      { name: "openai", provider: scripted("openai") },
      { name: "google", provider: scripted("google") },
    ]);
    expect(r.disagreements).toEqual([]);
    expect(r.results.map((x) => x.problems)).toEqual([[], [], []]);
    expect(r.results[0]!.model).toBe("scripted-1");
  });

  it("reports a provider whose call or stop reason differs", async () => {
    const r = await runToolCallParity([
      { name: "anthropic", provider: scripted("anthropic"), model: "m" },
      { name: "openai", provider: scripted("openai", { city: "paris" }), model: "m" },
      { name: "google", provider: scripted("google", { city: "Paris" }, "end_turn"), model: "m" },
    ]);
    expect(r.disagreements.join("\n")).toMatch(/openai tool calls/);
    expect(r.disagreements.join("\n")).toMatch(/google stopReason "end_turn"/);
    expect(r.results[1]!.problems.join()).toMatch(/differ from expected/);
    expect(r.results[2]!.problems.join()).toMatch(/tool-use-stop/);
  });

  it("reports errors, throws and missing models", async () => {
    const failing = createScriptedProvider([{ steps: [{ error: { kind: "server", message: "down" } }] }]);
    const throwing: ModelProvider = { ...failing, models: async () => [], send: async function* () { throw new Error("kaput"); } };
    const r = await runToolCallParity([{ name: "a", provider: failing, model: "m" }, { name: "b", provider: throwing }], WEATHER_SCENARIO, { timeoutMs: 2000 });
    expect(r.results[0]!.problems.join()).toMatch(/provider error \(server\)/);
    expect(r.results[0]!.stopReason).toBe("error");
    expect(r.results[1]!.problems.join()).toMatch(/no model given/);
    expect(r.results[1]!.problems.join()).toMatch(/send\(\) threw: kaput/);
    const broken: ModelProvider = { ...failing, models: async () => Promise.reject(new Error("nope")) };
    expect((await runToolCallParity([{ name: "c", provider: broken }])).results[0]!.problems.join()).toMatch(/models\(\) rejected/);
  });

  it("titles suites so the gates runner can read the providers", () => {
    expect(parityTitle([{ name: "anthropic" }, { name: "openai" }], WEATHER_SCENARIO)).toBe("conformance: cross-provider tool-call parity (anthropic, openai): weather");
  });
});
