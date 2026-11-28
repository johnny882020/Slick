// Turn the gap-check form into a Seller. Every field is plain text a seller can type.

import {
  EU_COUNTRIES,
  OBLIGATIONS,
  type CountryCode,
  type Jurisdiction,
  type ObligationId,
  type Seller,
  type SellerRole,
} from "@oneseat/contracts";

export class FormError extends Error {}

const ROLES: SellerRole[] = ["manufacturer", "importer", "distributor", "brand_owner", "fulfilment_provider"];
const EU = new Set<string>(EU_COUNTRIES);
const OBLIGATION_SET = new Set<string>(OBLIGATIONS);

export interface FormFields {
  get(name: string): string | undefined;
  getAll(name: string): string[];
}

function lines(text: string | undefined): string[][] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split(/\s*[,;]\s*/));
}

function jurisdiction(v: string | undefined, where: string): Jurisdiction {
  const j = (v ?? "").trim().toUpperCase();
  if (j === "EU" || EU.has(j)) return j as Jurisdiction;
  throw new FormError(`${where}: "${v ?? ""}" is not an EU country code like DE or FR`);
}

function obligation(v: string | undefined, where: string): ObligationId {
  const o = (v ?? "").trim().toLowerCase();
  if (OBLIGATION_SET.has(o)) return o as ObligationId;
  throw new FormError(`${where}: "${v ?? ""}" must be one of ${OBLIGATIONS.join(", ")}`);
}

function isoDate(v: string | undefined, where: string): string | undefined {
  const d = (v ?? "").trim();
  if (d === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new FormError(`${where}: "${d}" must be a date like 2027-12-31`);
  return d;
}

/** Build a Seller from form fields. Throws FormError with a plain message. */
export function sellerFromForm(f: FormFields): Seller {
  const legalName = (f.get("legalName") ?? "").trim();
  if (!legalName) throw new FormError("Please enter your company's legal name.");
  const establishedIn = (f.get("establishedIn") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(establishedIn)) throw new FormError("Please choose the country your business is established in.");
  const roles = f.getAll("roles").filter((r): r is SellerRole => (ROLES as string[]).includes(r));
  if (roles.length === 0) throw new FormError("Please tick at least one role (for example manufacturer or importer).");

  const seller: Seller = { id: "web-check", legalName, establishedIn, roles, registrations: [] };

  lines(f.get("registrations")).forEach((p, i) => {
    const where = `Registrations, line ${i + 1}`;
    if (p.length < 4) throw new FormError(`${where}: write country, duty, register, number (and optionally an end date)`);
    const validTo = isoDate(p[4], where);
    seller.registrations.push({ jurisdiction: jurisdiction(p[0], where), obligation: obligation(p[1], where), register: p[2]!, number: p[3]!, ...(validTo ? { validTo } : {}) });
  });
  const schemes = lines(f.get("schemes")).map((p, i) => {
    const where = `Take-back schemes, line ${i + 1}`;
    if (p.length < 3) throw new FormError(`${where}: write country, duty, scheme name`);
    return { jurisdiction: jurisdiction(p[0], where), obligation: obligation(p[1], where), scheme: p[2]! };
  });
  if (schemes.length) seller.schemes = schemes;
  const reps = lines(f.get("representatives")).map((p, i) => {
    const where = `Authorised representatives, line ${i + 1}`;
    if (p.length < 3) throw new FormError(`${where}: write country, duty, representative name`);
    return { jurisdiction: jurisdiction(p[0], where), obligation: obligation(p[1], where), name: p[2]! };
  });
  if (reps.length) seller.representatives = reps;
  const kg: Partial<Record<CountryCode, number>> = {};
  lines(f.get("annualPackagingKg")).forEach((p, i) => {
    const where = `Packaging per year, line ${i + 1}`;
    const j = jurisdiction(p[0], where);
    const n = Number((p[1] ?? "").replace(/\s/g, ""));
    if (j === "EU" || !Number.isFinite(n) || n < 0) throw new FormError(`${where}: write a country and kilograms, like NL, 12000`);
    kg[j] = n;
  });
  if (Object.keys(kg).length) seller.annualPackagingKg = kg;
  const est = (f.get("establishments") ?? "").split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (est.length) seller.establishments = est;

  const rpName = (f.get("rpName") ?? "").trim();
  if (rpName) {
    const rpCountry = (f.get("rpCountry") ?? "").trim().toUpperCase();
    const rpEmail = (f.get("rpEmail") ?? "").trim();
    seller.euResponsiblePerson = { name: rpName, country: rpCountry, ...(rpEmail ? { email: rpEmail } : {}) };
  }
  return seller;
}
