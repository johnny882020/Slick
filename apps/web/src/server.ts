// Oblige web server. Stateless: the gap check runs in memory and nothing is stored or logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RulePack, Seller } from "@oneseat/contracts";
import { buildAudit, CatalogError, parseCatalogCsv, renderHtml } from "@oneseat/obligations";
import { checkPage, errorPage, homePage } from "./pages.js";
import { FormError, sellerFromForm } from "./seller-form.js";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export const MAX_UPLOAD = 3 * 1024 * 1024;
export const MAX_PRODUCTS = 5000;

export interface WebOptions {
  packs: RulePack[];
  sampleHtml: string;
  templateCsv: string;
  version?: string;
  /** Gap checks allowed per client per minute. Default 10. */
  checksPerMinute?: number;
  /** ISO date for audits (tests). Default today. */
  today?: () => string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    ...(type.startsWith("text/html") ? { "content-security-policy": CSP, "x-frame-options": "DENY" } : {}),
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_UPLOAD) return reject(new HttpError(413, "That file is too large. The gap check takes catalogs up to 3 MB."));
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new HttpError(413, "That file is too large. The gap check takes catalogs up to 3 MB."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Fixed-window rate limit per client address. */
export function rateLimiter(perMinute: number, now: () => number = Date.now) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.windowStart >= 60_000) {
      hits.set(key, { windowStart: t, count: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.windowStart >= 60_000) hits.delete(k);
      return true;
    }
    h.count += 1;
    return h.count <= perMinute;
  };
}

function clientKey(req: IncomingMessage): string {
  // Render sets x-forwarded-for; the first entry is the client.
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

async function runCheck(req: IncomingMessage, o: WebOptions): Promise<string> {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "Please use the form on the gap check page.");
  const body = await readBody(req);
  const form = await new Request("http://local/check", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }).formData();
  const file = form.get("catalog");
  if (!file || typeof file === "string" || file.size === 0) throw new FormError("Please choose your catalog CSV file.");
  const fields = {
    get: (n: string) => {
      const v = form.get(n);
      return typeof v === "string" ? v : undefined;
    },
    getAll: (n: string) => form.getAll(n).filter((v): v is string => typeof v === "string"),
  };
  const seller: Seller = sellerFromForm(fields);
  const products = parseCatalogCsv(await file.text());
  if (products.length > MAX_PRODUCTS) throw new FormError(`The free check takes up to ${MAX_PRODUCTS} products; your file has ${products.length}.`);
  const today = o.today?.() ?? new Date().toISOString().slice(0, 10);
  return renderHtml(buildAudit({ seller, products, packs: o.packs, today }));
}

export function createWebServer(o: WebOptions): Server {
  const allow = rateLimiter(o.checksPerMinute ?? 10);
  const home = homePage(o.packs);
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const route = `${req.method} ${url.pathname}`;
    const handle = async (): Promise<void> => {
      switch (route) {
        case "GET /":
          return send(res, 200, home);
        case "GET /check":
          return send(res, 200, checkPage());
        case "POST /check": {
          if (!allow(clientKey(req))) return send(res, 429, errorPage(429, "Too many checks at once. Please wait a minute and try again."), undefined, { "retry-after": "60" });
          try {
            return send(res, 200, await runCheck(req, o));
          } catch (e) {
            if (e instanceof FormError || e instanceof CatalogError) return send(res, 400, checkPage(e.message));
            throw e;
          }
        }
        case "GET /sample":
          return send(res, 200, o.sampleHtml);
        case "GET /catalog-template.csv":
          return send(res, 200, o.templateCsv, "text/csv; charset=utf-8", { "content-disposition": 'attachment; filename="oblige-catalog-template.csv"' });
        case "GET /healthz":
          return send(res, 200, JSON.stringify({ ok: true, service: "oblige-web", version: o.version ?? "dev", rulePacks: o.packs.length }), "application/json");
        case "GET /api/v1/rulebook":
          return send(
            res,
            200,
            JSON.stringify(o.packs.map((p) => ({ id: p.id, version: p.version, jurisdiction: p.jurisdiction, obligation: p.obligation, rules: p.rules.length, citations: p.citations.length, reviewStatus: p.review.status }))),
            "application/json",
          );
        default:
          return send(res, 404, errorPage(404, "That page does not exist."));
      }
    };
    handle().catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, e.status === 413 ? checkPage(e.message) : errorPage(e.status, e.message));
      // Never log request bodies: they hold customer catalogs.
      console.error(`oblige-web: ${route} failed: ${e instanceof Error ? e.name : "error"}`);
      send(res, 500, errorPage(500, "Something went wrong on our side. Please try again."));
    });
  });
}
