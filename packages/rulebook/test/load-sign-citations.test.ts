import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RulePack } from "@oneseat/contracts";
import { inEffect, loadPackText, loadRulebook } from "../src/load.js";
import { canonicalJson, generateSigningKey, packHash, signPack, verifyPack } from "../src/sign.js";
import { checkCitation, checkCitations, normalizeText, quoteInText } from "../src/citations.js";
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
    expect(normalizeText("<p>Hello&nbsp;<b>World</b> &amp; “you”</p><script>x()</script><style>a{}</style>")).toBe('hello world & "you"');
    expect(quoteInText("Hersteller sind  verpflichtet", "<div>... Hersteller sind\nverpflichtet ...</div>")).toBe(true);
    expect(quoteInText("not there", "<p>something else</p>")).toBe(false);
  });

  const page = (status: number, body: string) => async () => ({ status, text: async () => body });

  it("passes when the page loads and contains the quote", async () => {
    const c = pack().citations[0]!;
    const r = await checkCitation("de", c, page(200, `<p>${c.quote}</p>`));
    expect(r).toMatchObject({ ok: true, quoteFound: true, status: 200 });
  });
  it("fails when the quote is gone, the page errors, or fetch throws", async () => {
    const c = pack().citations[0]!;
    expect((await checkCitation("de", c, page(200, "<p>other</p>"))).error).toMatch(/quote not found/);
    expect((await checkCitation("de", c, page(404, ""))).error).toBe("HTTP 404");
    const thrown = await checkCitation("de", c, async () => { throw new Error("offline"); });
    expect(thrown).toMatchObject({ ok: false, error: "offline" });
  });
  it("passes a quote-less citation on a 200 and checks a whole pack", async () => {
    const results = await checkCitations([pack()], page(200, "Hersteller sind verpflichtet, sich registrieren zu lassen."));
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[1]!.quoteFound).toBeUndefined();
  });
});
