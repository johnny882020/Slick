// The same behaviour for the in-memory store and the Postgres (Neon) store.
// Postgres runs when ONESEAT_TEST_PG_URL points at a database it may reset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MemoryStore, PgStore, type Store } from "../src/index.js";

const PG_URL = process.env["ONESEAT_TEST_PG_URL"];

function storeSuite(name: string, make: () => Promise<Store>, done?: () => Promise<void>) {
  describe(`store: ${name}`, () => {
    let s: Store;
    beforeAll(async () => {
      s = await make();
      await s.migrate();
      await s.migrate(); // idempotent
    });
    afterAll(async () => done?.());

    const k = (n: number) => ({ id: `lic_${name}_${n}`, keyHash: `hash_${name}_${n}`, key: `OS-KEY${n}` });

    it("pings and claims each Stripe event once", async () => {
      expect(await s.ping()).toBe(true);
      expect(await s.claimEvent(`evt_${name}_1`, "x")).toBe(true);
      expect(await s.claimEvent(`evt_${name}_1`, "x")).toBe(false);
    });

    it("creates a license once per subscription and merges later fields", async () => {
      const a = await s.upsertLicense({ stripeSubscription: `sub_${name}_1`, tier: "pro", status: "active", computers: 3 }, k(1));
      expect(a.created).toBe(true);
      expect(a.license).toMatchObject({ id: k(1).id, tier: "pro", computers: 3, email: "", checkoutSession: null });
      const b = await s.upsertLicense({ stripeSubscription: `sub_${name}_1`, email: "ada@example.com", checkoutSession: `cs_${name}_1`, stripeCustomer: "cus_1" }, k(2));
      expect(b.created).toBe(false);
      expect(b.license).toMatchObject({ id: k(1).id, tier: "pro", email: "ada@example.com", checkoutSession: `cs_${name}_1`, stripeCustomer: "cus_1" });
      expect((await s.licenseBySession(`cs_${name}_1`))?.id).toBe(k(1).id);
      expect((await s.licenseByKeyHash(k(1).keyHash))?.id).toBe(k(1).id);
      expect(await s.licenseByKeyHash(k(2).keyHash)).toBeUndefined();
      expect(await s.revealKey(k(1).id)).toBe("OS-KEY1");
      expect(await s.purgeReveals(24)).toBe(0);
      expect(await s.revealKey(k(1).id)).toBe("OS-KEY1");
      const c = await s.upsertLicense({ stripeSubscription: `sub_${name}_1`, status: "canceled" }, k(3));
      expect(c.license).toMatchObject({ status: "canceled", tier: "pro" });
      expect(await s.licenseBySubscription("nope")).toBeUndefined();
    });

    it("creates admin-issued pilot licenses with a team and an end date", async () => {
      const endsAt = new Date(Date.UTC(2027, 0, 15)).toISOString();
      const l = await s.createLicense({ id: `lic_${name}_pilot`, keyHash: `hash_${name}_pilot`, email: "owner@acme.example", tier: "team", status: "trialing", computers: 15, team: "Acme Bakery", endsAt });
      expect(l).toMatchObject({ tier: "team", status: "trialing", computers: 15, team: "Acme Bakery", endsAt, stripeSubscription: null, checkoutSession: null });
      expect((await s.licenseByKeyHash(`hash_${name}_pilot`))?.team).toBe("Acme Bakery");
      expect((await s.listLicenses(50)).find((x) => x.id === l.id)?.endsAt).toBe(endsAt);
      await expect(s.createLicense({ id: `lic_${name}_pilot2`, keyHash: l.keyHash, email: l.email, tier: "team", status: "trialing", computers: 15, team: "Dup", endsAt })).rejects.toThrow();
      const stripe = await s.upsertLicense({ stripeSubscription: `sub_${name}_9`, tier: "pro" }, k(9));
      expect(stripe.license).toMatchObject({ team: null, endsAt: null });
    });

    it("tracks devices per license", async () => {
      const lic = k(1).id;
      await s.upsertDevice({ licenseId: lic, deviceId: "d1", deviceName: "Mac" });
      await s.upsertDevice({ licenseId: lic, deviceId: "d2", deviceName: "PC" });
      const again = await s.upsertDevice({ licenseId: lic, deviceId: "d1", deviceName: "Mac 2" });
      expect(again.deviceName).toBe("Mac 2");
      expect((await s.devices(lic)).map((d) => d.deviceId).sort()).toEqual(["d1", "d2"]);
      expect(await s.removeDevice(lic, "d2")).toBe(true);
      expect(await s.removeDevice(lic, "d2")).toBe(false);
      const listed = await s.listLicenses(10);
      expect(listed.find((l) => l.id === lic)?.deviceCount).toBe(1);
    });

    it("stores and lists feedback newest first", async () => {
      await s.addFeedback({ licenseId: k(1).id, email: "a@b.c", rating: 4, topic: "t", message: "first", appVersion: "0.1.0", os: "macos" });
      const f2 = await s.addFeedback({ licenseId: null, email: null, rating: null, topic: null, message: "second", appVersion: null, os: null });
      const list = await s.listFeedback(10);
      expect(list[0]!.id).toBe(f2.id);
      expect(list.find((f) => f.message === "first")).toMatchObject({ rating: 4, licenseId: k(1).id });
    });
  });
}

storeSuite("memory", async () => new MemoryStore());

if (PG_URL) {
  let pool: pg.Pool;
  storeSuite(
    "postgres",
    async () => {
      pool = new pg.Pool({ connectionString: PG_URL });
      await pool.query("DROP TABLE IF EXISTS stripe_events, feedback, devices, license_reveals, licenses CASCADE");
      return new PgStore(pool);
    },
    async () => {
      await pool.end();
    },
  );
} else {
  describe("store: postgres", () => {
    it.skip("set ONESEAT_TEST_PG_URL to run the Postgres store against a real database", () => {});
  });
}
