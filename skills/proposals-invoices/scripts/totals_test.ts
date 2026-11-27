// Run: deno test skills/proposals-invoices/scripts/
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { addDays, computeTotals, divRoundHalfUp, formatMoney, parseScaled, TotalsError } from "./totals.ts";

Deno.test("line totals, tax and grand total in cents", () => {
  const t = computeTotals({
    items: [
      { description: "Brand workshop", quantity: 3, unit_cents: 12500 },
      { description: "Design hours", quantity: 1.5, unit_cents: 8000 },
    ],
    tax_bps: 825,
  });
  deepStrictEqual(t.lines.map((l) => l.line_cents), [37500, 12000]);
  strictEqual(t.subtotal_cents, 49500);
  strictEqual(t.tax_cents, 4084); // 4083.75 rounds half up
  strictEqual(t.total_cents, 53584);
  strictEqual(t.formatted.total, "$535.84");
  strictEqual(t.formatted.tax_rate, "8.25%");
});

Deno.test("tax exactly on a half cent rounds up", () => {
  const t = computeTotals({ items: [{ description: "Sticker pack", unit_cents: 1000 }], tax_percent: "8.25" });
  strictEqual(t.tax_cents, 83); // 82.5
  strictEqual(t.total_cents, 1083);
});

Deno.test("fractional quantity rounds each line once", () => {
  const t = computeTotals({ items: [{ description: "Consulting", quantity: "0.333", unit_cents: 15000 }] });
  strictEqual(t.lines[0]!.line_cents, 4995);
  strictEqual(t.total_cents, 4995);
});

Deno.test("no float drift on many small lines", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ description: `Item ${i}`, quantity: 0.1, unit_cents: 10 }));
  const t = computeTotals({ items });
  strictEqual(t.subtotal_cents, 10);
});

Deno.test("non-taxable lines and a discount split before tax", () => {
  const t = computeTotals({
    items: [
      { description: "Goods", unit_cents: 10000, taxable: true },
      { description: "Shipping", unit_cents: 1000, taxable: false },
    ],
    discount_cents: 1100,
    tax_bps: 1000,
  });
  strictEqual(t.subtotal_cents, 11000);
  strictEqual(t.taxable_cents, 9000); // 10000 - 1000 share of the discount
  strictEqual(t.tax_cents, 900);
  strictEqual(t.total_cents, 11000 - 1100 + 900);
});

Deno.test("due date from terms, default net 30", () => {
  strictEqual(computeTotals({ items: [{ description: "A", unit_cents: 1 }], issued_at: "2026-11-25" }).due_at, "2026-12-25");
  const t = computeTotals({ items: [{ description: "A", unit_cents: 1 }], issued_at: "2026-12-20", terms_days: 15 });
  strictEqual(t.due_at, "2027-01-04");
  strictEqual(computeTotals({ items: [{ description: "A", unit_cents: 1 }], issued_at: "2026-02-01", due_at: "2026-03-01" }).terms_days, 28);
  strictEqual(addDays("2028-02-28", 1), "2028-02-29");
});

Deno.test("zero-decimal currencies format without cents", () => {
  strictEqual(formatMoney(1500, "JPY"), "¥1,500");
  strictEqual(computeTotals({ items: [{ description: "A", unit_cents: 1500 }], currency: "jpy" }).currency, "JPY");
});

Deno.test("helpers", () => {
  strictEqual(parseScaled("8.25", 2, "x"), 825n);
  strictEqual(parseScaled(2, 3, "x"), 2000n);
  strictEqual(divRoundHalfUp(5n, 10n), 1n);
  strictEqual(divRoundHalfUp(4n, 10n), 0n);
});

Deno.test("rejects bad input", () => {
  throws(() => computeTotals({ items: [] }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: 12.5 }] }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: -100 }] }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", quantity: "1.2345", unit_cents: 100 }] }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: 100 }], tax_bps: 8.25 }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: 100 }], tax_bps: 825, tax_percent: 7 }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: 100 }], discount_cents: 101 }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "A", unit_cents: 100 }], issued_at: "2026-02-30" }), TotalsError);
  throws(() => computeTotals({ items: [{ description: "", unit_cents: 100 }] }), TotalsError);
});

// The CLI check needs --allow-run --allow-read; it is skipped under plain `deno test`.
const canSpawn =
  (await Deno.permissions.query({ name: "run" })).state === "granted" &&
  (await Deno.permissions.query({ name: "read" })).state === "granted";

Deno.test({ name: "CLI prints JSON totals", ignore: !canSpawn }, async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", new URL("./totals.ts", import.meta.url).pathname, JSON.stringify({ items: [{ description: "A", quantity: 2, unit_cents: 250 }] })],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  strictEqual(out.code, 0);
  strictEqual(JSON.parse(new TextDecoder().decode(out.stdout)).total_cents, 500);
});
