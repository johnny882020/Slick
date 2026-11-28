import { describe, expect, it, vi } from "vitest";
import { validateSchema } from "../src/schema.js";
import { checkReadSql, checkWriteSql, splitStatements, stripSql } from "../src/sql.js";
import { AbortError, AsyncQueue, createLogger, errorMessage, raceAbort, Redactor, sleep, truncateText } from "../src/util.js";
import { summarizeAction, isReadOnly, toolLabel } from "../src/approvals.js";
import { normaliseRelativePath, resolveInside } from "../src/workspace.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.js";

describe("Redactor", () => {
  it("redacts known secrets and credential patterns", () => {
    const r = new Redactor();
    r.add("my-very-secret-key-123");
    r.add("abc"); // too short to track
    const text = [
      "key my-very-secret-key-123 here",
      "authorization: Bearer abcdefghijklmnop",
      "x-api-key: zzz-111",
      '"x-goog-api-key":"AIzaSyA1234567890abcdefghijklmnopqrstu"',
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "password=hunter2",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      "max_tokens: 4096 and abc stays",
    ].join("\n");
    const out = r.redact(text);
    expect(out).not.toContain("my-very-secret-key-123");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("x-api-key: [REDACTED]");
    expect(out).not.toContain("AIzaSy");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("ghp_");
    expect(out).toContain("password=[REDACTED]");
    expect(out).not.toContain("AKIA");
    expect(out).not.toContain("eyJhbGci");
    expect(out).not.toContain("MIIE");
    expect(out).toContain("max_tokens: 4096 and abc stays");
    expect(r.redactKnown("x my-very-secret-key-123 password=1")).toBe("x [REDACTED] password=1");
    expect(r.redactValue({ a: ["token=abcdef"], b: 1, c: null })).toEqual({ a: ["token=[REDACTED]"], b: 1, c: null });
    r.remove("my-very-secret-key-123");
    expect(r.redactKnown("my-very-secret-key-123")).toBe("my-very-secret-key-123");
  });

  it("redacts a secret split across stream chunks", () => {
    const r = new Redactor();
    const plain = r.stream();
    expect(plain.push("no secrets yet")).toBe("no secrets yet");
    r.add("SECRET-KEY-42");
    const s = r.stream();
    const out = ["Key: SEC", "RET-K", "EY-42 done. S", "E", "x"].map((c) => s.push(c)).join("") + s.flush();
    expect(out).toBe("Key: [REDACTED] done. SEx");
    const t = r.stream();
    expect(t.push("ends with SECRET-")).toBe("ends with ");
    expect(t.flush()).toBe("SECRET-");
  });

  it("logs to the writer, redacted, filtered by level", () => {
    const r = new Redactor();
    r.add("SECRETSECRET");
    const lines: string[] = [];
    const log = createLogger(r, (l) => lines.push(l), "info");
    log.debug("hidden");
    log.info("hello SECRETSECRET", { apiKey: "sk-proj-ABCDEFGHIJKLMNOPQRSTUV" });
    log.warn("w", new Error("bad SECRETSECRET"));
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    log.error("e", circular);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("SECRETSECRET");
    expect(lines.join("\n")).not.toContain("sk-proj");
    expect(lines[0]).toMatch(/^\[oneseat info\] hello \[REDACTED\]/);
    expect(lines[1]).toBe("[oneseat warn] w bad [REDACTED]");
    expect(lines[2]).toBe("[oneseat error] e [object Object]");
  });
});

describe("async helpers", () => {
  it("AsyncQueue delivers pushed items, ends on close and calls onReturn on break", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.close();
      q.push(3);
    }, 5);
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
    expect(q.isClosed).toBe(true);

    const onReturn = vi.fn();
    const q2 = new AsyncQueue<number>(onReturn);
    q2.push(1);
    q2.push(2);
    for await (const n of q2) if (n === 1) break;
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("sleep and raceAbort honour abort signals", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    await expect(sleep(1, ac.signal)).rejects.toBeInstanceOf(AbortError);
    await expect(sleep(1)).resolves.toBeUndefined();
    await expect(raceAbort(Promise.resolve(5), new AbortController().signal)).resolves.toBe(5);
    await expect(raceAbort(Promise.reject(new Error("x")), new AbortController().signal)).rejects.toThrow("x");
    await expect(raceAbort(Promise.resolve(1), ac.signal)).rejects.toBeInstanceOf(AbortError);
    const ac2 = new AbortController();
    const pending = raceAbort(new Promise(() => undefined), ac2.signal);
    ac2.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it("truncateText and errorMessage", () => {
    expect(truncateText("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abcdef", 3, "x").text).toBe("abc\n[x truncated: showing 3 of 6 characters]");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("validateSchema", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, maxLength: 5 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      ratio: { type: "number" },
      kind: { enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      meta: { type: "object", additionalProperties: { type: "string" } },
      maybe: { type: ["string", "null"] },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts valid input", () => {
    expect(
      validateSchema(schema, { name: "abc", count: 2, ratio: 1.5, kind: "a", tags: ["x"], pair: ["a", 1], meta: { k: "v" }, maybe: null }),
    ).toEqual([]);
    expect(validateSchema(undefined, 5)).toEqual([]);
    expect(validateSchema({ type: "number" }, 3)).toEqual([]);
  });

  it("reports each problem with a path", () => {
    const errs = validateSchema(schema, {
      count: 9,
      ratio: "x",
      kind: "c",
      tags: [1, 2, 3],
      pair: [1, "a"],
      meta: { k: 1 },
      extra: true,
      maybe: 3,
      skipped: undefined,
    });
    expect(errs).toEqual([
      "input.name is required",
      "input.count must be <= 3",
      "input.ratio must be number, got string",
      'input.kind must be one of "a", "b"',
      "input.tags must have at most 2 items",
      "input.tags[0] must be string, got integer",
      "input.tags[1] must be string, got integer",
      "input.tags[2] must be string, got integer",
      "input.pair[0] must be string, got integer",
      "input.pair[1] must be number, got string",
      "input.meta.k must be string, got integer",
      "input.extra is not allowed",
      "input.maybe must be string or null, got integer",
    ]);
    expect(validateSchema(schema, { name: "a", count: 0, tags: [] })).toEqual([
      "input.name must be at least 2 characters",
      "input.count must be >= 1",
      "input.tags must have at least 1 items",
    ]);
    expect(validateSchema(schema, { name: "toolong" })).toEqual(["input.name must be at most 5 characters"]);
    expect(validateSchema(schema, [])).toEqual(["input must be object, got array"]);
    expect(validateSchema({ enum: [{ a: "x".repeat(80) }] }, 1)[0]).toContain("...");
  });
});

describe("SQL screening", () => {
  it("strips comments and literals", () => {
    expect(stripSql("SELECT 'a;b''c' -- x;\n, 1 /* ; */")).toBe("SELECT ''  \n, 1  ");
    expect(splitStatements("SELECT 1; ; SELECT ';'")).toEqual(["SELECT 1", "SELECT ''"]);
    expect(stripSql("SELECT 1 -- open")).toBe("SELECT 1  ");
    expect(stripSql("SELECT 1 /* open")).toBe("SELECT 1  ");
  });

  it("checkReadSql", () => {
    expect(checkReadSql("SELECT * FROM customers WHERE note = 'delete me'")).toMatchObject({ ok: true, kind: "SELECT" });
    expect(checkReadSql("with x as (select 1) select * from x")).toMatchObject({ ok: true, kind: "WITH" });
    expect(checkReadSql("VALUES (1)")).toMatchObject({ ok: true });
    expect(checkReadSql("PRAGMA table_info('customers')")).toMatchObject({ ok: true, kind: "PRAGMA" });
    expect(checkReadSql("PRAGMA main.table_xinfo(customers)")).toMatchObject({ ok: true });
    expect(checkReadSql("")).toEqual({ ok: false, reason: "no SQL statement given" });
    expect(checkReadSql("SELECT * FROM _OS_memory")).toMatchObject({ ok: false });
    expect(checkReadSql("INSERT INTO x VALUES (1)")).toMatchObject({ ok: false });
    expect(checkReadSql("SELECT 1 FROM x; UPDATE x SET a = 1")).toMatchObject({ ok: false });
    expect(checkReadSql("ATTACH DATABASE 'x' AS y")).toMatchObject({ ok: false });
  });

  it("checkWriteSql and delete detection", () => {
    expect(checkWriteSql("INSERT INTO customers (id, name) VALUES ('1', 'DELETE FROM x')")).toEqual({ ok: true, kind: "INSERT", deletes: false });
    expect(checkWriteSql("UPDATE customers SET name = 'x' WHERE id = 'c1'")).toMatchObject({ ok: true, deletes: false });
    // Security scan F3: these destroy data too, so they ask the person first.
    expect(checkWriteSql("UPDATE customers SET name = 'x'")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("ALTER TABLE customers DROP email")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("REPLACE INTO customers (id, name) VALUES ('c1', 'x')")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("INSERT OR REPLACE INTO customers (id, name) VALUES ('c1', 'x')")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("UPDATE OR REPLACE customers SET id = 'c2' WHERE id = 'c1'")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("WITH c AS (SELECT 1) REPLACE INTO notes (id) VALUES ('x')")).toMatchObject({ ok: true, deletes: true });
    // Not destructive: the replace() function, an ordinary insert, a rename, words inside literals.
    expect(checkWriteSql("UPDATE customers SET name = replace(name, 'Ltd', 'Limited') WHERE id = 'c1'")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("INSERT INTO notes (id, body) VALUES ('n1', 'please drop or replace into')")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("ALTER TABLE notes RENAME TO notes_old")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("INSERT INTO notes (id) VALUES ('n1') ON CONFLICT(id) DO NOTHING")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("INSERT INTO brand (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("WITH x AS (SELECT 1) UPDATE customers SET name = 'x'")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("DELETE FROM customers")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("DROP TABLE posts")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("ALTER TABLE posts DROP COLUMN campaign")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("ALTER TABLE posts ADD COLUMN x TEXT")).toMatchObject({ ok: true, deletes: false });
    expect(checkWriteSql("WITH old AS (SELECT id FROM posts) DELETE FROM posts WHERE id IN old")).toMatchObject({ ok: true, deletes: true });
    expect(checkWriteSql("CREATE TABLE IF NOT EXISTS notes (id TEXT)")).toMatchObject({ ok: true });
    expect(checkWriteSql("CREATE UNIQUE INDEX IF NOT EXISTS i ON notes(id)")).toMatchObject({ ok: true });
    expect(checkWriteSql("CREATE TABLE notes (id TEXT)")).toMatchObject({ ok: false });
    expect(checkWriteSql("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END")).toMatchObject({ ok: false });
    expect(checkWriteSql("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1 END")).toMatchObject({ ok: false });
    expect(checkWriteSql("CREATE VIRTUAL TABLE v USING fts5(x)")).toMatchObject({ ok: false });
    expect(checkWriteSql("PRAGMA foreign_keys = OFF")).toMatchObject({ ok: false });
    expect(checkWriteSql("BEGIN")).toMatchObject({ ok: false, reason: "transactions are managed by OneSeat" });
    expect(checkWriteSql("SELECT 1")).toMatchObject({ ok: false });
    expect(checkWriteSql("WITH x AS (SELECT 1) SELECT * FROM x")).toMatchObject({ ok: false });
    expect(checkWriteSql("ALTER INDEX x")).toMatchObject({ ok: false });
    expect(checkWriteSql(" ")).toMatchObject({ ok: false });
    expect(checkWriteSql("INSERT INTO a VALUES (1); INSERT INTO a VALUES (2)")).toMatchObject({ ok: false });
    expect(checkWriteSql("DELETE FROM _os_action_log")).toMatchObject({ ok: false });
  });
});

describe("action summaries", () => {
  it("describes send, pay, delete and other actions", () => {
    expect(summarizeAction("mcp__gmail__send_email", { to: "ada@example.com", subject: "Your invoice" }, ["send"])).toBe(
      "Send email to ada@example.com: 'Your invoice'",
    );
    expect(summarizeAction("mcp__slack__post_message", { channel: "#sales", text: "hi" }, ["send"])).toBe("Send post message to #sales");
    expect(summarizeAction("notify", { body: "x" }, ["send"])).toBe('Send with notify: {"body":"x"}');
    expect(summarizeAction("mcp__stripe__pay", { amount_cents: 12500, currency: "usd", payee: "Acme" }, ["pay"])).toBe(
      "Pay 125.00 USD to Acme (pay)",
    );
    expect(summarizeAction("pay_bill", { amount: 40, recipients: ["a", "b"] }, ["pay"])).toBe("Pay 40 to a, b (pay bill)");
    expect(summarizeAction("pay_bill", { memo: "x" }, ["pay"])).toBe('Pay with pay bill: {"memo":"x"}');
    expect(summarizeAction("mcp__drive__delete_file", { id: "f1" }, ["delete"])).toBe("Delete with delete file: f1");
    expect(summarizeAction("rm", { flag: true }, ["delete"])).toBe('Delete with rm: {"flag":true}');
    expect(summarizeAction("db_query", { sql: "SELECT 1" }, ["read"])).toBe('db query: {"sql":"SELECT 1"}');
    expect(summarizeAction("t", { s: "x".repeat(500) }, ["read"]).length).toBeLessThanOrEqual(200);
    expect(toolLabel("mcp__my_server__send_it")).toBe("send it");
    expect(isReadOnly(["read", "network"])).toBe(true);
    expect(isReadOnly(["network"])).toBe(false);
    expect(isReadOnly(["read", "write"])).toBe(false);
    expect(isReadOnly([])).toBe(false);
  });
});

describe("workspace paths", () => {
  it("normalises safe relative paths and rejects escapes", () => {
    expect(normaliseRelativePath("./a//b/./c.txt")).toBe("a/b/c.txt");
    expect(normaliseRelativePath("a\\b")).toBe("a/b");
    expect(normaliseRelativePath(".")).toBe("");
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "C:\\x", "\\\\server\\x", "~/x", "a\0b"])
      expect(() => normaliseRelativePath(bad)).toThrow();
    expect(() => normaliseRelativePath(5 as unknown as string)).toThrow("must be a string");
  });

  it("refuses symlinks that leave the workspace", () => {
    const root = tmpDir();
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(outside, join(ws, "link"));
    symlinkSync(join(outside, "secret.txt"), join(ws, "file-link"));
    expect(() => resolveInside(ws, "link/secret.txt")).toThrow("outside the workspace");
    expect(() => resolveInside(ws, "link/new.txt")).toThrow("outside the workspace");
    expect(() => resolveInside(ws, "file-link")).toThrow("outside the workspace");
    expect(resolveInside(ws, "deep/new/file.txt")).toContain(join("ws", "deep", "new", "file.txt"));
  });
});
