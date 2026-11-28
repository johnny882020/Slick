// 5-field cron (minute hour day-of-month month day-of-week), local time: validation and
// a plain-English description for the Schedules screen.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
] as const;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every weekday at 9:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00", cron: "0 9 * * 1" },
  { label: "Every day at 8:00", cron: "0 8 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "First day of the month at 9:00", cron: "0 9 1 * *" },
];

function toNumber(token: string, f: (typeof FIELDS)[number]): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const names = "names" in f ? (f.names as readonly string[]) : undefined;
  const i = names?.indexOf(token.toLowerCase()) ?? -1;
  if (i === -1) return null;
  return i + (f.name === "month" ? 1 : 0);
}

/** null if valid, else a sentence saying what is wrong. */
export function cronError(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (expr.trim() === "") return "Enter a schedule.";
  if (parts.length !== 5) return `A schedule has 5 parts (minute hour day month weekday); this has ${parts.length}.`;
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i]!;
    for (const item of parts[i]!.split(",")) {
      const m = item.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i);
      if (!m) return `The ${f.name} part "${parts[i]}" is not valid.`;
      const [, range, step] = m;
      if (step !== undefined && (Number(step) < 1 || Number(step) > f.max)) return `The ${f.name} step "${step}" is out of range.`;
      if (range === "*") continue;
      const [a, b] = range!.split("-");
      const lo = toNumber(a!, f);
      const hi = b === undefined ? lo : toNumber(b, f);
      if (lo === null || hi === null) return `The ${f.name} part "${parts[i]}" is not valid.`;
      if (lo < f.min || hi > f.max || lo > hi) return `The ${f.name} must be between ${f.min} and ${f.max}.`;
    }
  }
  return null;
}

function hhmm(h: string, m: string): string {
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

/** Plain-English description; falls back to the expression. */
export function describeCron(expr: string): string {
  if (cronError(expr)) return expr;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/) as [string, string, string, string, string];
  const num = /^\d+$/;
  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return "Every minute";
  const step = min.match(/^\*\/(\d+)$/);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${step[1]} minutes`;
  if (num.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return min === "0" ? "Every hour" : `Every hour at minute ${min}`;
  if (!num.test(min) || !num.test(hour)) return `Cron: ${expr.trim()}`;
  const at = hhmm(hour, min);
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${at}`;
    if (dow === "1-5") return `Every weekday at ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Every weekend day at ${at}`;
    const days = dow.split(",");
    if (days.every((d) => /^[0-7]$/.test(d))) {
      const names = days.map((d) => DAY_NAMES[Number(d) % 7]!);
      return `Every ${names.join(", ")} at ${at}`;
    }
  }
  if (num.test(dom) && mon === "*" && dow === "*") return `On day ${dom} of every month at ${at}`;
  return `Cron: ${expr.trim()}`;
}
