import { describe, expect, it } from "vitest";
import { assess, describePath } from "../src/assess.js";
import { buildFixes } from "../src/fixes.js";
import { buildAudit, buildMap } from "../src/report.js";
import { channelName, countryName } from "../src/names.js";
import { packs, product, seller } from "./fixtures.js";

const today = "2026-11-28";
const status = (rows: ReturnType<typeof assess>, key: string, market = "DE") =>
  rows.find((r) => r.requirementKey === key && r.market === market)?.status;

describe("assess", () => {
  it("marks missing duties for an unregistered non-EU manufacturer", () => {
    const rows = assess({ seller: seller(), products: [product()], packs: packs(), today });
    expect(status(rows, "registration_number")).toBe("missing");
    expect(status(rows, "scheme")).toBe("missing");
    expect(status(rows, "responsible_person")).toBe("missing");
    expect(status(rows, "warnings")).toBe("missing");
    expect(status(rows, "electrical_check")).toBe("missing");
    const reg = rows.find((r) => r.requirementKey === "registration_number")!;
    expect(reg.blocksListingOn).toEqual(["amazon"]);
    expect(reg.citations.map((c) => c.id)).toEqual(["law"]);
    expect(reg.reason).toContain("Germany");
    expect(reg.id).toBe("A1|DE|amazon|de.packaging_epr.registration|registration_number");
  });

  it("marks duties met, and registrations close to their end date as expiring", () => {
    const s = seller({
      registrations: [{ obligation: "packaging_epr", jurisdiction: "DE", register: "LUCID", number: "DE1", validTo: "2026-12-10" }],
      schemes: [{ obligation: "packaging_epr", jurisdiction: "DE", scheme: "System" }],
      euResponsiblePerson: { name: "RP GmbH", country: "DE" },
    });
    const p = product({ electrical: false, safety: { warnings: { de: "Achtung" } } });
    const rows = assess({ seller: s, products: [p], packs: packs(), today });
    expect(status(rows, "registration_number")).toBe("expiring");
    expect(status(rows, "scheme")).toBe("met");
    expect(status(rows, "responsible_person")).toBe("met");
    expect(status(rows, "warnings")).toBe("met");
    const later = assess({ seller: s, products: [p], packs: packs(), today, expiringWithinDays: 5 });
    expect(status(later, "registration_number")).toBe("met");
  });

  it("reports unknown when data is missing, with the paths needed", () => {
    const rows = assess({ seller: seller(), products: [product({ shipsPackaged: undefined, electrical: undefined })], packs: packs(), today });
    const reg = rows.find((r) => r.requirementKey === "registration_number")!;
    expect(reg.status).toBe("unknown");
    expect(reg.missingData).toEqual(["product.shipsPackaged"]);
    expect(reg.reason).toContain("whether it ships in packaging");
    const el = rows.find((r) => r.requirementKey === "electrical_check")!;
    expect(el.status).toBe("unknown");
    expect(el.reason).toContain("whether it is electrical or electronic");
  });

  it("skips packs for other markets and rules that do not apply", () => {
    const rows = assess({ seller: seller({ establishedIn: "NL" }), products: [product({ listings: [{ channel: "bol", market: "NL" }] })], packs: packs(), today });
    expect(rows.some((r) => r.rulePack.id === "de.packaging_epr")).toBe(false);
    expect(rows.some((r) => r.ruleId === "eu.gpsr.responsible_person")).toBe(false);
    expect(rows.some((r) => r.ruleId === "eu.gpsr.warnings")).toBe(true);
  });

  it("ignores packs that are not in effect", () => {
    const ps = packs().map((p) => ({ ...p, effectiveFrom: "2030-01-01" }));
    expect(assess({ seller: seller(), products: [product()], packs: ps, today })).toEqual([]);
  });

  it("describes paths in plain words", () => {
    expect(describePath("seller.roles")).toContain("role");
    expect(describePath("product.safety.identifier")).toBe("safety identifier");
  });
});

describe("buildFixes", () => {
  it("groups national duties per country and EU product data across markets, most urgent first", () => {
    const products = [
      product({ sku: "A1", listings: [{ channel: "amazon", market: "DE" }, { channel: "amazon", market: "FR" }] }),
      product({ sku: "A2", listings: [{ channel: "amazon", market: "DE" }] }),
    ];
    const rows = assess({ seller: seller(), products, packs: packs(), today });
    const fixes = buildFixes(rows, packs());
    const reg = fixes.find((f) => f.title.startsWith("Get LUCID"))!;
    expect(reg.impact).toEqual({ skus: 2, listings: 2, blockingListings: 2 });
    expect(reg.effects).toEqual(["submit"]);
    expect(reg.leadTimeDays).toEqual([1, 7]);
    expect(reg.steps.join(" ")).toContain("lucid.verpackungsregister.org");
    expect(fixes[0]!.impact.blockingListings).toBe(2);
    const warnings = fixes.find((f) => f.requirementIds.some((id) => id.endsWith("|warnings")))!;
    expect(warnings.jurisdiction).toBe("EU");
    expect(warnings.title).toContain("France");
    expect(warnings.title).toContain("Germany");
    expect(warnings.effects).toEqual(["publish"]);
    expect(warnings.impact.listings).toBe(3);
    const scheme = fixes.find((f) => f.title.includes("Dual system"))!;
    expect(scheme.effects).toEqual(["pay", "submit"]);
    const rp = fixes.find((f) => f.title.includes("responsible person"))!;
    expect(rp.effects).toEqual(["pay", "submit"]);
    expect(rp.steps[0]).toContain("authorised representative");
    const label = fixes.find((f) => f.title.includes("Electrical"))!;
    expect(label.steps[0]).toContain("2 products");
  });

  it("writes renewal, declaration, eID and representative-only steps", () => {
    const s = seller({ registrations: [{ obligation: "packaging_epr", jurisdiction: "DE", register: "LUCID", number: "DE1", validTo: "2026-12-01" }] });
    const p = product({ sku: "T1", textile: true, listings: [{ channel: "etsy", market: "DE" }] });
    const rows = assess({ seller: s, products: [p], packs: packs(), today });
    const fixes = buildFixes(rows, packs());
    expect(fixes.some((f) => f.title.startsWith("Renew LUCID"))).toBe(true);
    const decl = fixes.find((f) => f.title.includes("Annual declaration"))!;
    expect(decl.steps.join(" ")).toContain("Every January.");
    expect(decl.steps.join(" ")).toContain("example.eu/declare");
    const ar = fixes.find((f) => f.title.includes("Authorised representative"))!;
    expect(ar.steps.join(" ")).toContain("national eID");
    expect(ar.steps.join(" ")).toContain("An authorised representative files for you");
    expect(ar.filingChannel).toBe("portal_eid");
  });

  it("falls back to a generic step when the rule is no longer in the packs", () => {
    const rows = assess({ seller: seller(), products: [product()], packs: packs(), today });
    const fixes = buildFixes(rows, []);
    expect(fixes.every((f) => f.steps.length === 1 && f.steps[0]!.startsWith("Resolve:"))).toBe(true);
    expect(fixes.every((f) => f.effects.join() === "publish")).toBe(true);
  });

  it("handles email filing", () => {
    const ps = packs();
    ps[0]!.rules[0]!.requires[0]!.filing = { channel: "email" };
    const rows = assess({ seller: seller(), products: [product()], packs: ps, today });
    const f = buildFixes(rows, ps).find((x) => x.title.startsWith("Get LUCID"))!;
    expect(f.steps.join(" ")).toContain("prepared email");
    expect(f.leadTimeDays).toBeUndefined();
  });
});

describe("map and audit", () => {
  it("colours cells red, amber, green and grey", () => {
    const s = seller({
      establishedIn: "DE",
      registrations: [{ obligation: "packaging_epr", jurisdiction: "DE", register: "LUCID", number: "DE1" }],
      schemes: [{ obligation: "packaging_epr", jurisdiction: "DE", scheme: "S" }],
    });
    const products = [
      product({ sku: "OK", electrical: false, safety: { warnings: { de: "x" } }, listings: [{ channel: "amazon", market: "DE" }] }),
      product({ sku: "UNK", electrical: undefined, safety: { warnings: { de: "x" } }, listings: [{ channel: "otto", market: "DE" }] }),
      product({ sku: "FR", listings: [{ channel: "amazon", market: "FR" }] }),
    ];
    const rows = assess({ seller: s, products, packs: packs(), today });
    const map = buildMap(products, rows, packs());
    const cell = (m: string, c: string) => map.find((x) => x.market === m && x.channel === c)!;
    expect(cell("DE", "amazon").state).toBe("green");
    expect(cell("DE", "otto").state).toBe("amber");
    expect(cell("DE", "otto").skusUnknown).toBe(1);
    expect(cell("FR", "amazon").state).toBe("grey");

    const red = buildMap([product()], assess({ seller: seller(), products: [product()], packs: packs(), today }), packs());
    expect(red[0]!.state).toBe("red");
    const amber = [product({ electrical: false, safety: { warnings: { en: "x" } } })];
    const s2 = { ...s, establishedIn: "DE" };
    const m2 = buildMap(amber, assess({ seller: s2, products: amber, packs: packs(), today }), packs());
    expect(m2[0]!.state).toBe("amber"); // open gap, but neither blocking severity nor a marketplace block
  });

  it("builds a full audit with summary, data gaps and disclaimers", () => {
    const products = [
      product({ sku: "A1", listings: [{ channel: "amazon", market: "DE" }, { channel: "bol", market: "NL" }] }),
      product({ sku: "A2", shipsPackaged: undefined, electrical: undefined }),
    ];
    const r = buildAudit({ seller: seller(), products, packs: packs(), today, generatedAt: "2026-11-28T10:00:00Z" });
    expect(r.summary.products).toBe(2);
    expect(r.summary.listings).toBe(3);
    expect(r.summary.markets).toEqual(["DE", "NL"]);
    expect(r.summary.channels).toEqual(["amazon", "bol"]);
    expect(r.summary.skusAtRisk).toBe(2);
    expect(r.summary.skusFullyMet).toBe(0);
    expect(r.summary.listingsAtRiskOfBlock).toBe(1);
    expect(r.summary.byStatus.missing).toBeGreaterThan(0);
    expect(r.dataGaps.map((g) => g.path)).toEqual(["product.electrical", "product.shipsPackaged"]);
    expect(r.disclaimers.join(" ")).toContain("not legal advice");
    expect(r.disclaimers.join(" ")).toContain("de.packaging_epr: draft");
    expect(r.disclaimers.join(" ")).toContain("the Netherlands");
    expect(r.rulebook).toEqual([
      { id: "de.packaging_epr", version: "2026.11.1", reviewStatus: "draft" },
      { id: "eu.gpsr", version: "2026.11.1", reviewStatus: "verified" },
    ]);
  });

  it("omits review and coverage notes when every pack is approved and covered", () => {
    const ps = packs().map((p) => ({ ...p, review: { status: "approved" as const, reviewer: "R", reviewedAt: today } }));
    const r = buildAudit({ seller: seller(), products: [product()], packs: ps, today });
    expect(r.disclaimers).toHaveLength(1);
    expect(r.generatedAt).toMatch(/^\d{4}-/);
  });

  it("names countries and channels", () => {
    expect(countryName("NL")).toBe("the Netherlands");
    expect(channelName("bol")).toBe("bol");
    expect(channelName("my_shop")).toBe("my_shop");
  });
});
