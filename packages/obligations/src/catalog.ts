// Catalog import from CSV, the format every marketplace and shop can export.
//
// Columns (header names, case-insensitive; all optional except sku and listings):
//   sku, title, gtin, brand, category, consumer_product, ships_packaged, electrical, weee_category,
//   battery_included, battery_category, battery_capacity_wh, textile,
//   packaging            "paper_cardboard:120:sales;plastic:15:shipping"  (material:grams:role)
//   listings             "amazon:DE;amazon:FR;bol:NL"                     (channel:country)
//   manufacturer_name, manufacturer_country, manufacturer_email, manufacturer_address
//   responsible_person_name, responsible_person_country, responsible_person_email
//   identifier, shown_on_listing, has_images
//   warnings_<lang>      e.g. warnings_de, warnings_fr: safety text in that language
//   attr_<name>          any other attribute, kept on product.attributes

import { EU_COUNTRIES, type Address, type BatteryCategory, type CountryCode, type PackagingComponent, type PackagingMaterial, type Product } from "@oneseat/contracts";

export class CatalogError extends Error {}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new CatalogError("CSV has an unclosed quote");
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const MATERIALS = new Set<PackagingMaterial>(["paper_cardboard", "plastic", "glass", "aluminium", "steel", "wood", "composite", "textile", "ceramic", "other"]);
const ROLES = new Set<PackagingComponent["role"]>(["sales", "shipping", "transport", "service"]);
const BATTERY = new Set<BatteryCategory>(["portable", "lmt", "sli", "industrial", "ev"]);
const EU = new Set<string>(EU_COUNTRIES);

function bool(v: string | undefined, where: string): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const s = v.trim().toLowerCase();
  if (["yes", "y", "true", "1", "ja", "oui", "si", "sí"].includes(s)) return true;
  if (["no", "n", "false", "0", "nein", "non"].includes(s)) return false;
  throw new CatalogError(`${where}: "${v}" is not yes or no`);
}

function num(v: string | undefined, where: string): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) throw new CatalogError(`${where}: "${v}" is not a number`);
  return n;
}

function address(get: (k: string) => string | undefined, prefix: string): Address | undefined {
  const name = get(`${prefix}_name`);
  const country = get(`${prefix}_country`);
  if (!name && !country) return undefined;
  const email = get(`${prefix}_email`);
  const street = get(`${prefix}_address`);
  return { name: name ?? "", country: (country ?? "").toUpperCase(), ...(email ? { email } : {}), ...(street ? { street } : {}) };
}

export function parsePackaging(v: string, where: string): PackagingComponent[] {
  return v.split(";").map((s) => s.trim()).filter(Boolean).map((part) => {
    const [material, grams, role = "sales"] = part.split(":").map((x) => x.trim());
    if (!MATERIALS.has(material as PackagingMaterial)) throw new CatalogError(`${where}: unknown packaging material "${material}"`);
    const w = Number(grams);
    if (!Number.isFinite(w) || w < 0) throw new CatalogError(`${where}: packaging weight "${grams}" is not a number of grams`);
    if (!ROLES.has(role as PackagingComponent["role"])) throw new CatalogError(`${where}: unknown packaging role "${role}"`);
    return { material: material as PackagingMaterial, weightGrams: w, role: role as PackagingComponent["role"] };
  });
}

export function parseListings(v: string, where: string): Product["listings"] {
  return v.split(";").map((s) => s.trim()).filter(Boolean).map((part) => {
    const [channel, market] = part.split(":").map((x) => x.trim());
    const m = (market ?? "").toUpperCase();
    if (!channel) throw new CatalogError(`${where}: listing "${part}" has no channel`);
    if (!EU.has(m)) throw new CatalogError(`${where}: listing "${part}" needs an EU country code, like amazon:DE`);
    return { channel: channel.toLowerCase(), market: m as CountryCode };
  });
}

/** Parse a catalog CSV into products. Errors name the row and column. */
export function parseCatalogCsv(text: string): Product[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new CatalogError("the catalog needs a header row and at least one product");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  for (const required of ["sku", "listings"]) if (!header.includes(required)) throw new CatalogError(`the catalog needs a "${required}" column`);
  const seen = new Set<string>();
  return rows.slice(1).map((cells, i) => {
    const line = i + 2;
    const get = (k: string): string | undefined => {
      const idx = header.indexOf(k);
      const v = idx < 0 ? undefined : cells[idx]?.trim();
      return v === "" ? undefined : v;
    };
    const at = (k: string) => `row ${line}, ${k}`;
    const sku = get("sku");
    if (!sku) throw new CatalogError(`row ${line}: sku is empty`);
    if (seen.has(sku)) throw new CatalogError(`row ${line}: sku "${sku}" appears twice`);
    seen.add(sku);
    const listings = parseListings(get("listings") ?? "", at("listings"));
    if (listings.length === 0) throw new CatalogError(`row ${line}: listings is empty`);

    const p: Product = { sku, title: get("title") ?? sku, listings };
    const gtin = get("gtin"); if (gtin) p.gtin = gtin;
    const brand = get("brand"); if (brand) p.brand = brand;
    const category = get("category"); if (category) p.category = category;
    const consumer = bool(get("consumer_product"), at("consumer_product")); if (consumer !== undefined) p.consumerProduct = consumer;
    const packaged = bool(get("ships_packaged"), at("ships_packaged")); if (packaged !== undefined) p.shipsPackaged = packaged;
    const packaging = get("packaging"); if (packaging) p.packaging = parsePackaging(packaging, at("packaging"));
    const electrical = bool(get("electrical"), at("electrical")); if (electrical !== undefined) p.electrical = electrical;
    const weee = num(get("weee_category"), at("weee_category"));
    if (weee !== undefined) {
      if (![1, 2, 3, 4, 5, 6].includes(weee)) throw new CatalogError(`${at("weee_category")}: must be 1 to 6`);
      p.weeeCategory = weee as Product["weeeCategory"] & number;
    }
    const batteryIncluded = bool(get("battery_included"), at("battery_included"));
    if (batteryIncluded !== undefined) {
      const cat = get("battery_category");
      if (cat && !BATTERY.has(cat as BatteryCategory)) throw new CatalogError(`${at("battery_category")}: unknown battery type "${cat}"`);
      const wh = num(get("battery_capacity_wh"), at("battery_capacity_wh"));
      p.battery = { included: batteryIncluded, ...(cat ? { category: cat as BatteryCategory } : {}), ...(wh !== undefined ? { capacityWh: wh } : {}) };
    }
    const textile = bool(get("textile"), at("textile")); if (textile !== undefined) p.textile = textile;

    const manufacturer = address(get, "manufacturer");
    const responsiblePerson = address(get, "responsible_person");
    const identifier = get("identifier");
    const shownOnListing = bool(get("shown_on_listing"), at("shown_on_listing"));
    const hasImages = bool(get("has_images"), at("has_images"));
    const warnings: Record<string, string> = {};
    header.forEach((h, idx) => {
      const m = /^warnings_([a-z]{2}(?:-[a-z]{2})?)$/.exec(h);
      const text = cells[idx]?.trim();
      if (m && text) warnings[m[1]!] = text;
    });
    if (manufacturer || responsiblePerson || identifier || shownOnListing !== undefined || hasImages !== undefined || Object.keys(warnings).length > 0) {
      p.safety = {
        ...(manufacturer ? { manufacturer } : {}),
        ...(responsiblePerson ? { responsiblePerson } : {}),
        ...(identifier ? { identifier } : {}),
        ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
        ...(shownOnListing !== undefined ? { shownOnListing } : {}),
        ...(hasImages !== undefined ? { hasImages } : {}),
      };
    }
    const attributes: Record<string, string | number | boolean> = {};
    header.forEach((h, idx) => {
      const text = cells[idx]?.trim();
      if (h.startsWith("attr_") && text) {
        const lower = text.toLowerCase();
        attributes[h.slice(5)] = lower === "yes" || lower === "true" ? true : lower === "no" || lower === "false" ? false : Number.isFinite(Number(text)) ? Number(text) : text;
      }
    });
    if (Object.keys(attributes).length > 0) p.attributes = attributes;
    return p;
  });
}
