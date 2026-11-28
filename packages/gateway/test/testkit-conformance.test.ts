// Gate 2: run the shared testkit suites (stream F) against every adapter, using the
// documented-format fixtures in ../fixtures. Suite names start with "conformance:".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFixtureFetch,
  describeCrossProviderToolCallParity,
  describeModelProviderConformance,
  type FixtureRoute,
  type ModelProviderFixtures,
} from "@oneseat/testkit";
import type { ModelProvider, ProviderId } from "@oneseat/contracts";
import { createProvider } from "../src/index.js";

const FIX = join(__dirname, "..", "fixtures");
const read = (p: string, f: string) => readFileSync(join(FIX, p, f), "utf8");

/** Split a stream into small chunks so every adapter handles partial reads. */
function chunks(text: string, size = 37): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sse = (body: string) => ({ headers: { "content-type": "text/event-stream" }, chunks: chunks(body) });
const json = (body: string) => ({ headers: { "content-type": "application/json" }, body });

interface Spec {
  id: ProviderId;
  model: string;
  stream: RegExp;
  models: RegExp;
  countTokens?: { match: RegExp; file: string };
}

const SPECS: Spec[] = [
  { id: "anthropic", model: "claude-sonnet-5-5", stream: /^POST \S+\/v1\/messages(\?|$)/, models: /^GET \S+\/v1\/models/, countTokens: { match: /count_tokens/, file: "count_tokens.json" } },
  { id: "openai", model: "gpt-test", stream: /^POST \S+\/v1\/responses(\?|$)/, models: /^GET \S+\/v1\/models/, countTokens: { match: /\/v1\/responses\/input_tokens/, file: "input_tokens.json" } },
  { id: "google", model: "gemini-test", stream: /streamGenerateContent/, models: /^GET \S+\/v1beta\/models/, countTokens: { match: /:countTokens/, file: "count_tokens.json" } },
  { id: "local", model: "llama-test", stream: /^POST \S+\/v1\/chat\/completions/, models: /^GET \S+\/v1\/models/ },
];

const make = (id: ProviderId) => (fetch: Parameters<typeof createProvider>[1]["fetch"], apiKey: string) =>
  createProvider(id, { apiKey, fetch, baseUrl: "https://fixtures.test" });

function fixturesFor(s: Spec): ModelProviderFixtures {
  const f: ModelProviderFixtures = {
    model: s.model,
    text: { routes: [{ match: s.stream, response: sse(read(s.id, "text_only.sse")) }] },
    toolCall: { routes: [{ match: s.stream, response: sse(read(s.id, "weather_tool_call.sse")) }] },
    models: [
      // Gemini pages its model list; serve page 2 when the adapter asks for it.
      ...(s.id === "google" ? [{ match: /pageToken=page-2/, response: json(read(s.id, "models_page2.json")) }] : []),
      { match: s.models, response: json(read(s.id, "models.json")) },
    ],
  };
  if (s.countTokens) f.countTokens = [{ match: s.countTokens.match, response: json(read(s.id, s.countTokens.file)) }];
  return f;
}

for (const s of SPECS) describeModelProviderConformance(s.id, make(s.id), fixturesFor(s));

// Same scenario, every provider, same normalised tool call.
const parity: { name: string; provider: ModelProvider; model: string }[] = SPECS.map((s) => {
  const routes: FixtureRoute[] = [{ match: s.stream, response: sse(read(s.id, "weather_tool_call.sse")) }];
  return { name: s.id, model: s.model, provider: createProvider(s.id, { apiKey: "k-test", fetch: createFixtureFetch(routes).fetch, baseUrl: "https://fixtures.test" }) };
});
describeCrossProviderToolCallParity(parity, undefined, { minProviders: 4 });
