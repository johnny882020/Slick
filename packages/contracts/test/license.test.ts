import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  decodeLicenseToken,
  encodeLicensePayload,
  entitlementFrom,
  freeEntitlement,
  isLicenseKey,
  joinLicenseToken,
  PLANS,
  planHas,
  upgradeMessage,
  type LicensePayload,
} from "../src/index.js";

const now = 1_800_000_000;
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1,
  lic: "lic_1",
  tier: "pro",
  status: "active",
  email: "ada@example.com",
  computers: 3,
  features: [...PLANS.pro.features],
  deviceId: "dev_1",
  iat: now,
  exp: now + 14 * 86400,
  ...over,
});

describe("plans", () => {
  it("are flat per team, with the agreed prices and limits", () => {
    expect(PLANS.free).toMatchObject({ monthlyCents: 0, computers: 1, features: [] });
    expect(PLANS.pro).toMatchObject({ monthlyCents: 1900, yearlyCents: 18240, computers: 3 });
    expect(PLANS.team).toMatchObject({ monthlyCents: 7900, yearlyCents: 75840, computers: 15 });
    // Yearly is 20% off twelve months.
    for (const t of ["pro", "team"] as const) expect(PLANS[t].yearlyCents).toBe(Math.round(PLANS[t].monthlyCents * 12 * 0.8));
    expect(planHas("free", "pinned_apps")).toBe(false);
    expect(planHas("pro", "pinned_apps")).toBe(true);
    expect(planHas("pro", "priority_support")).toBe(false);
    expect(planHas("team", "priority_support")).toBe(true);
    expect(upgradeMessage("schedules")).toMatch(/Scheduled tasks is part of OneSeat Pro and Team/);
  });
});

describe("license token", () => {
  it("round-trips with a real ed25519 signature and rejects tampering", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = encodeLicensePayload(payload());
    const token = joinLicenseToken(signed, new Uint8Array(sign(null, Buffer.from(signed), privateKey)));
    const d = decodeLicenseToken(token)!;
    expect(d.payload).toEqual(payload());
    expect(verify(null, Buffer.from(d.signed), publicKey, Buffer.from(d.signature))).toBe(true);
    const forged = encodeLicensePayload(payload({ tier: "team" }));
    expect(verify(null, Buffer.from(forged), publicKey, Buffer.from(d.signature))).toBe(false);
    expect(decodeLicenseToken("nope")).toBeUndefined();
    expect(decodeLicenseToken("a.b.c")).toBeUndefined();
    expect(decodeLicenseToken(`${encodeLicensePayload({ ...payload(), tier: "gold" as never })}.AA`)).toBeUndefined();
  });

  it("turns a payload into what the app enforces", () => {
    expect(entitlementFrom(payload(), now)).toMatchObject({ tier: "pro", status: "active", computers: 3, email: "ada@example.com" });
    expect(entitlementFrom(payload({ status: "past_due" }), now).tier).toBe("pro");
    expect(entitlementFrom(payload({ status: "canceled" }), now)).toMatchObject({ tier: "free", reason: expect.stringMatching(/canceled/) });
    expect(entitlementFrom(payload({ exp: now }), now)).toMatchObject({ tier: "free", reason: expect.stringMatching(/14 days/) });
    expect(freeEntitlement()).toEqual({ tier: "free", status: "none", features: [], computers: 1 });
  });

  it("recognises license keys", () => {
    expect(isLicenseKey("OS-7K2M-Q9PX-4HTR-WB3D")).toBe(true);
    expect(isLicenseKey(" os-7k2m-q9px-4htr-wb3d ")).toBe(true);
    expect(isLicenseKey("OS-7K2M-Q9PX-4HTR")).toBe(false);
    expect(isLicenseKey("OS-ILOU-0000-0000-0000")).toBe(false); // I, L, O, U are not Crockford digits
  });
});
