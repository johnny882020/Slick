// 5-field cron (minute hour day-of-month month day-of-week), evaluated in local time.
// Supports *, lists, ranges, steps (*/n, a-b/n, a/n), month and weekday names,
// 7 as Sunday, and the @hourly/@daily/@weekly/@monthly/@yearly aliases.
//
// Day rule (Vixie cron): when both day-of-month and day-of-week are restricted
// (neither field starts with "*"), a day matches if EITHER matches.
//
// Next-run search works on local wall-clock fields, not on timestamps, so it is
// independent of DST: a wall time that does not exist (spring forward) is skipped,
// and a wall time that happens twice (fall back) fires once.

export interface CronSpec {
  source: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>; // 1-12
  daysOfWeek: Set<number>; // 0-6, Sunday = 0
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronError extends Error {
  override name = "CronError";
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, namesBase: 0 },
];

function parseValue(raw: string, f: FieldDef): number {
  const up = raw.toUpperCase();
  if (f.names) {
    const i = f.names.indexOf(up);
    if (i >= 0) return i + (f.namesBase ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`invalid ${f.name} value "${raw}"`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new CronError(`${f.name} value ${n} is out of range ${f.min}-${f.max}`);
  return n;
}

function parseField(text: string, f: FieldDef): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`empty item in ${f.name} field "${text}"`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`invalid step in ${f.name} field "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronError(`invalid step "${stepPart}" in ${f.name}`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = f.min;
      hi = f.max === 7 ? 6 : f.max;
    } else if (rangePart!.includes("-")) {
      const [a, b, more] = rangePart!.split("-");
      if (more !== undefined || !a || !b) throw new CronError(`invalid range "${rangePart}" in ${f.name}`);
      lo = parseValue(a, f);
      hi = parseValue(b, f);
      if (lo > hi) throw new CronError(`range ${rangePart} in ${f.name} runs backwards`);
    } else {
      lo = parseValue(rangePart!, f);
      // "a/n" means from a to the end of the range.
      hi = stepPart !== undefined ? (f.max === 7 ? 6 : f.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const source = expr.trim();
  const expanded = ALIASES[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5)
    throw new CronError(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  return {
    source,
    minutes: parseField(mi, FIELDS[0]!),
    hours: parseField(h, FIELDS[1]!),
    daysOfMonth: parseField(dom, FIELDS[2]!),
    months: parseField(mo, FIELDS[3]!),
    daysOfWeek: parseField(dow, FIELDS[4]!),
    domRestricted: !dom.startsWith("*"),
    dowRestricted: !dow.startsWith("*"),
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

function dayMatches(spec: CronSpec, y: number, m0: number, d: number): boolean {
  const domOk = spec.daysOfMonth.has(d);
  const dowOk = spec.daysOfWeek.has(new Date(y, m0, d).getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

function nextIn(set: Set<number>, from: number, max: number): number | undefined {
  for (let v = from; v <= max; v++) if (set.has(v)) return v;
  return undefined;
}

/** True if the local wall-clock minute of `date` matches. */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  return (
    spec.minutes.has(date.getMinutes()) &&
    spec.hours.has(date.getHours()) &&
    spec.months.has(date.getMonth() + 1) &&
    dayMatches(spec, date.getFullYear(), date.getMonth(), date.getDate())
  );
}

/**
 * The first local time strictly after `from` that matches, or undefined when none
 * exists within `horizonYears` (e.g. "0 0 30 2 *").
 */
export function nextRun(specOrExpr: CronSpec | string, from: Date, horizonYears = 8): Date | undefined {
  const spec = typeof specOrExpr === "string" ? parseCron(specOrExpr) : specOrExpr;
  let y = from.getFullYear();
  let mo = from.getMonth();
  let d = from.getDate();
  let h = from.getHours();
  let mi = from.getMinutes() + 1;
  const endYear = y + horizonYears;
  for (let guard = 0; guard < 1_000_000; guard++) {
    // Normalise carries.
    if (mi > 59) {
      mi = 0;
      h++;
    }
    if (h > 23) {
      h = 0;
      mi = 0;
      d++;
    }
    if (d > daysInMonth(y, mo)) {
      d = 1;
      h = 0;
      mi = 0;
      mo++;
    }
    if (mo > 11) {
      mo = 0;
      d = 1;
      h = 0;
      mi = 0;
      y++;
    }
    if (y > endYear) return undefined;

    if (!spec.months.has(mo + 1)) {
      mo++;
      d = 1;
      h = 0;
      mi = 0;
      if (mo > 11) {
        mo = 0;
        y++;
      }
      continue;
    }
    if (!dayMatches(spec, y, mo, d)) {
      d++;
      h = 0;
      mi = 0;
      continue;
    }
    const nh = nextIn(spec.hours, h, 23);
    if (nh === undefined) {
      d++;
      h = 0;
      mi = 0;
      continue;
    }
    if (nh !== h) {
      h = nh;
      mi = 0;
    }
    const nm = nextIn(spec.minutes, mi, 59);
    if (nm === undefined) {
      h++;
      mi = 0;
      continue;
    }
    mi = nm;
    const candidate = new Date(y, mo, d, h, mi, 0, 0);
    // A wall time that does not exist (DST gap) normalises to another time: skip it.
    if (
      candidate.getFullYear() === y &&
      candidate.getMonth() === mo &&
      candidate.getDate() === d &&
      candidate.getHours() === h &&
      candidate.getMinutes() === mi &&
      candidate.getTime() > from.getTime()
    )
      return candidate;
    mi++;
  }
  return undefined;
}
