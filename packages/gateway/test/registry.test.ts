import { describe, expect, it } from "vitest";
import { PROVIDER_IDS, type ProviderId } from "@oneseat/contracts";
import { createProvider, EXPERIMENTAL_PROVIDERS, PROVIDER_FACTORIES } from "../src/index.js";

describe("provider registry", () => {
  it("has a factory for every contract provider id", () => {
    expect(Object.keys(PROVIDER_FACTORIES).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const id of PROVIDER_IDS) {
      const p = createProvider(id, { apiKey: "k" });
      expect(p.id).toBe(id);
      expect(typeof p.send).toBe("function");
      expect(typeof p.models).toBe("function");
      expect(typeof p.countTokens).toBe("function");
    }
  });

  it("marks local as experimental", () => {
    expect(EXPERIMENTAL_PROVIDERS).toEqual(["local"]);
  });

  it("throws for an unknown id without echoing config", () => {
    expect(() => createProvider("bogus" as ProviderId, { apiKey: "sk-secret-value-123456" })).toThrow('unknown provider "bogus"');
    try {
      createProvider("bogus" as ProviderId, { apiKey: "sk-secret-value-123456" });
    } catch (e) {
      expect(String(e)).not.toContain("sk-secret");
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PROVIDER_FACTORIES)).toBe(true);
  });
});
