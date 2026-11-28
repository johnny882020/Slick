// Server-rendered pages. No JavaScript: every page works with the strict content policy.
// Visual design: docs/style-guide.md (Archival Editorial). Logical CSS properties throughout,
// so a right-to-left page only needs dir="rtl".
import { FEATURE_LABELS, PLANS, TRIAL_DAYS, type Feature, type Tier } from "@oneseat/contracts";
import type { CloudConfig } from "./config.js";
import { loadFonts } from "./fonts.js";
import type { FeedbackRow, LicenseRow } from "./store.js";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const CSS = `
:root{
--canvas:#F6F4EF;--card:#FFFFFF;--band:#EDEAE2;
--ink:#141517;--body:#4A4D55;--meta:#70747E;
--cobalt:#1B3B82;--cobalt-deep:#142D66;--cobalt-tint:#EBF0FA;
--vermilion:#D94E34;--vermilion-text:#A93A24;--vermilion-tint:#FDECE8;
--ok:#1E6B3E;
--line:rgba(20,21,23,.13);--line-strong:rgba(20,21,23,.24);
--display:"Newsreader","Frank Ruhl Libre",Georgia,"Times New Roman",serif;
--sans:"Instrument Sans","Heebo",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--gutter:clamp(1rem,4vw,2.5rem);--section:clamp(2.5rem,5vw,5rem);
--r-s:4px;--r:6px;--r-l:10px;
--shadow:0 2px 10px rgba(20,21,23,.05);--lift:0 14px 32px -12px rgba(20,21,23,.24);
color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:80px}
html,body{overflow-x:hidden}
body{margin:0;background:var(--canvas);color:var(--body);font:400 1rem/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:1220px;margin-inline:auto;padding-inline:var(--gutter)}
a{color:var(--cobalt);text-decoration-thickness:1px;text-underline-offset:.18em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--cobalt);outline-offset:2px;border-radius:var(--r-s)}
.skip{position:absolute;inset-inline-start:-9999px;top:.5rem;z-index:20;background:var(--card);padding:.75rem 1rem;border-radius:var(--r);border:1px solid var(--line-strong)}
.skip:focus{inset-inline-start:var(--gutter)}
header.site{position:sticky;top:0;z-index:10;height:64px;background:rgba(246,244,239,.84);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-block-end:1px solid var(--line)}
header.site .wrap{height:100%;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.brand{display:inline-flex;align-items:center;gap:.6rem;min-height:44px;font:600 1.3rem/1 var(--display);color:var(--ink);text-decoration:none;letter-spacing:-.01em;flex:none}
.brand::before{content:"";width:10px;height:10px;border-radius:2px;background:var(--vermilion)}
nav.primary{display:flex;gap:.125rem;overflow-x:auto;scrollbar-width:none;min-width:0}
nav.primary::-webkit-scrollbar{display:none}
nav.primary a{display:inline-flex;align-items:center;min-height:44px;padding-inline:.7rem;border-radius:var(--r);color:var(--body);text-decoration:none;font-weight:500;white-space:nowrap}
nav.primary a:hover{color:var(--ink);background:rgba(20,21,23,.05)}
nav.primary a[aria-current=page]{color:var(--cobalt);background:var(--cobalt-tint)}
@media (max-width:639px){nav.primary a.wide{display:none}}
.section{padding-block:var(--section)}
.section:not(.band)+.section:not(.band){padding-block-start:0}
.band{background:var(--band);border-block:1px solid var(--line)}
.eyebrow{display:flex;align-items:center;gap:.6rem;margin:0 0 1rem;font:500 .75rem/1.2 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--vermilion-text)}
.eyebrow::before{content:"";width:1.5rem;height:1px;background:var(--vermilion)}
h1,h2,h3{margin:0;color:var(--ink);font-family:var(--display);font-weight:500;letter-spacing:-.015em}
h1{font-size:clamp(2.25rem,1.35rem + 3.8vw,4.25rem);line-height:1.04;max-width:18ch}
h2{font-size:clamp(1.65rem,1.2rem + 1.7vw,2.5rem);line-height:1.12;margin-block-end:.75rem}
h3{font-size:1.4rem;line-height:1.25}
p{margin:0;max-width:68ch}
p+p{margin-block-start:.75rem}
.lead{margin-block-start:1.25rem;font-size:clamp(1.06rem,1rem + .45vw,1.28rem);line-height:1.55;max-width:58ch}
.head{display:grid;gap:.25rem;margin-block-end:2rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-block-start:2rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:44px;padding:.625rem 1.15rem;border:1px solid var(--cobalt);border-radius:var(--r);background:var(--cobalt);color:#fff;font:600 .95rem/1.2 var(--sans);text-decoration:none;transition:background .15s,box-shadow .15s}
.btn:hover{background:var(--cobalt-deep);box-shadow:var(--lift)}
.btn.secondary{background:var(--card);color:var(--cobalt);border-color:var(--line-strong)}
.btn.secondary:hover{background:var(--cobalt-tint)}
.btn.off{background:var(--band);color:var(--meta);border-color:var(--line);box-shadow:none;cursor:default}
.grid{display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)}
@media (min-width:700px){.grid.two,.grid.three{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1060px){.grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}}
.split>*+*{margin-block-start:1.5rem}
@media (min-width:860px){.split>*+*{margin-block-start:0}.split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:clamp(2rem,5vw,4rem);align-items:start}}
.card{display:flex;flex-direction:column;gap:.85rem;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r-l);padding:clamp(1.25rem,2.5vw,1.75rem);box-shadow:var(--shadow)}
.card.featured{border-color:var(--line-strong);border-block-start:3px solid var(--cobalt);box-shadow:var(--lift)}
.card .actions{margin-block-start:auto;padding-block-start:.5rem}
.price{font:500 2.4rem/1 var(--mono);color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.price small{font:400 .9rem/1.4 var(--sans);color:var(--meta);letter-spacing:0}
.meta,.note{color:var(--meta);font-size:.92rem}
.tag{align-self:flex-start;display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .55rem;border-radius:var(--r-s);background:var(--vermilion-tint);color:var(--vermilion-text);font:500 .72rem/1 var(--mono);letter-spacing:.07em;text-transform:uppercase}
.tag.cobalt{background:var(--cobalt-tint);color:var(--cobalt)}
ul.checks{list-style:none;margin:0;padding:0;display:grid;gap:.55rem}
ul.checks li{position:relative;padding-inline-start:1.6rem}
ul.checks li::before{content:"";position:absolute;inset-inline-start:.15rem;top:.62em;width:.6rem;height:.35rem;border-inline-start:2px solid var(--cobalt);border-block-end:2px solid var(--cobalt);transform:rotate(-45deg)}
ol.steps{list-style:none;counter-reset:step;margin:0;padding:0;display:grid;gap:0}
ol.steps>li{counter-increment:step;position:relative;padding-block:1.25rem;padding-inline-start:3.5rem;border-block-start:1px solid var(--line)}
ol.steps>li:last-child{border-block-end:1px solid var(--line)}
ol.steps>li::before{content:counter(step,decimal-leading-zero);position:absolute;inset-inline-start:0;top:1.25rem;width:2.4rem;height:2.4rem;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:50%;background:var(--card);color:var(--cobalt);font:500 .85rem/1 var(--mono);font-variant-numeric:tabular-nums}
ol.steps h3{font-size:1.25rem;margin-block-end:.35rem}
ol.steps .actions{margin-block-start:1rem}
.callout{background:var(--card);border:1px solid var(--line);border-inline-start:3px solid var(--vermilion);border-start-end-radius:var(--r);border-end-end-radius:var(--r);padding:1rem 1.25rem}
.key{display:block;max-width:100%;padding:1rem 1.25rem;border:1px dashed var(--cobalt);border-radius:var(--r);background:var(--cobalt-tint);color:var(--ink);font:500 clamp(1.1rem,1rem + 1vw,1.55rem)/1.3 var(--mono);letter-spacing:.06em;user-select:all;overflow-wrap:anywhere}
code{font-family:var(--mono);font-size:.88em;background:var(--band);padding:.08em .35em;border-radius:var(--r-s);overflow-wrap:anywhere}
pre{margin:0;font:400 .85rem/1.6 var(--mono);background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:1rem 1.25rem;white-space:pre-wrap;overflow-wrap:anywhere}
.table{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--r-l);box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th{background:var(--band);color:var(--meta);font:500 .72rem/1.2 var(--mono);letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
th,td{padding:.7rem .9rem;border-block-end:1px solid var(--line);text-align:start;vertical-align:top}
tr:last-child td{border-block-end:0}
td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--vermilion-text)}
form.stack{display:grid;gap:1rem;max-width:34rem}
label{display:grid;gap:.35rem;color:var(--ink);font-weight:500}
input,select{min-height:44px;width:100%;padding:.55rem .75rem;border:1px solid var(--line-strong);border-radius:var(--r);background:var(--card);color:var(--ink);font:inherit}
input:focus-visible,select:focus-visible{outline:2px solid var(--cobalt);outline-offset:1px}
footer.site{background:var(--band);border-block-start:1px solid var(--line);color:var(--meta);font-size:.9rem;padding-block:2rem}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:.5rem 2rem;justify-content:space-between}
footer.site a{color:var(--body)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

type NavKey = "home" | "download" | "pilot" | "privacy" | "admin";

const NAV: [NavKey, string, string][] = [
  ["home", "/#plans", "Plans"],
  ["download", "/download", "Download"],
  ["pilot", "/pilot", "Pilot"],
  ["privacy", "/privacy", "Privacy"],
];
/** Links the phone header leaves to the footer, so the header never clips. */
const WIDE_ONLY = new Set<NavKey>(["privacy"]);

export function layout(title: string, body: string, opts: { refreshSeconds?: number; active?: NavKey; description?: string } = {}): string {
  const nav = NAV.map(([k, href, label]) => `<a href="${href}"${WIDE_ONLY.has(k) ? ' class="wide"' : ""}${opts.active === k ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(opts.description ?? "OneSeat: one desktop app, one skills library, any model.")}">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}<meta name="theme-color" content="#F6F4EF">
<style>${loadFonts().css}\n${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap"><a class="brand" href="/">OneSeat</a><nav class="primary" aria-label="Main">${nav}</nav></div></header>
<main id="main">${body}</main>
<footer class="site"><div class="wrap"><span>OneSeat runs on your computer with your own model key. Your business data never comes to our servers.</span><a href="/privacy">Privacy</a></div></footer>
</body></html>`;
}

const section = (inner: string, opts: { band?: boolean; id?: string; label?: string } = {}) =>
  `<section class="section${opts.band ? " band" : ""}"${opts.id ? ` id="${opts.id}"` : ""}${opts.label ? ` aria-labelledby="${opts.label}"` : ""}><div class="wrap">${inner}</div></section>`;

const eyebrow = (text: string) => `<p class="eyebrow">${esc(text)}</p>`;

function planCard(tier: Tier, cfg: CloudConfig): string {
  const p = PLANS[tier];
  const feats: string[] =
    tier === "free"
      ? ["The seven starter skills", "Runs, approvals and the activity log", "Your own model key: Claude, OpenAI, Gemini or local"]
      : [`${p.computers} computers`, ...p.features.map((f: Feature) => FEATURE_LABELS[f])];
  const links =
    tier === "free"
      ? `<a class="btn secondary" href="/download">Download free</a>`
      : [
          cfg.paymentLinks[`${tier}_monthly`] ? `<a class="btn" href="${esc(cfg.paymentLinks[`${tier}_monthly`])}">Choose monthly</a>` : "",
          cfg.paymentLinks[`${tier}_yearly`] ? `<a class="btn secondary" href="${esc(cfg.paymentLinks[`${tier}_yearly`])}">Yearly, 20% off</a>` : "",
        ].join("") || `<span class="note">Checkout opens soon.</span>`;
  const price =
    tier === "free"
      ? `<div class="price">$0<small> forever</small></div>`
      : `<div class="price">${money(p.monthlyCents)}<small> / month per team</small></div><div class="note">or ${money(p.yearlyCents)} a year</div>`;
  return `<article class="card${tier === "pro" ? " featured" : ""}" aria-labelledby="plan-${tier}">${tier === "pro" ? `<span class="tag cobalt">Most teams</span>` : ""}<h3 id="plan-${tier}">${esc(p.name)}</h3>${price}<p>${esc(p.blurb)}</p><ul class="checks">${feats.map((f) => `<li>${esc(f)}</li>`).join("")}</ul><div class="actions">${links}</div></article>`;
}

export function homePage(cfg: CloudConfig): string {
  return layout(
    "OneSeat: one desktop app, one skills library, any model",
    section(
      `${eyebrow("Desktop agent for small business")}<h1>One desktop app, one skills library, any model.</h1>
<p class="lead">OneSeat runs repetitive business tasks as skills: customer lookups, outreach emails, invoices, social posts, support replies and weekly reports. It replaces several per-seat tools with one app on your own model key.</p>
<div class="actions"><a class="btn" href="/download">Download for Windows or Mac</a><a class="btn secondary" href="#plans">See plans</a></div>`,
    ) +
      section(
        `<div class="head">${eyebrow("Plans")}<h2 id="plans-title">Flat price per team</h2><p class="note">No per-seat fees. You pay your model provider directly for what you use.</p></div>
<div class="grid three">${(["free", "pro", "team"] as const).map((t) => planCard(t, cfg)).join("")}</div>
${cfg.billingPortalUrl ? `<p class="note" style="margin-block-start:1.25rem">Already subscribed? <a href="${esc(cfg.billingPortalUrl)}">Manage billing</a>.</p>` : ""}`,
        { band: true, id: "plans", label: "plans-title" },
      ) +
      section(
        `<div class="split"><div>${eyebrow("Safety")}<h2>What OneSeat never does</h2></div>
<ul class="checks"><li>It never sends, pays or deletes without asking you first.</li><li>It never uploads your customer data: everything stays on your computer.</li><li>Your model key lives in your operating system's keychain, not in a file.</li></ul></div>`,
      ),
    { active: "home" },
  );
}

/** Where the published files and checksums are, when the installers come from a GitHub release. */
function releasePage(url: string | undefined): string | undefined {
  const m = url && /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(url);
  return m ? `${m[1]}/releases/tag/${m[2]}` : undefined;
}

function platformCards(cfg: CloudConfig): string {
  const button = (url: string | undefined, href: string, label: string) =>
    url ? `<a class="btn" href="${href}">${esc(label)}</a>` : `<span class="btn off" aria-disabled="true">${esc(label)}: not published yet</span>`;
  const checksums = releasePage(cfg.downloads.windows ?? cfg.downloads.mac);
  return `<div class="grid two">
<article class="card" aria-labelledby="dl-win"><span class="tag">Pilot build</span><h3 id="dl-win">Windows 10 and 11</h3><p>Installs for your user only. No admin rights needed.</p>
<div class="actions">${button(cfg.downloads.windows, "/download/windows", "Download for Windows")}</div>
<p class="note">Pilot builds aren't signed yet. If Windows says it protected your PC, choose <b>More info</b>, then <b>Run anyway</b>.</p></article>
<article class="card" aria-labelledby="dl-mac"><span class="tag">Pilot build</span><h3 id="dl-mac">macOS on Apple silicon</h3><p>Open the disk image and drag OneSeat to Applications. Needs a Mac with an M-series chip.</p>
<div class="actions">${button(cfg.downloads.mac, "/download/mac", "Download for Mac")}</div>
<p class="note">The first time, right-click OneSeat and choose <b>Open</b>. If macOS says the app is damaged, run <code>xattr -cr /Applications/OneSeat.app</code> in Terminal.</p></article>
</div>${checksums ? `<p class="note" style="margin-block-start:1rem">Release notes and SHA-256 checksums: <a href="${esc(checksums)}">${esc(checksums.replace(/^https:\/\//, ""))}</a></p>` : ""}`;
}

/** The self-serve trial lives in the app, so it is tied to a computer: the site only points there. */
const trialNote = () =>
  `<div class="callout"><p><b>Try Team free for ${TRIAL_DAYS} days.</b> Start it from <b>OneSeat → Plan</b>: enter your email and choose <b>Start free trial</b>. You get a Team license key for up to ${PLANS.team.computers} computers, with no payment details.</p></div>`;

const MODEL_KEYS = `<ul class="checks">
<li><b>Claude (recommended):</b> create a key at <a href="https://console.anthropic.com/settings/keys">console.anthropic.com</a> and add prepaid credit under Billing. A Claude Pro or Max subscription doesn't include API use. OneSeat uses Claude Sonnet 5.5 by default.</li>
<li><b>OpenAI:</b> a key from <a href="https://platform.openai.com/api-keys">platform.openai.com</a> with prepaid credit. A ChatGPT subscription doesn't include API use.</li>
<li><b>Gemini:</b> a free key from <a href="https://aistudio.google.com/apikey">Google AI Studio</a> works for a first look, but its daily limit is small, and Google may use free-tier requests to improve its products. Use a paid key for real customer data.</li>
</ul>`;

export function downloadPage(cfg: CloudConfig): string {
  return layout(
    "Download OneSeat",
    section(`${eyebrow("Download")}<h1>Download OneSeat</h1><p class="lead">Install it, paste a model key, and run your first task in under five minutes.</p>`) +
      section(platformCards(cfg)) +
      section(trialNote()) +
      section(`<div class="split"><div>${eyebrow("Model keys")}<h2>Connect one model key</h2><p>The key stays in your computer's keychain. OneSeat never sends it to us.</p></div>${MODEL_KEYS}</div>`, { band: true }),
    { active: "download" },
  );
}

export function pilotPage(cfg: CloudConfig): string {
  const dl = (url: string | undefined, href: string, label: string) => (url ? `<a class="btn" href="${href}">${label}</a>` : "");
  const buttons = [dl(cfg.downloads.windows, "/download/windows", "Windows installer"), dl(cfg.downloads.mac, "/download/mac", "Mac installer")].join("");
  return layout(
    "OneSeat pilot",
    section(
      `${eyebrow("Pilot")}<h1>Welcome to the OneSeat pilot</h1>
<p class="lead">For two weeks, your team uses OneSeat for real work, and tells us what helped and what got in the way. During the pilot your team has the full Team plan, for up to ${PLANS.team.computers} computers, at no cost.</p>`,
    ) +
      section(trialNote()) +
      section(
        `<ol class="steps">
<li><h3>Install OneSeat</h3><p>On each computer that will use it: Windows 10 or 11, or a Mac with Apple silicon.</p><div class="actions">${buttons || `<a class="btn secondary" href="/download">Download page</a>`}</div></li>
<li><h3>Connect a model key</h3><p>Open OneSeat and paste a key when it asks. We recommend Claude: create a key at <a href="https://console.anthropic.com/settings/keys">console.anthropic.com</a> and add some prepaid credit. You pay the model provider for what you use. The pilot itself is free.</p></li>
<li><h3>Activate your pilot license</h3><p>Go to <b>Plan</b>, paste the license key from your invitation email (it looks like <code>OS-XXXX-XXXX-XXXX-XXXX</code>), and choose <b>Activate</b>. Use the same key on every computer in your team. No invitation? Start a free ${TRIAL_DAYS}-day Team trial in <b>Plan</b> instead, then use its key on your team's other computers.</p></li>
<li><h3>Use it for real work</h3><p>Look up customers, draft invoices and outreach emails, answer support messages, write the weekly report. OneSeat always asks before it sends, pays or deletes anything.</p></li>
<li><h3>Tell us how it went</h3><p>In OneSeat, go to <b>Plan</b>, then <b>Send feedback</b>, whenever something works well or gets in your way. Don't include API keys or customer data.</p></li>
</ol>`,
        { label: "pilot-steps" },
      ) +
      section(
        `<div class="split"><div>${eyebrow("Good to know")}<h2>When the pilot ends</h2></div><ul class="checks">
<li>Your license switches to Free on its end date. Your data, skills and pinned apps stay on your computer.</li>
<li>To keep Pro or Team features, choose a plan on the <a href="/#plans">plans page</a> and paste the new key in <b>Plan</b>.</li>
<li>Pilot builds aren't signed yet, so Windows and macOS warn the first time you open OneSeat. The <a href="/download">download page</a> explains the one-time step.</li>
</ul></div>`,
        { band: true },
      ),
    { active: "pilot" },
  );
}

export function privacyPage(): string {
  return layout(
    "Privacy",
    section(`${eyebrow("Privacy")}<h1>Your business data stays on your computer</h1><p class="lead">Here is exactly what goes where.</p>`) +
      section(`<div class="grid three">
<article class="card"><h3>On your computer</h3><p>Your database, skills, pinned apps and activity log. Your model key is in the operating system's keychain.</p></article>
<article class="card"><h3>To your model provider</h3><p>The text of your requests and the data a skill looks up to answer them, under that provider's terms.</p></article>
<article class="card"><h3>To OneSeat Cloud</h3><p>Your email and billing status (from Stripe), your license key's activations (a random computer id and its name), and feedback you choose to send.</p></article>
</div><p class="note" style="margin-block-start:1.25rem">Payments are handled by Stripe. We never see your card number. This site sets no cookies and loads nothing from other servers.</p>`),
    { active: "privacy" },
  );
}

export function welcomePage(state: { kind: "pending" } | { kind: "ready"; license: LicenseRow; key: string | undefined } | { kind: "missing" }): string {
  if (state.kind === "pending")
    return layout("Setting up your license", section(`${eyebrow("Checkout")}<h1>Thank you!</h1><p class="lead">We are setting up your license. This page refreshes by itself.</p>`), { refreshSeconds: 3 });
  if (state.kind === "missing")
    return layout(
      "License not found",
      section(`${eyebrow("Checkout")}<h1>We couldn't find that checkout</h1><p class="lead">If you just paid, wait a minute and reload this page. Otherwise contact support with your receipt.</p>`),
    );
  const p = PLANS[state.license.tier];
  const key = state.key
    ? `<p>Your license key:</p><p class="key">${esc(state.key)}</p><p class="note">Copy it now. For your security we show it for 24 hours only.</p>`
    : `<p class="note">The key was shown when you checked out and is no longer displayed. Contact support to issue a new one.</p>`;
  return layout(
    "Welcome to OneSeat",
    section(`${eyebrow("Your license")}<h1>Welcome to OneSeat ${esc(p.name)}</h1><div style="display:grid;gap:.75rem;margin-block-start:2rem;max-width:40rem">${key}</div>`) +
      section(`<ol class="steps"><li><h3>Open OneSeat</h3><p><a href="/download">Download it</a> if you haven't yet.</p></li><li><h3>Activate</h3><p>Go to <b>Plan</b>, paste the key and choose <b>Activate</b>.</p></li><li><h3>Add your team</h3><p>Use the same key on up to ${p.computers} computers.</p></li></ol>`),
  );
}

/** The invitation the lead sends to a pilot team: one key, the pilot page, nothing else to know. */
export function pilotInvitation(cfg: CloudConfig, license: LicenseRow, key: string): { subject: string; body: string } {
  const ends = license.endsAt ? new Date(license.endsAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "the end of the pilot";
  return {
    subject: `Your OneSeat pilot license for ${license.team ?? "your team"}`,
    body: [
      `Hi,`,
      ``,
      `Thank you for piloting OneSeat. Your team's license key is:`,
      ``,
      `    ${key}`,
      ``,
      `It gives up to ${license.computers} computers the full Team plan until ${ends}, at no cost.`,
      ``,
      `Start here: ${cfg.publicUrl}/pilot`,
      ``,
      `1. Install OneSeat (Windows: ${cfg.publicUrl}/download/windows, Mac: ${cfg.publicUrl}/download/mac).`,
      `2. Paste a model key when OneSeat asks. We recommend Claude, with prepaid API credit.`,
      `3. In OneSeat, open Plan, paste the license key above and choose Activate.`,
      `4. Use it for real work, and send feedback from Plan, then Send feedback.`,
      ``,
      `Please keep this key within your team.`,
    ].join("\n"),
  };
}

export function pilotCreatedPage(cfg: CloudConfig, license: LicenseRow, key: string): string {
  const inv = pilotInvitation(cfg, license, key);
  const mailto = `mailto:${encodeURIComponent(license.email)}?subject=${encodeURIComponent(inv.subject)}&body=${encodeURIComponent(inv.body)}`;
  return layout(
    "Pilot license created",
    section(
      `${eyebrow("Admin · pilot")}<h1>License for ${esc(license.team)}</h1>
<p class="lead">Team plan, ${license.computers} computers, until ${esc((license.endsAt ?? "").slice(0, 10))}. This page shows the key once: send the invitation now.</p>
<div style="display:grid;gap:1rem;margin-block-start:2rem;max-width:46rem"><p class="key">${esc(key)}</p>
<div class="actions" style="margin:0"><a class="btn" href="${esc(mailto)}">Open the invitation in my email</a><a class="btn secondary" href="/admin">Back to admin</a></div>
<p class="note">Or copy this invitation to ${esc(license.email)}:</p><pre>${esc(`Subject: ${inv.subject}\n\n${inv.body}`)}</pre></div>`,
    ),
    { active: "admin" },
  );
}

export function adminPage(licenses: (LicenseRow & { deviceCount: number; trial?: boolean })[], feedback: FeedbackRow[]): string {
  const trials = licenses.filter((l) => l.trial).length;
  const statusCls = (s: string) => (s === "active" || s === "trialing" ? "ok" : "warn");
  const ended = (l: LicenseRow) => !!l.endsAt && Date.parse(l.endsAt) <= Date.now();
  const teamOf = new Map(licenses.map((l) => [l.id, l.team ?? l.email]));
  return layout(
    "OneSeat admin",
    section(`${eyebrow("Admin")}<h1>Admin</h1><p class="lead">${licenses.length} recent licenses · ${trials} free trial${trials === 1 ? "" : "s"} · ${feedback.length} recent feedback</p>`) +
      section(
        `<div class="split"><div>${eyebrow("Pilot")}<h2>Invite a pilot team</h2><p>Creates a Team license for up to ${PLANS.team.computers} computers that switches to Free on its end date. You see the key once, with an invitation to send.</p></div>
<form class="stack card" method="post" action="/admin/pilot"><label>Team name<input name="team" required maxlength="80" autocomplete="organization" placeholder="Acme Bakery"></label>
<label>Contact email<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="owner@acme.example"></label>
<label>Pilot length<select name="weeks"><option value="2">2 weeks</option><option value="4" selected>4 weeks</option><option value="6">6 weeks</option><option value="8">8 weeks</option></select></label>
<div><button class="btn" type="submit">Create pilot license</button></div></form></div>`,
        { band: true },
      ) +
      section(
        `<div class="head">${eyebrow("Feedback")}<h2>Feedback</h2></div><div class="table"><table><thead><tr><th>When</th><th>Rating</th><th>Topic</th><th>Message</th><th>Team / from</th><th>App</th></tr></thead><tbody>
${feedback.map((f) => `<tr><td class="num">${esc(f.createdAt.slice(0, 16).replace("T", " "))}</td><td class="num">${f.rating ?? ""}</td><td>${esc(f.topic)}</td><td>${esc(f.message)}</td><td>${f.licenseId && teamOf.get(f.licenseId) ? `<b>${esc(teamOf.get(f.licenseId))}</b><br>` : ""}${esc(f.email ?? "")}${f.licenseId ? ` <code>${esc(f.licenseId)}</code>` : ""}</td><td>${esc(f.appVersion)} ${esc(f.os)}</td></tr>`).join("") || `<tr><td colspan="6">No feedback yet.</td></tr>`}
</tbody></table></div>`,
      ) +
      section(
        `<div class="head">${eyebrow("Licenses")}<h2>Licenses</h2></div><div class="table"><table><thead><tr><th>Created</th><th>Team or email</th><th>Plan</th><th>Status</th><th>Ends</th><th>Computers</th><th>Stripe</th></tr></thead><tbody>
${licenses.map((l) => `<tr><td class="num">${esc(l.createdAt.slice(0, 10))}</td><td>${l.team ? `<b>${esc(l.team)}</b><br>` : ""}${esc(l.email)}</td><td>${esc(PLANS[l.tier].name)}${l.trial ? ` <span class="tag cobalt">trial</span>` : l.team ? ` <span class="tag">pilot</span>` : ""}</td><td class="${ended(l) ? "warn" : statusCls(l.status)}">${ended(l) ? "ended" : esc(l.status)}</td><td class="num">${esc((l.endsAt ?? "").slice(0, 10))}</td><td class="num">${l.deviceCount} / ${l.computers}</td><td><code>${esc(l.stripeSubscription ?? "")}</code></td></tr>`).join("") || `<tr><td colspan="7">No licenses yet.</td></tr>`}
</tbody></table></div>`,
      ),
    { active: "admin" },
  );
}
