import { describe, expect, it } from "vitest";
import { toGeminiSchema, toObjectSchema } from "../src/index.js";

describe("toObjectSchema", () => {
  it("keeps a valid object schema and fills in missing pieces", () => {
    expect(toObjectSchema({ type: "object", properties: { a: { type: "string" } } })).toEqual({ type: "object", properties: { a: { type: "string" } } });
    expect(toObjectSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(toObjectSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
  });
});

describe("toGeminiSchema", () => {
  it("strips keywords Gemini rejects", () => {
    expect(
      toGeminiSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:tool",
        $comment: "x",
        type: "object",
        additionalProperties: false,
        properties: {
          q: { type: "string", default: "x", examples: ["a"], minLength: 1, maxLength: 9, pattern: "^a", title: "Query" },
          n: { type: "integer", minimum: 0, maximum: 10, exclusiveMinimum: 0, multipleOf: 2 },
          tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
        },
        required: ["q", "missing"],
        patternProperties: { "^x": {} },
      }),
    ).toEqual({
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, maxLength: 9, pattern: "^a", title: "Query" },
        n: { type: "integer", minimum: 0, maximum: 10 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      },
      required: ["q"],
    });
  });

  it("returns undefined for a tool with no parameters", () => {
    expect(toGeminiSchema({ type: "object" })).toBeUndefined();
    expect(toGeminiSchema({ type: "object", properties: {} })).toBeUndefined();
    expect(toGeminiSchema(undefined)).toBeUndefined();
  });

  it("folds type arrays and null unions into nullable / anyOf", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          a: { type: ["string", "null"], description: "maybe" },
          b: { anyOf: [{ type: "integer" }, { type: "null" }] },
          c: { oneOf: [{ type: "string" }, { type: "number" }] },
          d: { type: ["string", "integer"], description: "either" },
          e: { type: ["string", "integer", "null"] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string", nullable: true, description: "maybe" },
        b: { type: "integer", nullable: true },
        c: { anyOf: [{ type: "string" }, { type: "number" }] },
        d: { anyOf: [{ type: "string" }, { type: "integer" }], description: "either" },
        e: { anyOf: [{ type: "string" }, { type: "integer" }], nullable: true },
      },
    });
  });

  it("keeps supported formats only and string enums only", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          when: { type: "string", format: "date-time" },
          email: { type: "string", format: "email" },
          big: { type: "integer", format: "int64" },
          f: { type: "number", format: "int32" },
          color: { enum: ["red", "green"] },
          level: { type: "integer", enum: [1, 2, 3], description: "Level" },
          mode: { const: "fast" },
          num: { const: 3 },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        email: { type: "string" },
        big: { type: "integer", format: "int64" },
        f: { type: "number" },
        color: { type: "string", enum: ["red", "green"] },
        level: { type: "integer", description: "Level (allowed values: 1, 2, 3)" },
        mode: { type: "string", enum: ["fast"] },
        num: { type: "integer", description: "allowed values: 3" },
      },
    });
  });

  it("resolves local $refs, including nested and escaped paths", () => {
    expect(
      toGeminiSchema({
        type: "object",
        $defs: { Address: { type: "object", properties: { city: { $ref: "#/$defs/City" } }, required: ["city"] }, City: { type: "string" } },
        definitions: { "a/b": { type: "boolean" } },
        properties: {
          home: { $ref: "#/$defs/Address", description: "Home address" },
          flag: { $ref: "#/definitions/a~1b" },
          ext: { $ref: "https://example.com/schema.json" },
          bad: { $ref: "#/$defs/Missing" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        home: { type: "object", properties: { city: { type: "string" } }, required: ["city"], description: "Home address" },
        flag: { type: "boolean" },
        ext: { type: "object", description: "see https://example.com/schema.json" },
        bad: { type: "object", description: "see #/$defs/Missing" },
      },
    });
  });

  it("breaks recursive $refs", () => {
    const out = toGeminiSchema({
      type: "object",
      $defs: { Node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/$defs/Node", description: "Child" } } } },
      properties: { root: { $ref: "#/$defs/Node" }, self: { $ref: "#" } },
    });
    expect(out?.["properties"]).toEqual({
      root: {
        type: "object",
        properties: { name: { type: "string" }, child: { type: "object", description: "Child (recursive structure)" } },
      },
      self: expect.objectContaining({ type: "object" }),
    });
  });

  it("merges allOf and infers missing types", () => {
    expect(
      toGeminiSchema({
        type: "object",
        $defs: { Base: { properties: { id: { type: "string" } }, required: ["id"] } },
        properties: {
          item: {
            allOf: [
              { $ref: "#/$defs/Base" },
              { properties: { qty: { type: "integer" } }, required: ["qty"], description: "An item", allOf: [{ properties: { note: { type: "string" } } }] },
              "junk",
            ],
          },
          list: { items: { type: "string" } },
          tuple: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
          single: { type: "array", items: [{ type: "string" }] },
          bare: { type: "array" },
          wild: { type: "date" },
          one: { anyOf: [{ type: "string", description: "only" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { id: { type: "string" }, qty: { type: "integer" }, note: { type: "string" } },
          required: ["id", "qty"],
          description: "An item",
        },
        list: { type: "array", items: { type: "string" } },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
        single: { type: "array", items: { type: "string" } },
        bare: { type: "array", items: { type: "string" } },
        wild: { type: "string" },
        one: { type: "string", description: "only" },
      },
    });
  });

  it("keeps propertyOrdering for declared properties and truncates absurd depth", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) deep = { type: "object", properties: { x: deep } };
    const out = toGeminiSchema({ type: "object", properties: { a: { type: "string" }, deep }, propertyOrdering: ["a", "zzz", 3] as unknown as string[] });
    expect(out?.["propertyOrdering"]).toEqual(["a"]);
    expect(JSON.stringify(out)).toContain("schema truncated");
  });

  it("ignores non-object property schemas and non-string metadata", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          a: true as unknown as Record<string, unknown>,
          b: { type: "string", description: 5, required: "x", minLength: "1" } as unknown as Record<string, unknown>,
        },
        required: "a" as unknown as string[],
      }),
    ).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
  });
});
