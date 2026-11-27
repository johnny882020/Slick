// Invoice and proposal totals in exact integer cents.
// Run: deno run scripts/totals.ts '<json>'   (or pipe the JSON on stdin). Needs no permissions.
//
// Input:
//   {
//     "items": [{ "description": "Design", "quantity": 1.5, "unit_cents": 8000, "taxable": true }],
//     "tax_bps": 825,            // 8.25% as basis points, or "tax_percent": "8.25"
//     "discount_cents": 0,       // optional, applied before tax
//     "currency": "USD",         // optional, default USD
//     "locale": "en-US",         // optional, for the formatted strings
//     "issued_at": "2026-11-25", // optional, YYYY-MM-DD
//     "terms_days": 30           // optional, default 30 when issued_at is set; or give "due_at"
//   }
//
// Rules: each line is rounded half-up to a whole cent once (quantity x unit). Tax is computed once,
// on the taxable subtotal after its share of the discount, and rounded half-up. Quantities may have
// up to 3 decimals, tax percents up to 2 decimals. Amounts are never negative.

export interface ItemInput {
  description: string;
  quantity?: number | string;
  unit_cents: number;
  taxable?: boolean;
}

export interface TotalsInput {
  items: ItemInput[];
  tax_bps?: number;
  tax_percent?: number | string;
  discount_cents?: number;
  currency?: string;
  locale?: string;
  issued_at?: string;
  terms_days?: number;
  due_at?: string;
}

export interface Line {
  description: string;
  quantity: number;
  unit_cents: number;
  line_cents: number;
  taxable: boolean;
}

export interface Totals {
  currency: string;
  lines: Line[];
  subtotal_cents: number;
  discount_cents: number;
  taxable_cents: number;
  tax_bps: number;
  tax_cents: number;
  total_cents: number;
  issued_at?: string;
  due_at?: string;
  terms_days?: number;
  formatted: {
    lines: string[];
    unit: string[];
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    tax_rate: string;
  };
}

export class TotalsError extends Error {
  override name = "TotalsError";
}

/** Parse a non-negative decimal with at most `places` decimals into an integer scaled by 10^places. */
export function parseScaled(value: number | string, places: number, what: string): bigint {
  const text = typeof value === "number" ? String(value) : String(value).trim();
  const m = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new TotalsError(`${what} must be a non-negative number, got ${JSON.stringify(value)}`);
  const frac = m[2] ?? "";
  if (frac.length > places) throw new TotalsError(`${what} has more than ${places} decimals: ${text}`);
  return BigInt(m[1]!) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0") || "0");
}

/** floor(n / d + 1/2) for n >= 0, d > 0: round half up. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

function cents(value: unknown, what: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TotalsError(`${what} must be a whole, non-negative number of cents, got ${JSON.stringify(value)}`);
  return BigInt(value);
}

function isoDate(value: string, what: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new TotalsError(`${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== value) throw new TotalsError(`${what} is not a real date: ${value}`);
  return d;
}

const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(isoDate(iso, "date").getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function formatMoney(amountCents: number, currency: string, locale = "en-US"): string {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(amountCents / 10 ** digits);
}

function taxBps(input: TotalsInput): bigint {
  const hasBps = input.tax_bps !== undefined;
  const hasPct = input.tax_percent !== undefined;
  let bps = 0n;
  if (hasBps) {
    if (typeof input.tax_bps !== "number" || !Number.isInteger(input.tax_bps))
      throw new TotalsError(`tax_bps must be a whole number (8.25% = 825), got ${JSON.stringify(input.tax_bps)}`);
    bps = BigInt(input.tax_bps);
  }
  if (hasPct) {
    const fromPct = parseScaled(input.tax_percent!, 2, "tax_percent");
    if (hasBps && fromPct !== bps) throw new TotalsError("tax_bps and tax_percent disagree; give one");
    bps = fromPct;
  }
  if (bps < 0n || bps > 10_000n) throw new TotalsError("tax rate must be between 0% and 100%");
  return bps;
}

export function computeTotals(input: TotalsInput): Totals {
  if (!input || typeof input !== "object") throw new TotalsError("input must be a JSON object");
  if (!Array.isArray(input.items) || input.items.length === 0) throw new TotalsError("items must be a non-empty list");
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TotalsError(`currency must be a 3-letter code, got ${input.currency}`);
  const locale = input.locale ?? "en-US";

  const lines: Line[] = [];
  let subtotal = 0n;
  let taxableSub = 0n;
  input.items.forEach((item, i) => {
    if (!item || typeof item !== "object") throw new TotalsError(`items[${i}] must be an object`);
    if (typeof item.description !== "string" || item.description.trim() === "")
      throw new TotalsError(`items[${i}].description is required`);
    const qtyMilli = parseScaled(item.quantity ?? 1, 3, `items[${i}].quantity`);
    const unit = cents(item.unit_cents, `items[${i}].unit_cents`);
    const line = divRoundHalfUp(qtyMilli * unit, 1000n);
    const taxable = item.taxable !== false;
    subtotal += line;
    if (taxable) taxableSub += line;
    lines.push({
      description: item.description.trim(),
      quantity: Number(qtyMilli) / 1000,
      unit_cents: Number(unit),
      line_cents: Number(line),
      taxable,
    });
  });

  const discount = cents(input.discount_cents ?? 0, "discount_cents");
  if (discount > subtotal) throw new TotalsError("discount_cents is larger than the subtotal");
  const taxableDiscount = subtotal === 0n ? 0n : divRoundHalfUp(discount * taxableSub, subtotal);
  const taxable = taxableSub - taxableDiscount;
  const bps = taxBps(input);
  const tax = divRoundHalfUp(taxable * bps, 10_000n);
  const total = subtotal - discount + tax;
  for (const [k, v] of [["subtotal", subtotal], ["total", total]] as const)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new TotalsError(`${k} is too large`);

  const out: Totals = {
    currency,
    lines,
    subtotal_cents: Number(subtotal),
    discount_cents: Number(discount),
    taxable_cents: Number(taxable),
    tax_bps: Number(bps),
    tax_cents: Number(tax),
    total_cents: Number(total),
    formatted: {
      lines: lines.map((l) => formatMoney(l.line_cents, currency, locale)),
      unit: lines.map((l) => formatMoney(l.unit_cents, currency, locale)),
      subtotal: formatMoney(Number(subtotal), currency, locale),
      discount: formatMoney(Number(discount), currency, locale),
      tax: formatMoney(Number(tax), currency, locale),
      total: formatMoney(Number(total), currency, locale),
      tax_rate: `${(Number(bps) / 100).toString()}%`,
    },
  };

  if (input.issued_at !== undefined) {
    isoDate(input.issued_at, "issued_at");
    out.issued_at = input.issued_at;
    if (input.due_at !== undefined) {
      const due = isoDate(input.due_at, "due_at");
      const days = Math.round((due.getTime() - isoDate(input.issued_at, "issued_at").getTime()) / DAY_MS);
      if (days < 0) throw new TotalsError("due_at is before issued_at");
      out.due_at = input.due_at;
      out.terms_days = days;
    } else {
      const days = input.terms_days ?? 30;
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new TotalsError("terms_days must be 0 to 365");
      out.due_at = addDays(input.issued_at, days);
      out.terms_days = days;
    }
  } else if (input.due_at !== undefined || input.terms_days !== undefined) {
    throw new TotalsError("give issued_at with due_at or terms_days");
  }
  return out;
}

async function readInput(): Promise<string> {
  if (Deno.args.length > 0) return Deno.args.join(" ");
  return await new Response(Deno.stdin.readable).text();
}

if (import.meta.main) {
  try {
    const text = await readInput();
    const result = computeTotals(JSON.parse(text) as TotalsInput);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    const message = e instanceof SyntaxError ? `input is not valid JSON: ${e.message}` : (e as Error).message;
    console.log(JSON.stringify({ error: message }));
    Deno.exit(1);
  }
}
