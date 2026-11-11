import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

type Runner = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const storage = new AsyncLocalStorage<Runner>();

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (typeof value === "string" && /_minor$|_bps$|_bytes$/.test(key) && /^-?\d+$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

export async function migrate(db: Database): Promise<void> {
  await db.exec(schemaSql);
  await db.exec(`ALTER TABLE households ADD COLUMN IF NOT EXISTS member_limit integer`);
  await db.exec(`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'shared'`);
  await db.exec(`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS owner_user_id text`);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash ON invitations (token_hash)`);
}

export async function openDatabase(databaseUrl = process.env.DATABASE_URL): Promise<Database> {
  if (databaseUrl) return openPostgres(databaseUrl);
  const path = process.env.BUDGETCENTS_DATA ?? "./data/budgetcents";
  mkdirSync(path, { recursive: true });
  const pg = new PGlite(path);
  await pg.waitReady;
  const db = wrapPglite(pg);
  await migrate(db);
  return db;
}

export async function openMemoryDatabase(): Promise<Database> {
  const pg = new PGlite();
  await pg.waitReady;
  const db = wrapPglite(pg);
  await migrate(db);
  return db;
}

function wrapPglite(pg: PGlite): Database {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const runQuery: Runner = async (sql, params = []) => {
    const result = await pg.query(sql, params);
    return result.rows.map((row) => normalize(row as Record<string, unknown>));
  };
  const db: Database = {
    query: (sql, params) => {
      const current = storage.getStore();
      if (current) return current(sql, params) as Promise<never[]>;
      return enqueue(() => runQuery(sql, params)) as Promise<never[]>;
    },
    exec: async (sql) => {
      if (storage.getStore()) {
        await pg.exec(sql);
        return;
      }
      await enqueue(() => pg.exec(sql));
    },
    tx: <T>(fn: () => Promise<T>) => {
      if (storage.getStore()) return fn();
      return enqueue(async () => {
        await pg.exec("BEGIN");
        try {
          const value = await storage.run(runQuery, fn);
          await pg.exec("COMMIT");
          return value;
        } catch (error) {
          await pg.exec("ROLLBACK");
          throw error;
        }
      });
    },
    close: () => pg.close(),
  };
  return db;
}

async function openPostgres(databaseUrl: string): Promise<Database> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: databaseUrl });
  const runQuery: Runner = async (sql, params = []) => {
    const result = await pool.query(sql, params as never[]);
    return result.rows.map((row) => normalize(row as Record<string, unknown>));
  };
  const db: Database = {
    query: (sql, params) => (storage.getStore() ?? runQuery)(sql, params) as Promise<never[]>,
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async <T>(fn: () => Promise<T>) => {
      if (storage.getStore()) return fn();
      const client = await pool.connect();
      const clientRun: Runner = async (sql, params = []) => {
        const result = await client.query(sql, params as never[]);
        return result.rows.map((row) => normalize(row as Record<string, unknown>));
      };
      try {
        await client.query("BEGIN");
        const value = await storage.run(clientRun, fn);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return fallback;
}

export function str(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
