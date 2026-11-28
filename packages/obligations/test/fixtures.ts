import type { Product, RulePack, Seller } from "@oneseat/contracts";
import { loadPackText } from "@oneseat/rulebook";

const DE = `
id: de.packaging_epr
version: 2026.11.1
jurisdiction: DE
obligation: packaging_epr
title: Packaging in Germany
effectiveFrom: "2019-01-01"
confidence: medium
review: { status: draft }
citations:
  - { id: law, title: VerpackG 9, url: "https://www.gesetze-im-internet.de/verpackg/__9.html", publisher: BMJ, kind: law, retrieved: "2026-11-28", quote: "registrieren" }
  - { id: amz, title: Amazon EPR, url: "https://sellercentral.amazon.de/epr", publisher: Amazon, kind: marketplace_policy, retrieved: "2026-11-28", quote: "EPR" }
rules:
  - id: de.packaging_epr.registration
    title: Register in LUCID
    summary: Register before selling packaged goods in Germany.
    severity: blocking
    citations: [law]
    appliesWhen:
      all:
        - { eq: [market, DE] }
        - { eq: [product.shipsPackaged, true] }
        - { contains: [seller.roles, manufacturer] }
    requires:
      - key: registration_number
        label: LUCID registration number
        kind: registration
        satisfiedWhen: { registered: { obligation: packaging_epr, register: LUCID } }
        whoMayFile: [producer]
        filing: { channel: portal, url: "https://lucid.verpackungsregister.org/", leadTimeDays: [1, 7] }
      - key: scheme
        label: Dual system contract
        kind: scheme_contract
        satisfiedWhen: { inScheme: { obligation: packaging_epr } }
    marketplaceChecks:
      - { channel: amazon, blocksListing: true, citations: [amz] }
`;

const EU = `
id: eu.gpsr
version: 2026.11.1
jurisdiction: EU
obligation: gpsr
title: Product safety
effectiveFrom: "2024-12-13"
confidence: medium
review: { status: verified }
citations:
  - { id: gpsr, title: GPSR, url: "https://eur-lex.europa.eu/eli/reg/2023/988/oj", publisher: EU, kind: law, retrieved: "2026-11-28", quote: "responsible" }
rules:
  - id: eu.gpsr.responsible_person
    title: EU responsible person
    summary: Non-EU manufacturers need an EU responsible person.
    severity: blocking
    citations: [gpsr]
    appliesWhen:
      all:
        - { eq: [product.consumerProduct, true] }
        - { not: { inEU: seller.establishedIn } }
    requires:
      - key: responsible_person
        label: EU responsible person
        kind: representative
        satisfiedWhen: { exists: seller.euResponsiblePerson }
  - id: eu.gpsr.warnings
    title: Warnings in the local language
    summary: Safety information must be in the market's language.
    severity: high
    citations: [gpsr]
    appliesWhen: { eq: [product.consumerProduct, true] }
    requires:
      - key: warnings
        label: Safety warnings in the local language
        kind: data_field
        satisfiedWhen: { localized: product.safety.warnings }
      - key: electrical_check
        label: Electrical safety note
        kind: label
        satisfiedWhen: { eq: [product.electrical, false] }
  - id: eu.gpsr.declaration
    title: Annual declaration
    summary: An example declaration rule.
    severity: low
    citations: [gpsr]
    appliesWhen: { eq: [product.textile, true] }
    requires:
      - key: declaration
        label: Annual declaration
        kind: declaration
        satisfiedWhen: { exists: product.attributes.declared }
        filing: { channel: portal, url: "https://example.eu/declare" }
        recurring: { every: year, note: Every January. }
      - key: ar
        label: Authorised representative
        kind: registration
        satisfiedWhen: { registered: { obligation: gpsr } }
        whoMayFile: [authorised_representative]
        filing: { channel: portal_eid }
`;

export const packs = (): RulePack[] => [loadPackText(DE, "de").pack!, loadPackText(EU, "eu").pack!];

export function seller(over: Partial<Seller> = {}): Seller {
  return { id: "s1", legalName: "Example Seller Ltd", establishedIn: "GB", roles: ["manufacturer"], registrations: [], ...over };
}

export function product(over: Partial<Product> = {}): Product {
  return {
    sku: "A1",
    title: "Speaker",
    consumerProduct: true,
    shipsPackaged: true,
    electrical: true,
    textile: false,
    listings: [{ channel: "amazon", market: "DE" }],
    ...over,
  };
}
