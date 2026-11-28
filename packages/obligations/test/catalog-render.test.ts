import { describe, expect, it } from "vitest";
import { CatalogError, parseCatalogCsv, parseCsv, parseListings, parsePackaging } from "../src/catalog.js";
import { renderHtml, renderMarkdown } from "../src/render.js";
import { buildAudit } from "../src/report.js";
import { packs, product, seller } from "./fixtures.js";

const HEADER =
  "sku,title,gtin,brand,category,consumer_product,ships_packaged,packaging,electrical,weee_category,battery_included,battery_category,battery_capacity_wh,textile,listings,manufacturer_name,manufacturer_country,manufacturer_email,manufacturer_address,responsible_person_name,responsible_person_country,identifier,shown_on_listing,has_images,warnings_de,warnings_fr,attr_declared,attr_colour,attr_count";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, CRLF, BOM and blank lines", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,2')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["1", "2"]]);
    expect(parseCsv("a\nmulti\r")).toEqual([["a"], ["multi"]]);
    expect(() => parseCsv('a\n"open')).toThrow(CatalogError);
  });
});

describe("parseCatalogCsv", () => {
  it("parses every column", () => {
    const row =
      'S1,Speaker,4006381333931,Acme,audio,yes,ja,"paper_cardboard:120:sales;plastic:15:shipping",1,4,true,portable,12.5,no,"amazon:DE;bol:nl",Acme Ltd,cn,info@acme.example,1 Road,RP GmbH,DE,SPK-1,oui,y,Achtung,Attention,yes,blue,3';
    const [p] = parseCatalogCsv(`${HEADER}\n${row}\n`);
    expect(p).toEqual({
      sku: "S1",
      title: "Speaker",
      gtin: "4006381333931",
      brand: "Acme",
      category: "audio",
      consumerProduct: true,
      shipsPackaged: true,
      packaging: [
        { material: "paper_cardboard", weightGrams: 120, role: "sales" },
        { material: "plastic", weightGrams: 15, role: "shipping" },
      ],
      electrical: true,
      weeeCategory: 4,
      battery: { included: true, category: "portable", capacityWh: 12.5 },
      textile: false,
      listings: [{ channel: "amazon", market: "DE" }, { channel: "bol", market: "NL" }],
      safety: {
        manufacturer: { name: "Acme Ltd", country: "CN", email: "info@acme.example", street: "1 Road" },
        responsiblePerson: { name: "RP GmbH", country: "DE" },
        identifier: "SPK-1",
        warnings: { de: "Achtung", fr: "Attention" },
        shownOnListing: true,
        hasImages: true,
      },
      attributes: { declared: true, colour: "blue", count: 3 },
    });
  });

  it("keeps optional columns optional", () => {
    const [p] = parseCatalogCsv("sku,listings,battery_included,attr_flag\nX,etsy:FR,nein,no\n");
    expect(p).toEqual({ sku: "X", title: "X", listings: [{ channel: "etsy", market: "FR" }], battery: { included: false }, attributes: { flag: false } });
  });

  it("explains bad input by row and column", () => {
    const bad: [string, RegExp][] = [
      ["sku\nX", /"listings" column/],
      ["sku,listings", /header row and at least one product/],
      ["sku,listings\n,amazon:DE", /row 2: sku is empty/],
      ["sku,listings\nA,amazon:DE\nA,amazon:FR", /appears twice/],
      ["sku,listings\nA,amazon:US", /needs an EU country code/],
      ["sku,listings\nA,:DE", /has no channel/],
      ["sku,listings\nA,;", /listings is empty/],
      ["sku,listings,electrical\nA,amazon:DE,maybe", /row 2, electrical: "maybe" is not yes or no/],
      ["sku,listings,weee_category\nA,amazon:DE,9", /must be 1 to 6/],
      ["sku,listings,weee_category\nA,amazon:DE,x", /not a number/],
      ["sku,listings,battery_included,battery_category\nA,amazon:DE,yes,car", /unknown battery type/],
      ["sku,listings,packaging\nA,amazon:DE,foil:1", /unknown packaging material/],
      ["sku,listings,packaging\nA,amazon:DE,plastic:heavy", /not a number of grams/],
      ["sku,listings,packaging\nA,amazon:DE,plastic:1:gift", /unknown packaging role/],
    ];
    for (const [csv, re] of bad) expect(() => parseCatalogCsv(csv), csv).toThrow(re);
  });

  it("exposes the field parsers", () => {
    expect(parsePackaging("glass:300", "x")).toEqual([{ material: "glass", weightGrams: 300, role: "sales" }]);
    expect(parseListings("Shopify:at", "x")).toEqual([{ channel: "shopify", market: "AT" }]);
  });
});

describe("renderers", () => {
  const report = () =>
    buildAudit({
      seller: seller({ legalName: 'Bad <Name> & "Co"' }),
      products: [product({ shipsPackaged: undefined }), product({ sku: "B2", listings: [{ channel: "bol", market: "NL" }] })],
      packs: packs(),
      today: "2026-11-28",
      generatedAt: "2026-11-28T10:00:00Z",
    });

  it("renders Markdown with the map, fixes, data gaps, sources and notes", () => {
    const md = renderMarkdown(report());
    for (const s of ["# Oblige gap audit", "## Can I sell?", "| Germany | Amazon |", "## What to fix", "## Data we still need", "whether it ships in packaging", "## Sources", "[GPSR](https://eur-lex.europa.eu/eli/reg/2023/988/oj)", "eu.gpsr 2026.11.1 (verified)", "not legal advice"]) {
      expect(md).toContain(s);
    }
  });

  it("renders one escaped, self-contained HTML page", () => {
    const html = renderHtml(report());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Bad &lt;Name&gt; &amp; &quot;Co&quot;");
    expect(html).not.toContain("<Name>");
    expect(html).toContain('class="chip grey"');
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).not.toMatch(/<link|<script src/);
  });

  it("says so when nothing needs fixing", () => {
    const s = seller({
      establishedIn: "DE",
      registrations: [{ obligation: "packaging_epr", jurisdiction: "DE", register: "LUCID", number: "DE1" }],
      schemes: [{ obligation: "packaging_epr", jurisdiction: "DE", scheme: "S" }],
    });
    const r = buildAudit({ seller: s, products: [product({ electrical: false, safety: { warnings: { de: "x" } } })], packs: packs(), today: "2026-11-28" });
    expect(renderMarkdown(r)).toContain("Nothing to fix");
    expect(renderMarkdown(r)).toContain("have no open gaps in the rules we cover");
    expect(renderHtml(r)).toContain("Nothing to fix");
  });
});
