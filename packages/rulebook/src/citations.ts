// Gate R2, live half: re-fetch every citation and check that the quoted passage is still there.
// Runs on demand and in a weekly sweep, never in the per-PR unit tests (no network in CI tests).
//
// Outcomes separate real problems (quote missing, page gone) from pages a script cannot judge
// (bot challenges, PDFs, server errors), which go to a verifier agent or a person instead.

import type { Citation, RulePack } from "@oneseat/contracts";

export type CitationOutcome =
  /** Page loaded and the quote is on it (or the citation has no quote). */
  | "ok"
  /** Page loaded but the quote is not on it: the source changed or the quote is wrong. */
  | "quote_missing"
  /** The page is gone (4xx other than bot blocks). */
  | "http_error"
  /** Bot challenge or rate limit (202, 403, 429) or a temporary server error (5xx): check by hand. */
  | "blocked"
  /** A PDF or other binary file: the script cannot read it; check by hand or with an agent. */
  | "needs_manual"
  /** Network error. */
  | "fetch_error";

export interface CitationCheck {
  pack: string;
  id: string;
  url: string;
  outcome: CitationOutcome;
  /** True only for "ok". */
  ok: boolean;
  status?: number;
  error?: string;
}

export interface FetchedPage {
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export type Fetcher = (url: string) => Promise<FetchedPage>;

const BLOCK_STATUS = new Set([202, 403, 429]);

/** Strip tags, decode the common entities and fold whitespace, so quotes match page text. */
export function normalizeText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&laquo;|&raquo;|&ldquo;|&rdquo;|&bdquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[‘’]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/­/g, "")
    .replace(/[ \s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteInText(quote: string, pageText: string): boolean {
  return normalizeText(pageText).includes(normalizeText(quote));
}

/** Decode a page using the charset from the Content-Type header or the HTML meta tag. */
export function decodePage(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isBinary(url: string, contentType: string | null): boolean {
  if (contentType && /pdf|octet-stream|msword|officedocument/i.test(contentType)) return true;
  return /\.pdf(?:$|[?#])/i.test(url);
}

/**
 * EUR-Lex answers automated requests with an empty bot page. The EU Publications Office serves the
 * same Official Journal act by CELEX number. Maps ELI links for regulations and directives,
 * e.g. /eli/reg/2025/40/oj → https://publications.europa.eu/resource/celex/32025R0040.
 */
export function eurLexFallback(url: string): string | undefined {
  const m = /eur-lex\.europa\.eu\/eli\/(reg|dir|dec)\/(\d{4})\/(\d+)/i.exec(url);
  if (!m) return undefined;
  const type = { reg: "R", dir: "L", dec: "D" }[m[1]!.toLowerCase() as "reg" | "dir" | "dec"];
  return `https://publications.europa.eu/resource/celex/3${m[2]}${type}${m[3]!.padStart(4, "0")}`;
}

export async function checkCitation(pack: string, c: Citation, fetcher: Fetcher): Promise<CitationCheck> {
  const base = { pack, id: c.id, url: c.url };
  try {
    let res = await fetcher(c.url);
    const fallback = eurLexFallback(c.url);
    if (fallback && (BLOCK_STATUS.has(res.status) || res.status >= 500)) res = await fetcher(fallback);
    if (BLOCK_STATUS.has(res.status) || res.status >= 500) {
      return { ...base, outcome: "blocked", ok: false, status: res.status, error: `HTTP ${res.status}: check by hand` };
    }
    if (res.status < 200 || res.status >= 300) return { ...base, outcome: "http_error", ok: false, status: res.status, error: `HTTP ${res.status}` };
    const contentType = res.headers?.get("content-type") ?? null;
    if (isBinary(c.url, contentType)) {
      return { ...base, outcome: "needs_manual", ok: false, status: res.status, error: "PDF or binary file: check the quote by hand" };
    }
    if (c.quote === undefined) return { ...base, outcome: "ok", ok: true, status: res.status };
    const text = decodePage(new Uint8Array(await res.arrayBuffer()), contentType);
    if (quoteInText(c.quote, text)) return { ...base, outcome: "ok", ok: true, status: res.status };
    return { ...base, outcome: "quote_missing", ok: false, status: res.status, error: "quote not found on the page" };
  } catch (e) {
    return { ...base, outcome: "fetch_error", ok: false, error: (e as Error).message };
  }
}

export async function checkCitations(packs: RulePack[], fetcher: Fetcher, concurrency = 6): Promise<CitationCheck[]> {
  const jobs = packs.flatMap((p) => p.citations.map((c) => () => checkCitation(p.id, c, fetcher)));
  const out: CitationCheck[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  return out;
}

/** Outcomes that mean the rule pack must change: gate R2 fails on these. */
export const FAILING_OUTCOMES: readonly CitationOutcome[] = ["quote_missing", "http_error"];
