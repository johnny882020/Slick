// Group open requirements into fixes: one card per thing the seller must do.

import type { Fix, FixEffect, Jurisdiction, Requirement, RequirementSpec, RulePack, Severity } from "@oneseat/contracts";
import { countryName } from "./names.js";

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, high: 1, medium: 2, low: 3 };

const EFFECTS: Record<RequirementSpec["kind"], FixEffect[]> = {
  registration: ["submit"],
  scheme_contract: ["pay", "submit"],
  representative: ["pay", "submit"],
  data_field: ["publish"],
  label: ["publish"],
  declaration: ["submit"],
};

function steps(spec: RequirementSpec, where: string, skus: number): string[] {
  const who = spec.whoMayFile ?? [];
  const arOnly = who.includes("authorised_representative") && !who.includes("producer");
  const url = spec.filing?.url ? ` (${spec.filing.url})` : "";
  switch (spec.kind) {
    case "registration": {
      const s = ["Check the company and product details we pre-filled from your catalog."];
      if (spec.filing?.channel === "portal_eid") s.push(`Log in to the register for ${where} with a national eID or digital certificate; we hand you every field ready to paste.`);
      if (arOnly) s.push(`An authorised representative files for you in ${where}; we send them the prepared file.`);
      else if (spec.filing?.channel === "email") s.push("Approve the prepared email and forms; we send them to the register.");
      s.push(`Submit the registration${url}.`);
      s.push("Add the registration number here; we put it on your listings and keep it on file.");
      return s;
    }
    case "scheme_contract":
      return [
        `Pick a take-back scheme for ${where}; we show the licensed schemes and what they charge.`,
        "Sign the contract and pay the licence fee for your expected volumes.",
        "Record the contract here so reports and renewals are tracked.",
      ];
    case "representative":
      return [
        `Appoint an authorised representative for ${where}; we introduce vetted partners with prices.`,
        "Sign the mandate.",
        "Record the representative here; we share the details with your listings where required.",
      ];
    case "declaration":
      return [
        `Review the ${spec.label.toLowerCase()} we prepare from your sales and packaging data.`,
        `Approve and submit it${url}.`,
        ...(spec.recurring ? [`Repeat every ${spec.recurring.every}: ${spec.recurring.note}`] : []),
      ];
    default:
      return [
        `Add ${spec.label.toLowerCase()} for ${skus} product${skus === 1 ? "" : "s"}; we suggest values from your documents.`,
        "Approve publishing the details to your listings.",
      ];
  }
}

function specFor(packById: Map<string, RulePack>, r: Requirement): { pack?: RulePack; spec?: RequirementSpec } {
  const pack = packById.get(r.rulePack.id);
  const spec = pack?.rules.find((x) => x.id === r.ruleId)?.requires.find((q) => q.key === r.requirementKey);
  return { ...(pack ? { pack } : {}), ...(spec ? { spec } : {}) };
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Build fixes from the open (missing or expiring) requirements, most urgent first. */
export function buildFixes(requirements: Requirement[], packs: RulePack[]): Fix[] {
  const packById = new Map(packs.map((p) => [p.id, p]));
  const groups = new Map<string, Requirement[]>();
  for (const r of requirements) {
    if (r.status !== "missing" && r.status !== "expiring") continue;
    const { pack, spec } = specFor(packById, r);
    // National duties are fixed once per country; EU-wide product data once across markets.
    const scope = pack?.jurisdiction === "EU" ? "EU" : r.market;
    // Requirements in the same fix group are one action for the seller.
    const what = spec?.group && pack?.fixGroups?.[spec.group] ? `${r.rulePack.id}|group:${spec.group}` : `${r.ruleId}|${r.requirementKey}`;
    const key = `${what}|${scope}|${r.status}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const fixes: Fix[] = [];
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    const { pack, spec } = specFor(packById, first);
    const parts = key.split("|");
    const scope = parts[parts.length - 2] as Jurisdiction;
    const markets = [...new Set(rows.map((r) => r.market))].sort();
    const where = scope === "EU" ? markets.map(countryName).join(", ") : countryName(scope);
    const skus = new Set(rows.map((r) => r.sku)).size;
    const listings = new Set(rows.map((r) => `${r.sku}|${r.market}|${r.channel}`));
    const blocking = new Set(rows.filter((r) => r.blocksListingOn.includes(r.channel)).map((r) => `${r.sku}|${r.market}|${r.channel}`));

    // Every distinct requirement in this fix, in first-seen order.
    const specs: RequirementSpec[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.ruleId}|${r.requirementKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const s = specFor(packById, r).spec;
      if (s) specs.push(s);
    }
    const groupTitle = spec?.group ? pack?.fixGroups?.[spec.group] : undefined;
    const kind = spec?.kind ?? "data_field";
    const title = groupTitle
      ? `${groupTitle} — ${where}`
      : first.status === "expiring"
        ? `Renew ${first.label} — ${where}`
        : kind === "registration"
          ? `Get ${first.label} — ${where}`
          : `${capitalize(first.label)} — ${where}`;

    let fixSteps = spec ? steps(spec, where, skus) : [`Resolve: ${first.label}.`];
    if (specs.length > 1) fixSteps = [...fixSteps, `This one fix covers: ${specs.map((s) => s.label).join("; ")}.`];
    const effects = [...new Set(specs.flatMap((s) => EFFECTS[s.kind]))];
    const who = [...new Set(specs.flatMap((s) => s.whoMayFile ?? []))];
    const leads = specs.map((s) => s.filing?.leadTimeDays).filter((x): x is [number, number] => x !== undefined);
    const leadTimeDays: [number, number] | undefined = leads.length > 0 ? [Math.min(...leads.map((l) => l[0])), Math.max(...leads.map((l) => l[1]))] : undefined;

    fixes.push({
      id: key,
      title,
      requirementIds: rows.map((r) => r.id),
      obligation: first.obligation,
      jurisdiction: scope,
      steps: fixSteps,
      effects: effects.length > 0 ? effects : EFFECTS[kind],
      ...(who.length > 0 ? { whoMayFile: who } : {}),
      ...(spec?.filing?.channel ? { filingChannel: spec.filing.channel } : {}),
      ...(leadTimeDays ? { leadTimeDays } : {}),
      impact: { skus, listings: listings.size, blockingListings: blocking.size },
      status: "proposed",
    });
  }

  const severityOf = (f: Fix) => Math.min(...f.requirementIds.map((id) => SEVERITY_RANK[requirements.find((r) => r.id === id)!.severity]));
  return fixes.sort(
    (a, b) =>
      b.impact.blockingListings - a.impact.blockingListings ||
      severityOf(a) - severityOf(b) ||
      b.impact.listings - a.impact.listings ||
      a.title.localeCompare(b.title),
  );
}
