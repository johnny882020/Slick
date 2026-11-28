#!/usr/bin/env node
// End-to-end check of the live billing path, in Stripe TEST mode:
//   Payment Link -> Stripe Checkout (pilot code, no card) -> webhook -> Render -> Neon
//   -> welcome page shows a license key -> activate (signed token verified) -> deactivate.
//
//   node apps/cloud/scripts/checkout-smoke.mjs <test payment link> [--cloud https://oneseat-cloud.onrender.com] [--code ONESEATPILOT]
//
// Uses the Chromium that Playwright provides. Never point it at a live-mode link.
import { createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";

// Playwright is a tool dependency (e.g. a global install), not part of the service.
const { chromium } = createRequire(import.meta.url)("playwright");

const args = process.argv.slice(2);
const link = args.find((a) => a.startsWith("https://"));
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const cloud = opt("--cloud", "https://oneseat-cloud.onrender.com").replace(/\/$/, "");
const code = opt("--code", "ONESEATPILOT");
if (!link || !/^https:\/\/buy\.stripe\.com\/test_/.test(link)) {
  console.error("usage: checkout-smoke.mjs https://buy.stripe.com/test_... (test-mode links only)");
  process.exit(2);
}

const email = `oneseat-smoke+${Date.now()}@example.com`;
const step = (s) => console.log(`- ${s}`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(45_000);
  step(`open ${link}`);
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(email);
  step(`apply promotion code ${code}`);
  const promoButton = page.getByRole("button", { name: /add promotion code/i });
  if (await promoButton.isVisible().catch(() => false)) await promoButton.click();
  await page.locator("#promotionCode").fill(code);
  await page.locator("#promotionCode").press("Enter");
  await page.getByText(/100% off|-\$|−\$/i).first().waitFor();
  step("subscribe");
  await page.locator("button[type=submit], .SubmitButton").first().click();
  await page.waitForURL(/\/welcome\?session_id=cs_test_/, { timeout: 90_000 });
  step(`redirected to ${page.url().replace(/session_id=.*/, "session_id=…")}`);
  // The page refreshes itself until the webhook has created the license.
  let key;
  for (let i = 0; i < 40 && !key; i++) {
    key = (await page.content()).match(/OS(-[0-9A-HJKMNP-TV-Z]{4}){4}/)?.[0];
    if (!key) await page.waitForTimeout(3000), await page.reload();
  }
  if (!key) throw new Error("the welcome page never showed a license key (webhook not received?)");
  step(`license key issued: ${key.slice(0, 7)}…`);
  const heading = await page.locator("h1").textContent();
  step(`welcome page: "${heading}"`);

  const health = await (await fetch(`${cloud}/healthz`)).json();
  if (!health.licensing) {
    console.log("\nCheckout, webhook and license issue PASSED. Activation skipped: LICENSE_PRIVATE_KEY is not set on the service yet.");
    process.exit(0);
  }
  const deviceId = `dev_smoke_${Date.now()}`;
  const act = await fetch(`${cloud}/api/v1/licenses/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseKey: key, deviceId, deviceName: "checkout-smoke" }) });
  const body = await act.json();
  if (!act.ok) throw new Error(`activation failed: ${act.status} ${JSON.stringify(body)}`);
  const [signed, sig] = body.token.split(".");
  const pem = await (await fetch(`${cloud}/license-public-key.pem`)).text();
  const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = verify(null, Buffer.from(signed), createPublicKey(pem), b64(sig));
  const payload = JSON.parse(b64(signed).toString("utf8"));
  if (!ok) throw new Error("the license token signature does not verify");
  step(`activated: ${payload.tier} (${payload.status}), ${body.used} of ${payload.computers} computers, signature verified`);
  const deact = await fetch(`${cloud}/api/v1/licenses/deactivate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseKey: key, deviceId }) });
  step(`deactivated: ${(await deact.json()).ok}`);
  console.log("\nLive billing path PASSED end to end.");
} catch (e) {
  console.error(`\nLive billing path FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
