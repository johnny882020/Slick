// Gate 1 coverage: parse istanbul json-summary files (vitest --coverage.reporter=json-summary).

import { readFile } from "node:fs/promises";

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface CoverageSummary {
  lines: CoverageMetric;
  statements?: CoverageMetric;
  functions?: CoverageMetric;
  branches?: CoverageMetric;
}

function metric(v: unknown): CoverageMetric | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = v as { total?: unknown; covered?: unknown; pct?: unknown };
  const total = typeof m.total === "number" ? m.total : NaN;
  const covered = typeof m.covered === "number" ? m.covered : NaN;
  if (!Number.isFinite(total) || !Number.isFinite(covered)) return undefined;
  const pct = typeof m.pct === "number" ? m.pct : total === 0 ? NaN : (covered / total) * 100;
  return { total, covered, pct };
}

/** Parse a coverage-summary.json object. Throws if it has no total.lines. */
export function parseCoverageSummary(raw: unknown): CoverageSummary {
  const total = (raw as { total?: Record<string, unknown> } | null)?.total;
  const lines = metric(total?.["lines"]);
  if (!lines) throw new Error("coverage summary has no total.lines");
  const out: CoverageSummary = { lines };
  for (const k of ["statements", "functions", "branches"] as const) {
    const m = metric(total?.[k]);
    if (m) out[k] = m;
  }
  return out;
}

export async function readCoverageSummary(path: string): Promise<CoverageSummary> {
  return parseCoverageSummary(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export interface CoverageVerdict {
  pkg: string;
  ok: boolean;
  pct?: number;
  message: string;
}

/** Compare a package's line coverage with the threshold. */
export function checkCoverage(pkg: string, summary: CoverageSummary | undefined, threshold: number, error?: string): CoverageVerdict {
  if (!summary) return { pkg, ok: false, message: `${pkg}: no coverage summary${error ? ` (${error})` : ""}` };
  const { pct, total, covered } = summary.lines;
  if (total === 0 || !Number.isFinite(pct)) return { pkg, ok: false, message: `${pkg}: coverage measured no lines; check coverage.include` };
  const ok = pct + 1e-9 >= threshold;
  return { pkg, ok, pct, message: `${pkg}: ${pct.toFixed(2)}% lines (${covered}/${total})${ok ? "" : `, below ${threshold}%`}` };
}
