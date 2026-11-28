import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RulePack } from "@oneseat/contracts";
import { inEffect, loadPackText, loadRulebook } from "../src/load.js";
import { canonicalJson, generateSigningKey, packHash, signPack, verifyPack } from "../src/sign.js";
import { checkCitation, checkCitations, decodePage, eurLexFallback, FAILING_OUTCOMES, normalizeText, quoteInText } from "../src/citations.js";
import { PACK_YAML } from "./fixtures.js";

const pack = (): RulePack => loadPackText(PACK_YAML, "de").pack!;

describe("loadPackText", () => {
  it("parses a valid pack and keeps dates as strings", () => {
    const p = pack();
    expect(p.id).toBe("de.packaging_epr");
    expect(p.effectiveFrom).toBe("2019-01-01");
    expect(p.rules[0]!.requires[0]!.numberFormat).toBe("^DE\\d{13}$");
  });
  it("reports YAML errors and lint errors without returning a pack", () => {
    const bad = loadPackText("a: [", "bad");
    expect(bad.pack).toBeUndefined();
    expect(bad.issues[0]!.message).toMatch(/does not parse/);
    const invalid = loadPackText("id: x", "invalid");
    expect(invalid.pack).toBeUndefined();
    expect(invalid.issues.length).toBeGreaterThan(0);
  });
});

describe("loadRulebook", () => {
  it("loads packs recursively and flags duplicates and broken files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rules-"));
    await mkdir(join(dir, "de"));
    await mkdir(join(dir, "copy"));
    await writeFile(join(dir, "de", "packaging_epr.yaml"), PACK_YAML);
    await writeFile(join(dir, "copy", "packaging_epr.yml"), PACK_YAML);
    await writeFile(join(dir, "broken.yaml"), "id: [");
    await writeFile(join(dir, "README.md"), "# not a pack");
    const r = await loadRulebook(dir);
    expect(r.packs.map((p) => p.id)).toEqual(["de.packaging_epr"]);
    expect(r.issues.some((i) => i.message.includes("also used by"))).toBe(true);
    expect(r.issues.some((i) => i.message.includes("does not parse"))).toBe(true);
  });
});

describe("inEffect", () => {
  it("respects dates and retirement", () => {
    const p = pack();
    expect(inEffect(p, "2026-11-28")).toBe(true);
    expect(inEffect(p, "2018-12-31")).toBe(false);
    expect(inEffect({ ...p, effectiveTo: "2020-01-01" }, "2026-11-28")).toBe(false);
    expect(inEffect({ ...p, effectiveTo: "2030-01-01" }, "2026-11-28")).toBe(true);
    expect(inEffect({ ...p, effectiveTo: undefined }, "2026-11-28")).toBe(true);
    expect(inEffect({ ...p, review: { status: "retired" } }, "2026-11-28")).toBe(false);
  });
});

describe("signing", () => {
  it("produces stable canonical JSON and hashes", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    const p = pack();
    expect(packHash(p)).toBe(packHash(structuredClone(p)));
    expect(packHash(p)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("signs and verifies, and rejects any change", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const p = pack();
    const sig = signPack(p, privateKeyPem);
    expect(verifyPack(p, sig, publicKeyPem)).toBe(true);
    const changed = structuredClone(p);
    changed.rules[0]!.title = "changed";
    expect(verifyPack(changed, sig, publicKeyPem)).toBe(false);
    expect(verifyPack({ ...p, version: "2026.12.1" }, sig, publicKeyPem)).toBe(false);
    expect(verifyPack(p, { ...sig, sha256: packHash(changed) }, publicKeyPem)).toBe(false);
    const other = generateSigningKey();
    expect(verifyPack(p, sig, other.publicKeyPem)).toBe(false);
  });
  it("refuses non-ed25519 keys", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => signPack(pack(), privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow(/ed25519/);
  });
});

describe("citations", () => {
  it("normalises page text so quotes match", () => {
    expect(normalizeText("<p>Hello&nbsp;<b>World</b> &amp; “you” &#252;ber &#xE9;t\u00ADe</p><script>x()</script><style>a{}</style>")).toBe('hello world & "you" über éte');
    expect(quoteInText("Hersteller sind  verpflichtet", "<div>... Hersteller sind\nverpflichtet ...</div>")).toBe(true);
    expect(quoteInText("not there", "<p>something else</p>")).toBe(false);
  });

  it("decodes pages by header or meta charset", () => {
    const latin1 = new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in ISO-8859-1
    expect(decodePage(latin1, "text/html; charset=ISO-8859-1")).toBe("Grüße");
    const withMeta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252">'), 0xfc]);
    expect(decodePage(withMeta, "text/html")).toContain("ü");
    expect(decodePage(new TextEncoder().encode("plain ü"), null)).toBe("plain ü");
    expect(decodePage(new TextEncoder().encode("x"), "text/html; charset=nonsense-charset")).toBe("x");
  });

  const page = (status: number, body: string, contentType = "text/html; charset=utf-8") => async () => ({
    status,
    headers: { get: (n: string) => (n === "content-type" ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });

  it("passes when the page loads and contains the quote", async () => {
    const c = pack().citations[0]!;
    expect(await checkCitation("de", c, page(200, `<p>${c.quote}</p>`))).toMatchObject({ outcome: "ok", ok: true, status: 200 });
  });

  it("classifies missing quotes, dead pages, bot blocks, PDFs and network errors", async () => {
    const c = pack().citations[0]!;
    expect((await checkCitation("de", c, page(200, "<p>other</p>"))).outcome).toBe("quote_missing");
    expect((await checkCitation("de", c, page(404, ""))).outcome).toBe("http_error");
    for (const s of [202, 403, 429, 503]) expect((await checkCitation("de", c, page(s, ""))).outcome).toBe("blocked");
    expect((await checkCitation("de", c, page(200, "%PDF", "application/pdf"))).outcome).toBe("needs_manual");
    expect((await checkCitation("de", { ...c, url: "https://x.example/doc.pdf?x=1" }, page(200, "", ""))).outcome).toBe("needs_manual");
    const thrown = await checkCitation("de", c, async () => { throw new Error("offline"); });
    expect(thrown).toMatchObject({ outcome: "fetch_error", ok: false, error: "offline" });
  });

  it("passes a quote-less citation on a 200 and checks a whole pack in order", async () => {
    const results = await checkCitations([pack()], page(200, "Hersteller sind verpflichtet, sich registrieren zu lassen."), 1);
    expect(results.map((r) => r.outcome)).toEqual(["ok", "ok"]);
    expect(FAILING_OUTCOMES).toEqual(["quote_missing", "http_error"]);
    expect(await checkCitations([], page(200, ""))).toEqual([]);
  });

  it("works without a content-type header", async () => {
    const c = pack().citations[0]!;
    const r = await checkCitation("de", c, async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(c.quote!).buffer as ArrayBuffer }));
    expect(r.outcome).toBe("ok");
  });
});

describe("EUR-Lex fallback", () => {
  it("maps ELI links to the Publications Office CELEX resource", () => {
    expect(eurLexFallback("https://eur-lex.europa.eu/eli/reg/2025/40/oj")).toBe("https://publications.europa.eu/resource/celex/32025R0040");
    expect(eurLexFallback("https://eur-lex.europa.eu/eli/dir/2012/19/oj")).toBe("https://publications.europa.eu/resource/celex/32012L0019");
    expect(eurLexFallback("https://eur-lex.europa.eu/eli/dec/2020/1234/oj")).toBe("https://publications.europa.eu/resource/celex/32020D1234");
    expect(eurLexFallback("https://example.com/eli/reg/2025/40")).toBeUndefined();
  });

  it("retries a blocked EUR-Lex link on the Publications Office copy", async () => {
    const c = { id: "ppwr", title: "PPWR", url: "https://eur-lex.europa.eu/eli/reg/2025/40/oj", publisher: "EU", kind: "law" as const, retrieved: "2026-11-28", quote: "producers shall register" };
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      const blocked = url.includes("eur-lex");
      return { status: blocked ? 202 : 200, arrayBuffer: async () => new TextEncoder().encode(blocked ? "" : "<p>Producers shall register</p>").buffer as ArrayBuffer };
    };
    expect((await checkCitation("eu", c, fetcher)).outcome).toBe("ok");
    expect(seen).toEqual(["https://eur-lex.europa.eu/eli/reg/2025/40/oj", "https://publications.europa.eu/resource/celex/32025R0040"]);
  });
});
