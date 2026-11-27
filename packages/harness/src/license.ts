// The computer's OneSeat plan. A license token signed by OneSeat Cloud is verified offline
// with the built-in public key; Free applies when there is none. Only the license key, a
// random computer id and the computer's name go to the cloud — never business data or model keys.
import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import {
  decodeLicenseToken,
  entitlementFrom,
  freeEntitlement,
  isLicenseKey,
  LICENSE_REFRESH_DAYS,
  type Entitlement,
  type Feature,
  type FeedbackInput,
  type FetchLike,
} from "@oneseat/contracts";

export class LicenseError extends Error {
  override name = "LicenseError";
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Saved {
  licenseKey: string;
  token: string;
}

export interface LicenseManagerOptions {
  dataDir: string;
  /** SPKI PEM of OneSeat Cloud's ed25519 signing key. */
  publicKeyPem: string;
  /** e.g. https://oneseat-cloud.onrender.com */
  cloudUrl: string;
  fetch?: FetchLike;
  now?: () => Date;
  appVersion?: string;
  log?: (line: string) => void;
}

export class LicenseManager {
  private readonly key: KeyObject;
  private readonly file: string;
  private readonly deviceFile: string;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;
  private readonly cloud: string;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: LicenseManagerOptions) {
    this.key = createPublicKey(opts.publicKeyPem);
    this.file = join(opts.dataDir, "license.json");
    this.deviceFile = join(opts.dataDir, "device.json");
    this.fetch = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.now = opts.now ?? (() => new Date());
    this.cloud = opts.cloudUrl.replace(/\/$/, "");
    this.log = opts.log ?? (() => {});
  }

  /** A random id for this computer, created once. It identifies nothing about the person. */
  deviceId(): string {
    try {
      const v = JSON.parse(readFileSync(this.deviceFile, "utf8")) as { deviceId?: string };
      if (typeof v.deviceId === "string" && v.deviceId) return v.deviceId;
    } catch {
      /* create below */
    }
    const id = `dev_${randomUUID()}`;
    mkdirSync(this.opts.dataDir, { recursive: true });
    writeFileSync(this.deviceFile, JSON.stringify({ deviceId: id }));
    return id;
  }

  private saved(): Saved | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      return typeof v.licenseKey === "string" && typeof v.token === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private save(s: Saved) {
    mkdirSync(this.opts.dataDir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* Windows: the profile folder is private to the user */
    }
  }

  /** Verify a token: our signature, this computer, a known plan. */
  verifyToken(token: string): Entitlement {
    const d = decodeLicenseToken(token);
    if (!d) return freeEntitlement("the saved license is unreadable");
    if (!verify(null, Buffer.from(d.signed), this.key, Buffer.from(d.signature))) return freeEntitlement("the saved license has an invalid signature");
    if (d.payload.deviceId !== this.deviceId()) return freeEntitlement("the saved license belongs to another computer");
    return entitlementFrom(d.payload, Math.floor(this.now().getTime() / 1000));
  }

  status(): Entitlement {
    const s = this.saved();
    return s ? this.verifyToken(s.token) : freeEntitlement();
  }

  has(feature: Feature): boolean {
    return this.status().features.includes(feature);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetch(`${this.cloud}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new LicenseError(`could not reach OneSeat Cloud (${(e as Error).message}); check the internet connection`, "network");
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new LicenseError(typeof json["error"] === "string" ? json["error"] : `OneSeat Cloud answered ${res.status}`, typeof json["code"] === "string" ? json["code"] : undefined);
    return json;
  }

  async activate(licenseKey: string): Promise<Entitlement> {
    const key = licenseKey.trim().toUpperCase();
    if (!isLicenseKey(key)) throw new LicenseError("that does not look like a OneSeat license key (OS-XXXX-XXXX-XXXX-XXXX)", "bad_key");
    const r = await this.post("/api/v1/licenses/activate", { licenseKey: key, deviceId: this.deviceId(), deviceName: hostname().slice(0, 80) });
    const token = String(r["token"] ?? "");
    const ent = this.verifyToken(token);
    if (ent.tier === "free") throw new LicenseError(`OneSeat Cloud sent a license this computer cannot use: ${ent.reason ?? "unknown reason"}`, "bad_token");
    this.save({ licenseKey: key, token });
    this.log(`license activated: ${ent.tier}`);
    return ent;
  }

  async deactivate(): Promise<Entitlement> {
    const s = this.saved();
    if (s) {
      try {
        await this.post("/api/v1/licenses/deactivate", { licenseKey: s.licenseKey, deviceId: this.deviceId() });
      } catch (e) {
        this.log(`license deactivate: ${(e as Error).message}`);
      }
      rmSync(this.file, { force: true });
    }
    return freeEntitlement();
  }

  /** Refresh when the offline token has fewer than 7 days left. Network trouble keeps the current token. */
  async refreshIfDue(): Promise<Entitlement> {
    const s = this.saved();
    if (!s) return freeEntitlement();
    const d = decodeLicenseToken(s.token);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (d && d.payload.exp - nowSec > LICENSE_REFRESH_DAYS * 86400) return this.status();
    try {
      const r = await this.post("/api/v1/licenses/refresh", { licenseKey: s.licenseKey, deviceId: this.deviceId() });
      const token = String(r["token"] ?? "");
      if (this.verifyToken(token).tier !== "free") this.save({ licenseKey: s.licenseKey, token });
    } catch (e) {
      const err = e as LicenseError;
      // The cloud says the license is gone for good: fall back to Free now.
      if (err.code === "canceled" || err.code === "unknown_key" || err.code === "not_activated") {
        rmSync(this.file, { force: true });
        this.log(`license ended: ${err.message}`);
        return freeEntitlement(err.message);
      }
      this.log(`license refresh postponed: ${err.message}`);
    }
    return this.status();
  }

  async sendFeedback(input: FeedbackInput): Promise<{ ok: boolean; id?: string }> {
    const message = String(input.message ?? "").trim();
    if (!message) throw new LicenseError("feedback message is empty", "bad_input");
    const r = await this.post("/api/v1/feedback", {
      message: message.slice(0, 5000),
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.topic ? { topic: input.topic } : {}),
      ...(this.saved()?.licenseKey ? { licenseKey: this.saved()!.licenseKey } : {}),
      appVersion: this.opts.appVersion ?? "0.1.0",
      os: platform(),
    });
    return { ok: r["ok"] === true, ...(typeof r["id"] === "string" ? { id: r["id"] } : {}) };
  }

  hasSavedLicense(): boolean {
    return existsSync(this.file);
  }
}
