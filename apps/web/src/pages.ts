// Oblige web pages: one stylesheet, system fonts, light and dark, phone width.

import { EU_COUNTRIES, OBLIGATION_LABELS, type RulePack } from "@oneseat/contracts";
import { countryName } from "@oneseat/obligations";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#f6f8f7;--surface:#fff;--fg:#15211d;--muted:#56665f;--rule:#d8e0dc;--accent:#0b6b4c;--accent-fg:#fff;--accent-tint:#e3f1eb;--bad:#a3332b;--bad-bg:#f8e1de;--mid:#8a5a00;--mid-bg:#f8ecd2;
--sans:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1513;--surface:#151d1a;--fg:#e3ebe7;--muted:#95a59e;--rule:#26322d;--accent:#4fc39a;--accent-fg:#0f1513;--accent-tint:#183229;--bad:#f08a80;--bad-bg:#3a201d;--mid:#e7b75a;--mid-bg:#33281a;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f1513;--surface:#151d1a;--fg:#e3ebe7;--muted:#95a59e;--rule:#26322d;--accent:#4fc39a;--accent-fg:#0f1513;--accent-tint:#183229;--bad:#f08a80;--bad-bg:#3a201d;--mid:#e7b75a;--mid-bg:#33281a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 var(--sans);padding:0 max(16px,env(safe-area-inset-right,0px)) 3rem max(16px,env(safe-area-inset-left,0px))}
header.site{max-width:960px;margin:0 auto;padding:1.1rem 0;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;border-bottom:1px solid var(--rule)}
.brand{font-weight:700;font-size:1.2rem;color:var(--fg);text-decoration:none;letter-spacing:-.01em}.brand small{font-weight:400;color:var(--muted);font-size:.85rem;margin-left:.5rem}
nav a{color:var(--muted);text-decoration:none;margin-left:1rem}nav a:hover,nav a:focus-visible{color:var(--fg)}
main{max-width:960px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr);gap:2.5rem;padding-top:2.5rem}
h1,h2,h3{margin:0;line-height:1.2;text-wrap:balance}h1{font-size:clamp(1.9rem,1.4rem + 2vw,2.8rem);letter-spacing:-.02em}h2{font-size:1.35rem}h3{font-size:1.05rem}
p{margin:0;max-width:68ch}.lead{font-size:1.15rem;color:var(--muted);max-width:60ch}.muted{color:var(--muted)}
section{display:grid;gap:1rem;min-width:0}.eyebrow{font:500 .75rem var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);border:0;border-radius:6px;padding:.75rem 1.2rem;font:600 1rem var(--sans);text-decoration:none;cursor:pointer}
.btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}.actions{display:flex;gap:.75rem;flex-wrap:wrap}
a{color:var(--accent);text-underline-offset:2px}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.9rem}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:1rem 1.1rem;display:grid;gap:.4rem;align-content:start;min-width:0}
.wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface)}table{border-collapse:collapse;width:100%;font-size:.92rem;min-width:520px}
th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--rule)}th{font:500 .72rem var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--bg)}tr:last-child td{border-bottom:0}
.chip{display:inline-block;font:500 .75rem var(--mono);padding:.15rem .45rem;border-radius:4px;background:var(--accent-tint);color:var(--accent)}.chip.draft{background:var(--mid-bg);color:var(--mid)}
form{display:grid;gap:1.4rem}fieldset{border:1px solid var(--rule);border-radius:8px;padding:1rem 1.1rem;display:grid;gap:.9rem;background:var(--surface);min-width:0}legend{font-weight:600;padding:0 .3rem}
label{display:grid;gap:.3rem;font-weight:500}label span.hint{font-weight:400;color:var(--muted);font-size:.88rem}
input[type=text],input[type=email],select,textarea{font:inherit;padding:.55rem .65rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
textarea{font-family:var(--mono);font-size:.88rem;min-height:5.5rem}.checks{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem}.checks label{display:flex;gap:.4rem;align-items:center;font-weight:400}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.9rem}
.error{border:1px solid var(--bad);background:var(--bad-bg);color:var(--fg);border-radius:8px;padding:1rem 1.1rem}
footer{max-width:960px;margin:3rem auto 0;border-top:1px solid var(--rule);padding-top:1rem;color:var(--muted);font-size:.88rem;display:flex;gap:1rem;flex-wrap:wrap;justify-content:space-between}
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="Oblige checks every product you sell in the EU against packaging and product-safety rules per country and marketplace."><style>${CSS}</style></head>
<body><header class="site"><a class="brand" href="/">Oblige<small>Compliance by design</small></a><nav><a href="/check">Gap check</a><a href="/sample">Sample report</a></nav></header>
<main>${body}</main>
<footer><span>Oblige checks rules; it is not legal advice. Your catalog is checked in memory and never stored.</span><span>EU-hosted</span></footer>
</body></html>`;
}

export function homePage(packs: RulePack[]): string {
  const rows = [...packs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (p) => `<tr><td>${esc(p.jurisdiction === "EU" ? "All EU countries" : countryName(p.jurisdiction))}</td><td>${esc(OBLIGATION_LABELS[p.obligation])}</td><td>${p.rules.length}</td><td>${p.citations.length}</td><td><span class="chip${p.review.status === "draft" ? " draft" : ""}">${esc(p.review.status)}</span></td></tr>`,
    )
    .join("");
  return layout(
    "Oblige · Compliance by design",
    `<section>
  <div class="eyebrow">For sellers on several EU marketplaces</div>
  <h1>Can you keep selling this product, in this country, on this marketplace?</h1>
  <p class="lead">Oblige checks every product you list against the packaging and product-safety rules of each EU country and marketplace. It shows what's missing before a marketplace blocks a listing, and ranks the fixes by how many listings each one protects.</p>
  <div class="actions"><a class="btn" href="/check">Run a free gap check</a><a class="btn secondary" href="/sample">See a sample report</a></div>
</section>
<section class="grid3">
  <div class="card"><h3>Every rule cited</h3><p class="muted">Each rule points to the law, the regulator or the marketplace's own policy, with the exact passage it relies on.</p></div>
  <div class="card"><h3>Never a guess</h3><p class="muted">When a product's data is missing, Oblige says what it needs instead of guessing whether a duty applies.</p></div>
  <div class="card"><h3>Your data stays yours</h3><p class="muted">The gap check runs in memory on EU servers. Nothing you upload is stored.</p></div>
</section>
<section>
  <h2>What we check today</h2>
  <div class="wrap"><table><thead><tr><th>Where</th><th>Duty</th><th>Rules</th><th>Sources</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted">"verified" means an independent check re-read every source. Rules are signed off by a legal reviewer before Oblige prepares any filing.</p>
</section>`,
  );
}

const ROLE_LABELS: [string, string][] = [
  ["manufacturer", "Manufacturer (makes it or has it made under your name)"],
  ["brand_owner", "Brand owner"],
  ["importer", "Importer into the EU"],
  ["distributor", "Reseller of goods already in the EU"],
  ["fulfilment_provider", "Fulfilment provider"],
];

export function checkPage(error?: string): string {
  const countries = [["", "Choose a country"], ...EU_COUNTRIES.map((c) => [c, countryName(c)]), ["GB", "United Kingdom"], ["US", "United States"], ["CN", "China"], ["TR", "Türkiye"], ["CH", "Switzerland"], ["NO", "Norway"]]
    .map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`)
    .join("");
  return layout(
    "Gap check · Oblige",
    `<section>
  <div class="eyebrow">Free gap check</div>
  <h1>Check your catalog in two minutes</h1>
  <p class="lead">Upload your products and tell us what you already hold. You get the report straight away. Nothing is stored.</p>
  ${error ? `<div class="error" role="alert"><b>Please fix this:</b> ${esc(error)}</div>` : ""}
</section>
<form method="post" action="/check" enctype="multipart/form-data">
  <fieldset><legend>1. Your products</legend>
    <label>Catalog (CSV)<span class="hint">One row per product with where you list it, e.g. <code>amazon:DE;bol:NL</code>. <a href="/catalog-template.csv">Download the template</a>.</span>
      <input type="file" name="catalog" accept=".csv,text/csv" required></label>
  </fieldset>
  <fieldset><legend>2. Your company</legend>
    <div class="row">
      <label>Legal name<input type="text" name="legalName" autocomplete="organization" required></label>
      <label>Established in<select name="establishedIn" required>${countries}</select></label>
    </div>
    <div><div style="font-weight:500;margin-bottom:.3rem">Your role for these products</div><div class="checks">${ROLE_LABELS.map(([v, l]) => `<label><input type="checkbox" name="roles" value="${v}"> ${esc(l)}</label>`).join("")}</div></div>
    <label>Countries where you have a branch<span class="hint">Optional, e.g. DE, AT</span><input type="text" name="establishments"></label>
  </fieldset>
  <fieldset><legend>3. What you already hold (optional)</legend>
    <label>Registrations<span class="hint">One per line: country, duty, register, number, end date (optional). Duties: packaging_epr, gpsr, weee, batteries_epr. Example: <code>DE, packaging_epr, LUCID, DE1234567890123</code></span><textarea name="registrations"></textarea></label>
    <label>Take-back scheme contracts<span class="hint">One per line: country, duty, scheme. Example: <code>DE, packaging_epr, Der Grüne Punkt</code></span><textarea name="schemes"></textarea></label>
    <label>Authorised representatives<span class="hint">One per line: country, duty, name. Example: <code>FR, packaging_epr, Mandataire SAS</code></span><textarea name="representatives"></textarea></label>
    <label>Packaging per year<span class="hint">One per line: country, kilograms last year. Example: <code>NL, 12000</code></span><textarea name="annualPackagingKg"></textarea></label>
    <div class="row">
      <label>EU responsible person (product safety)<input type="text" name="rpName"></label>
      <label>Their country<input type="text" name="rpCountry" maxlength="2" placeholder="DE"></label>
      <label>Their email<input type="email" name="rpEmail"></label>
    </div>
  </fieldset>
  <div class="actions"><button class="btn" type="submit">Run the gap check</button></div>
  <p class="muted">By running the check you agree that we process the file in memory to produce your report. It is not stored or logged.</p>
</form>`,
  );
}

export function errorPage(status: number, message: string): string {
  return layout(`${status} · Oblige`, `<section><div class="eyebrow">Error ${status}</div><h1>${esc(message)}</h1><p><a href="/">Back to the start</a></p></section>`);
}
