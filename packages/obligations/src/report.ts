// The gap audit: requirements, the "Can I sell?" map, fixes and data gaps in one report.

import type {
  AuditReport,
  ChannelId,
  CountryCode,
  MapCell,
  Product,
  Requirement,
  RequirementStatus,
  RulePack,
  Seller,
} from "@oneseat/contracts";
import { inEffect } from "@oneseat/rulebook";
import { assess } from "./assess.js";
import { buildFixes } from "./fixes.js";
import { countryName } from "./names.js";

export interface AuditInput {
  seller: Seller;
  products: Product[];
  packs: RulePack[];
  today: string;
  /** Override the generated-at timestamp (tests). */
  generatedAt?: string;
}

const OPEN: RequirementStatus[] = ["missing", "expiring"];

export function buildMap(products: Product[], requirements: Requirement[], packs: RulePack[]): MapCell[] {
  const covered = new Set(packs.filter((p) => p.jurisdiction !== "EU").map((p) => p.jurisdiction));
  const bySkuCell = new Map<string, Requirement[]>();
  for (const r of requirements) {
    const k = `${r.market}|${r.channel}|${r.sku}`;
    bySkuCell.set(k, [...(bySkuCell.get(k) ?? []), r]);
  }
  const cells = new Map<string, MapCell>();
  for (const p of products) {
    for (const l of p.listings) {
      const ck = `${l.market}|${l.channel}`;
      const cell = cells.get(ck) ?? { market: l.market, channel: l.channel, skus: 0, skusMet: 0, skusAtRisk: 0, skusUnknown: 0, blockingGaps: 0, state: "green" as const };
      cell.skus += 1;
      const rows = bySkuCell.get(`${ck}|${p.sku}`) ?? [];
      const open = rows.filter((r) => OPEN.includes(r.status));
      if (open.length > 0) cell.skusAtRisk += 1;
      else if (rows.some((r) => r.status === "unknown")) cell.skusUnknown += 1;
      else cell.skusMet += 1;
      cell.blockingGaps += open.filter((r) => r.blocksListingOn.includes(l.channel) || r.severity === "blocking").length;
      cells.set(ck, cell);
    }
  }
  for (const c of cells.values()) {
    c.state = !covered.has(c.market) ? "grey" : c.blockingGaps > 0 ? "red" : c.skusAtRisk > 0 || c.skusUnknown > 0 ? "amber" : "green";
  }
  return [...cells.values()].sort((a, b) => a.market.localeCompare(b.market) || String(a.channel).localeCompare(String(b.channel)));
}

export function buildAudit(input: AuditInput): AuditReport {
  const { seller, products, today } = input;
  const packs = input.packs.filter((p) => inEffect(p, today));
  const requirements = assess({ seller, products, packs, today });
  const fixes = buildFixes(requirements, packs);
  const map = buildMap(products, requirements, packs);

  const byStatus: Record<RequirementStatus, number> = { met: 0, missing: 0, expiring: 0, unknown: 0, not_applicable: 0 };
  for (const r of requirements) byStatus[r.status] += 1;

  const markets = [...new Set(products.flatMap((p) => p.listings.map((l) => l.market)))].sort() as CountryCode[];
  const channels = [...new Set(products.flatMap((p) => p.listings.map((l) => l.channel)))].sort() as ChannelId[];
  const atRisk = new Set(requirements.filter((r) => OPEN.includes(r.status)).map((r) => r.sku));
  const unknownSkus = new Set(requirements.filter((r) => r.status === "unknown").map((r) => r.sku));
  const listingsAtRisk = new Set(
    requirements.filter((r) => OPEN.includes(r.status) && r.blocksListingOn.includes(r.channel)).map((r) => `${r.sku}|${r.market}|${r.channel}`),
  );

  const gapSkus = new Map<string, Set<string>>();
  for (const r of requirements) for (const path of r.missingData ?? []) gapSkus.set(path, (gapSkus.get(path) ?? new Set()).add(r.sku));
  const dataGaps = [...gapSkus].map(([path, s]) => ({ path, skus: s.size })).sort((a, b) => b.skus - a.skus || a.path.localeCompare(b.path));

  const covered = new Set(packs.filter((p) => p.jurisdiction !== "EU").map((p) => p.jurisdiction));
  const uncovered = markets.filter((m) => !covered.has(m));
  const unapproved = packs.filter((p) => p.review.status !== "approved");
  const disclaimers = [
    "This audit is information, not legal advice. Filings are made only after you approve them, and only from rules a qualified reviewer has signed off.",
  ];
  if (unapproved.length > 0) {
    disclaimers.push(
      `${unapproved.length} of ${packs.length} rule packs used here are not yet signed off by a legal reviewer (${unapproved.map((p) => `${p.id}: ${p.review.status}`).join(", ")}). Treat their results as a first check.`,
    );
  }
  if (uncovered.length > 0) {
    disclaimers.push(`National rules for ${uncovered.map(countryName).join(", ")} are not covered yet; only EU-wide rules were checked there.`);
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    seller: { id: seller.id, legalName: seller.legalName, establishedIn: seller.establishedIn, roles: seller.roles },
    rulebook: packs.map((p) => ({ id: p.id, version: p.version, reviewStatus: p.review.status })),
    summary: {
      products: products.length,
      listings: products.reduce((n, p) => n + p.listings.length, 0),
      markets,
      channels,
      requirements: requirements.length,
      byStatus,
      skusFullyMet: products.filter((p) => !atRisk.has(p.sku) && !unknownSkus.has(p.sku)).length,
      skusAtRisk: atRisk.size,
      listingsAtRiskOfBlock: listingsAtRisk.size,
    },
    map,
    requirements,
    fixes,
    dataGaps,
    disclaimers,
  };
}
