// OneSeat Cloud over real HTTP with the in-memory store: Stripe webhooks (signed),
// license issue and reveal, activation with computer limits, token signatures,
// feedback, admin auth and pages.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { decodeLicenseToken, entitlementFrom } from "@oneseat/contracts";
import { createCloudApp, loadConfig, LicenseSigner, MemoryStore, signStripePayload, verifyStripeSignature, tierFromSubscription, mapSubscriptionStatus, generateLicenseKey, hashKey } from "../src/index.js";

const WHSEC = "whsec_test_secret";
const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const cfg = loadConfig({
  PORT: "0",
  PUBLIC_URL: "https://oneseat.test",
  STRIPE_WEBHOOK_SECRET: WHSEC,
  LICENSE_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
  ADMIN_TOKEN: "admin-secret",
  PAYMENT_LINK_PRO_MONTHLY: "https://buy.stripe.com/test_pro_m",
  PAYMENT_LINK_TEAM_MONTHLY: "https://buy.stripe.com/test_team_m",
  PAYMENT_LINK_IDS: "plink_pro_m,plink_team_m",
  PRICE_TIERS: "price_team_y=team",
  BILLING_PORTAL_URL: "https://billing.stripe.com/p/login/test",
  DOWNLOAD_WINDOWS_URL: "https://dl.test/OneSeat-setup.exe",
});
const store = new MemoryStore();
const logs: string[] = [];
const app = createCloudApp(cfg, store, (l) => logs.push(l));
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.server.close(() => r())));

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const hook = (event: unknown) => {
  const payload = JSON.stringify(event);
  return post("/api/v1/stripe/webhook", payload, { "stripe-signature": signStripePayload(payload, WHSEC) });
};
const sub = (id: string, status: string, price: Record<string, unknown>) => ({ id, object: "subscription", status, customer: "cus_1", items: { data: [{ price }] } });

describe("Stripe signature", () => {
  it("accepts Stripe's scheme and rejects tampering, old timestamps and bad headers", () => {
    const now = 1_800_000_000;
    const h = signStripePayload("{}", WHSEC, now);
    expect(() => verifyStripeSignature("{}", h, WHSEC, 300, now)).not.toThrow();
    expect(() => verifyStripeSignature("{ }", h, WHSEC, 300, now)).toThrow(/no matching/);
    expect(() => verifyStripeSignature("{}", h, "whsec_other", 300, now)).toThrow(/no matching/);
    expect(() => verifyStripeSignature("{}", h, WHSEC, 300, now + 301)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature("{}", undefined, WHSEC)).toThrow(/missing/);
    expect(() => verifyStripeSignature("{}", "v1=abc", WHSEC)).toThrow(/malformed/);
    expect(() => verifyStripeSignature("{}", `t=${now},v0=aa,${h.split(",")[1]}`, WHSEC, 300, now)).not.toThrow();
  });
  it("maps statuses and tiers", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("trialing");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("canceled");
    expect(tierFromSubscription(sub("s", "active", { id: "p", metadata: { tier: "pro" } }), {})).toBe("pro");
    expect(tierFromSubscription(sub("s", "active", { id: "price_team_y", metadata: {} }), { price_team_y: "team" })).toBe("team");
    expect(tierFromSubscription(sub("s", "active", { id: "p", lookup_key: "oneseat_team_yearly" }), {})).toBe("team");
    expect(tierFromSubscription(sub("s", "active", { id: "other" }), {})).toBeUndefined();
  });
  it("generates readable, unique keys", () => {
    const keys = new Set(Array.from({ length: 500 }, generateLicenseKey));
    expect(keys.size).toBe(500);
    for (const k of keys) expect(k).toMatch(/^OS(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    expect(hashKey(" os-aaaa-bbbb-cccc-dddd ")).toBe(hashKey("OS-AAAA-BBBB-CCCC-DDDD"));
  });
});

describe("checkout to license to activation", () => {
  let key = "";
  it("rejects unsigned and wrongly signed webhooks", async () => {
    expect((await post("/api/v1/stripe/webhook", "{}")).status).toBe(400);
    expect((await post("/api/v1/stripe/webhook", "{}", { "stripe-signature": signStripePayload("{}", "whsec_wrong") })).body.code).toBe("bad_signature");
  });

  it("issues a license from checkout + subscription events, in either order, once", async () => {
    // Subscription event first, then the checkout (Stripe does not order them).
    expect((await hook({ id: "evt_1", type: "customer.subscription.created", data: { object: sub("sub_1", "active", { id: "price_pro_m", metadata: { tier: "pro" } }) } })).body.handled).toBe(true);
    const r = await hook({ id: "evt_2", type: "checkout.session.completed", data: { object: { id: "cs_test_aaaaaaaa1", mode: "subscription", subscription: "sub_1", customer: "cus_1", payment_link: "plink_pro_m", customer_details: { email: "ada@example.com" } } } });
    expect(r.body.handled).toBe(true);
    expect((await hook({ id: "evt_2", type: "checkout.session.completed", data: { object: {} } })).body.duplicate).toBe(true);
    expect(store.licenses.size).toBe(1);
    const lic = [...store.licenses.values()][0]!;
    expect(lic).toMatchObject({ tier: "pro", status: "active", computers: 3, email: "ada@example.com", checkoutSession: "cs_test_aaaaaaaa1" });
  });

  it("ignores other products on the same Stripe account", async () => {
    expect((await hook({ id: "evt_x1", type: "customer.subscription.created", data: { object: sub("sub_other", "active", { id: "price_other" }) } })).body.handled).toBe(false);
    expect((await hook({ id: "evt_x2", type: "checkout.session.completed", data: { object: { id: "cs_test_other0001", mode: "subscription", subscription: "sub_other", payment_link: "plink_not_ours" } } })).body.handled).toBe(false);
    expect((await hook({ id: "evt_x3", type: "invoice.paid", data: { object: {} } })).body.handled).toBe(false);
    expect(store.licenses.size).toBe(1);
  });

  it("shows the key on the welcome page, and a waiting page before the webhook lands", async () => {
    const page = await (await fetch(`${base}/welcome?session_id=cs_test_aaaaaaaa1`)).text();
    const m = page.match(/OS(-[0-9A-HJKMNP-TV-Z]{4}){4}/);
    expect(m).not.toBeNull();
    key = m![0];
    expect(page).toContain("Welcome to OneSeat Pro");
    const waiting = await fetch(`${base}/welcome?session_id=cs_test_notyet000`);
    expect(await waiting.text()).toContain('http-equiv="refresh"');
    expect((await fetch(`${base}/welcome?session_id=<script>`)).status).toBe(404);
  });

  it("activates up to the plan's computer limit with a verifiable signed token", async () => {
    const a = await post("/api/v1/licenses/activate", { licenseKey: key.toLowerCase(), deviceId: "dev-1", deviceName: "Ada's Mac" });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ tier: "pro", computers: 3, used: 1 });
    const pem = await (await fetch(`${base}/license-public-key.pem`)).text();
    const d = decodeLicenseToken(String(a.body.token))!;
    expect(verify(null, Buffer.from(d.signed), createPublicKey(pem), Buffer.from(d.signature))).toBe(true);
    expect(d.payload).toMatchObject({ tier: "pro", deviceId: "dev-1", email: "ada@example.com" });
    expect(entitlementFrom(d.payload, Math.floor(Date.now() / 1000)).features).toContain("pinned_apps");
    // Same computer again does not use another slot.
    expect((await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: "dev-1" })).body.used).toBe(1);
    for (const dev of ["dev-2", "dev-3"]) expect((await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: dev })).status).toBe(200);
    const full = await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: "dev-4" });
    expect(full).toMatchObject({ status: 409, body: { code: "computer_limit" } });
    expect((await post("/api/v1/licenses/deactivate", { licenseKey: key, deviceId: "dev-3" })).body.ok).toBe(true);
    expect((await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: "dev-4" })).status).toBe(200);
  });

  it("refreshes known computers only, and follows plan changes and cancellation", async () => {
    expect((await post("/api/v1/licenses/refresh", { licenseKey: key, deviceId: "dev-9" })).body.code).toBe("not_activated");
    await hook({ id: "evt_3", type: "customer.subscription.updated", data: { object: sub("sub_1", "active", { id: "price_team_y", metadata: {} }) } });
    const up = await post("/api/v1/licenses/refresh", { licenseKey: key, deviceId: "dev-1" });
    expect(up.body).toMatchObject({ tier: "team", computers: 15 });
    await hook({ id: "evt_4", type: "customer.subscription.updated", data: { object: sub("sub_1", "past_due", { id: "price_team_y" }) } });
    expect((await post("/api/v1/licenses/refresh", { licenseKey: key, deviceId: "dev-1" })).body.status).toBe("past_due");
    await hook({ id: "evt_5", type: "customer.subscription.deleted", data: { object: sub("sub_1", "canceled", { id: "price_team_y" }) } });
    expect((await post("/api/v1/licenses/refresh", { licenseKey: key, deviceId: "dev-1" })).body.code).toBe("canceled");
  });

  it("validates input", async () => {
    expect((await post("/api/v1/licenses/activate", { licenseKey: "nope", deviceId: "d" })).body.code).toBe("bad_key");
    expect((await post("/api/v1/licenses/activate", { licenseKey: "OS-AAAA-BBBB-CCCC-DDDD", deviceId: "d" })).body.code).toBe("unknown_key");
    expect((await post("/api/v1/licenses/activate", { licenseKey: key })).status).toBe(400);
    expect((await post("/api/v1/licenses/activate", "[1]")).status).toBe(400);
    expect((await post("/api/v1/nope", {})).status).toBe(404);
    expect((await fetch(`${base}/api/v1/feedback`, { method: "PUT" })).status).toBe(405);
  });
});

describe("feedback, admin and pages", () => {
  it("stores feedback, links it to a license, and rate limits", async () => {
    const key = (await store.revealKey([...store.licenses.values()][0]!.id))!;
    const r = await post("/api/v1/feedback", { message: "Invoices worked first time.", rating: 5, topic: "invoices", licenseKey: key, appVersion: "0.1.0", os: "macos" });
    expect(r.body.ok).toBe(true);
    expect(store.feedback[0]).toMatchObject({ rating: 5, topic: "invoices", licenseId: [...store.licenses.values()][0]!.id });
    expect((await post("/api/v1/feedback", { message: "x", rating: 9 })).status).toBe(400);
    expect((await post("/api/v1/feedback", { rating: 3 })).status).toBe(400);
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) limited = (await post("/api/v1/feedback", { message: `m${i}` })).status === 429;
    expect(limited).toBe(true);
  });

  it("protects /admin with basic auth and escapes what users wrote", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(401);
    const bad = await fetch(`${base}/admin`, { headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` } });
    expect(bad.status).toBe(401);
    await store.addFeedback({ licenseId: null, email: null, rating: null, topic: null, message: "<img src=x onerror=alert(1)>", appVersion: null, os: null });
    const ok = await fetch(`${base}/admin`, { headers: { authorization: `Basic ${Buffer.from("admin:admin-secret").toString("base64")}` } });
    const page = await ok.text();
    expect(ok.status).toBe(200);
    expect(page).toContain("&lt;img src=x");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("ada@example.com");
  });

  it("serves pages with a strict content policy and the configured links", async () => {
    const home = await fetch(`${base}/`);
    const text = await home.text();
    expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(text).toContain("https://buy.stripe.com/test_pro_m");
    expect(text).toContain("$19");
    expect(text).toContain("$79");
    expect(text).toContain("Manage billing");
    expect(text).not.toMatch(/<script/i);
    const download = await (await fetch(`${base}/download`)).text();
    expect(download).toContain('href="/download/windows"');
    expect(download).toContain("Download for Mac: not published yet");
    const win = await fetch(`${base}/download/windows`, { redirect: "manual" });
    expect(win.status).toBe(302);
    expect(win.headers.get("location")).toBe("https://dl.test/OneSeat-setup.exe");
    expect((await fetch(`${base}/download/mac`, { redirect: "manual" })).status).toBe(404);
    const pilot = await (await fetch(`${base}/pilot`)).text();
    expect(pilot).toContain("Activate your pilot license");
    expect(pilot).not.toContain("$79");
    expect(pilot).not.toContain("buy.stripe.com");
    expect(home.headers.get("content-security-policy")).toContain("font-src 'self'");
    // Keeps referrers off links to other sites, and lets the admin form's origin check work.
    expect(home.headers.get("referrer-policy")).toBe("same-origin");
    const font = await fetch(`${base}/fonts/newsreader-latin-wght-normal.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${base}/fonts/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/fonts/nope.woff2`)).status).toBe(404);
    for (const p of ["/pilot", "/privacy"]) expect((await fetch(base + p)).status).toBe(200);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, db: true, licensing: true, webhooks: true });
  });
});

describe("pilot licenses", () => {
  const auth = { authorization: `Basic ${Buffer.from("admin:admin-secret").toString("base64")}` };
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/admin/pilot`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...auth, ...headers }, body: new URLSearchParams(fields).toString() });

  it("creates a Team license for a pilot team from the admin form, shown once with an invitation", async () => {
    const r = await form({ team: "Acme Bakery", email: "owner@acme.example", weeks: "4" }, { origin: "https://oneseat.test", "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const page = await r.text();
    const key = /OS(-[0-9A-HJKMNP-TV-Z]{4}){4}/.exec(page)![0];
    expect(page).toContain("mailto:owner%40acme.example");
    expect(page).toContain("https://oneseat.test/pilot");
    const lic = [...store.licenses.values()].find((l) => l.team === "Acme Bakery")!;
    expect(lic).toMatchObject({ tier: "team", status: "trialing", computers: 15, email: "owner@acme.example", stripeSubscription: null });
    expect(Date.parse(lic.endsAt!) - Date.now()).toBeGreaterThan(27 * 86_400_000);
    const a = await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: "pilot-dev-1", deviceName: "Front desk" });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ tier: "team", status: "trialing", computers: 15 });
    const admin = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(admin).toContain("Acme Bakery");
  });

  it("refuses cross-site posts, bad input and missing auth", async () => {
    expect((await form({ team: "X", email: "x@x.example" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await form({ team: "X", email: "x@x.example" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await form({ team: "", email: "x@x.example" })).status).toBe(400);
    expect((await form({ team: "X", email: "not-an-email" })).status).toBe(400);
    expect((await form({ team: "X", email: "x@x.example", weeks: "40" })).status).toBe(400);
    const noAuth = await fetch(`${base}/admin/pilot`, { method: "POST", body: "team=X&email=x%40x.example" });
    expect(noAuth.status).toBe(401);
  });

  it("stops working after its end date, so the app falls back to Free", async () => {
    const key = "OS-ABCD-EFGH-JKMN-PQRS";
    await store.createLicense({ id: "lic_ended", keyHash: hashKey(key), email: "t@t.example", tier: "team", status: "trialing", computers: 15, team: "Ended Co", endsAt: new Date(Date.now() - 1000).toISOString() });
    const a = await post("/api/v1/licenses/activate", { licenseKey: key, deviceId: "d1" });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ code: "canceled" });
    expect(String(a.body.error)).toMatch(/pilot license ended/);
  });
});

describe("free Team trial", () => {
  // Each test uses its own client address so the trial rate limit (5 a minute) stays predictable.
  const from = (ip: string) => ({ "x-forwarded-for": ip });
  const auth = { authorization: `Basic ${Buffer.from("admin:admin-secret").toString("base64")}` };
  let trialKey = "";

  it("issues a Team key for 14 days and activates this computer with it, once", async () => {
    const logStart = logs.length;
    const r = await post("/api/v1/trials", { email: "  Owner@Trial.example ", deviceId: "dev_trial_aaaa1", deviceName: "Front desk" }, from("10.1.0.1"));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["computers", "expiresAt", "licenseKey", "status", "tier", "token", "used"]);
    expect(r.body).toMatchObject({ tier: "team", status: "trialing", computers: 15, used: 1 });
    trialKey = String(r.body.licenseKey);
    expect(trialKey).toMatch(/^OS(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    const pem = await (await fetch(`${base}/license-public-key.pem`)).text();
    const d = decodeLicenseToken(String(r.body.token))!;
    expect(verify(null, Buffer.from(d.signed), createPublicKey(pem), Buffer.from(d.signature))).toBe(true);
    expect(d.payload).toMatchObject({ tier: "team", status: "trialing", deviceId: "dev_trial_aaaa1", email: "Owner@Trial.example" });
    // The token stops on the trial's last day even without a refresh.
    const lic = [...store.licenses.values()].find((l) => l.keyHash === hashKey(trialKey))!;
    expect(lic).toMatchObject({ team: "Trial", tier: "team", status: "trialing", computers: 15, email: "Owner@Trial.example", stripeSubscription: null });
    expect(Math.abs(Date.parse(lic.endsAt!) - (Date.now() + 14 * 86_400_000))).toBeLessThan(60_000);
    expect(d.payload.exp).toBe(Math.floor(Date.parse(lic.endsAt!) / 1000));
    expect(r.body.expiresAt).toBe(new Date(d.payload.exp * 1000).toISOString());
    expect((await store.devices(lic.id)).map((x) => x.deviceName)).toEqual(["Front desk"]);
    // Neither the key nor the email goes to the log.
    const lines = logs.slice(logStart).join("\n");
    expect(lines).toContain("trial license");
    expect(lines).not.toContain(trialKey);
    expect(lines.toLowerCase()).not.toContain("owner@trial.example");
  });

  it("lets the rest of the team use the trial key on their computers", async () => {
    const a = await post("/api/v1/licenses/activate", { licenseKey: trialKey, deviceId: "dev_trial_bbbb2", deviceName: "Office PC" });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ tier: "team", status: "trialing", computers: 15, used: 2 });
  });

  it("refuses a second trial for the same email or the same computer", async () => {
    const again = await post("/api/v1/trials", { email: "OWNER@trial.example", deviceId: "dev_trial_cccc3" }, from("10.1.0.2"));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "trial_used" });
    expect(String(again.body.error)).toContain("https://oneseat.test/#plans");
    const sameComputer = await post("/api/v1/trials", { email: "someone.else@trial.example", deviceId: "dev_trial_aaaa1" }, from("10.1.0.2"));
    expect(sameComputer).toMatchObject({ status: 409, body: { code: "trial_used" } });
    expect(store.trials).toHaveLength(1);
    expect([...store.licenses.values()].filter((l) => l.team === "Trial")).toHaveLength(1);
  });

  it("validates the email and the computer id", async () => {
    const ip = from("10.1.0.3");
    expect((await post("/api/v1/trials", { email: "not-an-email", deviceId: "dev_trial_dddd4" }, ip)).body).toMatchObject({ code: "bad_email" });
    expect((await post("/api/v1/trials", { email: `${"a".repeat(250)}@x.example`, deviceId: "dev_trial_dddd4" }, ip)).status).toBe(400);
    expect((await post("/api/v1/trials", { email: "a@b.example", deviceId: "x" }, ip)).body).toMatchObject({ code: "bad_device" });
    expect((await post("/api/v1/trials", { deviceId: "dev_trial_dddd4" }, ip)).status).toBe(400);
    expect((await post("/api/v1/trials", { email: "a@b.example" }, ip)).status).toBe(400);
    expect(store.trials).toHaveLength(1);
  });

  it("rate limits trial requests to 5 a minute per client", async () => {
    const ip = from("10.1.0.4");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("/api/v1/trials", { email: `bad${i}`, deviceId: "dev_trial_eeee5" }, ip)).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect((await post("/api/v1/trials", { email: "bad", deviceId: "dev_trial_eeee5" }, from("10.1.0.5"))).status).toBe(400);
  });

  it("shows trials on the admin page", async () => {
    const admin = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(admin).toContain("<b>Trial</b><br>Owner@Trial.example");
    expect(admin).toContain('<span class="tag cobalt">trial</span>');
    expect(admin).toContain("1 free trial ·");
  });

  it("ends on its end date, so the app falls back to Free", async () => {
    const lic = [...store.licenses.values()].find((l) => l.keyHash === hashKey(trialKey))!;
    store.licenses.set(lic.id, { ...lic, endsAt: new Date(Date.now() - 1000).toISOString() });
    const r = await post("/api/v1/licenses/refresh", { licenseKey: trialKey, deviceId: "dev_trial_aaaa1" });
    expect(r).toMatchObject({ status: 403, body: { code: "canceled" } });
    expect(String(r.body.error)).toMatch(/free Team trial ended/);
  });

  it("points to the trial from the pilot and download pages", async () => {
    for (const p of ["/pilot", "/download"]) {
      const page = await (await fetch(base + p)).text();
      expect(page).toContain("Try Team free for 14 days.");
      expect(page).toContain("OneSeat → Plan");
    }
  });
});

describe("unconfigured service", () => {
  it("says what is missing instead of failing silently", async () => {
    const bare = createCloudApp(loadConfig({}), new MemoryStore(), () => {});
    await new Promise<void>((r) => bare.server.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(bare.server.address() as AddressInfo).port}`;
    try {
      expect((await (await fetch(`${b}/api/v1/stripe/webhook`, { method: "POST", body: "{}" })).json()).error).toMatch(/not configured/);
      expect((await fetch(`${b}/license-public-key.pem`)).status).toBe(404);
      const trial = await fetch(`${b}/api/v1/trials`, { method: "POST", body: JSON.stringify({ email: "a@b.example", deviceId: "dev_trial_ffff6" }) });
      expect(trial.status).toBe(503);
      expect((await fetch(`${b}/admin`)).status).toBe(401);
      expect(await (await fetch(`${b}/`)).text()).toContain("Checkout opens soon");
    } finally {
      await new Promise<void>((r) => bare.server.close(() => r()));
    }
  });
});

describe("LICENSE_PRIVATE_KEY as pasted into a dashboard", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
  const shapes: Record<string, string> = {
    "real newlines": pem,
    "\\n escapes": pem.trim().replace(/\n/g, "\\n"),
    "newlines as spaces": pem.trim().replace(/\n/g, " "),
    "in quotes": `"${pem.trim().replace(/\n/g, "\\n")}"`,
    "base64 body only": body,
    "CRLF": pem.replace(/\n/g, "\r\n"),
  };
  for (const [name, value] of Object.entries(shapes)) {
    it(`accepts ${name}`, () => {
      const cfg = loadConfig({ LICENSE_PRIVATE_KEY: value });
      expect(new LicenseSigner(cfg.licensePrivateKey!).publicKeyPem).toContain("BEGIN PUBLIC KEY");
    });
  }
  it("rejects a broken key without echoing it", () => {
    const cfg = loadConfig({ LICENSE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nnot-a-key\\n-----END PRIVATE KEY-----" });
    expect(() => new LicenseSigner(cfg.licensePrivateKey!)).toThrow(/not a readable PEM/);
    try {
      new LicenseSigner(cfg.licensePrivateKey!);
    } catch (e) {
      expect((e as Error).message).not.toContain("not-a-key");
    }
  });
});
