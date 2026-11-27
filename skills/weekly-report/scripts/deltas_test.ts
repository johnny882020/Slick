// Run: deno test skills/weekly-report/scripts/
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { delta, run, weeks } from "./deltas.ts";

Deno.test("last full Monday-Sunday week", () => {
  for (const today of ["2026-11-23", "2026-11-25", "2026-11-29"]) {
    const w = weeks(today);
    strictEqual(w.current.start, "2026-11-16", today);
    strictEqual(w.current.end, "2026-11-22", today);
    strictEqual(w.current.end_exclusive, "2026-11-23", today);
    strictEqual(w.prior.start, "2026-11-09", today);
    strictEqual(w.prior.end, "2026-11-15", today);
  }
  strictEqual(weeks("2026-11-30").current.start, "2026-11-23");
  strictEqual(weeks("2026-01-02").current.label, "Dec 22 - Dec 28, 2025");
  strictEqual(weeks("2026-01-07").current.label, "Dec 29, 2025 - Jan 4, 2026");
});

Deno.test("money delta with percent", () => {
  const m = delta({ name: "Revenue", current: 482000, prior: 395000, unit: "cents" });
  strictEqual(m.delta, 87000);
  strictEqual(m.pct, 22);
  strictEqual(m.verdict, "better");
  strictEqual(m.line, "Revenue: $4,820.00 vs $3,950.00, +$870.00 (+22%)");
});

Deno.test("lower is better", () => {
  const m = delta({ name: "Open tickets", current: 4, prior: 6, better: "down" });
  strictEqual(m.trend, "down");
  strictEqual(m.verdict, "better");
  strictEqual(m.delta_text, "-2 (-33.3%)");
});

Deno.test("prior zero and flat", () => {
  deepStrictEqual([delta({ name: "Posts", current: 3, prior: 0 }).pct, delta({ name: "Posts", current: 3, prior: 0 }).verdict], [null, "new"]);
  strictEqual(delta({ name: "Orders", current: 5, prior: 5 }).line, "Orders: 5 vs 5, no change");
});

Deno.test("percent metrics change in points", () => {
  strictEqual(delta({ name: "Conversion", current: 3.4, prior: 2.9, unit: "percent" }).delta_text, "+0.5 pts");
});

Deno.test("run combines weeks and metrics", () => {
  const out = run({ today: "2026-11-25", metrics: [{ name: "Orders", current: 12, prior: 10 }] }) as Record<string, any>;
  strictEqual(out.current.start, "2026-11-16");
  strictEqual(out.metrics[0].pct, 20);
});

Deno.test("rejects bad input", () => {
  throws(() => weeks("2026-13-01"));
  throws(() => delta({ name: "X", current: Number.NaN, prior: 1 }));
  throws(() => run({ metrics: "nope" as unknown as [] }));
});
