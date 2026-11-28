// Gate R1 (rule lint) and the offline half of gate R2 (citation structure).
// Packs arrive from YAML, so every field is checked as unknown input.

import { EU_COUNTRIES, OBLIGATIONS } from "@oneseat/contracts";
import { PREDICATE_OPERATORS } from "./predicate.js";

export interface LintIssue {
  pack: string;
  /** Where in the pack, e.g. "rules[2].requires[0].satisfiedWhen". */
  at: string;
  level: "error" | "warning";
  message: string;
}

const JURISDICTIONS = new Set<string>([...EU_COUNTRIES, "EU"]);
const OBLIGATION_SET = new Set<string>(OBLIGATIONS);
const REVIEW = new Set(["draft", "verified", "approved", "retired"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const SEVERITY = new Set(["blocking", "high", "medium", "low"]);
const KINDS = new Set(["registration", "scheme_contract", "representative", "data_field", "label", "declaration"]);
const FILING = new Set(["api", "portal", "portal_eid", "email", "post", "scheme", "marketplace"]);
const WHO = new Set(["producer", "authorised_representative", "marketplace", "compliance_scheme"]);
const CITATION_KINDS = new Set(["law", "regulator_guidance", "register", "marketplace_policy", "secondary"]);
const EVERY = new Set(["month", "quarter", "year"]);
const OPS = new Set<string>(PREDICATE_OPERATORS);

const SELLER_KEYS = new Set([
  "id", "legalName", "establishedIn", "roles", "vatIds", "registrations", "schemes",
  "euResponsiblePerson", "representatives",
]);
const PRODUCT_KEYS = new Set([
  "sku", "title", "gtin", "brand", "category", "consumerProduct", "listings", "shipsPackaged",
  "packaging", "electrical", "weeeCategory", "battery", "textile", "safety", "attributes",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d{4}\.\d{2}\.\d+$/;
const PACK_ID = /^(eu|[a-z]{2})\.[a-z_]+$/;
const MAX_QUOTE = 300;
const MAX_LABEL = 120;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Lint one parsed pack. Returns all issues; errors block merge. */
export function lintPack(raw: unknown, name = "<pack>"): LintIssue[] {
  const issues: LintIssue[] = [];
  const err = (at: string, message: string) => issues.push({ pack: name, at, level: "error", message });
  const warn = (at: string, message: string) => issues.push({ pack: name, at, level: "warning", message });

  if (!isObj(raw)) {
    err("", "a rule pack must be a mapping");
    return issues;
  }
  const p = raw;
  const id = isStr(p["id"]) ? p["id"] : "";
  if (!PACK_ID.test(id)) err("id", `id "${id}" must look like "de.packaging_epr" or "eu.gpsr"`);
  if (!isStr(p["version"]) || !VERSION.test(p["version"])) err("version", "version must be YYYY.MM.N");
  if (!isStr(p["jurisdiction"]) || !JURISDICTIONS.has(p["jurisdiction"])) err("jurisdiction", "jurisdiction must be an EU country code or EU");
  if (!isStr(p["obligation"]) || !OBLIGATION_SET.has(p["obligation"])) err("obligation", `obligation must be one of ${[...OBLIGATION_SET].join(", ")}`);
  if (id && isStr(p["jurisdiction"]) && isStr(p["obligation"])) {
    const expected = `${p["jurisdiction"].toLowerCase()}.${p["obligation"]}`;
    if (id !== expected) err("id", `id must be "${expected}" for this jurisdiction and obligation`);
  }
  if (!isStr(p["title"])) err("title", "title is required");
  if (!isStr(p["effectiveFrom"]) || !ISO_DATE.test(p["effectiveFrom"])) err("effectiveFrom", "effectiveFrom must be an ISO date (quote it in YAML)");
  if (p["effectiveTo"] !== undefined && p["effectiveTo"] !== null && !(isStr(p["effectiveTo"]) && ISO_DATE.test(p["effectiveTo"]))) {
    err("effectiveTo", "effectiveTo must be null or an ISO date");
  }
  if (!isStr(p["confidence"]) || !CONFIDENCE.has(p["confidence"])) err("confidence", "confidence must be low, medium or high");

  const review = p["review"];
  if (!isObj(review) || !isStr(review["status"]) || !REVIEW.has(review["status"])) {
    err("review.status", "review.status must be draft, verified, approved or retired");
  } else if (review["status"] === "approved" && (!isStr(review["reviewer"]) || !isStr(review["reviewedAt"]))) {
    err("review", "an approved pack needs reviewer and reviewedAt (gate R3)");
  }
  if (p["openQuestions"] !== undefined && !(Array.isArray(p["openQuestions"]) && p["openQuestions"].every(isStr))) {
    err("openQuestions", "openQuestions must be a list of strings");
  }
  const fixGroups = p["fixGroups"];
  const groupIds = new Set<string>();
  if (fixGroups !== undefined) {
    if (!isObj(fixGroups)) err("fixGroups", "fixGroups must map group ids to action titles");
    else for (const [g, title] of Object.entries(fixGroups)) {
      if (!/^[a-z][a-z0-9_]*$/.test(g)) err(`fixGroups.${g}`, "group ids are lower_snake_case");
      if (!isStr(title)) err(`fixGroups.${g}`, "each group needs an action title");
      groupIds.add(g);
    }
  }
  const usedGroups = new Set<string>();

  // Citations
  const citationIds = new Set<string>();
  const citationKind = new Map<string, string>();
  const citations = p["citations"];
  if (!Array.isArray(citations) || citations.length === 0) err("citations", "a pack needs at least one citation");
  else {
    citations.forEach((c, i) => {
      const at = `citations[${i}]`;
      if (!isObj(c)) return err(at, "citation must be a mapping");
      if (!isStr(c["id"])) err(`${at}.id`, "citation id is required");
      else if (citationIds.has(c["id"])) err(`${at}.id`, `duplicate citation id "${c["id"]}"`);
      else {
        citationIds.add(c["id"]);
        citationKind.set(c["id"], String(c["kind"]));
      }
      if (!isStr(c["title"])) err(`${at}.title`, "title is required");
      if (!isStr(c["publisher"])) err(`${at}.publisher`, "publisher is required");
      if (!isStr(c["url"]) || !/^https:\/\//.test(c["url"])) err(`${at}.url`, "url must be https");
      if (!isStr(c["kind"]) || !CITATION_KINDS.has(c["kind"])) err(`${at}.kind`, `kind must be one of ${[...CITATION_KINDS].join(", ")}`);
      if (!isStr(c["retrieved"]) || !ISO_DATE.test(c["retrieved"])) err(`${at}.retrieved`, "retrieved must be an ISO date (quote it in YAML)");
      if (c["quote"] !== undefined) {
        if (!isStr(c["quote"])) err(`${at}.quote`, "quote must be text");
        else if (c["quote"].length > MAX_QUOTE) err(`${at}.quote`, `quote is longer than ${MAX_QUOTE} characters`);
      } else warn(`${at}.quote`, "no quote: the verifier cannot confirm what this source says");
    });
  }

  // Rules
  const rules = p["rules"];
  const ruleIds = new Set<string>();
  if (!Array.isArray(rules) || rules.length === 0) err("rules", "a pack needs at least one rule");
  else {
    rules.forEach((r, i) => {
      const at = `rules[${i}]`;
      if (!isObj(r)) return err(at, "rule must be a mapping");
      if (!isStr(r["id"])) err(`${at}.id`, "rule id is required");
      else {
        if (id && !r["id"].startsWith(`${id}.`)) err(`${at}.id`, `rule id must start with "${id}."`);
        if (ruleIds.has(r["id"])) err(`${at}.id`, `duplicate rule id "${r["id"]}"`);
        ruleIds.add(r["id"]);
      }
      for (const k of ["title", "summary"]) if (!isStr(r[k])) err(`${at}.${k}`, `${k} is required`);
      if (!isStr(r["severity"]) || !SEVERITY.has(r["severity"])) err(`${at}.severity`, "severity must be blocking, high, medium or low");
      lintPredicate(r["appliesWhen"], `${at}.appliesWhen`, err);

      const cites = r["citations"];
      if (!Array.isArray(cites) || cites.length === 0) err(`${at}.citations`, "every rule needs at least one citation (gate R2)");
      else {
        for (const c of cites) if (!isStr(c) || !citationIds.has(c)) err(`${at}.citations`, `unknown citation id "${String(c)}"`);
        if (cites.every((c) => citationKind.get(String(c)) === "secondary")) {
          err(`${at}.citations`, "a rule cannot rest on secondary sources alone");
        }
      }

      const reqs = r["requires"];
      const keys = new Set<string>();
      if (!Array.isArray(reqs) || reqs.length === 0) err(`${at}.requires`, "a rule needs at least one requirement");
      else {
        reqs.forEach((q, j) => {
          const qa = `${at}.requires[${j}]`;
          if (!isObj(q)) return err(qa, "requirement must be a mapping");
          if (!isStr(q["key"])) err(`${qa}.key`, "key is required");
          else if (keys.has(q["key"])) err(`${qa}.key`, `duplicate requirement key "${q["key"]}"`);
          else keys.add(q["key"]);
          if (!isStr(q["label"])) err(`${qa}.label`, "label is required");
          else if (q["label"].length > MAX_LABEL) warn(`${qa}.label`, `label is longer than ${MAX_LABEL} characters; it becomes a fix title, so keep it short and put hints in the rule summary`);
          if (!isStr(q["kind"]) || !KINDS.has(q["kind"])) err(`${qa}.kind`, `kind must be one of ${[...KINDS].join(", ")}`);
          lintPredicate(q["satisfiedWhen"], `${qa}.satisfiedWhen`, err);
          if (q["whoMayFile"] !== undefined && !(Array.isArray(q["whoMayFile"]) && q["whoMayFile"].every((w) => WHO.has(String(w))))) {
            err(`${qa}.whoMayFile`, `whoMayFile must list ${[...WHO].join(", ")}`);
          }
          const filing = q["filing"];
          if (filing !== undefined) {
            if (!isObj(filing) || !isStr(filing["channel"]) || !FILING.has(filing["channel"])) err(`${qa}.filing.channel`, `filing.channel must be one of ${[...FILING].join(", ")}`);
            else {
              if (filing["url"] !== undefined && !(isStr(filing["url"]) && /^https:\/\//.test(filing["url"]))) err(`${qa}.filing.url`, "filing.url must be https");
              const lt = filing["leadTimeDays"];
              if (lt !== undefined && !(Array.isArray(lt) && lt.length === 2 && lt.every((n) => typeof n === "number" && n >= 0) && (lt[0] as number) <= (lt[1] as number))) {
                err(`${qa}.filing.leadTimeDays`, "leadTimeDays must be [min, max] days");
              }
            }
          }
          if (q["group"] !== undefined) {
            if (!isStr(q["group"]) || !groupIds.has(q["group"])) err(`${qa}.group`, `group "${String(q["group"])}" is not defined in fixGroups`);
            else usedGroups.add(q["group"]);
          }
          if (q["numberFormat"] !== undefined) {
            try { new RegExp(String(q["numberFormat"])); } catch { err(`${qa}.numberFormat`, "numberFormat is not a valid regular expression"); }
          }
          const rec = q["recurring"];
          if (rec !== undefined && !(isObj(rec) && EVERY.has(String(rec["every"])) && isStr(rec["note"]))) {
            err(`${qa}.recurring`, "recurring needs every (month, quarter, year) and a note");
          }
        });
      }
      const checks = r["marketplaceChecks"];
      if (i === rules.length - 1) {
        for (const g of groupIds) if (!usedGroups.has(g)) warn(`fixGroups.${g}`, `group "${g}" is defined but no requirement uses it`);
      }
      if (checks !== undefined) {
        if (!Array.isArray(checks)) err(`${at}.marketplaceChecks`, "marketplaceChecks must be a list");
        else checks.forEach((m, k) => {
          if (!isObj(m) || !isStr(m["channel"]) || typeof m["blocksListing"] !== "boolean") {
            err(`${at}.marketplaceChecks[${k}]`, "each check needs channel and blocksListing");
          } else if (m["citations"] !== undefined) {
            const mc = m["citations"];
            if (!Array.isArray(mc) || mc.some((c) => !citationIds.has(String(c)))) err(`${at}.marketplaceChecks[${k}].citations`, "unknown citation id");
          } else if (m["blocksListing"] === true) {
            warn(`${at}.marketplaceChecks[${k}]`, "a listing block should cite the marketplace's own policy");
          }
        });
      }
    });
  }
  return issues;
}

function lintPredicate(raw: unknown, at: string, err: (at: string, m: string) => void): void {
  if (!isObj(raw)) return err(at, "predicate must be a mapping");
  const keys = Object.keys(raw);
  if (keys.length !== 1) return err(at, `predicate must have exactly one operator, found ${keys.join(", ") || "none"}`);
  const op = keys[0]!;
  const v = raw[op];
  if (!OPS.has(op)) return err(at, `unknown operator "${op}"`);
  switch (op) {
    case "always":
      if (v !== true) err(at, "always must be true");
      return;
    case "all":
    case "any":
      if (!Array.isArray(v) || v.length === 0) return err(at, `${op} needs a non-empty list`);
      v.forEach((sub, i) => lintPredicate(sub, `${at}.${op}[${i}]`, err));
      return;
    case "not":
      return lintPredicate(v, `${at}.not`, err);
    case "eq":
    case "contains":
      if (!Array.isArray(v) || v.length !== 2 || !isScalar(v[1])) return err(at, `${op} needs [path, value]`);
      return lintPath(v[0], at, err);
    case "in":
      if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[1]) || !v[1].every(isScalar)) return err(at, "in needs [path, [values]]");
      return lintPath(v[0], at, err);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (!Array.isArray(v) || v.length !== 2 || typeof v[1] !== "number") return err(at, `${op} needs [path, number]`);
      return lintPath(v[0], at, err);
    case "exists":
    case "inEU":
    case "localized":
      return lintPath(v, at, err);
    default: {
      // registered, inScheme, hasRepresentative
      if (!isObj(v) || !isStr(v["obligation"]) || !OBLIGATION_SET.has(v["obligation"])) return err(at, `${op} needs a valid obligation`);
      const j = v["jurisdiction"];
      if (j !== undefined && !(isStr(j) && (j === "$market" || JURISDICTIONS.has(j)))) err(at, `${op}.jurisdiction must be $market, EU or a country code`);
    }
  }
}

function isScalar(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function lintPath(raw: unknown, at: string, err: (at: string, m: string) => void): void {
  if (!isStr(raw)) return err(at, "path must be text");
  const [head, second] = raw.split(".");
  if (head === "market" || head === "channel" || head === "today") {
    if (second !== undefined) err(at, `"${head}" has no fields`);
    return;
  }
  if (head === "seller") {
    if (second === undefined || !SELLER_KEYS.has(second)) err(at, `unknown seller field in "${raw}"`);
    return;
  }
  if (head === "product") {
    if (second === undefined || !PRODUCT_KEYS.has(second)) err(at, `unknown product field in "${raw}"`);
    return;
  }
  err(at, `path "${raw}" must start with market, channel, today, seller or product`);
}
