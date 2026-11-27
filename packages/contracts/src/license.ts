// Plans, entitlements and the signed license token shared by the desktop app,
// the daemon and OneSeat Cloud. Customer data and model keys never go to the cloud:
// a license only says which plan a team is on and which computers use it.

export type Tier = "free" | "pro" | "team";

export type Feature =
  /** Install skills from GitHub, skills.sh or a folder (the 7 starter skills are always there). */
  | "import_skills"
  /** Pin artifacts as their own app windows. */
  | "pinned_apps"
  /** Run tasks on a schedule. */
  | "schedules"
  /** Connect MCP servers (mcp.json). */
  | "mcp_connectors"
  | "priority_support";

export interface Plan {
  tier: Tier;
  name: string;
  /** Flat price per team, in US cents. No per-seat fee on any plan. */
  monthlyCents: number;
  yearlyCents: number;
  computers: number;
  features: Feature[];
  blurb: string;
}

export const PLANS: Record<Tier, Plan> = {
  free: {
    tier: "free",
    name: "Free",
    monthlyCents: 0,
    yearlyCents: 0,
    computers: 1,
    features: [],
    blurb: "One computer, the seven starter skills, your own model key.",
  },
  pro: {
    tier: "pro",
    name: "Pro",
    monthlyCents: 1900,
    yearlyCents: 18240,
    computers: 3,
    features: ["import_skills", "pinned_apps", "schedules", "mcp_connectors"],
    blurb: "Three computers. Import any skill, pin apps, schedule tasks, connect tools.",
  },
  team: {
    tier: "team",
    name: "Team",
    monthlyCents: 7900,
    yearlyCents: 75840,
    computers: 15,
    features: ["import_skills", "pinned_apps", "schedules", "mcp_connectors", "priority_support"],
    blurb: "Fifteen computers, everything in Pro, and priority support.",
  },
};

export const FEATURE_LABELS: Record<Feature, string> = {
  import_skills: "Import skills from GitHub and skills.sh",
  pinned_apps: "Pin apps as their own windows",
  schedules: "Scheduled tasks",
  mcp_connectors: "MCP tool connectors",
  priority_support: "Priority support",
};

export function planHas(tier: Tier, feature: Feature): boolean {
  return PLANS[tier].features.includes(feature);
}

/** Days a license token stays valid without reaching the cloud. */
export const LICENSE_OFFLINE_DAYS = 14;
/** Refresh when fewer than this many days are left. */
export const LICENSE_REFRESH_DAYS = 7;

export type LicenseStatus = "active" | "trialing" | "past_due" | "canceled";

/** What the cloud signs. One token per license per computer. */
export interface LicensePayload {
  v: 1;
  /** License id (not the secret key). */
  lic: string;
  tier: Tier;
  status: LicenseStatus;
  email: string;
  computers: number;
  features: Feature[];
  deviceId: string;
  /** Seconds since epoch. */
  iat: number;
  exp: number;
}

/** "OS-XXXX-XXXX-XXXX-XXXX", Crockford base32 groups. */
export const LICENSE_KEY_PATTERN = /^OS(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

export function isLicenseKey(s: string): boolean {
  return LICENSE_KEY_PATTERN.test(s.trim().toUpperCase());
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The bytes that get signed: the base64url of the payload JSON. */
export function encodeLicensePayload(p: LicensePayload): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(p)));
}

export function decodeLicenseToken(token: string): { payload: LicensePayload; signed: string; signature: Uint8Array } | undefined {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as LicensePayload;
    if (payload?.v !== 1 || !(payload.tier in PLANS)) return undefined;
    return { payload, signed: parts[0], signature: b64urlDecode(parts[1]) };
  } catch {
    return undefined;
  }
}

export function joinLicenseToken(signed: string, signature: Uint8Array): string {
  return `${signed}.${b64urlEncode(signature)}`;
}

/** What the app shows and enforces. Free when there is no valid token. */
export interface Entitlement {
  tier: Tier;
  status: LicenseStatus | "none";
  features: Feature[];
  computers: number;
  email?: string;
  /** ISO time the offline token expires. */
  expiresAt?: string;
  /** Why the app fell back to Free, if it did. */
  reason?: string;
}

export function freeEntitlement(reason?: string): Entitlement {
  return { tier: "free", status: "none", features: [], computers: 1, ...(reason ? { reason } : {}) };
}

/** Paid features stay on while a subscription is active, trialing or briefly past due. */
export function entitlementFrom(p: LicensePayload, nowSec: number): Entitlement {
  if (p.exp <= nowSec) return freeEntitlement("the license has not been refreshed for 14 days; connect to the internet");
  if (p.status === "canceled") return freeEntitlement("the subscription was canceled");
  return { tier: p.tier, status: p.status, features: [...p.features], computers: p.computers, email: p.email, expiresAt: new Date(p.exp * 1000).toISOString() };
}

/** Thrown (as an RPC error) when a feature needs a paid plan. */
export const UPGRADE_ERROR_CODE = -32003;

export function upgradeMessage(feature: Feature): string {
  return `${FEATURE_LABELS[feature]} is part of OneSeat Pro and Team. Add a license key under Plan, or see the plans at the OneSeat website.`;
}
