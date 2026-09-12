import pg from 'pg';
import { config } from '../config.js';

/**
 * The PostgreSQL data layer. One pool for the whole process; every query in
 * the application goes through query/queryOne/execute/transact below, so
 * connection handling, parameter binding and error redaction live in exactly
 * one place.
 *
 * Parameter style: better-sqlite3 (which this replaces) bound parameters by
 * NAME — `@id`, `@createdAt` — and several hundred call sites across the
 * codebase are written that way. `pg` only understands positional `$1, $2`.
 * Rather than rewrite every call site's parameter list by hand (and risk a
 * silent mis-ordering in any one of them), the helpers below accept the SAME
 * `@name` SQL plus a plain object and translate it here. Positional `$1`
 * style still works too — pass an array instead of an object.
 */

const { Pool } = pg;

/**
 * node-postgres hands back NUMERIC (and BIGINT) as strings, because they can
 * exceed JS number precision. This application's existing API contract —
 * which the React frontend already depends on — returns them as numbers, and
 * every value in this schema is comfortably inside the safe-integer range
 * (hours, litres, rates, counts). Parsing them back to numbers here keeps the
 * API responses byte-identical to what SQLite produced, which is the whole
 * point of the migration being invisible to the frontend.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // BIGINT / INT8

export const pool = new Pool({
  connectionString: config.postgres.url,
  ssl: config.postgres.ssl ? { rejectUnauthorized: false } : undefined,
  min: config.postgres.poolMin,
  max: config.postgres.poolMax,
});

/**
 * An idle client dying (network blip, server restart, admin killing a
 * backend) must never take the process down with it — the pool replaces it on
 * the next checkout. Logged without the connection string, which carries the
 * password.
 */
pool.on('error', (err) => {
  console.error('[postgres] idle client error:', redact(err.message));
});

/** Strips anything that looks like a password out of a message before it reaches a log or an API response. */
export function redact(message: string): string {
  return message
    .replace(/postgresql:\/\/[^\s]*/gi, 'postgresql://<redacted>')
    .replace(/password=('[^']*'|"[^"]*"|\S+)/gi, 'password=<redacted>');
}

export type Params = Record<string, unknown> | unknown[] | undefined;

/**
 * Rewrites `@name` placeholders into `$1, $2, ...` and builds the matching
 * positional array. A name used more than once in the same statement reuses
 * its position rather than binding it twice. Arrays (already positional) and
 * undefined pass straight through.
 *
 * `@` inside a string literal or a cast (`::`) is left alone: the pattern
 * only matches an @ that is followed by an identifier AND not preceded by
 * another @ or a colon, which covers this codebase's SQL. Anything more
 * exotic should be written positionally.
 */
export function bind(sql: string, params: Params): { text: string; values: unknown[] } {
  if (params === undefined) return { text: sql, values: [] };
  if (Array.isArray(params)) return { text: sql, values: params };

  const values: unknown[] = [];
  const positions = new Map<string, number>();
  const text = sql.replace(/(^|[^:@\w])@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, prefix: string, name: string) => {
    if (!(name in params)) {
      throw new Error(`Query references @${name} but no such value was provided.`);
    }
    let index = positions.get(name);
    if (index === undefined) {
      values.push(params[name]);
      index = values.length;
      positions.set(name, index);
    }
    return `${prefix}$${index}`;
  });
  return { text, values };
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined>;
  execute(sql: string, params?: Params): Promise<{ rowCount: number; rows: Record<string, unknown>[] }>;
}

async function run(client: pg.Pool | pg.PoolClient, sql: string, params: Params) {
  const { text, values } = bind(sql, params);
  try {
    return await client.query(text, values);
  } catch (err) {
    const e = err as Error;
    // Keep the failing statement (useful) but never the connection string.
    throw new Error(`${redact(e.message)} — while running: ${text.trim().slice(0, 300)}`);
  }
}

/** All matching rows. Replaces better-sqlite3's `.all()`. */
export async function query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]> {
  const res = await run(pool, sql, params);
  return res.rows as T[];
}

/** The first row, or undefined. Replaces better-sqlite3's `.get()`. */
export async function queryOne<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined> {
  const res = await run(pool, sql, params);
  return res.rows[0] as T | undefined;
}

/**
 * A write. Replaces better-sqlite3's `.run()`. `rows` carries whatever a
 * `RETURNING` clause produced — the PostgreSQL replacement for
 * last_insert_rowid(), though this schema's ids are all application-generated
 * strings (util/id.ts) so most callers never need it.
 */
export async function execute(sql: string, params?: Params): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  const res = await run(pool, sql, params);
  return { rowCount: res.rowCount ?? 0, rows: res.rows as Record<string, unknown>[] };
}

/**
 * Runs fn inside a single transaction on ONE pooled client — every statement
 * issued through the `q` handed to fn goes over that same connection, which
 * is what makes BEGIN/COMMIT meaningful (issuing them through the pool would
 * scatter them across different connections). Commits on return, rolls back
 * on throw, and always releases the client afterwards, never before.
 */
export async function transact<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const scoped: Queryable = {
    query: async <R>(sql: string, params?: Params) => (await run(client, sql, params)).rows as R[],
    queryOne: async <R>(sql: string, params?: Params) => (await run(client, sql, params)).rows[0] as R | undefined,
    execute: async (sql: string, params?: Params) => {
      const res = await run(client, sql, params);
      return { rowCount: res.rowCount ?? 0, rows: res.rows as Record<string, unknown>[] };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[postgres] rollback failed:', redact((rollbackErr as Error).message));
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface DbHealth {
  connected: boolean;
  database: string;
  responseMs: number | null;
  error?: string;
}

/** Used by GET /api/health. Reports reachability and latency — never credentials. */
export async function healthCheck(): Promise<DbHealth> {
  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    return { connected: true, database: config.postgres.database, responseMs: Date.now() - started };
  } catch (err) {
    return {
      connected: false,
      database: config.postgres.database,
      responseMs: null,
      error: redact((err as Error).message),
    };
  }
}

/** Closes every pooled connection. Called from the SIGINT/SIGTERM handlers in index.ts. */
export async function shutdown(): Promise<void> {
  await pool.end();
}
