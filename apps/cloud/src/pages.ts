// Server-rendered pages. No JavaScript: every page works with the strict content policy.
import { FEATURE_LABELS, PLANS, type Feature, type Tier } from "@oneseat/contracts";
import type { CloudConfig } from "./config.js";
import type { FeedbackRow, LicenseRow } from "./store.js";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const CSS = `
:root{--bg:#fbfaf7;--ink:#15171a;--mute:#5d636b;--line:#e3e0d8;--card:#fff;--brand:#1f4e79;--brand-ink:#fff;--ok:#1d6b3a;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--ink:#ecebe7;--mute:#a4a9b0;--line:#2b2f35;--card:#1a1d21;--brand:#7fb2e5;--brand-ink:#0b1622;--ok:#6fcf97;--warn:#f2c46d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px;max-width:1040px;margin:0 auto}
header.top nav{display:flex;gap:16px;flex-wrap:wrap}.logo{font-weight:700;font-size:18px;text-decoration:none;color:var(--ink)}
h1{font-size:clamp(30px,5vw,46px);line-height:1.1;margin:24px 0 12px;letter-spacing:-.02em;max-width:22ch}h2{font-size:24px;margin:40px 0 12px}
.lead{font-size:19px;color:var(--mute);max-width:62ch}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}.card h3{margin:0 0 4px;font-size:20px}
.price{font-size:32px;font-weight:700}.price small{font-size:15px;font-weight:400;color:var(--mute)}
ul.f{padding-left:18px;margin:12px 0}ul.f li{margin:4px 0}.btn{display:inline-block;background:var(--brand);color:var(--brand-ink);padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;margin:4px 8px 4px 0}
.btn.ghost{background:transparent;color:var(--brand);border:1px solid var(--brand)}.note{color:var(--mute);font-size:14px}
.key{font:600 22px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;background:var(--card);border:1px dashed var(--brand);padding:14px 16px;border-radius:8px;display:inline-block;user-select:all}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:13px}.ok{color:var(--ok)}.warn{color:var(--warn)}
footer{max-width:1040px;margin:0 auto;padding:24px 16px;color:var(--mute);font-size:14px;border-top:1px solid var(--line)}
`;

export function layout(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<style>${CSS}</style></head><body>
<header class="top"><a class="logo" href="/">OneSeat</a><nav><a href="/#plans">Plans</a><a href="/download">Download</a><a href="/pilot">Pilot</a><a href="/privacy">Privacy</a></nav></header>
<main>${body}</main>
<footer>OneSeat runs on your computer with your own model key. Your business data never comes to our servers.</footer>
</body></html>`;
}

function planCard(tier: Tier, cfg: CloudConfig): string {
  const p = PLANS[tier];
  const feats: string[] =
    tier === "free"
      ? ["The seven starter skills", "Runs, approvals and the activity log", "Your own model key: Claude, OpenAI, Gemini or local"]
      : [`${p.computers} computers`, ...p.features.map((f: Feature) => FEATURE_LABELS[f])];
  const links =
    tier === "free"
      ? `<a class="btn" href="/download">Download free</a>`
      : [
          cfg.paymentLinks[`${tier}_monthly`] ? `<a class="btn" href="${esc(cfg.paymentLinks[`${tier}_monthly`])}">Monthly</a>` : "",
          cfg.paymentLinks[`${tier}_yearly`] ? `<a class="btn ghost" href="${esc(cfg.paymentLinks[`${tier}_yearly`])}">Yearly, 20% off</a>` : "",
        ].join("") || `<span class="note">Checkout opens soon.</span>`;
  const price =
    tier === "free" ? `<div class="price">$0</div>` : `<div class="price">${money(p.monthlyCents)}<small> / month per team</small></div><div class="note">or ${money(p.yearlyCents)} / year</div>`;
  return `<section class="card" aria-labelledby="plan-${tier}"><h3 id="plan-${tier}">${esc(p.name)}</h3>${price}<p>${esc(p.blurb)}</p><ul class="f">${feats.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>${links}</section>`;
}

export function homePage(cfg: CloudConfig): string {
  return layout(
    "OneSeat",
    `<h1>One desktop app, one skills library, any model.</h1>
<p class="lead">OneSeat runs repetitive business tasks as skills: customer lookups, outreach emails, invoices, social posts, support replies and weekly reports. It replaces several per-seat tools with one app on your own model key.</p>
<p><a class="btn" href="/download">Download for Windows or Mac</a><a class="btn ghost" href="#plans">See plans</a></p>
<h2 id="plans">Plans</h2><p class="note">Flat price per team. No per-seat fees. You pay your model provider directly for what you use.</p>
<div class="grid">${(["free", "pro", "team"] as const).map((t) => planCard(t, cfg)).join("")}</div>
${cfg.billingPortalUrl ? `<p class="note">Already subscribed? <a href="${esc(cfg.billingPortalUrl)}">Manage billing</a>.</p>` : ""}
<h2>What OneSeat never does</h2><ul class="f"><li>It never sends, pays or deletes without asking you first.</li><li>It never uploads your customer data: everything stays on your computer.</li><li>Your model key lives in your operating system's keychain.</li></ul>`,
  );
}

export function downloadPage(cfg: CloudConfig): string {
  const link = (url: string | undefined, label: string) => (url ? `<a class="btn" href="${esc(url)}">${esc(label)}</a>` : `<span class="note">${esc(label)}: coming soon.</span>`);
  return layout(
    "Download OneSeat",
    `<h1>Download OneSeat</h1><p class="lead">Install, paste a model key, and run your first task in under five minutes.</p>
<div class="grid"><section class="card"><h3>Windows 10 / 11</h3><p>Installs for your user only; no admin rights.</p>${link(cfg.downloads.windows, "Download for Windows")}
<p class="note">Pilot builds are not signed yet. If Windows says it protected your PC, choose <b>More info → Run anyway</b>.</p></section>
<section class="card"><h3>macOS (Apple silicon)</h3><p>Drag OneSeat to Applications.</p>${link(cfg.downloads.mac, "Download for Mac")}
<p class="note">The first time, right-click OneSeat → Open. If macOS says it is damaged, run <code>xattr -cr /Applications/OneSeat.app</code> in Terminal.</p></section></div>
<h2>Model keys</h2><ul class="f"><li>Claude and OpenAI keys need prepaid API credit. A Claude Pro/Max or ChatGPT subscription does not include API use.</li><li>Gemini has a free tier, good for trying OneSeat. On it Google may use requests to improve its products, so use a paid key for real customer data.</li></ul>`,
  );
}

export function pilotPage(cfg: CloudConfig): string {
  return layout(
    "OneSeat pilot",
    `<h1>OneSeat pilot</h1><p class="lead">Thank you for testing OneSeat with your team. Pilot teams get Team for free during the pilot.</p>
<ol class="f"><li><a href="/download">Download and install</a> OneSeat.</li><li>Choose the Team plan below and enter your pilot code at checkout. You will not be charged during the pilot.</li><li>Copy the license key from the welcome page into OneSeat → <b>Plan</b>.</li><li>Use it for real work for two weeks and send feedback from OneSeat → <b>Plan → Send feedback</b>.</li></ol>
<div class="grid">${planCard("team", cfg)}</div>`,
  );
}

export function privacyPage(): string {
  return layout(
    "Privacy",
    `<h1>Privacy</h1><p class="lead">OneSeat is built so your business data stays on your computer.</p>
<ul class="f"><li><b>On your computer:</b> your database, skills, pinned apps and activity log. Your model key is in the operating system's keychain.</li>
<li><b>To your model provider:</b> the text of your requests and the data a skill looks up to answer them, under that provider's terms.</li>
<li><b>To OneSeat Cloud:</b> only your email and billing status (from Stripe), your license key's activations (a random computer id and its name), and feedback you choose to send.</li>
<li>Payments are handled by Stripe. We never see your card number.</li></ul>`,
  );
}

export function welcomePage(state: { kind: "pending" } | { kind: "ready"; license: LicenseRow; key: string | undefined } | { kind: "missing" }): string {
  if (state.kind === "pending")
    return layout("Setting up your license", `<h1>Thank you!</h1><p class="lead">We are setting up your license. This page refreshes by itself.</p>`, { refreshSeconds: 3 });
  if (state.kind === "missing")
    return layout("License not found", `<h1>We could not find that checkout</h1><p class="lead">If you just paid, wait a minute and reload this page. Otherwise contact support with your receipt.</p>`);
  const p = PLANS[state.license.tier];
  const key = state.key
    ? `<p>Your license key:</p><p class="key">${esc(state.key)}</p><p class="note">Copy it now. For your security we show it for 24 hours only.</p>`
    : `<p class="note">The key was shown when you checked out and is no longer displayed. Contact support to issue a new one.</p>`;
  return layout(
    "Welcome to OneSeat",
    `<h1>Welcome to OneSeat ${esc(p.name)}</h1>${key}
<ol class="f"><li>Open OneSeat (<a href="/download">download it</a> if needed).</li><li>Go to <b>Plan</b>, paste the key and choose <b>Activate</b>.</li><li>Use it on up to ${p.computers} computers.</li></ol>`,
  );
}

export function adminPage(licenses: (LicenseRow & { deviceCount: number })[], feedback: FeedbackRow[]): string {
  const statusCls = (s: string) => (s === "active" || s === "trialing" ? "ok" : "warn");
  return layout(
    "OneSeat admin",
    `<h1>Admin</h1><p class="note">${licenses.length} recent licenses · ${feedback.length} recent feedback</p>
<h2>Feedback</h2><table><thead><tr><th>When</th><th>Rating</th><th>Topic</th><th>Message</th><th>From</th><th>App</th></tr></thead><tbody>
${feedback.map((f) => `<tr><td>${esc(f.createdAt.slice(0, 16).replace("T", " "))}</td><td>${f.rating ?? ""}</td><td>${esc(f.topic)}</td><td>${esc(f.message)}</td><td>${esc(f.email ?? "")}${f.licenseId ? ` <span class="pill">${esc(f.licenseId)}</span>` : ""}</td><td>${esc(f.appVersion)} ${esc(f.os)}</td></tr>`).join("") || `<tr><td colspan="6">No feedback yet.</td></tr>`}
</tbody></table>
<h2>Licenses</h2><table><thead><tr><th>Created</th><th>Email</th><th>Plan</th><th>Status</th><th>Computers</th><th>Stripe</th></tr></thead><tbody>
${licenses.map((l) => `<tr><td>${esc(l.createdAt.slice(0, 10))}</td><td>${esc(l.email)}</td><td>${esc(PLANS[l.tier].name)}</td><td class="${statusCls(l.status)}">${esc(l.status)}</td><td>${l.deviceCount} / ${l.computers}</td><td>${esc(l.stripeSubscription ?? "")}</td></tr>`).join("") || `<tr><td colspan="6">No licenses yet.</td></tr>`}
</tbody></table>`,
  );
}
