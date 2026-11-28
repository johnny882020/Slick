// Compliance Keeper contracts, v1 (frozen 2026-11-28; change only with a lead review).
//
// The rulebook is data: versioned rule packs (one per jurisdiction × obligation) whose
// predicates are a small, deterministic expression language. The obligations engine
// evaluates those predicates against a seller, a product, a market and a channel and
// produces Requirement rows. AI may propose rules and classify products; it never makes
// the final determination at runtime.

// ---------- Places, channels, obligations ----------

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

/** An EU member state, ISO 3166-1 alpha-2 (Greece is GR, as in ISO; registers may use EL). */
export type CountryCode = (typeof EU_COUNTRIES)[number];

/** Official languages per member state (BCP 47 primary subtags), for `localized` checks. */
export const MARKET_LANGUAGES: Record<CountryCode, readonly string[]> = {
  AT: ["de"], BE: ["nl", "fr", "de"], BG: ["bg"], CY: ["el", "tr"], CZ: ["cs"], DE: ["de"],
  DK: ["da"], EE: ["et"], ES: ["es"], FI: ["fi", "sv"], FR: ["fr"], GR: ["el"], HR: ["hr"],
  HU: ["hu"], IE: ["en", "ga"], IT: ["it"], LT: ["lt"], LU: ["lb", "fr", "de"], LV: ["lv"],
  MT: ["mt", "en"], NL: ["nl"], PL: ["pl"], PT: ["pt"], RO: ["ro"], SE: ["sv"], SI: ["sl"],
  SK: ["sk"],
};

/** Where a rule pack applies: one member state, or the whole EU for regulations. */
export type Jurisdiction = CountryCode | "EU";

export const OBLIGATIONS = ["packaging_epr", "gpsr", "weee", "batteries_epr", "textiles_epr", "dpp"] as const;
export type ObligationId = (typeof OBLIGATIONS)[number];

export const OBLIGATION_LABELS: Record<ObligationId, string> = {
  packaging_epr: "Packaging registration and take-back",
  gpsr: "Product safety information",
  weee: "Electronics take-back",
  batteries_epr: "Batteries take-back",
  textiles_epr: "Textiles take-back",
  dpp: "Digital product passport",
};

/** Marketplace or shop system. Open set; these are the ones with connectors planned. */
export type ChannelId =
  | "amazon" | "bol" | "kaufland" | "allegro" | "ebay" | "etsy" | "zalando"
  | "cdiscount" | "otto" | "shopify" | "woocommerce" | "own_site"
  | (string & {});

export type SellerRole =
  | "manufacturer" // makes the product, or has it made and sells it under its own name or brand
  | "importer" // first places a product from outside the EU on the EU market
  | "distributor" // resells products already on the EU market
  | "brand_owner"
  | "fulfilment_provider";

// ---------- Seller and products ----------

export interface Address {
  name: string;
  street?: string;
  city?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2, any country. */
  country: string;
  email?: string;
  url?: string;
}

export interface Registration {
  obligation: ObligationId;
  jurisdiction: Jurisdiction;
  /** Register or scheme name, e.g. "LUCID", "SYDEREP", "stiftung ear". */
  register: string;
  number: string;
  holder?: string;
  /** Name of the authorised representative that filed, if any. */
  representative?: string;
  validFrom?: string;
  validTo?: string;
  /** Material streams or categories covered, when a register splits them. */
  scope?: string[];
  evidenceIds?: string[];
}

/** A take-back scheme (PRO / dual system) contract the seller holds. */
export interface SchemeMembership {
  obligation: ObligationId;
  jurisdiction: Jurisdiction;
  scheme: string;
  contractId?: string;
  validTo?: string;
}

export interface Seller {
  id: string;
  legalName: string;
  /** ISO 3166-1 alpha-2 of the country the business is established in (any country). */
  establishedIn: string;
  roles: SellerRole[];
  vatIds?: Partial<Record<CountryCode, string>>;
  registrations: Registration[];
  schemes?: SchemeMembership[];
  /** EU responsible person for product safety (GPSR Article 4), if the seller has one. */
  euResponsiblePerson?: Address;
  /** Authorised representatives appointed per jurisdiction and obligation. */
  representatives?: { jurisdiction: Jurisdiction; obligation: ObligationId; name: string; validTo?: string }[];
}

export type PackagingMaterial =
  | "paper_cardboard" | "plastic" | "glass" | "aluminium" | "steel" | "wood"
  | "composite" | "textile" | "ceramic" | "other";

export interface PackagingComponent {
  material: PackagingMaterial;
  weightGrams: number;
  /** sales = around the product; shipping = added for delivery; transport = pallets etc. */
  role: "sales" | "shipping" | "transport" | "service";
}

export type BatteryCategory = "portable" | "lmt" | "sli" | "industrial" | "ev";

export interface ProductSafetyInfo {
  manufacturer?: Address;
  /** EU responsible person printed on the product, packaging or documents. */
  responsiblePerson?: Address;
  /** Type, batch or serial number shown on the product. */
  identifier?: string;
  /** Warnings and safety information, keyed by BCP 47 language tag. */
  warnings?: Record<string, string>;
  /** Product images are on the listing. */
  hasImages?: boolean;
  /** Safety information is shown on the online listing (GPSR Article 19). */
  shownOnListing?: boolean;
}

export interface ChannelListing {
  channel: ChannelId;
  market: CountryCode;
  listingId?: string;
  /** Marketplace-reported status, if connected. */
  status?: "active" | "inactive" | "blocked" | "warning";
}

export interface Product {
  sku: string;
  title: string;
  gtin?: string;
  brand?: string;
  category?: string;
  /** Intended for (or likely used by) consumers. GPSR applies to consumer products. */
  consumerProduct?: boolean;
  listings: ChannelListing[];
  shipsPackaged?: boolean;
  packaging?: PackagingComponent[];
  electrical?: boolean;
  /** WEEE open-scope category 1–6, when known. */
  weeeCategory?: 1 | 2 | 3 | 4 | 5 | 6;
  battery?: { included: boolean; category?: BatteryCategory; removable?: boolean; capacityWh?: number };
  textile?: boolean;
  safety?: ProductSafetyInfo;
  /** Free attributes from imports, for rules that need them. */
  attributes?: Record<string, string | number | boolean>;
}

// ---------- The rule language ----------

/**
 * A path into the evaluation context, e.g. "product.electrical", "seller.roles",
 * "market", "channel", "product.safety.responsiblePerson.country".
 */
export type Path = string;
export type Scalar = string | number | boolean;

/**
 * Deterministic predicates with three-valued logic: a predicate that reads a missing
 * product or seller field evaluates to "unknown", which the engine reports as a data gap
 * instead of guessing. `$market` in a value means the market being evaluated.
 */
export type Predicate =
  | { always: true }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { eq: [Path, Scalar] }
  | { in: [Path, Scalar[]] }
  /** Array at path contains the value (e.g. seller.roles contains "importer"). */
  | { contains: [Path, Scalar] }
  | { exists: Path }
  | { gt: [Path, number] }
  | { gte: [Path, number] }
  | { lt: [Path, number] }
  | { lte: [Path, number] }
  /** True when the country at path is an EU member state. */
  | { inEU: Path }
  /**
   * The language-keyed record at path (e.g. product.safety.warnings) has an entry in an
   * official language of $market (see MARKET_LANGUAGES).
   */
  | { localized: Path }
  /** Seller holds a current registration for the obligation (jurisdiction defaults to $market). */
  | { registered: { obligation: ObligationId; jurisdiction?: Jurisdiction | "$market"; register?: string } }
  /** Seller has a current take-back scheme contract (jurisdiction defaults to $market). */
  | { inScheme: { obligation: ObligationId; jurisdiction?: Jurisdiction | "$market" } }
  /** Seller has a current authorised representative (jurisdiction defaults to $market). */
  | { hasRepresentative: { obligation: ObligationId; jurisdiction?: Jurisdiction | "$market" } };

export type FilingChannel = "api" | "portal" | "portal_eid" | "email" | "post" | "scheme" | "marketplace";
export type WhoMayFile = "producer" | "authorised_representative" | "marketplace" | "compliance_scheme";

export interface RequirementSpec {
  /** Stable key within the rule, e.g. "registration_number". */
  key: string;
  /** Plain-language label shown to sellers. */
  label: string;
  kind: "registration" | "scheme_contract" | "representative" | "data_field" | "label" | "declaration";
  satisfiedWhen: Predicate;
  whoMayFile?: WhoMayFile[];
  filing?: {
    channel: FilingChannel;
    url?: string;
    /** Typical days from starting to holding the number. */
    leadTimeDays?: [number, number];
    feeNote?: string;
  };
  /** Regex the registration number must match, when known. */
  numberFormat?: string;
  recurring?: { every: "month" | "quarter" | "year"; note: string };
}

export type Severity = "blocking" | "high" | "medium" | "low";

export interface MarketplaceCheck {
  channel: ChannelId;
  /** The marketplace hides or removes listings when this requirement is missing. */
  blocksListing: boolean;
  note?: string;
  citations?: string[];
}

export interface Rule {
  /** "<jurisdiction>.<obligation>.<name>", lower-case, e.g. "de.packaging_epr.registration". */
  id: string;
  title: string;
  /** Two or three plain sentences: what the duty is and who it falls on. */
  summary: string;
  appliesWhen: Predicate;
  requires: RequirementSpec[];
  severity: Severity;
  /** What can happen if ignored: fines, sales bans, delisting. */
  consequence?: string;
  /** Citation ids from the pack. Every rule needs at least one. */
  citations: string[];
  marketplaceChecks?: MarketplaceCheck[];
}

export interface Citation {
  id: string;
  title: string;
  /** Official source preferred: EUR-Lex, national gazette or register, regulator, marketplace policy page. */
  url: string;
  publisher: string;
  kind: "law" | "regulator_guidance" | "register" | "marketplace_policy" | "secondary";
  /** ISO date the source was last read. */
  retrieved: string;
  /** Short quote (under 300 characters) the rule relies on, in the source language. */
  quote?: string;
}

export type ReviewStatus = "draft" | "verified" | "approved" | "retired";

export interface RulePack {
  /** "<jurisdiction>.<obligation>", lower-case, e.g. "de.packaging_epr". */
  id: string;
  /** Calendar version: YYYY.MM.N. */
  version: string;
  jurisdiction: Jurisdiction;
  obligation: ObligationId;
  title: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  rules: Rule[];
  citations: Citation[];
  /**
   * draft = written by research; verified = an independent check re-read every citation;
   * approved = a named legal reviewer signed it off. Only approved packs are used for filings.
   */
  review: { status: ReviewStatus; reviewer?: string; reviewedAt?: string; notes?: string };
  confidence: "low" | "medium" | "high";
  /** Open questions for the legal reviewer. */
  openQuestions?: string[];
}

// ---------- Engine output ----------

export type RequirementStatus = "met" | "missing" | "expiring" | "unknown" | "not_applicable";

export interface Requirement {
  /** Deterministic id: sku|market|channel|ruleId|key. */
  id: string;
  sku: string;
  market: CountryCode;
  channel: ChannelId;
  obligation: ObligationId;
  ruleId: string;
  requirementKey: string;
  label: string;
  status: RequirementStatus;
  /** Plain-language reason, including which data was missing for "unknown". */
  reason: string;
  /** Data paths the engine needed but did not have (for "unknown"). */
  missingData?: string[];
  severity: Severity;
  /** Channels known to block the listing while this is missing. */
  blocksListingOn: ChannelId[];
  rulePack: { id: string; version: string; reviewStatus: ReviewStatus };
  citations: Citation[];
}

export type FixEffect = "submit" | "send" | "pay" | "publish";

export interface Money {
  amountCents: number;
  currency: "EUR";
}

export interface Fix {
  id: string;
  title: string;
  requirementIds: string[];
  obligation: ObligationId;
  jurisdiction: Jurisdiction;
  /** Ordered, plain-language steps. */
  steps: string[];
  /** Effects that need a person's approval before they happen. */
  effects: FixEffect[];
  whoMayFile?: WhoMayFile[];
  filingChannel?: FilingChannel;
  leadTimeDays?: [number, number];
  estimatedCost?: Money;
  /** Number of SKUs and listings this fix unblocks. */
  impact: { skus: number; listings: number; blockingListings: number };
  status: "proposed" | "approved" | "in_progress" | "done" | "rejected";
}

export interface Evidence {
  id: string;
  tenantId: string;
  kind: "registration_certificate" | "filing_receipt" | "contract" | "declaration" | "listing_snapshot" | "document" | "note";
  description: string;
  /** Hex SHA-256 of the stored bytes. */
  sha256: string;
  /** Hash of the previous entry in this tenant's chain ("" for the first). */
  prevHash: string;
  /** Hash over (prevHash, sha256, metadata): the chain link. */
  chainHash: string;
  createdAt: string;
  source: string;
}

export interface Deadline {
  id: string;
  obligation: ObligationId;
  jurisdiction: Jurisdiction;
  title: string;
  due: string;
  recurring?: { every: "month" | "quarter" | "year" };
  ruleId?: string;
}

/** One cell of the "Can I sell?" map. */
export interface MapCell {
  market: CountryCode;
  channel: ChannelId;
  skus: number;
  skusMet: number;
  skusAtRisk: number;
  skusUnknown: number;
  blockingGaps: number;
  state: "green" | "amber" | "red" | "grey";
}

export interface AuditReport {
  generatedAt: string;
  seller: Pick<Seller, "id" | "legalName" | "establishedIn" | "roles">;
  rulebook: { id: string; version: string; reviewStatus: ReviewStatus }[];
  summary: {
    products: number;
    listings: number;
    markets: CountryCode[];
    channels: ChannelId[];
    requirements: number;
    byStatus: Record<RequirementStatus, number>;
    skusFullyMet: number;
    skusAtRisk: number;
    listingsAtRiskOfBlock: number;
  };
  map: MapCell[];
  requirements: Requirement[];
  fixes: Fix[];
  /** Data the seller should add so "unknown" rows can be decided. */
  dataGaps: { path: string; skus: number }[];
  disclaimers: string[];
}

export const COMPLIANCE_CONTRACTS_VERSION = "1.0.0";
