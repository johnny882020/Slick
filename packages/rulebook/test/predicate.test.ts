import { describe, expect, it } from "vitest";
import type { Predicate } from "@oneseat/contracts";
import { evaluate, normalizeCountry, predicatePaths, readPath } from "../src/predicate.js";
import { ctx, product, seller } from "./fixtures.js";

describe("readPath", () => {
  it("reads context roots and nested fields", () => {
    const c = ctx();
    expect(readPath(c, "market")).toBe("DE");
    expect(readPath(c, "channel")).toBe("amazon");
    expect(readPath(c, "today")).toBe("2026-11-28");
    expect(readPath(c, "seller.roles")).toEqual(["manufacturer"]);
    expect(readPath(c, "product.shipsPackaged")).toBe(true);
  });
  it("returns a missing marker for absent fields and unknown roots", () => {
    const c = ctx();
    expect(typeof readPath(c, "product.battery.category")).toBe("symbol");
    expect(typeof readPath(c, "product.title.length.x")).toBe("symbol");
    expect(typeof readPath(c, "nowhere")).toBe("symbol");
  });
});

describe("evaluate", () => {
  it("handles always, eq, in, contains and comparisons", () => {
    const c = ctx({ product: product({ battery: { included: true, capacityWh: 50 } }) });
    expect(evaluate({ always: true }, c).value).toBe("true");
    expect(evaluate({ eq: ["market", "DE"] }, c).value).toBe("true");
    expect(evaluate({ eq: ["market", "FR"] }, c).value).toBe("false");
    expect(evaluate({ in: ["channel", ["bol", "amazon"]] }, c).value).toBe("true");
    expect(evaluate({ in: ["channel", ["bol"]] }, c).value).toBe("false");
    expect(evaluate({ contains: ["seller.roles", "manufacturer"] }, c).value).toBe("true");
    expect(evaluate({ contains: ["seller.roles", "importer"] }, c).value).toBe("false");
    expect(evaluate({ contains: ["product.title", "x"] }, c).value).toBe("false");
    expect(evaluate({ gt: ["product.battery.capacityWh", 40] }, c).value).toBe("true");
    expect(evaluate({ gte: ["product.battery.capacityWh", 50] }, c).value).toBe("true");
    expect(evaluate({ lt: ["product.battery.capacityWh", 50] }, c).value).toBe("false");
    expect(evaluate({ lte: ["product.battery.capacityWh", 50] }, c).value).toBe("true");
    expect(evaluate({ gt: ["product.title", 1] }, c).value).toBe("false");
  });

  it("returns unknown with the missing path when data is absent", () => {
    const c = ctx({ product: product({ shipsPackaged: undefined }) });
    expect(evaluate({ eq: ["product.shipsPackaged", true] }, c)).toEqual({ value: "unknown", missing: ["product.shipsPackaged"] });
    expect(evaluate({ in: ["product.category", ["a"]] }, c).value).toBe("unknown");
    expect(evaluate({ contains: ["product.packaging", "x"] }, c).value).toBe("unknown");
    expect(evaluate({ gt: ["product.battery.capacityWh", 1] }, c).value).toBe("unknown");
    expect(evaluate({ inEU: "product.safety.manufacturer.country" }, c).value).toBe("unknown");
  });

  it("uses Kleene logic for all, any and not", () => {
    const c = ctx({ product: product({ electrical: undefined }) });
    const unk: Predicate = { eq: ["product.electrical", true] };
    const t: Predicate = { always: true };
    const f: Predicate = { eq: ["market", "FR"] };
    expect(evaluate({ all: [t, f, unk] }, c).value).toBe("false");
    expect(evaluate({ all: [t, unk] }, c)).toEqual({ value: "unknown", missing: ["product.electrical"] });
    expect(evaluate({ all: [t, t] }, c).value).toBe("true");
    expect(evaluate({ any: [f, unk] }, c).value).toBe("unknown");
    expect(evaluate({ any: [unk, t] }, c).value).toBe("true");
    expect(evaluate({ any: [f, f] }, c).value).toBe("false");
    expect(evaluate({ not: unk }, c).value).toBe("unknown");
    expect(evaluate({ not: f }, c).value).toBe("true");
    expect(evaluate({ not: t }, c).value).toBe("false");
  });

  it("treats exists as false for missing, blank or empty values", () => {
    const c = ctx({ product: product({ title: " ", packaging: [], safety: { warnings: {} }, gtin: "123", weeeCategory: 4 }) });
    expect(evaluate({ exists: "product.safety.manufacturer" }, c).value).toBe("false");
    expect(evaluate({ exists: "product.title" }, c).value).toBe("false");
    expect(evaluate({ exists: "product.packaging" }, c).value).toBe("false");
    expect(evaluate({ exists: "product.safety.warnings" }, c).value).toBe("false");
    expect(evaluate({ exists: "product.gtin" }, c).value).toBe("true");
    expect(evaluate({ exists: "product.weeeCategory" }, c).value).toBe("true");
  });

  it("checks EU membership, including EL for Greece", () => {
    expect(evaluate({ inEU: "seller.establishedIn" }, ctx()).value).toBe("false");
    expect(evaluate({ inEU: "seller.establishedIn" }, ctx({ seller: seller({ establishedIn: "nl" }) })).value).toBe("true");
    expect(evaluate({ inEU: "seller.establishedIn" }, ctx({ seller: seller({ establishedIn: "EL" }) })).value).toBe("true");
    expect(normalizeCountry(" el ")).toBe("GR");
  });

  it("checks text in the market's language", () => {
    const withWarnings = (warnings: Record<string, string>) => ctx({ product: product({ safety: { warnings } }) });
    expect(evaluate({ localized: "product.safety.warnings" }, withWarnings({ "de-DE": "Achtung" })).value).toBe("true");
    expect(evaluate({ localized: "product.safety.warnings" }, withWarnings({ en: "Warning" })).value).toBe("false");
    expect(evaluate({ localized: "product.safety.warnings" }, withWarnings({ de: " " })).value).toBe("false");
    expect(evaluate({ localized: "product.safety.warnings" }, { ...withWarnings({ fr: "Attention" }), market: "BE" }).value).toBe("true");
    expect(evaluate({ localized: "product.safety.warnings" }, ctx()).value).toBe("false");
  });

  it("checks current registrations, schemes and representatives", () => {
    const s = seller({
      registrations: [
        { obligation: "packaging_epr", jurisdiction: "DE", register: "LUCID", number: "DE1234567890123" },
        { obligation: "packaging_epr", jurisdiction: "FR", register: "SYDEREP", number: "FR1", validTo: "2026-01-01" },
        { obligation: "weee", jurisdiction: "DE", register: "ear", number: " " },
      ],
      schemes: [{ obligation: "packaging_epr", jurisdiction: "DE", scheme: "Der Grüne Punkt" }],
      representatives: [{ obligation: "packaging_epr", jurisdiction: "FR", name: "AR GmbH", validTo: "2027-12-31" }],
    });
    const de = ctx({ seller: s });
    const fr = ctx({ seller: s, market: "FR" });
    expect(evaluate({ registered: { obligation: "packaging_epr" } }, de).value).toBe("true");
    expect(evaluate({ registered: { obligation: "packaging_epr", register: "lucid" } }, de).value).toBe("true");
    expect(evaluate({ registered: { obligation: "packaging_epr", register: "other" } }, de).value).toBe("false");
    expect(evaluate({ registered: { obligation: "packaging_epr" } }, fr).value).toBe("false");
    expect(evaluate({ registered: { obligation: "packaging_epr", jurisdiction: "DE" } }, fr).value).toBe("true");
    expect(evaluate({ registered: { obligation: "weee" } }, de).value).toBe("false");
    expect(evaluate({ inScheme: { obligation: "packaging_epr" } }, de).value).toBe("true");
    expect(evaluate({ inScheme: { obligation: "packaging_epr", jurisdiction: "$market" } }, fr).value).toBe("false");
    expect(evaluate({ hasRepresentative: { obligation: "packaging_epr" } }, fr).value).toBe("true");
    expect(evaluate({ hasRepresentative: { obligation: "packaging_epr" } }, de).value).toBe("false");
  });

  it("throws on an unknown operator", () => {
    expect(() => evaluate({ nope: 1 } as never, ctx())).toThrow(/unknown predicate operator/);
  });
});

describe("predicatePaths", () => {
  it("collects every path a predicate reads", () => {
    const paths = predicatePaths({
      all: [
        { eq: ["market", "DE"] },
        { any: [{ in: ["channel", ["a"]] }, { contains: ["seller.roles", "x"] }] },
        { not: { exists: "product.gtin" } },
        { gt: ["product.battery.capacityWh", 1] },
        { gte: ["a.b", 1] },
        { lt: ["c.d", 1] },
        { lte: ["e.f", 1] },
        { inEU: "seller.establishedIn" },
        { localized: "product.safety.warnings" },
        { registered: { obligation: "weee" } },
      ],
    });
    expect(paths).toEqual([
      "market", "channel", "seller.roles", "product.gtin", "product.battery.capacityWh", "a.b", "c.d", "e.f",
      "seller.establishedIn", "product.safety.warnings",
    ]);
  });
});
