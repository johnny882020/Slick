// License keys and signed license tokens.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import {
  encodeLicensePayload,
  joinLicenseToken,
  LICENSE_OFFLINE_DAYS,
  PLANS,
  type LicensePayload,
  type LicenseStatus,
  type Tier,
} from "@oneseat/contracts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "OS-XXXX-XXXX-XXXX-XXXX": 80 random bits, easy to read aloud and type. */
export function generateLicenseKey(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => CROCKFORD[b % 32]!).slice(0, 16);
  return `OS-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
}

export function normaliseKey(key: string): string {
  return key.trim().toUpperCase();
}

export function hashKey(key: string): string {
  return createHash("sha256").update(normaliseKey(key)).digest("hex");
}

export class LicenseSigner {
  readonly publicKeyPem: string;
  private readonly key: KeyObject;

  constructor(privateKeyPem: string) {
    try {
      this.key = createPrivateKey(privateKeyPem);
    } catch {
      // Never echo the value: it is the signing key.
      throw new Error(
        "LICENSE_PRIVATE_KEY is not a readable PEM private key. Paste the whole single line from license-private.escaped " +
          "(from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----), or the PEM file with its line breaks.",
      );
    }
    if (this.key.asymmetricKeyType !== "ed25519") throw new Error("LICENSE_PRIVATE_KEY must be an ed25519 key");
    this.publicKeyPem = createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
  }

  /**
   * A token valid offline for LICENSE_OFFLINE_DAYS, or until `endsAt` (ISO) when that is sooner:
   * a trial or pilot license then stops on its end date even if the computer stays offline.
   */
  token(input: { lic: string; tier: Tier; status: LicenseStatus; email: string; computers: number; deviceId: string; endsAt?: string | null }, nowSec = Math.floor(Date.now() / 1000)): {
    token: string;
    payload: LicensePayload;
  } {
    const offline = nowSec + LICENSE_OFFLINE_DAYS * 86400;
    const ends = input.endsAt ? Math.floor(Date.parse(input.endsAt) / 1000) : NaN;
    const payload: LicensePayload = {
      v: 1,
      lic: input.lic,
      tier: input.tier,
      status: input.status,
      email: input.email,
      computers: input.computers,
      features: [...PLANS[input.tier].features],
      deviceId: input.deviceId,
      iat: nowSec,
      exp: Number.isFinite(ends) && ends > nowSec ? Math.min(offline, ends) : offline,
    };
    const signed = encodeLicensePayload(payload);
    return { token: joinLicenseToken(signed, new Uint8Array(sign(null, Buffer.from(signed), this.key))), payload };
  }
}
