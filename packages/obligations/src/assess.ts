// The obligations engine: catalog × rulebook → Requirement rows. Deterministic; no AI.

import type {
  ChannelId,
  CountryCode,
  Product,
  Requirement,
  RequirementSpec,
  Rule,
  RulePack,
  Seller,
} from "@oneseat/contracts";
import { evaluate, inEffect, type EvalContext } from "@oneseat/rulebook";
import { countryName } from "./names.js";

export interface AssessInput {
  seller: Seller;
  products: Product[];
  packs: RulePack[];
  /** ISO date the audit is for. */
  today: string;
  /** Registrations that end within this many days count as "expiring". Default 30. */
  expiringWithinDays?: number;
}

/** A friendly description of a context path, for "we need to know…" reasons. */
export function describePath(path: string): string {
  const known: Record<string, string> = {
    "product.shipsPackaged": "whether it ships in packaging",
    "product.consumerProduct": "whether it is sold to consumers",
    "product.electrical": "whether it is electrical or electronic",
    "product.weeeCategory": "its electronics category",
    "product.battery": "whether it contains a battery",
    "product.battery.included": "whether it contains a battery",
    "product.battery.category": "the battery type",
    "product.textile": "whether it is a textile product",
    "product.packaging": "its packaging materials and weights",
    "product.safety.manufacturer.country": "the manufacturer's country",
    "seller.establishedIn": "the country your business is established in",
    "seller.roles": "your role (manufacturer, importer or reseller)",
  };
  return known[path] ?? path.replace(/^(product|seller)\./, "").replace(/\./g, " ");
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function expiringRegistration(seller: Seller, pack: RulePack, market: CountryCode, today: string, horizon: string) {
  const j = pack.jurisdiction === "EU" ? market : pack.jurisdiction;
  return seller.registrations.find(
    (r) => r.obligation === pack.obligation && r.jurisdiction === j && r.validTo !== undefined && r.validTo >= today && r.validTo <= horizon,
  );
}

function row(
  pack: RulePack,
  rule: Rule,
  spec: RequirementSpec,
  product: Product,
  market: CountryCode,
  channel: ChannelId,
  status: Requirement["status"],
  reason: string,
  missingData?: string[],
): Requirement {
  const blocksListingOn = (rule.marketplaceChecks ?? []).filter((m) => m.blocksListing).map((m) => m.channel);
  const cited = new Set(rule.citations);
  return {
    id: [product.sku, market, channel, rule.id, spec.key].join("|"),
    sku: product.sku,
    market,
    channel,
    obligation: pack.obligation,
    ruleId: rule.id,
    requirementKey: spec.key,
    label: spec.label,
    status,
    reason,
    ...(missingData && missingData.length > 0 ? { missingData } : {}),
    severity: rule.severity,
    blocksListingOn,
    rulePack: { id: pack.id, version: pack.version, reviewStatus: pack.review.status },
    citations: pack.citations.filter((c) => cited.has(c.id)),
  };
}

/** Evaluate every in-force pack for every listing of every product. */
export function assess(input: AssessInput): Requirement[] {
  const { seller, products, today } = input;
  const horizon = addDays(today, input.expiringWithinDays ?? 30);
  const packs = input.packs.filter((p) => inEffect(p, today));
  const out: Requirement[] = [];

  for (const product of products) {
    for (const listing of product.listings) {
      const { market, channel } = listing;
      const ctx: EvalContext = { seller, product, market, channel, today };
      for (const pack of packs) {
        if (pack.jurisdiction !== "EU" && pack.jurisdiction !== market) continue;
        for (const rule of pack.rules) {
          const applies = evaluate(rule.appliesWhen, ctx);
          if (applies.value === "false") continue;
          for (const spec of rule.requires) {
            if (applies.value === "unknown") {
              const needs = applies.missing.map(describePath).join(", ");
              out.push(row(pack, rule, spec, product, market, channel, "unknown",
                `We can't tell yet whether "${rule.title}" applies. We need to know ${needs}.`, applies.missing));
              continue;
            }
            const sat = evaluate(spec.satisfiedWhen, ctx);
            if (sat.value === "true") {
              const exp = spec.kind === "registration" ? expiringRegistration(seller, pack, market, today, horizon) : undefined;
              if (exp) {
                out.push(row(pack, rule, spec, product, market, channel, "expiring",
                  `${spec.label} ${exp.number} ends on ${exp.validTo}. Renew it to keep selling in ${countryName(market)}.`));
              } else {
                out.push(row(pack, rule, spec, product, market, channel, "met", `${spec.label} is in place.`));
              }
            } else if (sat.value === "false") {
              out.push(row(pack, rule, spec, product, market, channel, "missing",
                `${spec.label} is missing for ${countryName(market)}. ${rule.summary.trim()}`));
            } else {
              const needs = sat.missing.map(describePath).join(", ");
              out.push(row(pack, rule, spec, product, market, channel, "unknown",
                `We need to know ${needs} to check ${spec.label.toLowerCase()}.`, sat.missing));
            }
          }
        }
      }
    }
  }
  return out;
}
