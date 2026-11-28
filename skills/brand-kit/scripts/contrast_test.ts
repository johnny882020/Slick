// Run: deno test skills/brand-kit/scripts/
import { strictEqual, throws } from "node:assert/strict";
import { checkPair, checkTokens, parseHex, ratio, run, suggest, toHex } from "./contrast.ts";

Deno.test("known WCAG ratios", () => {
  strictEqual(ratio("#000000", "#ffffff"), 21);
  strictEqual(ratio("#ffffff", "#ffffff"), 1);
  strictEqual(ratio("#767676", "#ffffff"), 4.54);
  strictEqual(ratio("#ff8800", "#ffffff"), 2.39);
});

Deno.test("hex parsing", () => {
  strictEqual(toHex(parseHex("#abc")), "#aabbcc");
  strictEqual(toHex(parseHex("1F4E79")), "#1f4e79");
  throws(() => parseHex("orange"));
});

Deno.test("failing pair gets a passing suggestion", () => {
  const r = checkPair("#ff8800", "#ffffff");
  strictEqual(r.aa_text, false);
  strictEqual(r.aa_large, false);
  strictEqual(ratio(r.suggestion!, "#ffffff") >= 4.5, true);
  const dark = suggest("#1f4e79", "#121417");
  strictEqual(ratio(dark!, "#121417") >= 4.5, true);
});

Deno.test("token set covers light, dark and buttons", () => {
  const out = checkTokens({ primary_color: "#1f4e79", accent_color: "#b5452f", ink: "#1b1b1b", paper: "#ffffff" });
  strictEqual(out.length, 6);
  strictEqual(out[0]!.aa_text, true);
  strictEqual(out.find((r) => r.label.startsWith("button"))!.aa_text, true);
  strictEqual(run({ pairs: [{ fg: "#000", bg: "#fff" }] }).all_aa, true);
  throws(() => run({}));
});
