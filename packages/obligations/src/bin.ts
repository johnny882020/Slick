#!/usr/bin/env node
// keeper-audit --catalog catalog.csv --seller seller.json [--rules dir] [--today YYYY-MM-DD]
//              [--html out.html] [--md out.md] [--json out.json]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Seller } from "@oneseat/contracts";
import { loadRulebook } from "@oneseat/rulebook";
import { parseCatalogCsv } from "./catalog.js";
import { buildAudit } from "./report.js";
import { renderHtml, renderMarkdown } from "./render.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      catalog: { type: "string" },
      seller: { type: "string" },
      rules: { type: "string", default: "rules" },
      today: { type: "string" },
      html: { type: "string" },
      md: { type: "string" },
      json: { type: "string" },
    },
  });
  if (!values.catalog || !values.seller) {
    console.error("usage: keeper-audit --catalog catalog.csv --seller seller.json [--rules dir] [--html out.html] [--md out.md] [--json out.json]");
    return 2;
  }
  const { packs, issues } = await loadRulebook(values.rules!);
  const errors = issues.filter((i) => i.level === "error");
  for (const e of errors) console.error(`rule pack error: ${e.pack} ${e.at}: ${e.message}`);
  if (packs.length === 0) {
    console.error("no valid rule packs found");
    return 1;
  }
  const seller = JSON.parse(await readFile(values.seller, "utf8")) as Seller;
  const products = parseCatalogCsv(await readFile(values.catalog, "utf8"));
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  const report = buildAudit({ seller, products, packs, today });
  if (values.html) await writeFile(values.html, renderHtml(report));
  if (values.md) await writeFile(values.md, renderMarkdown(report));
  if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  console.log(`${report.seller.legalName}: ${s.products} products, ${s.listings} listings, ${s.skusAtRisk} need fixes, ${s.listingsAtRiskOfBlock} listings can be blocked, ${report.fixes.length} fixes, ${packs.length} rule packs (${errors.length} skipped with errors)`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
