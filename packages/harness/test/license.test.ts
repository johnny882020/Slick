// LicenseManager against a fake OneSeat Cloud that signs real ed25519 tokens, and the
// daemon's plan gates (import skills, pinned apps, schedules, MCP) on Free vs Pro.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createScriptedProvider,
  encodeLicensePayload,
  joinLicenseToken,
  PLANS,
  RPC_ERRORS,
  type FetchLike,
  type LicensePayload,
  type Tier,
} from "@oneseat/contracts";
import { createDaemon } from "../src/daemon.js";
import { LicenseManager } from "../src/license.js";
import { MemorySkillStore, onCleanup, tmpDir } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY = "OS-7K2M-Q9PX-4HTR-WB3D";

function mint(over: Partial<LicensePayload> & { deviceId: string }, signer = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const tier: Tier = over.tier ?? "pro";
  const p: LicensePayload = { v: 1, lic: "lic_1", tier, status: "active", email: "ada@example.com", computers: PLANS[tier].computers, features: [...PLANS[tier].features], iat: now, exp: now + 14 * 86400, ...over };
  const signed = encodeLicensePayload(p);
  return joinLicenseToken(signed, new Uint8Array(sign(null, Buffer.from(signed), signer)));
}

/** A fake cloud. `answer` decides each response from the path and body. */
function cloud(answer: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const a = answer(path, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const proCloud = () => cloud((path, body) => (path.endsWith("/feedback") ? { json: { ok: true, id: "fb_1" } } : path.endsWith("/deactivate") ? { json: { ok: true } } : { json: { token: mint({ deviceId: String(body["deviceId"]) }) } }));

describe("LicenseManager", () => {
  it("is Free until a key is activated, then verifies the token offline", async () => {
    const dir = tmpDir();
    const c = proCloud();
    const lm = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://cloud.test/", fetch: c.fetch });
    expect(lm.status()).toMatchObject({ tier: "free", status: "none" });
    expect(lm.has("pinned_apps")).toBe(false);
    const ent = await lm.activate(` ${KEY.toLowerCase()} `);
    expect(ent).toMatchObject({ tier: "pro", status: "active", computers: 3 });
    expect(c.calls[0]).toMatchObject({ path: "/api/v1/licenses/activate", body: { licenseKey: KEY, deviceId: lm.deviceId() } });
    expect(lm.has("pinned_apps")).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "license.json")).mode & 0o777).toBe(0o600);
    // A new process on the same computer reads the saved license without the network.
    const again = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://cloud.test", fetch: async () => { throw new Error("offline"); } });
    expect(again.status().tier).toBe("pro");
    expect(again.deviceId()).toBe(lm.deviceId());
  });

  it("rejects forged, foreign-computer and expired tokens", async () => {
    const dir = tmpDir();
    const lm = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://cloud.test", fetch: proCloud().fetch });
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(lm.verifyToken(mint({ deviceId: lm.deviceId() }, other))).toMatchObject({ tier: "free", reason: expect.stringMatching(/signature/) });
    expect(lm.verifyToken(mint({ deviceId: "dev_someone_else" }))).toMatchObject({ tier: "free", reason: expect.stringMatching(/another computer/) });
    expect(lm.verifyToken(mint({ deviceId: lm.deviceId(), exp: 1 }))).toMatchObject({ tier: "free", reason: expect.stringMatching(/14 days/) });
    expect(lm.verifyToken("garbage")).toMatchObject({ tier: "free", reason: expect.stringMatching(/unreadable/) });
    writeFileSync(join(dir, "license.json"), JSON.stringify({ licenseKey: KEY, token: mint({ deviceId: lm.deviceId() }, other) }));
    expect(lm.status().tier).toBe("free");
  });

  it("refuses a bad key, a cloud error, and a token it cannot verify", async () => {
    const dir = tmpDir();
    await expect(new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: proCloud().fetch }).activate("nope")).rejects.toMatchObject({ code: "bad_key" });
    const full = cloud(() => ({ status: 409, json: { error: "this license is already used on 3 of 3 computers", code: "computer_limit" } }));
    await expect(new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: full.fetch }).activate(KEY)).rejects.toMatchObject({ code: "computer_limit", message: expect.stringMatching(/3 of 3/) });
    const forged = cloud(() => ({ json: { token: mint({ deviceId: "x" }, generateKeyPairSync("ed25519").privateKey) } }));
    await expect(new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: forged.fetch }).activate(KEY)).rejects.toMatchObject({ code: "bad_token" });
    const down = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: async () => { throw new Error("ENOTFOUND"); } });
    await expect(down.activate(KEY)).rejects.toMatchObject({ code: "network" });
    const html = cloud(() => ({ status: 502, json: "<html>" }));
    await expect(new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: async (u, i) => { await html.fetch(u, i); return new Response("<html>", { status: 502 }); } }).activate(KEY)).rejects.toMatchObject({ message: expect.stringMatching(/502/) });
  });

  it("refreshes only when due, keeps the token offline, and ends on cancellation", async () => {
    const dir = tmpDir();
    let mode: "ok" | "down" | "canceled" = "ok";
    let soon = false;
    const c = cloud((path, body) => {
      if (mode === "canceled") return { status: 403, json: { error: "this subscription was canceled", code: "canceled" } };
      const now = Math.floor(Date.now() / 1000);
      return { json: { token: mint({ deviceId: String(body["deviceId"]), ...(soon ? { exp: now + 86400 } : {}) }) } };
    });
    const fetch: FetchLike = async (u, i) => {
      if (mode === "down") throw new Error("offline");
      return c.fetch(u, i);
    };
    const lm = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch });
    expect((await lm.refreshIfDue()).tier).toBe("free"); // nothing saved, no call
    expect(c.calls).toHaveLength(0);
    soon = true;
    await lm.activate(KEY); // a token with one day left
    soon = false;
    await lm.refreshIfDue();
    expect(c.calls.at(-1)!.path).toBe("/api/v1/licenses/refresh");
    const n = c.calls.length;
    await lm.refreshIfDue(); // fresh token: not due
    expect(c.calls.length).toBe(n);
    soon = true;
    await lm.activate(KEY);
    mode = "down";
    expect((await lm.refreshIfDue()).tier).toBe("pro"); // offline keeps the plan
    mode = "canceled";
    expect(await lm.refreshIfDue()).toMatchObject({ tier: "free", reason: expect.stringMatching(/canceled/) });
    expect(existsSync(join(dir, "license.json"))).toBe(false);
  });

  it("deactivates and sends feedback with the license key", async () => {
    const dir = tmpDir();
    const c = proCloud();
    const lm = new LicenseManager({ dataDir: dir, publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: c.fetch, appVersion: "9.9.9" });
    await expect(lm.sendFeedback({ message: "  " })).rejects.toMatchObject({ code: "bad_input" });
    await lm.activate(KEY);
    expect(await lm.sendFeedback({ message: "Great", rating: 5, topic: "invoices", email: "a@b.c" })).toEqual({ ok: true, id: "fb_1" });
    expect(c.calls.at(-1)).toMatchObject({ path: "/api/v1/feedback", body: { message: "Great", rating: 5, licenseKey: KEY, appVersion: "9.9.9" } });
    expect(await lm.deactivate()).toMatchObject({ tier: "free" });
    expect(c.calls.at(-1)!.path).toBe("/api/v1/licenses/deactivate");
    expect(lm.hasSavedLicense()).toBe(false);
    expect((await lm.deactivate()).tier).toBe("free"); // nothing to do
  });
});

describe("daemon plan gates", () => {
  function daemonWith(license?: LicenseManager) {
    const dataDir = tmpDir();
    const d = createDaemon({ store: new MemorySkillStore(), providers: { local: () => createScriptedProvider([]) }, dataDir, startScheduler: false, log: () => {}, ...(license ? { license } : {}) });
    onCleanup(() => void d.close());
    return d;
  }
  const bundle = { html: "<!doctype html><html><body>hi</body></html>", app: { id: "hello", name: "Hello", version: "1.0.0", window: { width: 600, height: 400 }, allowedSkills: [] } };
  const schedule = { id: "s1", cron: "0 9 * * 1", task: { input: "weekly report", provider: "local" as const, model: "m" }, enabled: true };

  it("blocks paid features on Free with an upgrade error, and allows them after activation", async () => {
    const c = proCloud();
    const lm = new LicenseManager({ dataDir: tmpDir(), publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: c.fetch });
    const d = daemonWith(lm);
    await d.ready;
    expect(await d.handle("license.status", {})).toMatchObject({ tier: "free" });
    for (const [m, p] of [
      ["skills.install", { source: "./x" }],
      ["apps.pin", bundle],
      ["schedules.upsert", schedule],
    ] as const)
      await expect(d.handle(m, p as never)).rejects.toMatchObject({ code: RPC_ERRORS.upgradeRequired, message: expect.stringMatching(/Pro and Team/) });
    expect(await d.handle("license.activate", { licenseKey: KEY })).toMatchObject({ tier: "pro" });
    expect((await d.handle("apps.pin", bundle as never)).app.app.id).toBe("hello");
    expect((await d.handle("schedules.upsert", schedule as never)).schedule.id).toBe("s1");
    expect(await d.handle("feedback.send", { message: "Works", rating: 4 })).toEqual({ ok: true, id: "fb_1" });
    await expect(d.handle("feedback.send", { message: "x", rating: 7 } as never)).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    expect(await d.handle("license.deactivate", {})).toMatchObject({ tier: "free" });
    await expect(d.handle("apps.pin", bundle as never)).rejects.toMatchObject({ code: RPC_ERRORS.upgradeRequired });
  });

  it("turns cloud errors into clear RPC errors", async () => {
    const full = cloud(() => ({ status: 409, json: { error: "already used on 3 of 3 computers", code: "computer_limit" } }));
    const d = daemonWith(new LicenseManager({ dataDir: tmpDir(), publicKeyPem: PUB, cloudUrl: "https://c.test", fetch: full.fetch }));
    await expect(d.handle("license.activate", { licenseKey: KEY })).rejects.toMatchObject({ code: RPC_ERRORS.blocked, message: expect.stringMatching(/3 of 3/) });
  });

  it("gates nothing when no license manager is configured (development and tests)", async () => {
    const d = daemonWith();
    expect((await d.handle("apps.pin", bundle as never)).app.app.id).toBe("hello");
    expect(await d.handle("license.status", {})).toMatchObject({ tier: "free", reason: expect.stringMatching(/not configured/) });
    await expect(d.handle("license.activate", { licenseKey: KEY })).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
  });
});
