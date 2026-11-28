import type { Product, Seller } from "@oneseat/contracts";
import type { EvalContext } from "../src/predicate.js";

export const PACK_YAML = `
id: de.packaging_epr
version: 2026.11.1
jurisdiction: DE
obligation: packaging_epr
title: Packaging in Germany
effectiveFrom: "2019-01-01"
effectiveTo: null
confidence: medium
review:
  status: draft
citations:
  - id: verpackg-9
    title: VerpackG 9
    url: https://www.gesetze-im-internet.de/verpackg/__9.html
    publisher: BMJ
    kind: law
    retrieved: "2026-11-28"
    quote: "Hersteller sind verpflichtet, sich registrieren zu lassen."
  - id: amazon-epr
    title: Amazon EPR help
    url: https://sellercentral.amazon.de/help/epr
    publisher: Amazon
    kind: marketplace_policy
    retrieved: "2026-11-28"
rules:
  - id: de.packaging_epr.registration
    title: Register in LUCID
    summary: Register before selling packaged goods in Germany.
    severity: blocking
    citations: [verpackg-9]
    appliesWhen:
      all:
        - { eq: [market, DE] }
        - { eq: [product.shipsPackaged, true] }
        - any:
            - { contains: [seller.roles, manufacturer] }
            - { contains: [seller.roles, importer] }
    requires:
      - key: registration_number
        label: LUCID registration number
        kind: registration
        satisfiedWhen: { registered: { obligation: packaging_epr, register: LUCID } }
        whoMayFile: [producer]
        filing: { channel: portal, url: "https://lucid.verpackungsregister.org/", leadTimeDays: [1, 7] }
        numberFormat: "^DE\\\\d{13}$"
      - key: scheme
        label: Dual system contract
        kind: scheme_contract
        satisfiedWhen: { inScheme: { obligation: packaging_epr } }
        recurring: { every: year, note: Annual report }
    marketplaceChecks:
      - { channel: amazon, blocksListing: true, citations: [amazon-epr] }
`;

export function seller(over: Partial<Seller> = {}): Seller {
  return {
    id: "s1",
    legalName: "Acme Trading Ltd",
    establishedIn: "GB",
    roles: ["manufacturer"],
    registrations: [],
    ...over,
  };
}

export function product(over: Partial<Product> = {}): Product {
  return {
    sku: "SKU-1",
    title: "Bluetooth speaker",
    listings: [{ channel: "amazon", market: "DE" }],
    shipsPackaged: true,
    consumerProduct: true,
    ...over,
  };
}

export function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return { seller: seller(), product: product(), market: "DE", channel: "amazon", today: "2026-11-28", ...over };
}
