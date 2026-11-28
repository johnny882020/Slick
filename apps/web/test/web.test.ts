import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSite } from "../src/load.js";
import { createWebServer, rateLimiter } from "../src/server.js";
import { FormError, sellerFromForm } from "../src/seller-form.js";
import { esc } from "../src/pages.js";

const ROOT = resolve(__dirname, "../../..");
const CSV = "sku,title,consumer_product,ships_packaged,electrical,textile,listings\nA1,Mug,yes,yes,no,no,amazon:DE;bol:NL\n";

let base = "";
let close: () => void = () => {};

beforeAll(async () => {
  const site = await loadSite(join(ROOT, "rules"), join(ROOT, "examples/audit"), "2026-11-28");
  const server = createWebServer({ ...site, version: "test", checksPerMinute: 3, today: () => "2026-11-28" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

function form(over: Record<string, string | string[]> = {}, csv: string | null = CSV): FormData {
  const f = new FormData();
  if (csv !== null) f.set("catalog", new Blob([csv], { type: "text/csv" }), "catalog.csv");
  const fields: Record<string, string | string[]> = { legalName: "Test Ltd", establishedIn: "GB", roles: ["manufacturer"], ...over };
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
}

const post = (f: FormData, ip = "1.1.1.1") => fetch(`${base}/check`, { method: "POST", body: f, headers: { "x-forwarded-for": ip } });

describe("pages", () => {
  it("serves the home page with coverage and security headers", async () => {
    const r = await fetch(`${base}/`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Compliance by design");
    expect(html).toContain("Germany");
    expect(html).toContain("All EU countries");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
  });
  it("serves the check form, sample, template, health and rulebook", async () => {
    expect(await (await fetch(`${base}/check`)).text()).toContain('enctype="multipart/form-data"');
    expect(await (await fetch(`${base}/sample`)).text()).toContain("Oblige gap audit");
    const t = await fetch(`${base}/catalog-template.csv`);
    expect(t.headers.get("content-disposition")).toContain("oblige-catalog-template.csv");
    expect((await t.text()).startsWith("sku,")).toBe(true);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, service: "oblige-web", version: "test", rulePacks: 6 });
    const rb = (await (await fetch(`${base}/api/v1/rulebook`)).json()) as { id: string }[];
    expect(rb.map((p) => p.id)).toContain("eu.gpsr");
  });
  it("returns 404 for unknown pages", async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("does not exist");
  });
});

describe("gap check", () => {
  it("returns the report for a valid upload", async () => {
    const r = await post(form({ registrations: "DE, packaging_epr, LUCID, DE1234567890123, 2027-12-31", schemes: "DE, packaging_epr, Der Grüne Punkt", representatives: "FR, packaging_epr, Mandataire SAS", annualPackagingKg: "NL, 12000", establishments: "de, at", rpName: "RP GmbH", rpCountry: "de", rpEmail: "rp@example.com" }), "2.2.2.2");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Oblige gap audit");
    expect(html).toContain("Test Ltd");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("explains form and catalog errors on the form page", async () => {
    const noFile = await post(form({}, null), "3.3.3.3");
    expect(noFile.status).toBe(400);
    expect(await noFile.text()).toContain("Please choose your catalog CSV file.");
    const badCsv = await post(form({}, "sku,listings\nA,amazon:US\n"), "3.3.3.4");
    expect(badCsv.status).toBe(400);
    expect(await badCsv.text()).toContain("needs an EU country code");
    const noRole = await post(form({ roles: [] }), "3.3.3.5");
    expect(await noRole.text()).toContain("tick at least one role");
  });
  it("rejects non-form posts and oversized uploads", async () => {
    const r = await fetch(`${base}/check`, { method: "POST", body: "x", headers: { "content-type": "text/plain", "x-forwarded-for": "4.4.4.4" } });
    expect(r.status).toBe(415);
    const big = await post(form({}, `sku,listings\n${"A".repeat(3 * 1024 * 1024)},amazon:DE\n`), "4.4.4.5");
    expect(big.status).toBe(413);
    expect(await big.text()).toContain("too large");
  });
  it("rate-limits each client", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post(form(), "5.5.5.5")).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("rateLimiter", () => {
  it("resets after a minute and prunes old entries", () => {
    let t = 0;
    const allow = rateLimiter(1, () => t);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    t = 60_000;
    expect(allow("a")).toBe(true);
    for (let i = 0; i < 10_001; i++) allow(`k${i}`);
    t = 200_000;
    expect(allow("fresh")).toBe(true);
  });
});

describe("sellerFromForm", () => {
  const fields = (m: Record<string, string | string[]>) => ({
    get: (n: string) => (typeof m[n] === "string" ? (m[n] as string) : undefined),
    getAll: (n: string) => [m[n] ?? []].flat(),
  });
  const ok = { legalName: "X", establishedIn: "DE", roles: ["importer", "bogus"] };
  it("builds a seller and ignores unknown roles and comments", () => {
    const s = sellerFromForm(fields({ ...ok, registrations: "# comment\nfr; packaging_epr; SYDEREP; FR123" }));
    expect(s).toEqual({ id: "web-check", legalName: "X", establishedIn: "DE", roles: ["importer"], registrations: [{ jurisdiction: "FR", obligation: "packaging_epr", register: "SYDEREP", number: "FR123" }] });
  });
  it("explains every bad field", () => {
    const bad: [Record<string, string | string[]>, RegExp][] = [
      [{ ...ok, legalName: " " }, /legal name/],
      [{ ...ok, establishedIn: "Germany" }, /established in/],
      [{ ...ok, roles: [] }, /at least one role/],
      [{ ...ok, registrations: "DE, packaging_epr, LUCID" }, /Registrations, line 1/],
      [{ ...ok, registrations: "XX, packaging_epr, LUCID, 1" }, /not an EU country code/],
      [{ ...ok, registrations: "DE, tax, LUCID, 1" }, /must be one of/],
      [{ ...ok, registrations: "DE, packaging_epr, LUCID, 1, 31/12/2027" }, /date like/],
      [{ ...ok, schemes: "DE, packaging_epr" }, /Take-back schemes, line 1/],
      [{ ...ok, representatives: "DE" }, /Authorised representatives, line 1/],
      [{ ...ok, annualPackagingKg: "EU, 10" }, /Packaging per year/],
      [{ ...ok, annualPackagingKg: "NL, lots" }, /Packaging per year/],
    ];
    for (const [m, re] of bad) expect(() => sellerFromForm(fields(m)), JSON.stringify(m)).toThrow(re);
    expect(() => sellerFromForm(fields({ ...ok, legalName: "" }))).toThrow(FormError);
  });
  it("keeps a responsible person without an email", () => {
    expect(sellerFromForm(fields({ ...ok, rpName: "RP", rpCountry: "nl" })).euResponsiblePerson).toEqual({ name: "RP", country: "NL" });
  });
});

describe("loadSite", () => {
  it("fails on pack errors or an empty rulebook", async () => {
    const empty = await mkdtemp(join(tmpdir(), "rules-"));
    await expect(loadSite(empty, join(ROOT, "examples/audit"), "2026-11-28")).rejects.toThrow(/no rule packs/);
    await writeFile(join(empty, "bad.yaml"), "id: x");
    await expect(loadSite(empty, join(ROOT, "examples/audit"), "2026-11-28")).rejects.toThrow(/rule packs have errors/);
  });
  it("escapes text", () => {
    expect(esc('<a href="x">\'&')).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});
