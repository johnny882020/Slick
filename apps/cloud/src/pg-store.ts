// Postgres (Neon) implementation of the Store.
import pg from "pg";
import type { DeviceRow, FeedbackRow, LicenseRow, LicenseUpsert, Store } from "./store.js";
import { newId } from "./store.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS licenses (
  id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  email text NOT NULL DEFAULT '',
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro','team')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trialing','past_due','canceled')),
  computers integer NOT NULL DEFAULT 1,
  stripe_customer text,
  stripe_subscription text UNIQUE,
  checkout_session text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS license_reveals (
  license_id text PRIMARY KEY REFERENCES licenses(id) ON DELETE CASCADE,
  license_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  license_id text NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_name text NOT NULL DEFAULT '',
  activated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (license_id, device_id)
);
CREATE TABLE IF NOT EXISTS feedback (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  license_id text REFERENCES licenses(id) ON DELETE SET NULL,
  email text,
  rating integer CHECK (rating BETWEEN 1 AND 5),
  topic text,
  message text NOT NULL,
  app_version text,
  os text
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_at DESC);
CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
`;

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function licenseFrom(r: Row): LicenseRow {
  return {
    id: String(r["id"]),
    keyHash: String(r["key_hash"]),
    email: String(r["email"]),
    tier: r["tier"] as LicenseRow["tier"],
    status: r["status"] as LicenseRow["status"],
    computers: Number(r["computers"]),
    stripeCustomer: (r["stripe_customer"] as string | null) ?? null,
    stripeSubscription: (r["stripe_subscription"] as string | null) ?? null,
    checkoutSession: (r["checkout_session"] as string | null) ?? null,
    createdAt: iso(r["created_at"]),
    updatedAt: iso(r["updated_at"]),
  };
}
function deviceFrom(r: Row): DeviceRow {
  return { licenseId: String(r["license_id"]), deviceId: String(r["device_id"]), deviceName: String(r["device_name"]), activatedAt: iso(r["activated_at"]), lastSeenAt: iso(r["last_seen_at"]) };
}
function feedbackFrom(r: Row): FeedbackRow {
  return {
    id: String(r["id"]),
    createdAt: iso(r["created_at"]),
    licenseId: (r["license_id"] as string | null) ?? null,
    email: (r["email"] as string | null) ?? null,
    rating: r["rating"] === null ? null : Number(r["rating"]),
    topic: (r["topic"] as string | null) ?? null,
    message: String(r["message"]),
    appVersion: (r["app_version"] as string | null) ?? null,
    os: (r["os"] as string | null) ?? null,
  };
}

const COLS: Record<keyof Omit<LicenseUpsert, "stripeSubscription">, string> = {
  email: "email",
  tier: "tier",
  status: "status",
  computers: "computers",
  stripeCustomer: "stripe_customer",
  checkoutSession: "checkout_session",
};

export class PgStore implements Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string): PgStore {
    // Neon needs TLS; its connection strings carry sslmode=require.
    return new PgStore(new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 }));
  }

  private async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  async migrate() {
    await this.pool.query(SCHEMA_SQL);
  }
  async ping() {
    try {
      await this.q("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  async claimEvent(id: string, type: string) {
    const r = await this.q("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [id, type]);
    return r.length === 1;
  }
  async licenseBySubscription(s: string) {
    const r = await this.q("SELECT * FROM licenses WHERE stripe_subscription = $1", [s]);
    return r[0] ? licenseFrom(r[0]) : undefined;
  }
  async licenseByKeyHash(h: string) {
    const r = await this.q("SELECT * FROM licenses WHERE key_hash = $1", [h]);
    return r[0] ? licenseFrom(r[0]) : undefined;
  }
  async licenseBySession(s: string) {
    const r = await this.q("SELECT * FROM licenses WHERE checkout_session = $1", [s]);
    return r[0] ? licenseFrom(r[0]) : undefined;
  }
  async upsertLicense(fields: LicenseUpsert, k: { id: string; keyHash: string; key: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO licenses (id, key_hash, stripe_subscription) VALUES ($1, $2, $3)
         ON CONFLICT (stripe_subscription) DO NOTHING RETURNING id`,
        [k.id, k.keyHash, fields.stripeSubscription],
      );
      const created = ins.rowCount === 1;
      if (created) await client.query("INSERT INTO license_reveals (license_id, license_key) VALUES ($1, $2)", [k.id, k.key]);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [f, col] of Object.entries(COLS)) {
        const v = (fields as Record<string, unknown>)[f];
        if (v === undefined) continue;
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      }
      vals.push(fields.stripeSubscription);
      const upd = await client.query(
        `UPDATE licenses SET ${[...sets, "updated_at = now()"].join(", ")} WHERE stripe_subscription = $${vals.length} RETURNING *`,
        vals,
      );
      await client.query("COMMIT");
      return { license: licenseFrom(upd.rows[0] as Row), created };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async revealKey(id: string) {
    const r = await this.q("SELECT license_key FROM license_reveals WHERE license_id = $1 AND created_at > now() - interval '24 hours'", [id]);
    return r[0] ? String(r[0]["license_key"]) : undefined;
  }
  async purgeReveals(hours: number) {
    const r = await this.q("DELETE FROM license_reveals WHERE created_at < now() - make_interval(hours => $1) RETURNING license_id", [hours]);
    return r.length;
  }
  async devices(licenseId: string) {
    return (await this.q("SELECT * FROM devices WHERE license_id = $1 ORDER BY activated_at", [licenseId])).map(deviceFrom);
  }
  async upsertDevice(d: Omit<DeviceRow, "activatedAt" | "lastSeenAt">) {
    const r = await this.q(
      `INSERT INTO devices (license_id, device_id, device_name) VALUES ($1, $2, $3)
       ON CONFLICT (license_id, device_id) DO UPDATE SET device_name = EXCLUDED.device_name, last_seen_at = now()
       RETURNING *`,
      [d.licenseId, d.deviceId, d.deviceName],
    );
    return deviceFrom(r[0]!);
  }
  async removeDevice(licenseId: string, deviceId: string) {
    return (await this.q("DELETE FROM devices WHERE license_id = $1 AND device_id = $2 RETURNING device_id", [licenseId, deviceId])).length === 1;
  }
  async addFeedback(f: Omit<FeedbackRow, "id" | "createdAt">) {
    const r = await this.q(
      `INSERT INTO feedback (id, license_id, email, rating, topic, message, app_version, os)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [newId("fb"), f.licenseId, f.email, f.rating, f.topic, f.message, f.appVersion, f.os],
    );
    return feedbackFrom(r[0]!);
  }
  async listFeedback(limit: number) {
    return (await this.q("SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1", [limit])).map(feedbackFrom);
  }
  async listLicenses(limit: number) {
    const r = await this.q(
      `SELECT l.*, (SELECT count(*) FROM devices d WHERE d.license_id = l.id)::int AS device_count
       FROM licenses l ORDER BY l.created_at DESC LIMIT $1`,
      [limit],
    );
    return r.map((x) => ({ ...licenseFrom(x), deviceCount: Number(x["device_count"]) }));
  }
}
