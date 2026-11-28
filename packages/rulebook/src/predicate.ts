// Deterministic predicate evaluation with three-valued (Kleene) logic.
//
// A predicate that reads a field the seller has not supplied evaluates to "unknown" and
// records the path, so the engine can ask for the data instead of guessing.

import {
  EU_COUNTRIES,
  MARKET_LANGUAGES,
  type CountryCode,
  type Jurisdiction,
  type ObligationId,
  type Predicate,
  type Product,
  type Scalar,
  type Seller,
} from "@oneseat/contracts";

export type Truth = "true" | "false" | "unknown";

export interface EvalContext {
  seller: Seller;
  product: Product;
  market: CountryCode;
  channel: string;
  /** ISO date used for "current" checks on registrations, schemes and representatives. */
  today: string;
}

export interface EvalResult {
  value: Truth;
  /** Paths that were missing and made the result unknown. */
  missing: string[];
}

const EU = new Set<string>(EU_COUNTRIES);

/** Every operator name the language accepts, for the linter. */
export const PREDICATE_OPERATORS = [
  "always", "all", "any", "not", "eq", "in", "contains", "exists",
  "gt", "gte", "lt", "lte", "inEU", "localized", "registered", "inScheme", "hasRepresentative",
] as const;

const MISSING = Symbol("missing");

/** Read a dotted path from the context. Returns MISSING when any segment is absent. */
export function readPath(ctx: EvalContext, path: string): unknown {
  const [head, ...rest] = path.split(".");
  let cur: unknown;
  switch (head) {
    case "market": cur = ctx.market; break;
    case "channel": cur = ctx.channel; break;
    case "today": cur = ctx.today; break;
    case "seller": cur = ctx.seller; break;
    case "product": cur = ctx.product; break;
    default: return MISSING;
  }
  for (const key of rest) {
    if (cur === null || cur === undefined || typeof cur !== "object") return MISSING;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur === undefined || cur === null ? MISSING : cur;
}

const T: EvalResult = { value: "true", missing: [] };
const F: EvalResult = { value: "false", missing: [] };
const unknown = (path: string): EvalResult => ({ value: "unknown", missing: [path] });
const of = (b: boolean): EvalResult => (b ? T : F);

function current(validTo: string | undefined, today: string): boolean {
  return validTo === undefined || validTo >= today;
}

function resolveJurisdiction(j: Jurisdiction | "$market" | undefined, ctx: EvalContext): Jurisdiction {
  return j === undefined || j === "$market" ? ctx.market : j;
}

function compare(ctx: EvalContext, path: string, n: number, op: (a: number, b: number) => boolean): EvalResult {
  const v = readPath(ctx, path);
  if (v === MISSING) return unknown(path);
  return of(typeof v === "number" && op(v, n));
}

function scalarEquals(a: unknown, b: Scalar): boolean {
  return a === b;
}

/** Evaluate a predicate. Unknown operators throw: the linter should have caught them. */
export function evaluate(p: Predicate, ctx: EvalContext): EvalResult {
  if ("always" in p) return T;
  if ("all" in p) {
    const missing: string[] = [];
    let sawUnknown = false;
    for (const sub of p.all) {
      const r = evaluate(sub, ctx);
      if (r.value === "false") return F;
      if (r.value === "unknown") { sawUnknown = true; missing.push(...r.missing); }
    }
    return sawUnknown ? { value: "unknown", missing: dedupe(missing) } : T;
  }
  if ("any" in p) {
    const missing: string[] = [];
    let sawUnknown = false;
    for (const sub of p.any) {
      const r = evaluate(sub, ctx);
      if (r.value === "true") return T;
      if (r.value === "unknown") { sawUnknown = true; missing.push(...r.missing); }
    }
    return sawUnknown ? { value: "unknown", missing: dedupe(missing) } : F;
  }
  if ("not" in p) {
    const r = evaluate(p.not, ctx);
    if (r.value === "unknown") return r;
    return of(r.value === "false");
  }
  if ("eq" in p) {
    const [path, value] = p.eq;
    const v = readPath(ctx, path);
    if (v === MISSING) return unknown(path);
    return of(scalarEquals(v, value));
  }
  if ("in" in p) {
    const [path, values] = p.in;
    const v = readPath(ctx, path);
    if (v === MISSING) return unknown(path);
    return of(values.some((x) => scalarEquals(v, x)));
  }
  if ("contains" in p) {
    const [path, value] = p.contains;
    const v = readPath(ctx, path);
    if (v === MISSING) return unknown(path);
    return of(Array.isArray(v) && v.some((x) => scalarEquals(x, value)));
  }
  if ("exists" in p) {
    const v = readPath(ctx, p.exists);
    if (v === MISSING) return F;
    if (typeof v === "string") return of(v.trim() !== "");
    if (Array.isArray(v)) return of(v.length > 0);
    if (typeof v === "object") return of(Object.keys(v as object).length > 0);
    return T;
  }
  if ("gt" in p) return compare(ctx, p.gt[0], p.gt[1], (a, b) => a > b);
  if ("gte" in p) return compare(ctx, p.gte[0], p.gte[1], (a, b) => a >= b);
  if ("lt" in p) return compare(ctx, p.lt[0], p.lt[1], (a, b) => a < b);
  if ("lte" in p) return compare(ctx, p.lte[0], p.lte[1], (a, b) => a <= b);
  if ("inEU" in p) {
    const v = readPath(ctx, p.inEU);
    if (v === MISSING) return unknown(p.inEU);
    return of(typeof v === "string" && EU.has(normalizeCountry(v)));
  }
  if ("localized" in p) {
    const v = readPath(ctx, p.localized);
    if (v === MISSING || typeof v !== "object") return F;
    const langs = MARKET_LANGUAGES[ctx.market];
    const keys = Object.entries(v as Record<string, unknown>)
      .filter(([, text]) => typeof text === "string" && text.trim() !== "")
      .map(([k]) => k.toLowerCase().split("-")[0]);
    return of(keys.some((k) => langs.includes(k ?? "")));
  }
  if ("registered" in p) {
    const { obligation, register } = p.registered;
    const j = resolveJurisdiction(p.registered.jurisdiction, ctx);
    return of(
      ctx.seller.registrations.some(
        (r) =>
          r.obligation === obligation &&
          r.jurisdiction === j &&
          r.number.trim() !== "" &&
          (register === undefined || r.register.toLowerCase() === register.toLowerCase()) &&
          current(r.validTo, ctx.today),
      ),
    );
  }
  if ("inScheme" in p) {
    const j = resolveJurisdiction(p.inScheme.jurisdiction, ctx);
    return of(hasScheme(ctx, p.inScheme.obligation, j));
  }
  if ("hasRepresentative" in p) {
    const j = resolveJurisdiction(p.hasRepresentative.jurisdiction, ctx);
    return of(
      (ctx.seller.representatives ?? []).some(
        (r) => r.obligation === p.hasRepresentative.obligation && r.jurisdiction === j && current(r.validTo, ctx.today),
      ),
    );
  }
  throw new Error(`unknown predicate operator: ${Object.keys(p).join(", ")}`);
}

function hasScheme(ctx: EvalContext, obligation: ObligationId, j: Jurisdiction): boolean {
  return (ctx.seller.schemes ?? []).some(
    (s) => s.obligation === obligation && s.jurisdiction === j && current(s.validTo, ctx.today),
  );
}

/** Registers sometimes use EL for Greece; ISO uses GR. */
export function normalizeCountry(c: string): string {
  const up = c.trim().toUpperCase();
  return up === "EL" ? "GR" : up;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Collect every context path a predicate reads (for the linter). */
export function predicatePaths(p: Predicate): string[] {
  const out: string[] = [];
  const walk = (q: Predicate): void => {
    if ("all" in q) q.all.forEach(walk);
    else if ("any" in q) q.any.forEach(walk);
    else if ("not" in q) walk(q.not);
    else if ("eq" in q) out.push(q.eq[0]);
    else if ("in" in q) out.push(q.in[0]);
    else if ("contains" in q) out.push(q.contains[0]);
    else if ("exists" in q) out.push(q.exists);
    else if ("gt" in q) out.push(q.gt[0]);
    else if ("gte" in q) out.push(q.gte[0]);
    else if ("lt" in q) out.push(q.lt[0]);
    else if ("lte" in q) out.push(q.lte[0]);
    else if ("inEU" in q) out.push(q.inEU);
    else if ("localized" in q) out.push(q.localized);
  };
  walk(p);
  return out;
}
