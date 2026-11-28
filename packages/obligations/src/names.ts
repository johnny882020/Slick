// Plain names for countries and channels, used in titles and reports.

import type { ChannelId, Jurisdiction } from "@oneseat/contracts";

const COUNTRY_NAMES: Record<Jurisdiction, string> = {
  EU: "the EU", AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia", DE: "Germany",
  DK: "Denmark", EE: "Estonia", ES: "Spain", FI: "Finland", FR: "France", GR: "Greece", HR: "Croatia",
  HU: "Hungary", IE: "Ireland", IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta",
  NL: "the Netherlands", PL: "Poland", PT: "Portugal", RO: "Romania", SE: "Sweden", SI: "Slovenia", SK: "Slovakia",
};

const CHANNEL_NAMES: Record<string, string> = {
  amazon: "Amazon", bol: "bol", kaufland: "Kaufland", allegro: "Allegro", ebay: "eBay", etsy: "Etsy",
  zalando: "Zalando", cdiscount: "Cdiscount", otto: "OTTO", shopify: "Shopify", woocommerce: "WooCommerce",
  own_site: "Own website",
};

export function countryName(j: Jurisdiction): string {
  return COUNTRY_NAMES[j];
}

export function channelName(c: ChannelId): string {
  return CHANNEL_NAMES[c] ?? c;
}
