// A fresh data folder per eval run: business database seeded from EvalCase.db, workspace files from EvalCase.workspace.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUSINESS_SCHEMA_SQL, BUSINESS_TABLES, type EvalCase } from "@oneseat/contracts";
import { safeSkillPath } from "../memory-store.js";
import { IDENTIFIER } from "./validate.js";

/**
 * File name of the business database inside dataDir.
 * Contract gap: packages/contracts does not name this file. The harness must open
 * `${dataDir}/${EVAL_DB_FILE}` (or take EvalHarnessContext.dbPath) to see the seeded rows.
 */
export const EVAL_DB_FILE = "oneseat.db";

export interface RunDirs {
  /** Root temp folder for the run; removed by cleanup(). */
  root: string;
  /** Harness data folder (database, memory, logs). */
  dataDir: string;
  /** Path of the seeded SQLite database. */
  dbPath: string;
  /** Workspace folder holding EvalCase.workspace files. */
  workspaceDir: string;
  cleanup: () => Promise<void>;
}

type SqlValue = string | number | bigint | null | Uint8Array;

function toSqlValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

async function openDb(path: string) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

/** Create the business schema and insert the case's rows. Throws with the table and row on bad data. */
export async function seedDatabase(path: string, db: EvalCase["db"]): Promise<{ rows: number }> {
  const conn = await openDb(path);
  let rows = 0;
  try {
    conn.exec(BUSINESS_SCHEMA_SQL);
    conn.exec("BEGIN");
    try {
      const tables = Object.keys(db ?? {});
      for (const t of tables) if (!(BUSINESS_TABLES as readonly string[]).includes(t)) throw new Error(`cannot seed table "${t}": only ${BUSINESS_TABLES.join(", ")}`);
      // Insert in schema order so referenced rows exist first.
      for (const table of BUSINESS_TABLES) {
        for (const [i, row] of (db?.[table] ?? []).entries()) {
          const cols = Object.keys(row);
          for (const c of cols) if (!IDENTIFIER.test(c)) throw new Error(`${table}[${i}]: bad column name "${c}"`);
          const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
          try {
            conn.prepare(sql).run(...cols.map((c) => toSqlValue(row[c])));
          } catch (e) {
            throw new Error(`${table}[${i}]: ${(e as Error).message}`);
          }
          rows++;
        }
      }
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
  } finally {
    conn.close();
  }
  return { rows };
}

/** Write workspace files. Rejects paths that leave the workspace. */
export async function writeWorkspace(dir: string, files: EvalCase["workspace"]): Promise<number> {
  let n = 0;
  for (const [rel, content] of Object.entries(files ?? {})) {
    const safe = safeSkillPath(rel);
    if (safe === undefined) throw new Error(`workspace path "${rel}" leaves the workspace`);
    const full = join(dir, ...safe.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    n++;
  }
  return n;
}

/** Make a fresh temp folder for one run and seed it. */
export async function prepareRunDirs(c: Pick<EvalCase, "db" | "workspace">, opts: { tmpRoot?: string; label?: string; keep?: boolean } = {}): Promise<RunDirs> {
  const base = opts.tmpRoot ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `oneseat-eval-${(opts.label ?? "run").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60)}-`));
  const dataDir = join(root, "data");
  const workspaceDir = join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const dbPath = join(dataDir, EVAL_DB_FILE);
  const cleanup = async () => {
    if (!opts.keep) await rm(root, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await seedDatabase(dbPath, c.db);
    await writeWorkspace(workspaceDir, c.workspace);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { root, dataDir, dbPath, workspaceDir, cleanup };
}

/** Seed a case into an in-memory database (dry-run validation). Returns the error message, if any. */
export async function trySeedInMemory(c: Pick<EvalCase, "db">): Promise<string | undefined> {
  try {
    await seedDatabase(":memory:", c.db);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
