// Persistence for OneSeat Cloud. Only accounts, subscriptions, licenses, devices and
// feedback live here. Never customer business data and never model API keys.

import type { LicenseStatus, Tier } from "@oneseat/contracts";

export interface LicenseRow {
  id: string;
  /** sha256 of the license key. The key itself is never stored, except briefly to reveal it once. */
  keyHash: string;
  email: string;
  tier: Tier;
  status: LicenseStatus;
  computers: number;
  stripeCustomer: string | null;
  stripeSubscription: string | null;
  checkoutSession: string | null;
  /** Pilot team name; null for licenses bought through Stripe. */
  team: string | null;
  /** When a pilot license stops working (ISO time); null when it has no end date. */
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A license created by an admin (pilot teams), not by a Stripe checkout. */
export interface NewLicense {
  id: string;
  keyHash: string;
  email: string;
  tier: Tier;
  status: LicenseStatus;
  computers: number;
  team: string;
  endsAt: string;
}

/** The `team` of a trial license, shown in the admin list. */
export const TRIAL_TEAM = "Trial";

/** A free Team trial started from the app: one per email (lowercased) and one per computer, ever. */
export interface NewTrial {
  license: NewLicense;
  emailLc: string;
  deviceId: string;
  deviceName: string;
}

export interface DeviceRow {
  licenseId: string;
  deviceId: string;
  deviceName: string;
  activatedAt: string;
  lastSeenAt: string;
}

export interface FeedbackRow {
  id: string;
  createdAt: string;
  licenseId: string | null;
  email: string | null;
  rating: number | null;
  topic: string | null;
  message: string;
  appVersion: string | null;
  os: string | null;
}

export type LicenseUpsert = Partial<Omit<LicenseRow, "id" | "keyHash" | "createdAt" | "updatedAt">> & { stripeSubscription: string };

export interface Store {
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  /** Record a Stripe event id; false when it was already handled (webhooks repeat). */
  claimEvent(id: string, type: string): Promise<boolean>;
  licenseBySubscription(subscriptionId: string): Promise<LicenseRow | undefined>;
  licenseByKeyHash(keyHash: string): Promise<LicenseRow | undefined>;
  licenseBySession(sessionId: string): Promise<LicenseRow | undefined>;
  /** Create the license for a subscription if it is new (with this key), else merge the fields. */
  upsertLicense(fields: LicenseUpsert, newKey: { id: string; keyHash: string; key: string }): Promise<{ license: LicenseRow; created: boolean }>;
  createLicense(l: NewLicense): Promise<LicenseRow>;
  /**
   * Create the trial's license, record the trial and activate its computer, all or nothing.
   * Undefined when this email or this computer already had a trial.
   */
  createTrial(t: NewTrial): Promise<LicenseRow | undefined>;
  /** The plain key, kept for 24 hours so the welcome page can show it. */
  revealKey(licenseId: string): Promise<string | undefined>;
  purgeReveals(olderThanHours: number): Promise<number>;
  devices(licenseId: string): Promise<DeviceRow[]>;
  upsertDevice(d: Omit<DeviceRow, "activatedAt" | "lastSeenAt">): Promise<DeviceRow>;
  removeDevice(licenseId: string, deviceId: string): Promise<boolean>;
  addFeedback(f: Omit<FeedbackRow, "id" | "createdAt">): Promise<FeedbackRow>;
  listFeedback(limit: number): Promise<FeedbackRow[]>;
  /** Trials started at or after this ISO time (a daily cap that does not trust client IPs). */
  countTrialsSince(sinceIso: string): Promise<number>;
  /** Newest first; `trial` marks licenses that came from a self-serve trial. */
  listLicenses(limit: number): Promise<(LicenseRow & { deviceCount: number; trial: boolean })[]>;
}

const nowIso = () => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** In-memory store for tests and local development. */
export class MemoryStore implements Store {
  licenses = new Map<string, LicenseRow>();
  reveals = new Map<string, { key: string; at: number }>();
  deviceRows = new Map<string, DeviceRow>();
  feedback: FeedbackRow[] = [];
  events = new Set<string>();
  trials: { emailLc: string; deviceId: string; licenseId: string; createdAt: string }[] = [];

  async migrate() {}
  async ping() {
    return true;
  }
  async claimEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
  async licenseBySubscription(s: string) {
    return [...this.licenses.values()].find((l) => l.stripeSubscription === s);
  }
  async licenseByKeyHash(h: string) {
    return [...this.licenses.values()].find((l) => l.keyHash === h);
  }
  async licenseBySession(s: string) {
    return [...this.licenses.values()].find((l) => l.checkoutSession === s);
  }
  async upsertLicense(fields: LicenseUpsert, k: { id: string; keyHash: string; key: string }) {
    const existing = await this.licenseBySubscription(fields.stripeSubscription);
    if (existing) {
      const merged: LicenseRow = { ...existing, ...definedOnly(fields), updatedAt: nowIso() };
      this.licenses.set(existing.id, merged);
      return { license: merged, created: false };
    }
    const row: LicenseRow = {
      id: k.id,
      keyHash: k.keyHash,
      email: fields.email ?? "",
      tier: fields.tier ?? "free",
      status: fields.status ?? "active",
      computers: fields.computers ?? 1,
      stripeCustomer: fields.stripeCustomer ?? null,
      stripeSubscription: fields.stripeSubscription,
      checkoutSession: fields.checkoutSession ?? null,
      team: fields.team ?? null,
      endsAt: fields.endsAt ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.licenses.set(row.id, row);
    this.reveals.set(row.id, { key: k.key, at: Date.now() });
    return { license: row, created: true };
  }
  async createLicense(l: NewLicense) {
    if ([...this.licenses.values()].some((x) => x.keyHash === l.keyHash)) throw new Error("duplicate license key");
    const row: LicenseRow = { ...l, stripeCustomer: null, stripeSubscription: null, checkoutSession: null, createdAt: nowIso(), updatedAt: nowIso() };
    this.licenses.set(row.id, row);
    return row;
  }
  async countTrialsSince(sinceIso: string) {
    return this.trials.filter((t) => t.createdAt >= sinceIso).length;
  }
  async createTrial(t: NewTrial) {
    if (this.trials.some((x) => x.emailLc === t.emailLc || x.deviceId === t.deviceId)) return undefined;
    const row = await this.createLicense(t.license);
    this.trials.push({ emailLc: t.emailLc, deviceId: t.deviceId, licenseId: row.id, createdAt: nowIso() });
    await this.upsertDevice({ licenseId: row.id, deviceId: t.deviceId, deviceName: t.deviceName });
    return row;
  }
  async revealKey(id: string) {
    return this.reveals.get(id)?.key;
  }
  async purgeReveals(hours: number) {
    let n = 0;
    for (const [id, r] of this.reveals) if (Date.now() - r.at > hours * 3600_000) (this.reveals.delete(id), n++);
    return n;
  }
  async devices(licenseId: string) {
    return [...this.deviceRows.values()].filter((d) => d.licenseId === licenseId);
  }
  async upsertDevice(d: Omit<DeviceRow, "activatedAt" | "lastSeenAt">) {
    const k = `${d.licenseId}/${d.deviceId}`;
    const prev = this.deviceRows.get(k);
    const row: DeviceRow = { ...d, activatedAt: prev?.activatedAt ?? nowIso(), lastSeenAt: nowIso() };
    this.deviceRows.set(k, row);
    return row;
  }
  async removeDevice(licenseId: string, deviceId: string) {
    return this.deviceRows.delete(`${licenseId}/${deviceId}`);
  }
  async addFeedback(f: Omit<FeedbackRow, "id" | "createdAt">) {
    const row: FeedbackRow = { ...f, id: newId("fb"), createdAt: nowIso() };
    this.feedback.unshift(row);
    return row;
  }
  async listFeedback(limit: number) {
    return this.feedback.slice(0, limit);
  }
  async listLicenses(limit: number) {
    return [...this.licenses.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((l) => ({
        ...l,
        deviceCount: [...this.deviceRows.values()].filter((d) => d.licenseId === l.id).length,
        trial: this.trials.some((t) => t.licenseId === l.id),
      }));
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
