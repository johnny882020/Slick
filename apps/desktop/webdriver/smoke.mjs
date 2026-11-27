#!/usr/bin/env node
// Tauri WebDriver smoke test (optional, CI-only, Windows). Drives the real app through
// tauri-driver (W3C WebDriver on :4444, backed by msedgedriver on Windows). tauri-driver does
// not support macOS; on Linux it needs WebKitWebDriver. No npm dependencies: plain HTTP.
//
// Build first (debug profile, bundled frontend, so the dev-only env hooks below work):
//   pnpm --filter @oneseat/desktop tauri build --debug --no-bundle
// Then, with tauri-driver running (cargo install tauri-driver --locked; tauri-driver):
//   node webdriver/smoke.mjs [path to oneseat-desktop(.exe)]
//
// The app runs with the fake daemon (ONESEAT_DAEMON), an in-memory key store
// (ONESEAT_DEV_MEMORY_KEYSTORE=1, so the runner's Credential Manager is untouched) and a
// throwaway data dir (ONESEAT_DEV_DATA_DIR). Steps: first-run setup -> save a key -> run a
// task -> see the skill chip and "Done" -> approve an email -> see it sent.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const exe =
  process.argv[2] ?? join(desktop, "src-tauri", "target", "debug", `oneseat-desktop${process.platform === "win32" ? ".exe" : ""}`);
const DRIVER = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a5ab-4b1df2fbd16c";

// The app inherits tauri-driver's environment; set these before starting tauri-driver in CI.
process.env.ONESEAT_DAEMON ??= join(desktop, "dev", "fake-daemon.mjs");
process.env.ONESEAT_DEV_MEMORY_KEYSTORE ??= "1";
process.env.ONESEAT_DEV_DATA_DIR ??= mkdtempSync(join(tmpdir(), "oneseat-wd-"));

async function wd(method, path, body) {
  const r = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await r.json();
  if (!r.ok || json.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function main() {
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: exe } } },
  });
  const sid = session.sessionId;
  const find = async (css) => (await wd("POST", `/session/${sid}/element`, { using: "css selector", value: css }))[ELEMENT];
  const text = async (css) => wd("GET", `/session/${sid}/element/${await find(css)}/text`);
  const click = async (css) => wd("POST", `/session/${sid}/element/${await find(css)}/click`, {});
  const type = async (css, value) => wd("POST", `/session/${sid}/element/${await find(css)}/value`, { text: value });
  const byText = async (tag, label) => {
    const id = await wd("POST", `/session/${sid}/execute/sync`, {
      script: `return [...document.querySelectorAll(arguments[0])].find((e) => e.textContent.trim() === arguments[1]) || null;`,
      args: [tag, label],
    });
    if (!id) throw new Error(`no ${tag} "${label}"`);
    return id[ELEMENT];
  };
  try {
    await waitFor(async () => (await text("h1")) === "Connect a model", "setup screen");
    console.log("ok: first run shows setup");
    await type('input[name="api-key"]', "sk-ant-webdriver-0123456789");
    await click('button[type="submit"]');
    await waitFor(async () => (await text("main .status")).includes("saved in your keychain"), "key saved");
    console.log("ok: key saved");
    await wd("POST", `/session/${sid}/element/${await byText("button", "Continue to Run")}/click`, {});
    await waitFor(async () => (await text("h1")) === "Run a task", "run screen");
    await waitFor(async () => (await wd("GET", `/session/${sid}/element/${await find('select[name="model"]')}/property/value`)) !== "", "models");
    await type('textarea[name="task"]', "Give me the weekly recap");
    await click('form button[type="submit"]');
    await waitFor(async () => (await text(".run-status")) === "Done", "run done");
    if (!(await text(".chips")).includes("weekly-report")) throw new Error("no skill chip");
    console.log("ok: run streamed with a skill chip");
    const task = await find('textarea[name="task"]');
    await wd("POST", `/session/${sid}/element/${task}/clear`, {});
    await type('textarea[name="task"]', "Send a reminder email to Acme");
    await click('form button[type="submit"]');
    await waitFor(async () => (await text("dialog.approval-dialog")).includes("billing@acme.example"), "approval dialog");
    await wd("POST", `/session/${sid}/element/${await byText("dialog button", "Approve")}/click`, {});
    await waitFor(async () => (await text(".run-output")).includes("I sent the reminder"), "approved send");
    console.log("ok: approval dialog approve");
    console.log("webdriver smoke: PASS");
  } finally {
    await wd("DELETE", `/session/${sid}`).catch(() => {});
  }
}

main().catch((e) => {
  console.error(`webdriver smoke: FAIL: ${e.message}`);
  process.exit(1);
});
