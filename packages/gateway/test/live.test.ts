// Live API tests. Nightly only: run with ONESEAT_LIVE=1 and the provider keys
// in the environment. Each provider is skipped when its key is absent.
//
//   ONESEAT_LIVE=1 ANTHROPIC_API_KEY=... pnpm --filter @oneseat/gateway test:live
//
// Models can be overridden with ONESEAT_LIVE_<PROVIDER>_MODEL (cheap defaults).
// Assertions are loose on wording (real models vary) but strict on the contract.

import { describe, expect, it } from "vitest";
import { collect, type ProviderId } from "@oneseat/contracts";
import { createProvider } from "../src/index.js";
import { all, assertStreamShape, textRequest, weatherTurn1, weatherTurn2 } from "./helpers.js";

const LIVE = process.env["ONESEAT_LIVE"] === "1";

const CASES: { id: ProviderId; envKey: string; model: string }[] = [
  { id: "anthropic", envKey: "ANTHROPIC_API_KEY", model: process.env["ONESEAT_LIVE_ANTHROPIC_MODEL"] ?? "claude-haiku-5-5" },
  { id: "openai", envKey: "OPENAI_API_KEY", model: process.env["ONESEAT_LIVE_OPENAI_MODEL"] ?? "gpt-5-mini" },
  { id: "google", envKey: "GEMINI_API_KEY", model: process.env["ONESEAT_LIVE_GOOGLE_MODEL"] ?? "gemini-2.5-flash" },
];

for (const c of CASES) {
  const key = process.env[c.envKey];
  describe.skipIf(!LIVE || !key)(`live: ${c.id} (${c.model})`, () => {
    const provider = () => createProvider(c.id, { apiKey: key as string });

    it("lists models", async () => {
      const models = await provider().models();
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) expect(m.provider).toBe(c.id);
    }, 60_000);

    it("counts tokens", async () => {
      expect(await provider().countTokens(weatherTurn1(c.model))).toBeGreaterThan(0);
    }, 60_000);

    it("streams text", async () => {
      const events = await all(provider().send({ ...textRequest(c.model, "Reply with the single word: pong"), maxTokens: 256 }));
      assertStreamShape(events);
      const res = await collect((async function* () { yield* events; })());
      expect(res.error).toBeUndefined();
      expect(JSON.stringify(res.message.content).toLowerCase()).toContain("pong");
    }, 60_000);

    it("runs the gate 2 weather scenario end to end", async () => {
      const p = provider();
      const t1 = await collect(p.send({ ...weatherTurn1(c.model), toolChoice: "any" }));
      expect(t1.error).toBeUndefined();
      expect(t1.stopReason).toBe("tool_use");
      const call = t1.message.content.find((x) => x.type === "tool_use");
      expect(call?.type === "tool_use" ? call.name : "").toBe("get_weather");
      expect(String(call?.type === "tool_use" ? call.input["city"] : "")).toMatch(/paris/i);
      if (call?.type !== "tool_use") return;
      const t2 = await collect(p.send(weatherTurn2(c.model, t1.message, call.id)));
      expect(t2.error).toBeUndefined();
      expect(t2.stopReason).toBe("end_turn");
      expect(JSON.stringify(t2.message.content)).toMatch(/18/);
    }, 120_000);

    it("reports a bad key as an auth error without echoing it", async () => {
      const bad = `${c.id}-definitely-not-a-valid-key-0000`;
      const events = await all(createProvider(c.id, { apiKey: bad }).send(textRequest(c.model)));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: { kind: "auth", retryable: false } });
      expect(JSON.stringify(events)).not.toContain(bad);
    }, 60_000);
  });
}

describe.skipIf(LIVE)("live tests", () => {
  it("are skipped unless ONESEAT_LIVE=1", () => {
    expect(LIVE).toBe(false);
  });
});
