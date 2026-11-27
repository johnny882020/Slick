// A small JSON Schema validator for the subset tool schemas use:
// type, properties, required, enum, items, additionalProperties
// (plus minLength/maxLength, minimum/maximum, minItems/maxItems when present).
// Unknown keywords are ignored, so MCP schemas with richer keywords still pass.

import type { JsonSchema } from "@oneseat/contracts";

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Validate a value. Returns a list of human-readable problems (empty when valid). */
export function validateSchema(schema: JsonSchema | undefined, value: unknown, path = "input"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path} must be ${types.join(" or ")}, got ${typeOf(value)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errors.push(`${path} must be one of ${schema.enum.map(show).join(", ")}`);

  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"])
      errors.push(`${path} must be at least ${schema["minLength"]} characters`);
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"])
      errors.push(`${path} must be at most ${schema["maxLength"]} characters`);
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"])
      errors.push(`${path} must be >= ${schema["minimum"]}`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"])
      errors.push(`${path} must be <= ${schema["maximum"]}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"])
      errors.push(`${path} must have at least ${schema["minItems"]} items`);
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"])
      errors.push(`${path} must have at most ${schema["maxItems"]} items`);
    if (Array.isArray(schema.items)) {
      schema.items.forEach((s, i) => {
        if (i < value.length) errors.push(...validateSchema(s, value[i], `${path}[${i}]`));
      });
    } else if (schema.items) {
      value.forEach((v, i) => errors.push(...validateSchema(schema.items as JsonSchema, v, `${path}[${i}]`)));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const r of schema.required ?? [])
      if (!(r in obj) || obj[r] === undefined) errors.push(`${path}.${r} is required`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const ps = props[k];
      if (ps) errors.push(...validateSchema(ps, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errors.push(...validateSchema(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return errors;
}
