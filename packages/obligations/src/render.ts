// Render an AuditReport as Markdown (for email and review) and as one self-contained HTML page
// (the paid gap-audit deliverable). No external files: system fonts, light and dark themes.

import type { AuditReport, Citation, Fix, MapCell } from "@oneseat/contracts";
import { OBLIGATION_LABELS } from "@oneseat/contracts";
import { describePath } from "./assess.js";
import { channelName, countryName } from "./names.js";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATE_LABEL: Record<MapCell["state"], string> = {
  green: "Ready",
  amber: "Check",
  red: "At risk",
  grey: "Not covered yet",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function leadTime(f: Fix): string {
  return f.leadTimeDays ? `${f.leadTimeDays[0]}–${f.leadTimeDays[1]} days` : "varies";
}

function headline(r: AuditReport): string {
  const s = r.summary;
  const ready = s.products - s.skusAtRisk;
  return s.skusAtRisk === 0
    ? `All ${plural(s.products, "product")} checked have no open gaps in the rules we cover.`
    : `${ready} of ${plural(s.products, "product")} have no open gaps. ${plural(s.skusAtRisk, "product")} need fixes, and ${plural(s.listingsAtRiskOfBlock, "listing")} can be blocked by a marketplace until they are fixed.`;
}

function citationsUsed(r: AuditReport): Citation[] {
  const seen = new Map<string, Citation>();
  for (const q of r.requirements) for (const c of q.citations) seen.set(c.url, c);
  return [...seen.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function renderMarkdown(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Oblige gap audit: ${r.seller.legalName}`, "", "*Compliance by design.*", "");
  lines.push(`Generated ${r.generatedAt.slice(0, 10)} · ${plural(r.summary.products, "product")} · ${plural(r.summary.listings, "listing")} · ${r.summary.markets.map(countryName).join(", ")}`, "");
  lines.push(headline(r), "");
  lines.push("## Can I sell?", "", "| Country | Channel | Products | Ready | Need fixes | Need data | Status |", "|---|---|---|---|---|---|---|");
  for (const c of r.map) {
    lines.push(`| ${countryName(c.market)} | ${channelName(c.channel)} | ${c.skus} | ${c.skusMet} | ${c.skusAtRisk} | ${c.skusUnknown} | ${STATE_LABEL[c.state]} |`);
  }
  lines.push("", "## What to fix, most urgent first", "");
  if (r.fixes.length === 0) lines.push("Nothing to fix in the rules we cover.", "");
  r.fixes.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title}`, "");
    lines.push(`${OBLIGATION_LABELS[f.obligation]} · ${plural(f.impact.skus, "product")} · ${plural(f.impact.listings, "listing")}${f.impact.blockingListings > 0 ? ` · **${plural(f.impact.blockingListings, "listing")} can be blocked**` : ""} · time: ${leadTime(f)}`, "");
    f.steps.forEach((s, j) => lines.push(`${j + 1}. ${s}`));
    lines.push("");
  });
  if (r.dataGaps.length > 0) {
    lines.push("## Data we still need", "", "| What | Products |", "|---|---|");
    for (const g of r.dataGaps) lines.push(`| ${describePath(g.path)} | ${g.skus} |`);
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const c of citationsUsed(r)) lines.push(`- [${c.title}](${c.url}) (${c.publisher}, read ${c.retrieved})`);
  lines.push("", "## Rule packs used", "");
  for (const p of r.rulebook) lines.push(`- ${p.id} ${p.version} (${p.reviewStatus})`);
  lines.push("", "## Notes", "");
  for (const d of r.disclaimers) lines.push(`- ${d}`);
  return `${lines.join("\n")}\n`;
}

const CSS = `
:root{--bg:#f6f8f7;--surface:#fff;--fg:#15211d;--muted:#56665f;--rule:#d8e0dc;--accent:#0b6b4c;--accent-tint:#e3f1eb;
--good:#0b6b4c;--good-bg:#dff0e8;--mid:#8a5a00;--mid-bg:#f8ecd2;--bad:#a3332b;--bad-bg:#f8e1de;--grey:#5f6b66;--grey-bg:#eceff0;
--sans:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1513;--surface:#151d1a;--fg:#e3ebe7;--muted:#95a59e;--rule:#26322d;--accent:#4fc39a;--accent-tint:#183229;
--good:#5fd0a6;--good-bg:#173229;--mid:#e7b75a;--mid-bg:#33281a;--bad:#f08a80;--bad-bg:#3a201d;--grey:#a3ada9;--grey-bg:#222a27;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f1513;--surface:#151d1a;--fg:#e3ebe7;--muted:#95a59e;--rule:#26322d;--accent:#4fc39a;--accent-tint:#183229;
--good:#5fd0a6;--good-bg:#173229;--mid:#e7b75a;--mid-bg:#33281a;--bad:#f08a80;--bad-bg:#3a201d;--grey:#a3ada9;--grey-bg:#222a27;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);padding:2rem max(16px,env(safe-area-inset-right,0px)) 3rem max(16px,env(safe-area-inset-left,0px))}
main{max-width:900px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr);gap:2rem}h1,h2,h3{margin:0;line-height:1.25;text-wrap:balance}h1{font-size:1.8rem}h2{font-size:1.25rem}h3{font-size:1rem}
p{margin:0;max-width:70ch}.muted{color:var(--muted)}.eyebrow{font:500 .72rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
section{display:grid;gap:.9rem;min-width:0}.lead{font-size:1.08rem;max-width:66ch}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem}
.kpi{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:.8rem 1rem}.kpi b{display:block;font:600 1.5rem var(--mono);font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface)}table{border-collapse:collapse;width:100%;font-size:.9rem;min-width:560px}
th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--rule);vertical-align:top}th{font:500 .72rem var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--bg)}
tr:last-child td{border-bottom:0}td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}
.chip{display:inline-block;font:500 .75rem var(--mono);padding:.15rem .45rem;border-radius:4px;white-space:nowrap}
.green{color:var(--good);background:var(--good-bg)}.amber{color:var(--mid);background:var(--mid-bg)}.red{color:var(--bad);background:var(--bad-bg)}.grey{color:var(--grey);background:var(--grey-bg)}
ol.fixes{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.fix{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:1rem 1.1rem;display:grid;grid-template-columns:minmax(0,1fr);gap:.55rem;min-width:0;overflow-wrap:anywhere}
.chip{overflow-wrap:normal}
.fix.block{border-color:var(--bad)}.meta{display:flex;flex-wrap:wrap;gap:.4rem .9rem;font-size:.85rem;color:var(--muted)}
.fix ol{margin:0;padding-left:1.2rem;display:grid;gap:.25rem}.sources{margin:0;padding-left:1.1rem;font-size:.85rem;display:grid;gap:.25rem}
a{color:var(--accent);text-underline-offset:2px}footer{border-top:1px solid var(--rule);padding-top:1rem;font-size:.85rem;color:var(--muted);display:grid;gap:.4rem}
`;

export function renderHtml(r: AuditReport): string {
  const s = r.summary;
  const map = r.map
    .map(
      (c) => `<tr><td>${esc(countryName(c.market))}</td><td>${esc(channelName(c.channel))}</td><td class="n">${c.skus}</td><td class="n">${c.skusMet}</td><td class="n">${c.skusAtRisk}</td><td class="n">${c.skusUnknown}</td><td><span class="chip ${c.state}">${STATE_LABEL[c.state]}</span></td></tr>`,
    )
    .join("");
  const fixes = r.fixes
    .map(
      (f, i) => `<li class="fix${f.impact.blockingListings > 0 ? " block" : ""}">
  <div class="eyebrow">${i + 1} · ${esc(OBLIGATION_LABELS[f.obligation])}</div>
  <h3>${esc(f.title)}</h3>
  <div class="meta"><span>${plural(f.impact.skus, "product")}</span><span>${plural(f.impact.listings, "listing")}</span>${f.impact.blockingListings > 0 ? `<span class="chip red">${plural(f.impact.blockingListings, "listing")} can be blocked</span>` : ""}<span>Time: ${esc(leadTime(f))}</span><span>Needs your approval to: ${esc(f.effects.join(", "))}</span></div>
  <ol>${f.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
</li>`,
    )
    .join("");
  const gaps = r.dataGaps.map((g) => `<tr><td>${esc(describePath(g.path))}</td><td class="n">${g.skus}</td></tr>`).join("");
  const sources = citationsUsed(r)
    .map((c) => `<li><a href="${esc(c.url)}">${esc(c.title)}</a> <span class="muted">(${esc(c.publisher)}, read ${esc(c.retrieved)})</span></li>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Oblige gap audit · ${esc(r.seller.legalName)}</title><style>${CSS}</style></head>
<body><main>
<header style="display:grid;gap:.6rem">
  <div class="eyebrow">Oblige · Compliance gap audit · ${esc(r.generatedAt.slice(0, 10))}</div>
  <h1>${esc(r.seller.legalName)}</h1>
  <p class="lead">${esc(headline(r))}</p>
</header>
<section class="kpis" aria-label="Summary">
  <div class="kpi"><b>${s.products}</b><span class="muted">products checked</span></div>
  <div class="kpi"><b>${s.listings}</b><span class="muted">listings in ${s.markets.length} ${s.markets.length === 1 ? "country" : "countries"}</span></div>
  <div class="kpi"><b>${s.skusAtRisk}</b><span class="muted">products need fixes</span></div>
  <div class="kpi"><b>${s.listingsAtRiskOfBlock}</b><span class="muted">listings can be blocked</span></div>
</section>
<section><h2>Can I sell?</h2>
<div class="wrap"><table><thead><tr><th>Country</th><th>Channel</th><th>Products</th><th>Ready</th><th>Need fixes</th><th>Need data</th><th>Status</th></tr></thead><tbody>${map}</tbody></table></div></section>
<section><h2>What to fix, most urgent first</h2>${r.fixes.length ? `<ol class="fixes">${fixes}</ol>` : `<p>Nothing to fix in the rules we cover.</p>`}</section>
${gaps ? `<section><h2>Data we still need</h2><p class="muted">Add these and we can decide the rows marked "Need data".</p><div class="wrap"><table><thead><tr><th>What</th><th>Products</th></tr></thead><tbody>${gaps}</tbody></table></div></section>` : ""}
<section><h2>Sources</h2><ul class="sources">${sources}</ul></section>
<footer><p><b>Oblige</b> · Compliance by design</p>${r.disclaimers.map((d) => `<p>${esc(d)}</p>`).join("")}<p>Rule packs: ${r.rulebook.map((p) => `${esc(p.id)} ${esc(p.version)} (${esc(p.reviewStatus)})`).join(", ")}</p></footer>
</main></body></html>
`;
}
