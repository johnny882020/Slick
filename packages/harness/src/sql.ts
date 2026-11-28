// SQL screening for db_query / db_execute. This is defence in depth: db_query also
// runs on a read-only connection, so a statement that slips past the screen still
// cannot write.

import { touchesPrivateTable } from "@oneseat/contracts";

/** Remove comments and the contents of string literals, keeping statement structure. */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'") {
      // String literal: blank its contents, '' is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += "''";
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Split into statements on semicolons outside literals and comments. Empty statements are dropped. */
export function splitStatements(sql: string): string[] {
  return stripSql(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type SqlCheck = { ok: true; kind: string; deletes: boolean } | { ok: false; reason: string };

function firstWords(stmt: string, n: number): string[] {
  return stmt.trim().split(/\s+/).slice(0, n).map((w) => w.toUpperCase());
}

/** Allowed for db_query: one SELECT / WITH ... SELECT / VALUES / PRAGMA table_info(...). */
export function checkReadSql(sql: string): SqlCheck {
  if (touchesPrivateTable(sql)) return { ok: false, reason: "tables starting with _os_ are private to OneSeat" };
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return { ok: false, reason: "no SQL statement given" };
  if (stmts.length > 1) return { ok: false, reason: "send one statement at a time" };
  const stmt = stmts[0]!;
  const head = firstWords(stmt, 1)[0]!.replace(/\(.*$/, "");
  if (head === "PRAGMA") {
    if (/^PRAGMA\s+(main\.)?table_(x)?info\s*\(\s*["'`[]?[A-Za-z0-9_]*["'`\]]?\s*\)$/i.test(stmt))
      return { ok: true, kind: "PRAGMA", deletes: false };
    return { ok: false, reason: "only PRAGMA table_info(<table>) is allowed in db_query" };
  }
  if (head !== "SELECT" && head !== "WITH" && head !== "VALUES")
    return { ok: false, reason: `db_query is read-only: ${head} is not allowed (use db_execute to change data)` };
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA)\b/i.test(stmt))
    return { ok: false, reason: "db_query is read-only: the statement contains a write keyword" };
  return { ok: true, kind: head, deletes: false };
}

const WRITE_HEADS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "WITH"]);

/** Allowed for db_execute: one INSERT / UPDATE / DELETE / REPLACE / CREATE ... IF NOT EXISTS / DROP / ALTER TABLE. */
export function checkWriteSql(sql: string): SqlCheck {
  if (touchesPrivateTable(sql)) return { ok: false, reason: "tables starting with _os_ are private to OneSeat" };
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return { ok: false, reason: "no SQL statement given" };
  if (stmts.length > 1) return { ok: false, reason: "send one statement at a time" };
  const stmt = stmts[0]!;
  const words = firstWords(stmt, 6);
  const head = words[0]!;
  if (/\b(ATTACH|DETACH|PRAGMA|VACUUM|load_extension)\b/i.test(stmt))
    return { ok: false, reason: "ATTACH, DETACH, PRAGMA, VACUUM and extensions are not allowed" };
  if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(head))
    return { ok: false, reason: "transactions are managed by OneSeat" };
  if (!WRITE_HEADS.has(head))
    return { ok: false, reason: `${head} is not allowed in db_execute (use db_query to read)` };
  if (head === "CREATE") {
    const rest = words.slice(1).join(" ");
    if (/^(TEMP |TEMPORARY )?TRIGGER\b/.test(rest)) return { ok: false, reason: "CREATE TRIGGER is not allowed" };
    if (/^(VIRTUAL )/.test(rest)) return { ok: false, reason: "CREATE VIRTUAL TABLE is not allowed" };
    if (!/^(TEMP |TEMPORARY )?(UNIQUE )?(TABLE|INDEX|VIEW) IF NOT EXISTS\b/.test(rest))
      return { ok: false, reason: "use CREATE TABLE|INDEX|VIEW IF NOT EXISTS so skills stay idempotent" };
  }
  if (head === "ALTER" && !/^ALTER TABLE\b/.test(words.join(" ")))
    return { ok: false, reason: "only ALTER TABLE is allowed" };
  if (head === "WITH" && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stmt))
    return { ok: false, reason: "a WITH statement in db_execute must write; use db_query to read" };
  return { ok: true, kind: head, deletes: destroysData(head, stmt) };
}

/**
 * Does a write statement remove or overwrite data that cannot be got back? These ask the person
 * first (the "delete" effect). Literals and comments are already blanked by stripSql.
 */
function destroysData(head: string, stmt: string): boolean {
  if (head === "DROP" || head === "REPLACE") return true;
  if (/\bDELETE\b/i.test(stmt)) return true;
  // SQLite's COLUMN keyword is optional: ALTER TABLE t DROP c drops the column too.
  if (head === "ALTER" && /\bDROP\b/i.test(stmt)) return true;
  // INSERT OR REPLACE / REPLACE INTO / UPDATE OR REPLACE delete the rows they conflict with.
  if (/\bOR\s+REPLACE\b|\bREPLACE\s+INTO\b/i.test(stmt)) return true;
  // An UPDATE with no WHERE overwrites every row of the table. An upsert's DO UPDATE changes only
  // the row it conflicts with (brand-kit saves its keys that way), so it is not counted.
  const updates = stmt.replace(/\bDO\s+UPDATE\b/gi, " ");
  if (/\bUPDATE\b/i.test(updates) && !/\bWHERE\b/i.test(updates)) return true;
  return false;
}
