// Content hashes and ed25519 signatures for rule packs, so an audit or filing can prove
// which exact rule text it used.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { RulePack } from "@oneseat/contracts";

/** Stable JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Hex SHA-256 of the canonical pack. */
export function packHash(pack: RulePack): string {
  return createHash("sha256").update(canonicalJson(pack)).digest("hex");
}

export interface PackSignature {
  id: string;
  version: string;
  sha256: string;
  /** Base64 ed25519 signature over the UTF-8 bytes of sha256. */
  signature: string;
}

export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function signPack(pack: RulePack, privateKeyPem: string): PackSignature {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("rule signing key must be ed25519");
  const sha256 = packHash(pack);
  return { id: pack.id, version: pack.version, sha256, signature: sign(null, Buffer.from(sha256), key).toString("base64") };
}

/** True when the signature matches this exact pack content and key. */
export function verifyPack(pack: RulePack, sig: PackSignature, publicKeyPem: string): boolean {
  if (sig.id !== pack.id || sig.version !== pack.version) return false;
  const sha256 = packHash(pack);
  if (sha256 !== sig.sha256) return false;
  return verify(null, Buffer.from(sha256), createPublicKey(publicKeyPem), Buffer.from(sig.signature, "base64"));
}
