// OneSeat Cloud HTTP server: pages, Stripe webhook, license API, feedback, admin.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isLicenseKey, PLANS, TRIAL_DAYS, type LicenseStatus } from "@oneseat/contracts";
import type { CloudConfig } from "./config.js";
import { loadFonts } from "./fonts.js";
import { generateLicenseKey, hashKey, LicenseSigner } from "./licenses.js";
import { adminPage, downloadPage, homePage, layout, pilotCreatedPage, pilotPage, privacyPage, welcomePage } from "./pages.js";
import { handleStripeEvent, StripeSignatureError, verifyStripeSignature } from "./stripe.js";
import { newId, TRIAL_TEAM, type LicenseRow, type Store } from "./store.js";

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com https://buy.stripe.com; frame-ancestors 'none'; base-uri 'none'";
const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Pages use no device features and open no windows that need a link back. */
const PAGE_HEADERS = {
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
} as const;

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    // Not "no-referrer": with it, browsers send "Origin: null" on our own form posts, and the
    // admin form's same-origin check could not tell its page from another site.
    "referrer-policy": "same-origin",
    // The service is HTTPS only (Render); browsers should never try plain HTTP again.
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    ...(type.startsWith("text/html") ? { "content-security-policy": PAGE_CSP, "x-frame-options": "DENY", ...PAGE_HEADERS } : {}),
    ...extra,
  });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8", { "cache-control": "no-store" });
const html = (res: ServerResponse, status: number, page: string) => send(res, status, page, "text/html; charset=utf-8");

function parseJson(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "body must be a JSON object");
}

function str(o: Record<string, unknown>, k: string, max = 200, required = true): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${k} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${k} must be a string of at most ${max} characters`);
  return v.trim();
}

/** A simple shape check: something@domain.tld, no spaces, at most 254 characters. */
function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);
}

/** Fixed-window rate limit per client and route group. */
class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function checkAdmin(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const h = req.headers["authorization"] ?? "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  const a = Buffer.from(pass);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CloudApp {
  server: Server;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createCloudApp(cfg: CloudConfig, store: Store, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): CloudApp {
  const signer = cfg.licensePrivateKey ? new LicenseSigner(cfg.licensePrivateKey) : undefined;
  const apiLimit = new RateLimiter(30, 60_000);
  const feedbackLimit = new RateLimiter(10, 60_000);
  const trialLimit = new RateLimiter(5, 60_000);

  const tokenFor = (l: LicenseRow, deviceId: string) => {
    if (!signer) throw new HttpError(503, "licensing is not configured");
    return signer.token({ lic: l.id, tier: l.tier, status: l.status, email: l.email, computers: l.computers, deviceId, endsAt: l.endsAt });
  };

  const findLicense = async (body: Record<string, unknown>) => {
    const key = str(body, "licenseKey", 40)!;
    if (!isLicenseKey(key)) throw new HttpError(400, "that does not look like a OneSeat license key (OS-XXXX-XXXX-XXXX-XXXX)", "bad_key");
    const l = await store.licenseByKeyHash(hashKey(key));
    if (!l) throw new HttpError(404, "license key not found", "unknown_key");
    return l;
  };

  /** A pilot license past its end date works like a canceled subscription: the app falls back to Free. */
  const usable = (l: LicenseRow, now = Date.now()): LicenseStatus => (l.endsAt && Date.parse(l.endsAt) <= now ? "canceled" : l.status);
  const canceledMessage = (l: LicenseRow) =>
    l.endsAt && Date.parse(l.endsAt) <= Date.now()
      ? `this ${l.team === TRIAL_TEAM ? "free Team trial" : "pilot license"} ended on ${l.endsAt.slice(0, 10)}; your data is still on your computer, and you can choose a plan at ${cfg.publicUrl}/#plans`
      : "this subscription was canceled; renew it to use this key";

  /** Browsers send basic-auth credentials on cross-site form posts too: only accept our own pages. */
  const sameOrigin = (req: IncomingMessage) => {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers["origin"];
    if (site !== undefined && site !== "same-origin") return false;
    if (origin !== undefined && origin !== new URL(cfg.publicUrl).origin) return false;
    return true;
  };

  const requireAdmin = (req: IncomingMessage, res: ServerResponse) => {
    if (checkAdmin(req, cfg.adminToken)) return true;
    res.writeHead(401, { "www-authenticate": 'Basic realm="OneSeat admin"', "content-type": "text/plain" });
    res.end("authentication required");
    return false;
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET") {
      switch (path) {
        case "/":
          return html(res, 200, homePage(cfg));
        case "/download":
          return html(res, 200, downloadPage(cfg));
        case "/pilot":
          return html(res, 200, pilotPage(cfg));
        case "/privacy":
          return html(res, 200, privacyPage());
        case "/healthz": {
          const db = await store.ping();
          return json(res, db ? 200 : 503, { ok: db, db, licensing: !!signer, webhooks: !!cfg.stripeWebhookSecret });
        }
        case "/license-public-key.pem":
          if (!signer) throw new HttpError(404, "licensing is not configured");
          return send(res, 200, signer.publicKeyPem, "application/x-pem-file");
        case "/welcome": {
          const sid = url.searchParams.get("session_id") ?? "";
          if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(sid)) return html(res, 404, welcomePage({ kind: "missing" }));
          const l = await store.licenseBySession(sid);
          if (!l || l.tier === "free") return html(res, 200, welcomePage({ kind: "pending" }));
          return html(res, 200, welcomePage({ kind: "ready", license: l, key: await store.revealKey(l.id) }));
        }
        case "/admin": {
          if (!requireAdmin(req, res)) return;
          return html(res, 200, adminPage(await store.listLicenses(200), await store.listFeedback(200)));
        }
        case "/download/windows":
        case "/download/mac": {
          // Stable links for pages, emails and the app; the file host behind them can change.
          const target = path.endsWith("windows") ? cfg.downloads.windows : cfg.downloads.mac;
          if (!target) return html(res, 404, downloadPage(cfg));
          return send(res, 302, "", "text/plain", { location: target, "cache-control": "no-store" });
        }
        default:
          if (path.startsWith("/fonts/")) {
            const file = loadFonts().files.get(path.slice("/fonts/".length));
            if (!file) throw new HttpError(404, "not found");
            res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
            return res.end(file);
          }
          return html(res, 404, layout("Not found", "<h1>Page not found</h1><p><a href=\"/\">Go home</a></p>"));
      }
    }

    if (method !== "POST") throw new HttpError(405, "method not allowed");

    if (path === "/api/v1/stripe/webhook") {
      if (!cfg.stripeWebhookSecret) throw new HttpError(503, "webhooks are not configured");
      const body = await readBody(req);
      try {
        verifyStripeSignature(body, req.headers["stripe-signature"] as string | undefined, cfg.stripeWebhookSecret);
      } catch (e) {
        if (e instanceof StripeSignatureError) throw new HttpError(400, e.message, "bad_signature");
        throw e;
      }
      const event = JSON.parse(body) as Parameters<typeof handleStripeEvent>[1];
      const r = await handleStripeEvent(store, event, { priceTiers: cfg.priceTiers, paymentLinkIds: cfg.paymentLinkIds });
      log(`stripe ${event.type} ${event.id}: ${r.handled ? "handled" : "skipped"}${r.duplicate ? " (duplicate)" : ""}${r.note ? ` - ${r.note}` : ""}`);
      return json(res, 200, { received: true, ...r });
    }

    if (path === "/admin/pilot") {
      if (!requireAdmin(req, res)) return;
      if (!sameOrigin(req)) throw new HttpError(403, "this form only works from the admin page");
      const form = new URLSearchParams(await readBody(req));
      const team = (form.get("team") ?? "").trim();
      const email = (form.get("email") ?? "").trim();
      const weeks = Number(form.get("weeks") ?? "4");
      if (!team || team.length > 80) throw new HttpError(400, "give the team a name of at most 80 characters");
      if (!isEmail(email)) throw new HttpError(400, "give a contact email for the team");
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw new HttpError(400, "the pilot lasts 1 to 12 weeks");
      const key = generateLicenseKey();
      const endsAt = new Date(Date.now() + weeks * 7 * 86_400_000).toISOString();
      const license = await store.createLicense({ id: newId("lic"), keyHash: hashKey(key), email, tier: "team", status: "trialing", computers: PLANS.team.computers, team, endsAt });
      log(`pilot license ${license.id} for "${team}" until ${endsAt.slice(0, 10)}`);
      return send(res, 200, pilotCreatedPage(cfg, license, key), "text/html; charset=utf-8", { "cache-control": "no-store" });
    }

    if (path.startsWith("/api/v1/")) {
      const limiter = path === "/api/v1/feedback" ? feedbackLimit : path === "/api/v1/trials" ? trialLimit : apiLimit;
      if (!limiter.allow(`${clientIp(req)} ${path}`)) throw new HttpError(429, "too many requests; try again in a minute", "rate_limited");
    }
    const body = parseJson(await readBody(req));

    switch (path) {
      case "/api/v1/licenses/activate":
      case "/api/v1/licenses/refresh": {
        const l = await findLicense(body);
        const deviceId = str(body, "deviceId", 80)!;
        const deviceName = str(body, "deviceName", 80, false) ?? "";
        if (usable(l) === "canceled") throw new HttpError(403, canceledMessage(l), "canceled");
        if (l.tier === "free") throw new HttpError(409, "this license is still being set up; try again in a minute", "pending");
        const devices = await store.devices(l.id);
        const known = devices.some((d) => d.deviceId === deviceId);
        if (!known && path.endsWith("/refresh")) throw new HttpError(404, "this computer is not activated on the license", "not_activated");
        if (!known && devices.length >= l.computers)
          throw new HttpError(409, `this license is already used on ${devices.length} of ${l.computers} computers; deactivate one in OneSeat → Plan on that computer`, "computer_limit");
        await store.upsertDevice({ licenseId: l.id, deviceId, deviceName });
        const { token, payload } = tokenFor({ ...l, status: usable(l) }, deviceId);
        return json(res, 200, { token, tier: payload.tier, status: payload.status, computers: payload.computers, used: known ? devices.length : devices.length + 1, expiresAt: new Date(payload.exp * 1000).toISOString() });
      }
      case "/api/v1/trials": {
        // A free Team trial, started from OneSeat → Plan: one per email and one per computer, ever.
        if (!signer) throw new HttpError(503, "licensing is not configured");
        const email = str(body, "email", 254)!;
        if (!isEmail(email)) throw new HttpError(400, "enter a valid email address to start the trial", "bad_email");
        const deviceId = str(body, "deviceId", 80)!;
        if (!/^[A-Za-z0-9_.-]{8,80}$/.test(deviceId)) throw new HttpError(400, "deviceId is not valid", "bad_device");
        const deviceName = str(body, "deviceName", 80, false) ?? "";
        // The per-IP limit trusts X-Forwarded-For, which a script can fake; this cap does not.
        if ((await store.countTrialsSince(new Date(Date.now() - 86_400_000).toISOString())) >= cfg.trialsPerDay) {
          log("trial refused: the daily cap of new trials is reached");
          throw new HttpError(429, "free trials are paused for today; please try again tomorrow, or choose a plan", "trials_paused");
        }
        const key = generateLicenseKey();
        const endsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
        const l = await store.createTrial({
          license: { id: newId("lic"), keyHash: hashKey(key), email, tier: "team", status: "trialing", computers: PLANS.team.computers, team: TRIAL_TEAM, endsAt },
          emailLc: email.toLowerCase(),
          deviceId,
          deviceName,
        });
        if (!l)
          throw new HttpError(
            409,
            `this email or this computer has already used its free Team trial. Choose a plan at ${cfg.publicUrl}/#plans, or paste a license key from your team in OneSeat → Plan`,
            "trial_used",
          );
        log(`trial license ${l.id} until ${endsAt.slice(0, 10)}`);
        const { token, payload } = tokenFor(l, deviceId);
        // The key is returned this once: the app saves it, and the person keeps it for the team.
        return json(res, 200, { licenseKey: key, token, tier: payload.tier, status: payload.status, computers: payload.computers, used: 1, expiresAt: new Date(payload.exp * 1000).toISOString() });
      }
      case "/api/v1/licenses/deactivate": {
        const l = await findLicense(body);
        const deviceId = str(body, "deviceId", 80)!;
        return json(res, 200, { ok: await store.removeDevice(l.id, deviceId) });
      }
      case "/api/v1/feedback": {
        const message = str(body, "message", 5000)!;
        const rating = body["rating"] === undefined || body["rating"] === null ? null : Number(body["rating"]);
        if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new HttpError(400, "rating must be 1 to 5");
        let licenseId: string | null = null;
        const key = str(body, "licenseKey", 40, false);
        if (key && isLicenseKey(key)) licenseId = (await store.licenseByKeyHash(hashKey(key)))?.id ?? null;
        const f = await store.addFeedback({
          licenseId,
          email: str(body, "email", 200, false) ?? null,
          rating,
          topic: str(body, "topic", 60, false) ?? null,
          message,
          appVersion: str(body, "appVersion", 40, false) ?? null,
          os: str(body, "os", 40, false) ?? null,
        });
        return json(res, 200, { ok: true, id: f.id });
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await route(req, res, url);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "internal error");
      if (!(e instanceof HttpError)) log(`error ${req.method} ${url.pathname}: ${(e as Error)?.stack ?? String(e)}`);
      if (res.headersSent) return void res.end();
      if (url.pathname.startsWith("/api/")) json(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      else html(res, err.status, layout("Error", `<h1>Something went wrong</h1><p>${err.message.replace(/[<>&]/g, "")}</p>`));
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  return { server, handle };
}

