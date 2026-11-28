// Tool input schema conversion per provider.
// MCP tools carry full JSON Schema. Anthropic and OpenAI accept JSON Schema as-is
// (we only make sure the root is an object). Gemini `parameters` accept a subset
// of OpenAPI 3.0, so we sanitise: resolve local $refs, fold type arrays into
// `nullable`, turn oneOf into anyOf, merge simple allOf, and drop keywords
// Gemini rejects.

import type { JsonSchema } from "@oneseat/contracts";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Root schema for Anthropic `input_schema` / OpenAI `parameters`: always an object schema. */
export function toObjectSchema(schema: JsonSchema | undefined): JsonSchema {
  const s: JsonSchema = isObj(schema) ? { ...schema } : {};
  if (s.type !== "object") s.type = "object";
  if (!isObj(s.properties)) s.properties = {};
  return s;
}

/** Keywords Gemini accepts in a function parameter schema. */
const GEMINI_KEEP = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "anyOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "propertyOrdering",
]);

/** Formats Gemini documents as supported. Anything else is dropped. */
const GEMINI_FORMATS: Record<string, readonly string[]> = {
  string: ["enum", "date-time"],
  number: ["float", "double"],
  integer: ["int32", "int64"],
};

const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

const MAX_DEPTH = 24;

interface Ctx {
  root: Record<string, unknown>;
  /** $ref targets currently being expanded, to break cycles. */
  stack: string[];
}

function resolveRef(ref: string, ctx: Ctx): Record<string, unknown> | undefined {
  if (!ref.startsWith("#")) return undefined;
  if (ref === "#") return ctx.root;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = ctx.root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return isObj(cur) ? cur : undefined;
}

function appendDescription(s: Record<string, unknown>, note: string): void {
  const d = typeof s["description"] === "string" ? (s["description"] as string) : "";
  s["description"] = d ? `${d} (${note})` : note;
}

/** Merge allOf members into one schema (properties and required are unioned). */
function mergeAllOf(base: Record<string, unknown>, parts: unknown[], ctx: Ctx, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  delete out["allOf"];
  for (const p of parts) {
    if (!isObj(p)) continue;
    const part = isObj(p) && typeof p["$ref"] === "string" ? (resolveRef(p["$ref"], ctx) ?? {}) : p;
    for (const [k, v] of Object.entries(part)) {
      if (k === "properties" && isObj(v)) {
        out["properties"] = { ...(isObj(out["properties"]) ? out["properties"] : {}), ...v };
      } else if (k === "required" && Array.isArray(v)) {
        const prev = Array.isArray(out["required"]) ? (out["required"] as unknown[]) : [];
        out["required"] = [...new Set([...prev, ...v])];
      } else if (k === "allOf" && Array.isArray(v) && depth < MAX_DEPTH) {
        Object.assign(out, mergeAllOf(out, v, ctx, depth + 1));
      } else if (!(k in out)) {
        out[k] = v;
      }
    }
  }
  return out;
}

function inferValueType(values: unknown): string {
  if (!Array.isArray(values) || values.length === 0) return "string";
  if (values.every((v) => typeof v === "boolean")) return "boolean";
  if (values.every((v) => typeof v === "number")) return values.every((v) => Number.isInteger(v)) ? "integer" : "number";
  return "string";
}

function sanitise(input: unknown, ctx: Ctx, depth: number): Record<string, unknown> {
  // `true` / non-object schemas mean "anything": the closest Gemini type is a string.
  if (!isObj(input)) return { type: "string" };
  if (depth > MAX_DEPTH) return { type: "object", description: "(schema truncated: too deep)" };
  let s: Record<string, unknown> = input;

  // $ref: inline local references; break cycles.
  if (typeof s["$ref"] === "string") {
    const ref = s["$ref"];
    const target = ctx.stack.includes(ref) ? undefined : resolveRef(ref, ctx);
    const { $ref: _ignored, ...rest } = s;
    if (!target) {
      const out: Record<string, unknown> = { type: "object" };
      if (typeof rest["description"] === "string") out["description"] = rest["description"];
      appendDescription(out, ctx.stack.includes(ref) ? "recursive structure" : `see ${ref}`);
      return out;
    }
    ctx.stack.push(ref);
    try {
      return sanitise({ ...target, ...rest }, ctx, depth + 1);
    } finally {
      ctx.stack.pop();
    }
  }

  if (Array.isArray(s["allOf"])) s = mergeAllOf(s, s["allOf"], ctx, depth);

  const out: Record<string, unknown> = {};

  // type: Gemini takes a single type. ["string","null"] -> string + nullable.
  let types: string[] = [];
  if (typeof s["type"] === "string") types = [s["type"]];
  else if (Array.isArray(s["type"])) types = s["type"].filter((t): t is string => typeof t === "string");
  if (types.includes("null")) {
    out["nullable"] = true;
    types = types.filter((t) => t !== "null");
  }
  types = types.filter((t) => GEMINI_TYPES.has(t));

  if ("const" in s && !("enum" in s)) s = { ...s, enum: [s["const"]] };

  // Union types become anyOf of single-type schemas.
  if (types.length > 1) {
    const { type: _t, description: _d, ...rest } = s;
    const variants = types.map((t) => sanitise({ ...rest, type: t }, ctx, depth + 1));
    const u: Record<string, unknown> = { anyOf: variants };
    if (typeof s["description"] === "string") u["description"] = s["description"];
    if (out["nullable"]) u["nullable"] = true;
    return u;
  }
  if (types.length === 1) out["type"] = types[0];

  const anyOf = Array.isArray(s["anyOf"]) ? s["anyOf"] : Array.isArray(s["oneOf"]) ? s["oneOf"] : undefined;
  if (anyOf) {
    const variants: Record<string, unknown>[] = [];
    for (const v of anyOf) {
      // {type:"null"} in a union means nullable.
      if (isObj(v) && v["type"] === "null" && Object.keys(v).length === 1) {
        out["nullable"] = true;
        continue;
      }
      variants.push(sanitise(v, ctx, depth + 1));
    }
    if (variants.length === 1 && !out["type"]) {
      const only = variants[0] as Record<string, unknown>;
      for (const [k, v] of Object.entries(only)) if (!(k in out) || k === "type") out[k] = v;
    } else if (variants.length > 0) {
      out["anyOf"] = variants;
    }
  }

  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_KEEP.has(k) || k === "type" || k === "anyOf" || k === "nullable") continue;
    switch (k) {
      case "properties": {
        if (!isObj(v)) break;
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(v)) props[name] = sanitise(sub, ctx, depth + 1);
        out["properties"] = props;
        break;
      }
      case "items": {
        if (Array.isArray(v)) {
          // Tuple form: Gemini has no prefixItems; accept any listed item shape.
          const variants = v.map((it) => sanitise(it, ctx, depth + 1));
          out["items"] = variants.length === 1 ? variants[0] : { anyOf: variants };
        } else if (isObj(v)) {
          out["items"] = sanitise(v, ctx, depth + 1);
        }
        break;
      }
      case "enum": {
        if (!Array.isArray(v)) break;
        if (v.every((e) => typeof e === "string")) {
          out["enum"] = v;
          if (!out["type"]) out["type"] = "string";
        } else {
          // Gemini enums are string-only. Keep the constraint as a hint.
          appendDescription(out, `allowed values: ${v.map((e) => JSON.stringify(e)).join(", ")}`);
        }
        break;
      }
      case "format": {
        const t = typeof out["type"] === "string" ? (out["type"] as string) : typeof s["type"] === "string" ? s["type"] : "";
        if (typeof v === "string" && GEMINI_FORMATS[t]?.includes(v)) out["format"] = v;
        break;
      }
      case "description":
      case "title":
      case "pattern":
        if (typeof v === "string") {
          if (k === "description" && typeof out["description"] === "string") {
            out["description"] = `${v} (${out["description"] as string})`;
          } else out[k] = v;
        }
        break;
      case "required":
        if (Array.isArray(v)) out["required"] = v.filter((r) => typeof r === "string");
        break;
      case "propertyOrdering":
        if (Array.isArray(v)) out["propertyOrdering"] = v.filter((r) => typeof r === "string");
        break;
      default:
        if (typeof v === "number") out[k] = v;
        break;
    }
  }

  // required may only name declared properties.
  if (Array.isArray(out["required"])) {
    const props = isObj(out["properties"]) ? out["properties"] : {};
    const req = (out["required"] as string[]).filter((r) => r in props);
    if (req.length > 0) out["required"] = req;
    else delete out["required"];
  }
  if (Array.isArray(out["propertyOrdering"])) {
    const props = isObj(out["properties"]) ? out["properties"] : {};
    out["propertyOrdering"] = (out["propertyOrdering"] as string[]).filter((r) => r in props);
  }
  // Gemini requires a type on every schema. Infer a missing one from structure or
  // from the allowed values; an unconstrained ("any") schema becomes a string.
  if (!out["type"] && !out["anyOf"]) {
    if (isObj(out["properties"])) out["type"] = "object";
    else if (out["items"]) out["type"] = "array";
    else out["type"] = inferValueType(s["enum"]);
  }
  if (out["type"] === "array" && !out["items"]) out["items"] = { type: "string" };
  return out;
}

/**
 * Convert an MCP JSON Schema into Gemini's OpenAPI subset.
 * Returns undefined when the tool takes no parameters (Gemini rejects an
 * object schema with no properties at the root).
 */
export function toGeminiSchema(schema: JsonSchema | undefined): Record<string, unknown> | undefined {
  if (!isObj(schema)) return undefined;
  const out = sanitise(schema, { root: schema, stack: [] }, 0);
  out["type"] = "object";
  delete out["anyOf"];
  delete out["nullable"];
  if (!isObj(out["properties"]) || Object.keys(out["properties"]).length === 0) return undefined;
  return out;
}
