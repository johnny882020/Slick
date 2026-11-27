// Week ranges and week-over-week deltas. Needs no permissions.
// Run: deno run scripts/deltas.ts '<json>'   (or JSON on stdin)
//
// Input:
//   {
//     "today": "2026-11-25",                 // optional; default is the current UTC date
//     "currency": "USD",                     // optional, for unit "cents"
//     "metrics": [                           // optional
//       { "name": "Revenue", "current": 482000, "prior": 395000, "unit": "cents", "better": "up" }
//     ]
//   }
// Units: "cents" (money in minor units), "count", "percent" (deltas in points), or any label.
// better: "up" (default) or "down" (e.g. response time, refunds).
//
// Output: the last full Monday-Sunday week before today, the week before it, and per metric the
// absolute delta, the percent change (null when prior is 0) and a formatted line.

export interface MetricIn {
  name: string;
  current: number;
  prior: number;
  unit?: string;
  better?: "up" | "down";
}

export interface Week {
  start: string;
  end: string;
  end_exclusive: string;
  label: string;
}

export interface MetricOut extends Required<Omit<MetricIn, "better">> {
  better: "up" | "down";
  delta: number;
  pct: number | null;
  trend: "up" | "down" | "flat";
  verdict: "better" | "worse" | "same" | "new";
  current_text: string;
  prior_text: string;
  delta_text: string;
  line: string;
}

const DAY = 86_400_000;

function parseDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (d.toISOString().slice(0, 10) !== iso) throw new Error(`not a real date: ${iso}`);
  return d;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function label(start: Date, end: Date): string {
  const f = (d: Date, year: boolean) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" });
  return `${f(start, start.getUTCFullYear() !== end.getUTCFullYear())} - ${f(end, true)}`;
}

function week(start: Date): Week {
  const end = new Date(start.getTime() + 6 * DAY);
  return { start: iso(start), end: iso(end), end_exclusive: iso(new Date(start.getTime() + 7 * DAY)), label: label(start, end) };
}

/** Last full Monday-Sunday week strictly before the week containing `today`, and the one before. */
export function weeks(today: string): { current: Week; prior: Week } {
  const t = parseDate(today);
  const sinceMonday = (t.getUTCDay() + 6) % 7;
  const thisMonday = new Date(t.getTime() - sinceMonday * DAY);
  const lastMonday = new Date(thisMonday.getTime() - 7 * DAY);
  return { current: week(lastMonday), prior: week(new Date(lastMonday.getTime() - 7 * DAY)) };
}

function fmt(value: number, unit: string, currency: string, signed = false): string {
  const sign = signed && value > 0 ? "+" : signed && value < 0 ? "-" : "";
  const v = signed ? Math.abs(value) : value;
  if (unit === "cents")
    return sign + new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v / 100);
  if (unit === "percent") return `${sign}${round1(v)}${signed ? " pts" : "%"}`;
  const n = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v);
  return unit === "count" || unit === "" ? sign + n : `${sign}${n} ${unit}`;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function delta(m: MetricIn, currency = "USD"): MetricOut {
  if (!m || typeof m.name !== "string" || m.name === "") throw new Error("each metric needs a name");
  for (const k of ["current", "prior"] as const)
    if (typeof m[k] !== "number" || !Number.isFinite(m[k])) throw new Error(`${m.name}: ${k} must be a number`);
  const unit = m.unit ?? "count";
  const better = m.better ?? "up";
  const d = m.current - m.prior;
  const pct = m.prior === 0 ? null : round1((d / Math.abs(m.prior)) * 100);
  const trend = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const verdict =
    m.prior === 0 && m.current !== 0 ? "new" : trend === "flat" ? "same" : trend === better ? "better" : "worse";
  const deltaText =
    unit === "percent"
      ? fmt(d, unit, currency, true)
      : `${fmt(d, unit, currency, true)}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`}`;
  const currentText = fmt(m.current, unit, currency);
  const priorText = fmt(m.prior, unit, currency);
  const line =
    verdict === "new"
      ? `${m.name}: ${currentText} (none the week before)`
      : `${m.name}: ${currentText} vs ${priorText}, ${trend === "flat" ? "no change" : deltaText}`;
  return {
    name: m.name,
    current: m.current,
    prior: m.prior,
    unit,
    better,
    delta: d,
    pct,
    trend,
    verdict,
    current_text: currentText,
    prior_text: priorText,
    delta_text: trend === "flat" ? "no change" : deltaText,
    line,
  };
}

export function run(input: { today?: string; currency?: string; metrics?: MetricIn[] }) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const out: Record<string, unknown> = { today, ...weeks(today) };
  if (input.metrics !== undefined) {
    if (!Array.isArray(input.metrics)) throw new Error("metrics must be a list");
    out.metrics = input.metrics.map((m) => delta(m, input.currency ?? "USD"));
  }
  return out;
}

if (import.meta.main) {
  try {
    const text = Deno.args.length > 0 ? Deno.args.join(" ") : await new Response(Deno.stdin.readable).text();
    console.log(JSON.stringify(run(text.trim() === "" ? {} : JSON.parse(text)), null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    Deno.exit(1);
  }
}
