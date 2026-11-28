import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { lintPack } from "../src/lint.js";
import { PACK_YAML } from "./fixtures.js";

const base = () => parse(PACK_YAML, { schema: "core" }) as Record<string, any>;
const errors = (p: unknown) => lintPack(p, "t").filter((i) => i.level === "error").map((i) => `${i.at}: ${i.message}`);

describe("lintPack", () => {
  it("accepts the fixture pack with no errors", () => {
    expect(errors(base())).toEqual([]);
    // the second citation has no quote: a warning, not an error
    expect(lintPack(base(), "t").some((i) => i.level === "warning" && i.at === "citations[1].quote")).toBe(true);
  });

  it("rejects non-mappings", () => {
    expect(errors("x")).toEqual([": a rule pack must be a mapping"]);
  });

  it("checks pack identity fields", () => {
    const p = base();
    p.id = "Germany";
    p.version = "1";
    p.jurisdiction = "XX";
    p.obligation = "nope";
    p.title = "";
    p.effectiveFrom = "2019";
    p.effectiveTo = 5;
    p.confidence = "sure";
    p.openQuestions = [1];
    const e = errors(p).join("\n");
    for (const s of ["id:", "version:", "jurisdiction:", "obligation:", "title:", "effectiveFrom:", "effectiveTo:", "confidence:", "openQuestions:"]) {
      expect(e).toContain(s);
    }
  });

  it("requires the id to match jurisdiction and obligation", () => {
    const p = base();
    p.id = "fr.packaging_epr";
    expect(errors(p).some((e) => e.includes('id must be "de.packaging_epr"'))).toBe(true);
  });

  it("checks review status and approval fields", () => {
    const p = base();
    p.review = { status: "approved" };
    expect(errors(p).some((e) => e.includes("gate R3"))).toBe(true);
    p.review = { status: "maybe" };
    expect(errors(p).some((e) => e.startsWith("review.status"))).toBe(true);
    p.review = { status: "approved", reviewer: "J. Doe", reviewedAt: "2026-12-01" };
    expect(errors(p)).toEqual([]);
  });

  it("checks citations", () => {
    const p = base();
    p.citations = [
      { id: "a", title: "", url: "http://x", publisher: "", kind: "blog", retrieved: "yesterday", quote: "x".repeat(301) },
      { id: "a", title: "t", url: "https://x", publisher: "p", kind: "law", retrieved: "2026-11-28", quote: 5 },
      "nope",
    ];
    const e = errors(p).join("\n");
    for (const s of ["citations[0].title", "citations[0].url", "citations[0].publisher", "citations[0].kind", "citations[0].retrieved", "citations[0].quote", "citations[1].id", "citations[1].quote", "citations[2]"]) {
      expect(e).toContain(s);
    }
    p.citations = [];
    expect(errors(p).some((x) => x.startsWith("citations:"))).toBe(true);
  });

  it("checks rules, requirements and marketplace checks", () => {
    const p = base();
    const r = p.rules[0];
    r.id = "fr.x";
    r.severity = "huge";
    r.summary = "";
    r.citations = ["missing"];
    r.requires[0].kind = "wish";
    r.requires[0].whoMayFile = ["anyone"];
    r.requires[0].filing = { channel: "portal", url: "http://x", leadTimeDays: [9, 1] };
    r.requires[0].numberFormat = "([";
    r.requires[1].key = "registration_number";
    r.requires[1].recurring = { every: "decade" };
    r.marketplaceChecks = [{ channel: "amazon" }, { channel: "bol", blocksListing: true, citations: ["zzz"] }];
    p.rules.push({ ...structuredClone(r), id: "fr.x" }, "junk");
    const e = errors(p).join("\n");
    for (const s of [
      'must start with "de.packaging_epr."', "severity", "summary", 'unknown citation id "missing"', "requires[0].kind",
      "requires[0].whoMayFile", "filing.url", "leadTimeDays", "numberFormat", 'duplicate requirement key', "recurring",
      "marketplaceChecks[0]", "marketplaceChecks[1].citations", 'duplicate rule id "fr.x"', "rules[2]",
    ]) {
      expect(e).toContain(s);
    }
  });

  it("warns when a listing block has no marketplace citation", () => {
    const p = base();
    p.rules[0].marketplaceChecks = [{ channel: "bol", blocksListing: true }];
    expect(lintPack(p, "t").some((i) => i.level === "warning" && i.message.includes("marketplace's own policy"))).toBe(true);
  });

  it("rejects rules that rest only on secondary sources, or have none", () => {
    const p = base();
    p.citations[0].kind = "secondary";
    expect(errors(p).some((e) => e.includes("secondary sources alone"))).toBe(true);
    p.rules[0].citations = [];
    expect(errors(p).some((e) => e.includes("gate R2"))).toBe(true);
  });

  it("checks missing rules, requirements and filing channels", () => {
    const p = base();
    p.rules[0].requires = [];
    expect(errors(p).some((e) => e.includes("at least one requirement"))).toBe(true);
    p.rules[0].requires = ["x", { key: "k", label: "l", kind: "label", satisfiedWhen: { always: true }, filing: { channel: "fax" } }];
    const e = errors(p).join("\n");
    expect(e).toContain("requires[0]");
    expect(e).toContain("filing.channel");
    p.rules = [];
    expect(errors(p).some((x) => x.startsWith("rules:"))).toBe(true);
    p.rules[0] = undefined;
    p.rules = "x";
    expect(errors(p).some((x) => x.startsWith("rules:"))).toBe(true);
  });

  it("checks predicates", () => {
    const p = base();
    const bad = [
      "x",
      { eq: ["market", "DE"], in: ["a", []] },
      { maybe: true },
      { always: false },
      { all: [] },
      { any: [{ eq: ["market"] }] },
      { not: { in: ["market", "DE"] } },
      { gt: ["product.battery", "1"] },
      { contains: ["seller.roles", { a: 1 }] },
      { exists: "product.colour" },
      { inEU: "seller.country" },
      { localized: "elsewhere.x" },
      { eq: ["market.code", "DE"] },
      { eq: [5, "x"] },
      { registered: { obligation: "nope" } },
      { hasRepresentative: { obligation: "weee", jurisdiction: "XX" } },
    ];
    p.rules[0].requires = bad.map((satisfiedWhen, i) => ({ key: `k${i}`, label: "l", kind: "label", satisfiedWhen }));
    const e = errors(p);
    expect(e.length).toBeGreaterThanOrEqual(bad.length);
    const joined = e.join("\n");
    for (const s of [
      "predicate must be a mapping", "exactly one operator", 'unknown operator "maybe"', "always must be true",
      "all needs a non-empty list", "eq needs [path, value]", "in needs [path, [values]]", "gt needs [path, number]",
      "contains needs [path, value]", 'unknown product field in "product.colour"', 'unknown seller field in "seller.country"',
      "must start with market", '"market" has no fields', "path must be text", "registered needs a valid obligation",
      "hasRepresentative.jurisdiction",
    ]) {
      expect(joined).toContain(s);
    }
  });

  it("accepts every valid operator form", () => {
    const p = base();
    p.rules[0].appliesWhen = {
      all: [
        { always: true },
        { any: [{ eq: ["market", "DE"] }, { in: ["channel", ["amazon"]] }] },
        { not: { contains: ["seller.roles", "distributor"] } },
        { exists: "product.safety" },
        { gte: ["product.weeeCategory", 1] },
        { lte: ["product.weeeCategory", 6] },
        { lt: ["product.weeeCategory", 7] },
        { inEU: "seller.establishedIn" },
        { localized: "product.safety.warnings" },
        { registered: { obligation: "packaging_epr", jurisdiction: "$market", register: "LUCID" } },
        { inScheme: { obligation: "packaging_epr", jurisdiction: "DE" } },
        { hasRepresentative: { obligation: "packaging_epr", jurisdiction: "EU" } },
        { eq: ["today", "2026-11-28"] },
      ],
    };
    expect(errors(p)).toEqual([]);
  });
});

describe("fix groups", () => {
  it("accepts defined groups and rejects undefined or malformed ones", () => {
    const p = base();
    p.fixGroups = { reg: "Register in Germany" };
    p.rules[0].requires[0].group = "reg";
    expect(errors(p)).toEqual([]);
    p.rules[0].requires[1].group = "nope";
    expect(errors(p).join("\n")).toContain('group "nope" is not defined');
    p.fixGroups = { Bad: "", unused: "Unused" };
    const all = lintPack(p, "t").map((i) => `${i.level} ${i.at}: ${i.message}`).join("\n");
    expect(all).toContain("lower_snake_case");
    expect(all).toContain("needs an action title");
    expect(all).toContain('warning fixGroups.unused: group "unused" is defined but no requirement uses it');
    p.fixGroups = "x";
    expect(errors(p).join("\n")).toContain("fixGroups must map");
  });
});

describe("labels", () => {
  it("warns when a label is too long to be a fix title", () => {
    const p = base();
    p.rules[0].requires[0].label = "x".repeat(121);
    expect(lintPack(p, "t").some((i) => i.level === "warning" && i.message.includes("keep it short"))).toBe(true);
  });
});
