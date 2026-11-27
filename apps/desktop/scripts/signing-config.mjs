#!/usr/bin/env node
// Signing settings for release builds, read from the environment (CI secrets).
// Nothing secret is committed: tauri.conf.json has null placeholders, and this script writes
// a --config override with only non-secret identifiers. Tauri itself reads the secret
// material straight from the environment.
//
//   node scripts/signing-config.mjs --out signing.json
//   tauri build --config signing.json
//
// Read here (non-secret identifiers):
//   WINDOWS_CERTIFICATE_THUMBPRINT  -> bundle.windows.certificateThumbprint (cert in the runner's store)
//   WINDOWS_TIMESTAMP_URL           -> bundle.windows.timestampUrl
//   APPLE_SIGNING_IDENTITY          -> bundle.macOS.signingIdentity ("Developer ID Application: ...")
//   APPLE_PROVIDER_SHORT_NAME       -> bundle.macOS.providerShortName
//   TAURI_SIGNING_PRIVATE_KEY set   -> bundle.createUpdaterArtifacts = true
// Read by Tauri directly (secrets; never pass them on a command line):
//   TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD (updater signatures)
//   APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD (base64 .p12, imported into a temp keychain)
//   APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID or APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH (notarization)

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ bundle?: Record<string, any> }}
 */
export function signingConfig(env) {
  /** @type {Record<string, any>} */
  const bundle = {};
  const win = {};
  if (env.WINDOWS_CERTIFICATE_THUMBPRINT) {
    const t = env.WINDOWS_CERTIFICATE_THUMBPRINT.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]{40}$/.test(t)) throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT must be 40 hex characters");
    win.certificateThumbprint = t;
  }
  if (env.WINDOWS_TIMESTAMP_URL) win.timestampUrl = env.WINDOWS_TIMESTAMP_URL;
  if (Object.keys(win).length) bundle.windows = win;
  const mac = {};
  if (env.APPLE_SIGNING_IDENTITY) mac.signingIdentity = env.APPLE_SIGNING_IDENTITY;
  if (env.APPLE_PROVIDER_SHORT_NAME) mac.providerShortName = env.APPLE_PROVIDER_SHORT_NAME;
  if (Object.keys(mac).length) bundle.macOS = mac;
  if (env.TAURI_SIGNING_PRIVATE_KEY) bundle.createUpdaterArtifacts = true;
  return Object.keys(bundle).length ? { bundle } : {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const text = JSON.stringify(signingConfig(process.env), null, 2) + "\n";
  if (i !== -1 && process.argv[i + 1]) {
    writeFileSync(process.argv[i + 1], text);
    console.error(`signing config -> ${process.argv[i + 1]}`);
  } else process.stdout.write(text);
}
