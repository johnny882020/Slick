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
  createdAt: string;
  updatedAt: string;
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
  /** The plain key, kept for 24 hours so the welcome page can show it. */
  revealKey(licenseId: string): Promise<string | undefined>;
  purgeReveals(olderThanHours: number): Promise<number>;
  devices(licenseId: string): Promise<DeviceRow[]>;
  upsertDevice(d: Omit<DeviceRow, "activatedAt" | "lastSeenAt">): Promise<DeviceRow>;
  removeDevice(licenseId: string, deviceId: string): Promise<boolean>;
  addFeedback(f: Omit<FeedbackRow, "id" | "createdAt">): Promise<FeedbackRow>;
  listFeedback(limit: number): Promise<FeedbackRow[]>;
  listLicenses(limit: number): Promise<(LicenseRow & { deviceCount: number })[]>;
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.licenses.set(row.id, row);
    this.reveals.set(row.id, { key: k.key, at: Date.now() });
    return { license: row, created: true };
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
      .map((l) => ({ ...l, deviceCount: [...this.deviceRows.values()].filter((d) => d.licenseId === l.id).length }));
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
