# Rule pack format

A rule pack holds the rules for one jurisdiction and one obligation, for example packaging
take-back in Germany. Packs live in `rules/<jurisdiction>/<obligation>.yaml`, for example
`rules/de/packaging_epr.yaml` or `rules/eu/gpsr.yaml`. The types are in
`packages/contracts/src/compliance.ts` (`RulePack`, `Rule`, `RequirementSpec`, `Predicate`,
`Citation`), and `packages/rulebook` loads, lints and evaluates the packs.

## Principles

1. **Every rule cites an official source.** Prefer, in order: EUR-Lex; the national law portal
   or gazette; the register or regulator's own pages; the marketplace's own policy page. Secondary
   sources (law firms, consultancies) may support a citation but never stand alone; mark them
   `kind: secondary`.
2. **Quotes are short** (under 300 characters), in the source language, and copied exactly.
3. **Predicates are deterministic.** They read only the context below. If a predicate reads a
   field the seller hasn't supplied, the result is "unknown" and the seller is asked for the data.
   Never guess.
4. **Plain language for sellers.** `title`, `summary`, `label` and `consequence` are written for
   a shop owner, not for a lawyer.
5. **Uncertainty is written down.** Anything you could not confirm goes in `openQuestions`, and
   `confidence` says how sure the pack is overall. New packs are always `review.status: draft`.

## Evaluation context

| Path | Meaning |
|---|---|
| `market` | The EU country being sold into (`DE`, `FR`, …) |
| `channel` | The marketplace or shop (`amazon`, `bol`, `shopify`, …) |
| `seller.establishedIn` | Country the seller's business is established in (any ISO alpha-2) |
| `seller.roles` | List: `manufacturer`, `importer`, `distributor`, `brand_owner`, `fulfilment_provider` |
| `seller.euResponsiblePerson` | Address of the seller's EU responsible person, if any |
| `seller.establishments` | Countries where the seller has a branch, besides `establishedIn` (v1.2) |
| `seller.annualPackagingKg.$market` | Packaging placed on this market last year, in kg (v1.2) |
| `seller.attributes.<name>` | Seller-level facts a rule needs, e.g. `de_ve_filed_for_last_year` (v1.2) |
| `product.consumerProduct` | Consumer product (true/false) |
| `product.shipsPackaged` | Sold with packaging, including shipping packaging (true/false) |
| `product.packaging` | List of `{material, weightGrams, role}` |
| `product.electrical` | Electrical or electronic equipment (true/false) |
| `product.weeeCategory` | 1–6 |
| `product.battery.included`, `product.battery.category` | Battery present; `portable`, `lmt`, `sli`, `industrial`, `ev` |
| `product.textile` | Textile product (true/false) |
| `product.safety.manufacturer`, `.responsiblePerson`, `.identifier`, `.warnings`, `.shownOnListing` | Product safety data |

## Predicate operators

`$market` stands for the country being evaluated, both as a path segment
(`seller.annualPackagingKg.$market`) and as a value (`{ contains: [seller.establishments, $market] }`).
Use a fix `group` on requirements that the seller satisfies with one action, and give each group a
title in the pack's `fixGroups` map.

```yaml
{ always: true }
{ all: [ <predicate>, ... ] }
{ any: [ <predicate>, ... ] }
{ not: <predicate> }
{ eq: [ "product.electrical", true ] }
{ in: [ "channel", ["amazon", "ebay"] ] }
{ contains: [ "seller.roles", "importer" ] }
{ exists: "product.safety.responsiblePerson" }
{ gt: [ "product.battery.capacityWh", 2000 ] }     # also gte, lt, lte
{ inEU: "seller.establishedIn" }
{ localized: "product.safety.warnings" }            # has text in an official language of $market
{ registered: { obligation: packaging_epr } }       # jurisdiction defaults to $market
{ registered: { obligation: packaging_epr, jurisdiction: DE, register: LUCID } }
{ inScheme: { obligation: packaging_epr } }
{ hasRepresentative: { obligation: packaging_epr } }
{ declared: { obligation: packaging_epr, kind: annual_declaration } }      # filed for last year (v1.2)
{ declared: { obligation: packaging_epr, kind: annual_declaration, period: this_year } }
```

## Example

```yaml
id: de.packaging_epr
version: 2026.11.1
jurisdiction: DE
obligation: packaging_epr
title: Packaging registration and take-back in Germany
effectiveFrom: "2019-01-01"
effectiveTo: null
confidence: medium
review:
  status: draft
openQuestions:
  - Confirm the LUCID registration number format.
citations:
  - id: verpackg-9
    title: Verpackungsgesetz § 9 Registrierung
    url: https://www.gesetze-im-internet.de/verpackg/__9.html
    publisher: Bundesministerium der Justiz
    kind: law
    retrieved: "2026-11-28"
    quote: "Hersteller systembeteiligungspflichtiger Verpackungen sind verpflichtet, sich vor dem Inverkehrbringen von Verpackungen bei der Zentralen Stelle registrieren zu lassen."
rules:
  - id: de.packaging_epr.registration
    title: Register in LUCID before selling packaged goods in Germany
    summary: >
      Anyone who first puts packaged goods on the German market, including sellers based
      outside Germany who ship to German customers, must register in the LUCID packaging
      register before selling.
    severity: blocking
    consequence: Fines and a sales ban; marketplaces must not let unregistered sellers sell.
    citations: [verpackg-9]
    appliesWhen:
      all:
        - { eq: [ market, DE ] }
        - { eq: [ product.shipsPackaged, true ] }
        - any:
            - { contains: [ seller.roles, manufacturer ] }
            - { contains: [ seller.roles, importer ] }
            - { contains: [ seller.roles, brand_owner ] }
    requires:
      - key: registration_number
        label: LUCID registration number
        kind: registration
        satisfiedWhen: { registered: { obligation: packaging_epr, register: LUCID } }
        whoMayFile: [producer]
        filing:
          channel: portal
          url: https://lucid.verpackungsregister.org/
          leadTimeDays: [1, 7]
          feeNote: Registration is free; take-back scheme fees are separate.
    marketplaceChecks:
      - channel: amazon
        blocksListing: true
        note: Amazon.de asks for the LUCID number before packaged products can be sold.
```

The example shows the format. Its legal content is for illustration and must be researched like
any other pack.

## Review states

| State | Set by | Meaning |
|---|---|---|
| `draft` | Research agent | Written from sources, not yet independently checked |
| `verified` | Verifier agent | Every citation re-read, quotes match, and dates are current |
| `approved` | Named legal reviewer | Signed off; may be used for filings |
| `retired` | Lead | Kept for history; no longer evaluated |

Audits may use `draft` and `verified` packs, and must say so on the report. Filings may use only
`approved` packs.
