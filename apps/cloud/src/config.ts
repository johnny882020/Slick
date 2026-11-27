// Configuration from the environment (Render env vars). Secrets are only read here.
import type { Tier } from "@oneseat/contracts";

export interface CloudConfig {
  port: number;
  publicUrl: string;
  databaseUrl?: string;
  /** whsec_... from the Stripe webhook endpoint. */
  stripeWebhookSecret?: string;
  /** ed25519 private key, PEM. Signs license tokens. */
  licensePrivateKey?: string;
  /** Basic-auth password for /admin (user "admin"). */
  adminToken?: string;
  paymentLinks: Partial<Record<"pro_monthly" | "pro_yearly" | "team_monthly" | "team_yearly", string>>;
  /** Payment Link ids (plink_...) that sell OneSeat. Other checkouts on the account are ignored. */
  paymentLinkIds: string[];
  priceTiers: Record<string, Tier>;
  billingPortalUrl?: string;
  downloads: { windows?: string; mac?: string };
}

/**
 * A PEM private key as it arrives through a dashboard text box: real newlines, "\n" escapes,
 * newlines turned into spaces, surrounding quotes, or only the base64 body. Rebuilt into a
 * canonical PKCS#8 PEM. Anything else is returned as given and fails at createPrivateKey.
 */
export function normalizePem(raw: string): string {
  let v = raw.trim().replace(/^["']|["']$/g, "").trim();
  v = v.replace(/\\r/g, "").replace(/\\n/g, "\n");
  const m = /^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/.exec(v);
  const label = m ? m[1]! : "PRIVATE KEY";
  const body = (m ? m[2]! : v).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) return v;
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const opt = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : undefined);
  const priceTiers: Record<string, Tier> = {};
  for (const pair of (opt("PRICE_TIERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, tier] = pair.split("=");
    if (id && (tier === "pro" || tier === "team")) priceTiers[id] = tier;
  }
  const links: CloudConfig["paymentLinks"] = {};
  for (const k of ["pro_monthly", "pro_yearly", "team_monthly", "team_yearly"] as const) {
    const v = opt(`PAYMENT_LINK_${k.toUpperCase()}`);
    if (v) links[k] = v;
  }
  return {
    port: Number(opt("PORT") ?? 10000),
    publicUrl: (opt("PUBLIC_URL") ?? opt("RENDER_EXTERNAL_URL") ?? "http://localhost:10000").replace(/\/$/, ""),
    ...(opt("DATABASE_URL") ? { databaseUrl: opt("DATABASE_URL")! } : {}),
    ...(opt("STRIPE_WEBHOOK_SECRET") ? { stripeWebhookSecret: opt("STRIPE_WEBHOOK_SECRET")! } : {}),
    ...(opt("LICENSE_PRIVATE_KEY") ? { licensePrivateKey: normalizePem(opt("LICENSE_PRIVATE_KEY")!) } : {}),
    ...(opt("ADMIN_TOKEN") ? { adminToken: opt("ADMIN_TOKEN")! } : {}),
    paymentLinks: links,
    paymentLinkIds: (opt("PAYMENT_LINK_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    priceTiers,
    ...(opt("BILLING_PORTAL_URL") ? { billingPortalUrl: opt("BILLING_PORTAL_URL")! } : {}),
    downloads: { ...(opt("DOWNLOAD_WINDOWS_URL") ? { windows: opt("DOWNLOAD_WINDOWS_URL")! } : {}), ...(opt("DOWNLOAD_MAC_URL") ? { mac: opt("DOWNLOAD_MAC_URL")! } : {}) },
  };
}
