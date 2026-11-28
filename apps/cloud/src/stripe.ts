// Stripe webhooks, verified with the endpoint's signing secret. The service needs no
// Stripe API key: plans are sold through Payment Links, and everything it must know
// arrives in signed events.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PLANS, type LicenseStatus, type Tier } from "@oneseat/contracts";
import { generateLicenseKey, hashKey } from "./licenses.js";
import type { Store } from "./store.js";
import { newId } from "./store.js";

export class StripeSignatureError extends Error {
  override name = "StripeSignatureError";
}

/** Verify a Stripe-Signature header (scheme v1, HMAC-SHA256 over "t.payload"). */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!header) throw new StripeSignatureError("missing Stripe-Signature header");
  const parts = header.split(",").map((p) => p.trim().split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || sigs.length === 0) throw new StripeSignatureError("malformed Stripe-Signature header");
  if (Math.abs(nowSec - t) > toleranceSec) throw new StripeSignatureError("timestamp outside the tolerance window");
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new StripeSignatureError("no matching signature");
}

/** Build a header Stripe would send (tests and the end-to-end check). */
export function signStripePayload(payload: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${payload}`, "utf8").digest("hex")}`;
}

export function mapSubscriptionStatus(s: string): LicenseStatus {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      return "canceled"; // canceled, incomplete_expired, paused
  }
}

type StripeObject = Record<string, unknown>;
interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeObject };
}

/** Tier from the subscription's first price: price.metadata.tier, else a configured price id map. */
export function tierFromSubscription(sub: StripeObject, priceTiers: Record<string, Tier>): Tier | undefined {
  const items = (sub["items"] as { data?: { price?: { id?: string; metadata?: Record<string, string>; lookup_key?: string } }[] } | undefined)?.data ?? [];
  for (const it of items) {
    const meta = it.price?.metadata?.["tier"];
    if (meta === "pro" || meta === "team") return meta;
    const byId = it.price?.id ? priceTiers[it.price.id] : undefined;
    if (byId) return byId;
    const lk = it.price?.lookup_key ?? "";
    if (lk.startsWith("oneseat_team")) return "team";
    if (lk.startsWith("oneseat_pro")) return "pro";
  }
  return undefined;
}

export interface WebhookResult {
  handled: boolean;
  duplicate?: boolean;
  licenseId?: string;
  note?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export interface StripeHandlerOptions {
  /** Price id -> tier, used when a price has no metadata.tier. */
  priceTiers?: Record<string, Tier>;
  /** OneSeat Payment Link ids. When set, checkouts from other links (other products on the account) are ignored. */
  paymentLinkIds?: string[];
}

export async function handleStripeEvent(store: Store, event: StripeEvent, opts: StripeHandlerOptions = {}): Promise<WebhookResult> {
  const priceTiers = opts.priceTiers ?? {};
  if (!(await store.claimEvent(event.id, event.type))) return { handled: true, duplicate: true };
  const o = event.data.object;
  const fresh = () => {
    const key = generateLicenseKey();
    return { id: newId("lic"), keyHash: hashKey(key), key };
  };
  switch (event.type) {
    case "checkout.session.completed": {
      if (o["mode"] !== "subscription") return { handled: false, note: "not a subscription checkout" };
      const link = str(o["payment_link"]);
      if (opts.paymentLinkIds?.length && (!link || !opts.paymentLinkIds.includes(link))) return { handled: false, note: "checkout is not from a OneSeat payment link" };
      const sub = str(o["subscription"]);
      if (!sub) return { handled: false, note: "checkout without a subscription" };
      const details = (o["customer_details"] as { email?: string } | undefined) ?? {};
      const email = str(details.email) ?? str(o["customer_email"]) ?? "";
      const { license } = await store.upsertLicense(
        { stripeSubscription: sub, checkoutSession: str(o["id"]) ?? null, stripeCustomer: str(o["customer"]) ?? null, ...(email ? { email } : {}) },
        fresh(),
      );
      return { handled: true, licenseId: license.id };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = str(o["id"]);
      if (!sub) return { handled: false, note: "subscription without an id" };
      const tier = tierFromSubscription(o, priceTiers);
      // Another product on the same Stripe account: never create a OneSeat license for it.
      if (!tier && !(await store.licenseBySubscription(sub))) return { handled: false, note: "not a OneSeat subscription" };
      const status: LicenseStatus = event.type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(String(o["status"] ?? ""));
      const { license } = await store.upsertLicense(
        {
          stripeSubscription: sub,
          status,
          stripeCustomer: str(o["customer"]) ?? null,
          ...(tier ? { tier, computers: PLANS[tier].computers } : {}),
        },
        fresh(),
      );
      return { handled: true, licenseId: license.id, ...(tier ? {} : { note: "no tier on the subscription's price" }) };
    }
    default:
      return { handled: false, note: `ignored ${event.type}` };
  }
}
