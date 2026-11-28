// Load the rulebook and the example files the site serves.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seller } from "@oneseat/contracts";
import { buildAudit, parseCatalogCsv, renderHtml } from "@oneseat/obligations";
import { loadRulebook } from "@oneseat/rulebook";
import type { WebOptions } from "./server.js";

/** Load rule packs from `rulesDir` and the sample files from `examplesDir`. Fails on any pack error. */
export async function loadSite(rulesDir: string, examplesDir: string, today: string): Promise<Pick<WebOptions, "packs" | "sampleHtml" | "templateCsv">> {
  const { packs, issues } = await loadRulebook(rulesDir);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) throw new Error(`rule packs have errors: ${errors.map((e) => `${e.pack} ${e.at}: ${e.message}`).join("; ")}`);
  if (packs.length === 0) throw new Error(`no rule packs found in ${rulesDir}`);
  const seller = JSON.parse(await readFile(join(examplesDir, "seller.json"), "utf8")) as Seller;
  const products = parseCatalogCsv(await readFile(join(examplesDir, "catalog.csv"), "utf8"));
  const sampleHtml = renderHtml(buildAudit({ seller, products, packs, today }));
  const templateCsv = await readFile(join(examplesDir, "catalog-template.csv"), "utf8");
  return { packs, sampleHtml, templateCsv };
}
